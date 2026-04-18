# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, etc.) working in this repo.
This is the canonical agent-guidance file; agent-specific notes live alongside
it (e.g. `CLAUDE.md` for Claude Code).

## Project

`releasewise` — AI-powered CLI that turns a git diff into a release (semver
bump, notes, changelog, tag, push, GitHub Release). See `README.md` for
user-facing details and the v1 plan for implementation context.

## Commit conventions

**Use Conventional Commits** for every commit in this repo. This is eaten by
our own dogfood — `releasewise` parses these commits to pick bump types.

Format:

```
<type>(<optional-scope>): <subject>

<optional body>

<optional footer>
```

Allowed types:

- `feat` — new user-facing feature (→ minor bump)
- `fix` — bug fix (→ patch)
- `perf` — performance improvement (→ patch)
- `refactor` — code change that neither fixes a bug nor adds a feature (→ patch)
- `docs` — documentation only (→ patch)
- `test` — adding/fixing tests (→ patch)
- `build` — build system, deps, tooling (→ patch)
- `ci` — CI config changes (→ patch)
- `chore` — anything else that shouldn't appear in release notes prominently (→ patch)
- `style` — formatting only, no code change (→ patch)

Breaking changes:

- Append `!` before the colon: `feat(api)!: drop support for node 18`
- OR add a `BREAKING CHANGE:` footer
- Either form → **major** bump

Scopes: prefer one of `cli`, `config`, `git`, `commits`, `version`, `ai`,
`changelog`, `github`, `notes`, `undo`, `docs`, `tests`, `build`. Omit the
scope if the change spans several.

Subject line:

- Imperative mood ("add", not "added" / "adds")
- Lowercase first letter
- No trailing period
- ≤ 72 characters

Examples:

```
feat(config): add Zod schema for .releasewise.json
fix(commits): treat feat! as major bump
refactor(ai)!: switch provider interface to per-SDK adapters
docs: clarify --dry-run vs --estimate in README
```

## Working style

- Implement the v1 plan step-by-step; pause between numbered steps for user review.
- Keep each commit focused on one logical change. Prefer multiple small
  commits over one giant one — easier to review and easier to revert.
- Never leave the repo in a broken state between commits: every commit
  should build and the tests that existed before the commit should still pass.
- Do not commit secrets. `.releasewise.local.json` and anything under
  `.releasewise/` are already in `.gitignore`.

## Review-before-commit workflow

**Never commit without an explicit user review of the staged changes.**
The loop is:

1. Write / edit files.
2. Run `bun run check` to confirm the tree is green.
3. **Stop and summarize what changed**, then wait for the user to review
   (they may read the diff, ask questions, or request edits).
4. Only after the user says to proceed: `git commit` and `git push`.

This applies to every commit, including docs-only and CI-only changes.
If a change is split across several logical commits, pause for review
before each one — don't batch them.

Stage files in a separate tool call from the `git commit` itself. Some
agents (see `CLAUDE.md`) have `PreToolUse` hooks that review
`git diff --cached` when a `git commit` command is detected, and those
hooks can only see what is already staged. Combining `git add X && git
commit ...` in one call bypasses that review.

## Pre-commit checklist

**Always run `bun run check` before every commit.** This runs, in order:

1. `bun run lint` — ESLint over `src/` and `tests/`
2. `bun run format:check` — Prettier in check mode
3. `bun run typecheck` — `tsc --noEmit`
4. `bun test` — full unit + integration test suite

If any step fails, fix the issue before committing. Never use `--no-verify`
to skip hooks, and never commit with failing or skipped tests. Auto-fixable
problems can be resolved with:

```
bun run lint:fix    # ESLint auto-fix
bun run format      # Prettier write
```

If you're touching code covered by tests, run `bun test` directly as you
iterate — it's much faster than the full `check` pipeline and gives
focused feedback. Run `bun run check` as the last thing before you
actually commit.

Reminder: **linting, formatting, and tests apply to source code only,
never to commit messages.** Commit messages follow the Conventional
Commits rules documented above and are enforced by review, not tooling.

## Tooling

- Runtime: **Bun** (≥ 1.3, per `engines.bun` in `package.json`).
- CLI framework: **citty**
- Validation: **Zod**
- Tests: **bun test**
- Language: TypeScript (strict), ESM, `.ts` imports via `allowImportingTsExtensions`
