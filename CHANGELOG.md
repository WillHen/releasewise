# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-12

### Fixed

- "Release plan (dry run)" banner and "This was a dry run…" footer no longer appear in the output when executing a real release (only in `--dry-run` mode)
- `dryRun` field in `--json` execute output now correctly reflects `false` instead of always being `true`