import { describe, expect, it } from 'bun:test';

import {
  SYSTEM_PROMPT,
  buildReleaseNotes,
  buildTemplateBody,
  buildUserPrompt,
  formatHeading,
  generateReleaseNotes,
  parseAIBody,
} from '../src/core/release-notes.ts';
import type { AIProvider, Commit, RemoteInfo } from '../src/types.ts';

// --------- Fixtures ---------

function commit(partial: Partial<Commit>): Commit {
  return {
    sha: 'f'.repeat(40),
    shortSha: 'abc1234',
    author: 'Test',
    authorEmail: 'test@example.com',
    date: '2026-04-11T12:00:00Z',
    subject: '',
    body: '',
    ...partial,
  };
}

const github: RemoteInfo = {
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
};

function fakeProvider(
  respond: (prompt: { system: string; user: string }) => string,
): AIProvider {
  return {
    name: 'anthropic',
    defaultModel: 'fake',
    estimateTokens: (s) => s.length,
    async generate(req) {
      return {
        text: respond({ system: req.system, user: req.user }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

// --------- SYSTEM_PROMPT ---------

describe('SYSTEM_PROMPT', () => {
  it('is a non-empty string mentioning Keep a Changelog sections', () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).toContain('### Added');
    expect(SYSTEM_PROMPT).toContain('### Fixed');
  });

  it('tells the model not to add a version heading', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('version heading');
  });

  it('defines a structural whitelist of allowed bullet shapes', () => {
    // Regression guard: earlier prompt iterations relied on a forbidden-
    // word blacklist, and the AI routed around it with synonyms
    // ("classifier", "resolver", "strategy"). The whitelist approach
    // describes what a bullet MUST look like instead, so anything that
    // doesn't fit gets deleted by construction.
    expect(SYSTEM_PROMPT).toContain('DELETE IT');
    // The five shapes should all be enumerated.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('command');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('flag');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('configuration option');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('new file');
  });

  it('lists internal categories that must always be omitted', () => {
    // Regression guard: dry-run #3 produced "Comprehensive test suite"
    // and dry-run #4 leaked 3 build/CI bullets. The prompt now names
    // these categories explicitly as ALWAYS internal.
    const lower = SYSTEM_PROMPT.toLowerCase();
    for (const internal of [
      'test suites',
      'ci workflows',
      'lint',
      'build scripts',
      'internal refactors',
      'dependency bumps',
    ]) {
      expect(lower).toContain(internal);
    }
  });

  it('includes concrete good and bad bullet examples', () => {
    // Few-shot examples are more sticky than imperative rules alone.
    // Note: dry-run #6 (with BAD list removed) produced strictly worse
    // output than #5 (with BAD list present) — the negative examples
    // were guardrails, not imitation bait, at least for Haiku.
    expect(SYSTEM_PROMPT).toContain('GOOD example');
    expect(SYSTEM_PROMPT).toContain('BAD bullets');
  });
});

// --------- buildUserPrompt ---------

describe('buildUserPrompt', () => {
  it('includes both version lines', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.2.3',
      previousVersion: '1.2.2',
      commits: [],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('New version: 1.2.3');
    expect(prompt).toContain('Previous version: 1.2.2');
  });

  it('labels the first-release case', () => {
    const prompt = buildUserPrompt({
      newVersion: '0.1.0',
      previousVersion: null,
      commits: [],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('Previous version: (none');
  });

  it('adds a first-release-only-Added reminder when previousVersion is null', () => {
    const prompt = buildUserPrompt({
      newVersion: '0.1.0',
      previousVersion: null,
      commits: [],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('first release');
    expect(prompt).toContain('### Added');
    expect(prompt).toContain(
      'Do not produce Changed, Deprecated, Removed, Fixed, or Security',
    );
  });

  it('does NOT add the first-release reminder when previousVersion is set', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.2.3',
      previousVersion: '1.2.2',
      commits: [],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).not.toContain('Do not produce Changed');
    expect(prompt).not.toContain('first release');
  });

  it('lists commit subjects with short SHAs', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.0.0',
      previousVersion: null,
      commits: [
        commit({ shortSha: 'abc1234', subject: 'feat: add thing' }),
        commit({ shortSha: 'def5678', subject: 'fix: handle edge' }),
      ],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('- abc1234 feat: add thing');
    expect(prompt).toContain('- def5678 fix: handle edge');
  });

  it('includes commit bodies indented under the subject', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.0.0',
      previousVersion: null,
      commits: [
        commit({
          shortSha: 'abc1234',
          subject: 'feat: x',
          body: 'line 1\nline 2',
        }),
      ],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('    line 1');
    expect(prompt).toContain('    line 2');
  });

  it('includes the diff body', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.0.0',
      previousVersion: null,
      commits: [],
      diff: 'diff --git a/x b/x\n+foo',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('diff --git a/x b/x');
  });

  it('mentions dropped files when the truncator removed any', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.0.0',
      previousVersion: null,
      commits: [],
      diff: 'x',
      diffDroppedFiles: ['package-lock.json', 'dist/bundle.js'],
    });
    expect(prompt).toContain('package-lock.json');
    expect(prompt).toContain('dist/bundle.js');
    expect(prompt).toContain('omitted from the diff');
  });

  it('handles an empty commit list without crashing', () => {
    const prompt = buildUserPrompt({
      newVersion: '1.0.0',
      previousVersion: null,
      commits: [],
      diff: '',
      diffDroppedFiles: [],
    });
    expect(prompt).toContain('Commits (0 total');
    expect(prompt).toContain('(none)');
  });
});

