# releasewise

[![CI](https://github.com/WillHen/releasewise/actions/workflows/ci.yml/badge.svg)](https://github.com/WillHen/releasewise/actions/workflows/ci.yml)

AI-powered CLI that turns a git diff into a high-quality release — semver bump, release notes, `CHANGELOG.md`, tag, push, and GitHub Release in one command.

## Install

### Standalone binary (recommended)

Download the latest binary from the [GitHub Releases](https://github.com/WillHen/releasewise/releases) page:

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/WillHen/releasewise/releases/latest/download/releasewise-darwin-arm64 -o releasewise
chmod +x releasewise && sudo mv releasewise /usr/local/bin/

# macOS (Intel)
curl -fsSL https://github.com/WillHen/releasewise/releases/latest/download/releasewise-darwin-x64 -o releasewise
chmod +x releasewise && sudo mv releasewise /usr/local/bin/

# Linux (x64)
curl -fsSL https://github.com/WillHen/releasewise/releases/latest/download/releasewise-linux-x64 -o releasewise
chmod +x releasewise && sudo mv releasewise /usr/local/bin/

# Linux (ARM64)
curl -fsSL https://github.com/WillHen/releasewise/releases/latest/download/releasewise-linux-arm64 -o releasewise
chmod +x releasewise && sudo mv releasewise /usr/local/bin/
```

### npm

```bash
npm install -g releasewise
```

### From source (requires Bun >= 1.1)

```bash
git clone https://github.com/WillHen/releasewise.git
cd releasewise
bun install
bun link
```

## Quick start

```bash
# 1. Set up your API key
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Initialize config in your project
releasewise init

# 3. Preview what a release would look like (safe by default)
releasewise release

# 4. Cut a real release — pushes a tag and creates a GitHub Release
releasewise release --yes
```

## How it works

1. **Reads commits** since the last tag (or from `--from <ref>`)
2. **Detects the bump type** — `major`, `minor`, or `patch` — from commit messages and/or AI classification
3. **Generates release notes** using AI (or a template fallback with `--no-ai`)
4. **Auto-links** `#123`, `(#456)`, and `Closes #789` to GitHub PRs/issues
5. **Updates** `package.json` version and prepends to `CHANGELOG.md`
6. **Commits, tags, and pushes** the release
7. **Creates a GitHub Release** via `gh` CLI (REST API fallback)

## Commands

### `releasewise release`

The main command. Analyzes commits, bumps the version, generates notes, and ships.

By default `releasewise release` is a **preview**: it runs the AI, renders the
plan, and exits without touching your repo or remote. Pass `--yes` (alias
`--force-release`, `-y`) to actually commit, tag, push, and create the GitHub
Release. This is a safety-first default — misclassified bumps or bad notes
should be caught before they ship.

```bash
releasewise release                   # preview only, no side effects
releasewise release --yes             # execute: commit, tag, push, release
releasewise release --bump major --yes # force a major bump and release
releasewise release --json            # structured JSON preview
releasewise release --no-ai           # template fallback, no AI call
releasewise release --pre beta --yes  # pre-release: 1.0.0-beta.0
```

| Flag                               | Description                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `--bump <type>`                    | Force bump type: `major`, `minor`, or `patch`               |
| `--mode <mode>`                    | Commit analysis mode: `conventional` or `mixed`             |
| `--pre <label>`                    | Pre-release label (e.g. `beta`, `rc`)                       |
| `--from <ref>`                     | Base ref for commit range (default: last tag)               |
| `--tone <tone>`                    | Release notes tone: `formal`, `casual`, or `technical`      |
| `--yes` / `-y` / `--force-release` | Execute the release. Without it, the command only previews. |
| `--no-push`                        | Skip `git push` after tagging                               |
| `--estimate`                       | Print token/cost estimate and exit                          |
| `--json`                           | Structured JSON output                                      |
| `--no-ai`                          | Skip AI, use template-based notes                           |
| `--no-diff`                        | Send commit messages but not the diff body to the AI        |
| `--no-github-release`              | Skip GitHub Release creation                                |
| `--quiet`                          | Suppress step logs and warnings                             |
| `--verbose`                        | Verbose logging with debug detail                           |

### `releasewise init`

Creates a `.releasewise.json` config file and updates `.gitignore`.

```bash
releasewise init          # interactive setup
releasewise init --force  # overwrite existing config
```

### `releasewise undo`

Reverts the last local (unpushed) release — deletes the tag and resets the bump commit.

```bash
releasewise undo
```

If the release was already pushed, `undo` refuses and prints manual rollback instructions.

### `releasewise estimate`

Prints a token and cost estimate for the current diff without calling the AI.

```bash
releasewise estimate
releasewise estimate --json
```

### `releasewise doctor`

Verifies your setup: git repo, config valid, API key present, `gh` CLI installed, `package.json` found.

```bash
releasewise doctor
```

## Configuration

`releasewise init` writes a `.releasewise.json` to your project root:

```json
{
  "projectName": "my-app",
  "commitMode": "mixed",
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "maxDiffTokens": 8000
  },
  "changelog": {
    "format": "changelog",
    "path": "CHANGELOG.md"
  },
  "release": {
    "tagPrefix": "v",
    "commitMessage": "chore(release): v${version}",
    "pushOnRelease": true,
    "createGithubRelease": true,
    "tone": "technical"
  }
}
```

### Commit modes

| Mode              | How it works                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `conventional`    | Parses [Conventional Commits](https://www.conventionalcommits.org/) strictly. `feat` = minor, `fix` = patch, `!` or `BREAKING CHANGE:` = major. |
| `mixed` (default) | Conventional first; non-conventional commits are classified by AI.                                                                              |

### AI providers

| Provider              | Env var             | Default model             |
| --------------------- | ------------------- | ------------------------- |
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6`       |
| `openai`              | `OPENAI_API_KEY`    | `gpt-4o-mini`             |
| `groq`                | `GROQ_API_KEY`      | `llama-3.3-70b-versatile` |
| `gemini`              | `GEMINI_API_KEY`    | `gemini-2.0-flash`        |

The Anthropic default is Sonnet, not Haiku: dogfood runs found Haiku 4.5 leaks internal module names and CI bullets into release notes despite explicit prompt guidance, while Sonnet 4.6 produces clean output. The cost delta is cents per release at this workload. Override `ai.model` in `.releasewise.json` if you want a different trade-off.

### API key resolution (highest priority first)

1. `RELEASEWISE_API_KEY` env var
2. Provider-specific env var (e.g. `ANTHROPIC_API_KEY`)
3. `.releasewise.local.json` (gitignored — for local-only overrides)

Never store API keys in the committed `.releasewise.json`.

## Privacy: what gets sent to the AI provider

By default, `releasewise release` sends two things to your configured AI
provider when generating notes:

1. The list of commits in the release range — subject lines and message bodies.
2. The unified `git diff` for the release range, after lockfiles, build
   output, and oversize files are dropped to fit `ai.maxDiffTokens`.

For repos with regulated data (HIPAA, PCI), licensed third-party code, or
unpatented IP that cannot leave the organization, the diff path is the
risk. There are four ways to constrain it, from coarsest to most granular:

| Control                                                    | What it does                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-ai` / `releasewise release --no-ai`                  | Skip the AI entirely. Notes are produced from commit messages alone via the deterministic template.                                       |
| `ai.sendDiff: false` (or `--no-diff`)                      | Keep AI-generated notes, but withhold the diff body. Only commit subjects/bodies are sent. Quality depends on commit-message hygiene.     |
| `ai.redactPaths: ["src/secrets/**", "vendor/licensed/**"]` | Glob patterns whose files (and headers) are stripped from the diff before truncation, regardless of size. Other paths are still sent.     |
| `ai.baseUrl: "https://ai.internal/v1"`                     | Route the SDK to an approved private gateway / proxy / mirror instead of the public `api.<vendor>.com` endpoint. Works for all providers. |

Example `.releasewise.json` for a regulated repo that wants AI-written
notes without sending the working tree to a public LLM endpoint:

```json
{
  "ai": {
    "provider": "anthropic",
    "sendDiff": false,
    "redactPaths": ["src/customer-data/**", "vendor/licensed/**"],
    "baseUrl": "https://ai-gateway.internal/v1"
  }
}
```

The preview (`releasewise release` with no flags) shows what was withheld:

```
Diff: 12031 -> 412 tokens (truncated)
  dropped: package-lock.json
  redacted (privacy): src/customer-data/profile.ts

Warnings:
  ! 1 file(s) redacted from the AI payload by ai.redactPaths.
  ! ai.sendDiff is false — diff body withheld from the AI provider. Release notes are based on commit messages only.
```

`--no-diff` only flips an explicit `true` to `false` for that invocation;
a config-file `sendDiff: false` is sticky and cannot be re-enabled by
omitting the flag.

## CI/CD

releasewise works in non-interactive CI pipelines. `--yes` is required to
actually execute a release — CI that runs `releasewise release` without it
will only print the preview, which is usually what you want for pull-request
jobs. Reserve `--yes` for the pipeline step that is explicitly allowed to
push tags.

```yaml
# GitHub Actions example
- name: Release
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: releasewise release --yes --json
```

The `--json` flag outputs structured data for downstream pipeline steps:

```json
{
  "executed": true,
  "previousVersion": "1.2.3",
  "newVersion": "1.3.0",
  "bumpType": "minor",
  "tagName": "v1.3.0",
  "commitSha": "abc1234",
  "changelogPath": "CHANGELOG.md",
  "pushed": true,
  "githubRelease": { "url": "https://github.com/..." }
}
```

## Development

```bash
bun install
bun run dev -- release             # preview from source
bun test                           # run tests
bun run check                      # lint + format + typecheck + test
bun run build:binary               # compile standalone binary
```

## License

MIT
