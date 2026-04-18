# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-04-18

### Fixed

- `releasewise --version` reported the version baked in at build time rather than the installed version; the CLI now reads `package.json` at runtime so the correct version is always shown

## [0.3.1] - 2026-04-18

### Fixed

- On a repo with no prior tag, the root commit was silently excluded from the commit list and diff, causing single-commit repos to throw "No commits in range" and multi-commit first releases to classify and generate changelogs without the root commit's contents
- GitHub tokens echoed by `gh` from the user's keychain, truncated token copies, and fine-grained PATs (`github_pat_`) were not redacted from error output when a release failed

## [0.3.0] - 2026-04-15

### Changed

- `releasewise release` now previews by default — it runs the AI, renders the plan, and exits without touching your repo or remote; pass `--yes` (alias `--force-release`, `-y`) to actually commit, tag, push, and create the GitHub Release
- `--dry-run` flag is removed; the default command behavior replaces it
- CI pipelines that relied on non-TTY auto-confirm must now pass `--yes` explicitly to execute a release

### Fixed

- Auto-detected `major` bumps on pre-1.0 (`0.x.y`) projects are silently downgraded to `minor` to prevent accidentally shipping `1.0.0`; a warning is surfaced pointing at `--bump major` as the graduation escape hatch
- Classifier no longer silently falls back to `patch` on AI batch failure — it retries once with backoff and then throws an error carrying the unclassified SHAs, so a breaking change can no longer be hidden as a patch release

## [0.2.1] - 2026-04-14

### Fixed

- AI classification silently falling back to "patch" for all unrecognized commits when a repo had 20+ non-conventional commits — the AI call is now split into batches of 20 so the JSON response is never truncated mid-stream
- A failed AI classification batch poisoning unrelated commits — each batch now fails independently, leaving other batches' results intact
- Truncated AI responses that open a ` ```json ` fence but are cut off before the closing fence now parse correctly instead of being discarded

## [0.2.0] - 2026-04-13

### Fixed

- `releasewise undo` now errors with a clear message instead of silently reporting success when the transaction log is missing `bumpCommitSha`
- `releasewise undo` now detects root-commit releases before touching anything and prints a manual-recovery recipe instead of leaving the working tree in an unclear state
- `releasewise doctor` now correctly detects git worktrees (where `.git` is a pointer file rather than a directory) instead of reporting "Not a git repository"
- GitHub release failures now surface the actual error and a manual-retry command instead of falling through to a misleading "skipped: gh not available and no token" message
- Auth tokens are redacted from any GitHub release error message shown in the CLI summary
- Tag names, ref names, remote names, and ref-range endpoints that begin with `-` are now rejected before being passed to git or gh, preventing them from being interpreted as flags

## [0.1.1] - 2026-04-12

### Fixed

- "Release plan (dry run)" banner and "This was a dry run…" footer no longer appear in the output when executing a real release (only in `--dry-run` mode)
- `dryRun` field in `--json` execute output now correctly reflects `false` instead of always being `true`