// --------- buildTemplateBody ---------

describe('buildTemplateBody', () => {
  it('groups feat commits under Added', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'a1', subject: 'feat: add widget' }),
    ]);
    expect(body).toContain('### Added');
    expect(body).toContain('- Add widget (a1)');
  });

  it('groups fix commits under Fixed', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'b2', subject: 'fix(api): handle null' }),
    ]);
    expect(body).toContain('### Fixed');
    expect(body).toContain('- Handle null (b2)');
  });

  it('groups perf, refactor, and docs under Changed', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'c3', subject: 'perf: speed up parse' }),
      commit({ shortSha: 'd4', subject: 'refactor: simplify loop' }),
      commit({ shortSha: 'e5', subject: 'docs: clarify readme' }),
    ]);
    expect(body).toContain('### Changed');
    expect(body).toContain('- Speed up parse (c3)');
    expect(body).toContain('- Simplify loop (d4)');
    expect(body).toContain('- Clarify readme (e5)');
  });

  it('routes breaking changes to Changed', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'f6', subject: 'feat(api)!: drop v1 route' }),
    ]);
    expect(body).toContain('### Changed');
    expect(body).toContain('- Drop v1 route (f6)');
    // Breaking feat should NOT also appear under Added.
    expect(body).not.toContain('### Added');
  });

  it('routes BREAKING CHANGE footer commits to Changed', () => {
    const body = buildTemplateBody([
      commit({
        shortSha: 'g7',
        subject: 'refactor(db): new schema',
        body: 'BREAKING CHANGE: migration required',
      }),
    ]);
    expect(body).toContain('### Changed');
  });

  it('omits chore, ci, build, test, style commits entirely', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'h8', subject: 'chore: bump deps' }),
      commit({ shortSha: 'i9', subject: 'ci: update workflow' }),
      commit({ shortSha: 'ja', subject: 'build: tsconfig' }),
      commit({ shortSha: 'kb', subject: 'test: add cases' }),
      commit({ shortSha: 'lc', subject: 'style: format' }),
    ]);
    expect(body).toBe('_No user-facing changes in this release._');
  });

  it('preserves section order: Added, Changed, Fixed', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'aa', subject: 'fix: x' }),
      commit({ shortSha: 'bb', subject: 'feat: y' }),
      commit({ shortSha: 'cc', subject: 'refactor: z' }),
    ]);
    const addedIdx = body.indexOf('### Added');
    const changedIdx = body.indexOf('### Changed');
    const fixedIdx = body.indexOf('### Fixed');
    expect(addedIdx).toBeGreaterThan(-1);
    expect(changedIdx).toBeGreaterThan(addedIdx);
    expect(fixedIdx).toBeGreaterThan(changedIdx);
  });

  it('strips trailing periods from subjects', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'ab', subject: 'feat: add thing.' }),
    ]);
    expect(body).toContain('- Add thing (ab)');
  });

  it('returns the no-changes sentinel for an empty commit list', () => {
    expect(buildTemplateBody([])).toBe(
      '_No user-facing changes in this release._',
    );
  });

  it('omits unknown commit types', () => {
    const body = buildTemplateBody([
      commit({ shortSha: 'xx', subject: 'random not-a-type something' }),
    ]);
    expect(body).toBe('_No user-facing changes in this release._');
  });
});

// --------- parseAIBody ---------

