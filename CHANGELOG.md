# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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