describe('parseAIBody', () => {
  it('returns plain input unchanged (trimmed)', () => {
    expect(parseAIBody('### Added\n- x\n')).toBe('### Added\n- x');
  });

  it('strips a leading # heading', () => {
    const input = '# v1.2.3\n\n### Added\n- x';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('strips a leading ## heading', () => {
    const input = '## [1.2.3] - 2026-04-11\n\n### Added\n- x';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('strips multiple leading # / ## lines', () => {
    const input = '# Release\n## Notes\n\n### Added\n- x';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('does NOT strip ### section headings', () => {
    const input = '### Added\n- x';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('strips a surrounding ``` fence', () => {
    const input = '```\n### Added\n- x\n```';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('strips a surrounding ```markdown fence', () => {
    const input = '```markdown\n### Added\n- x\n```';
    expect(parseAIBody(input)).toBe('### Added\n- x');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(parseAIBody('   \n  ')).toBe('');
  });
});

// --------- formatHeading + buildReleaseNotes ---------

describe('formatHeading', () => {
  it('produces a Keep a Changelog heading', () => {
    expect(formatHeading('1.2.3', '2026-04-11')).toBe(
      '## [1.2.3] - 2026-04-11',
    );
  });
});

describe('buildReleaseNotes', () => {
  it('wraps body with title and heading', () => {
    const notes = buildReleaseNotes('### Added\n- x', '1.0.0', '2026-04-11');
    expect(notes.title).toBe('v1.0.0');
    expect(notes.heading).toBe('## [1.0.0] - 2026-04-11');
    expect(notes.body).toBe('### Added\n- x');
  });
});

// --------- generateReleaseNotes ---------

describe('generateReleaseNotes — template path', () => {
  it('uses template when provider is null', async () => {
    const notes = await generateReleaseNotes({
      commits: [commit({ shortSha: 'aa', subject: 'feat: thing' })],
      diff: '',
      diffDroppedFiles: [],
      version: '1.0.0',
      previousVersion: null,
      date: '2026-04-11',
      provider: null,
      remote: null,
    });
    expect(notes.body).toContain('### Added');
    expect(notes.body).toContain('- Thing (aa)');
    expect(notes.heading).toBe('## [1.0.0] - 2026-04-11');
    expect(notes.title).toBe('v1.0.0');
  });

  it('enriches PR refs in template body when remote is given', async () => {
    const notes = await generateReleaseNotes({
      commits: [commit({ shortSha: 'aa', subject: 'feat: add thing (#42)' })],
      diff: '',
      diffDroppedFiles: [],
      version: '1.0.0',
      previousVersion: null,
      date: '2026-04-11',
      provider: null,
      remote: github,
    });
    expect(notes.body).toContain(
      '[#42](https://github.com/acme/widgets/pull/42)',
    );
  });
});

describe('generateReleaseNotes — AI path', () => {
  it('sends the system + user prompt to the provider', async () => {
    let seenSystem = '';
    let seenUser = '';
    const provider = fakeProvider(({ system, user }) => {
      seenSystem = system;
      seenUser = user;
      return '### Added\n- Generated bullet';
    });

    const notes = await generateReleaseNotes({
      commits: [commit({ shortSha: 'aa', subject: 'feat: x' })],
      diff: 'diff --git a/x b/x\n+foo',
      diffDroppedFiles: [],
      version: '1.2.3',
      previousVersion: '1.2.2',
      date: '2026-04-11',
      provider,
      remote: null,
    });

    expect(seenSystem).toBe(SYSTEM_PROMPT);
    expect(seenUser).toContain('New version: 1.2.3');
    expect(seenUser).toContain('Previous version: 1.2.2');
    expect(seenUser).toContain('diff --git a/x b/x');
    expect(notes.body).toBe('### Added\n- Generated bullet');
  });

  it('strips a heading that the AI added despite instructions', async () => {
    const provider = fakeProvider(
      () => '## [1.2.3] - 2026-04-11\n\n### Fixed\n- Some fix',
    );
    const notes = await generateReleaseNotes({
      commits: [],
      diff: '',
      diffDroppedFiles: [],
      version: '1.2.3',
      previousVersion: '1.2.2',
      date: '2026-04-11',
      provider,
      remote: null,
    });
    expect(notes.body).toBe('### Fixed\n- Some fix');
  });

  it('enriches PR links in AI output', async () => {
    const provider = fakeProvider(() => '### Fixed\n- Handle edge case #42');
    const notes = await generateReleaseNotes({
      commits: [],
      diff: '',
      diffDroppedFiles: [],
      version: '1.0.0',
      previousVersion: null,
      date: '2026-04-11',
      provider,
      remote: github,
    });
    expect(notes.body).toContain(
      '[#42](https://github.com/acme/widgets/pull/42)',
    );
  });

  it('falls back to template when AI returns empty', async () => {
    const provider = fakeProvider(() => '   ');
    const notes = await generateReleaseNotes({
      commits: [commit({ shortSha: 'aa', subject: 'feat: thing' })],
      diff: '',
      diffDroppedFiles: [],
      version: '1.0.0',
      previousVersion: null,
      date: '2026-04-11',
      provider,
      remote: null,
    });
    expect(notes.body).toContain('### Added');
    expect(notes.body).toContain('- Thing (aa)');
  });

  it('passes maxOutputTokens and temperature to the provider', async () => {
    let seenMax: number | undefined;
    let seenTemp: number | undefined;
    const provider: AIProvider = {
      name: 'anthropic',
      defaultModel: 'x',
      estimateTokens: () => 0,
      async generate(req) {
        seenMax = req.maxTokens;
        seenTemp = req.temperature;
        return { text: '### Added\n- x', inputTokens: 1, outputTokens: 1 };
      },
    };
    await generateReleaseNotes({
      commits: [],
      diff: '',
      diffDroppedFiles: [],
      version: '1.0.0',
      previousVersion: null,
      date: '2026-04-11',
      provider,
      remote: null,
      maxOutputTokens: 1234,
      temperature: 0.1,
    });
    expect(seenMax).toBe(1234);
    expect(seenTemp).toBe(0.1);
  });
});
