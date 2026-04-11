# CLAUDE.md

Guidance for Claude Code when working in this repo.

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

## Tooling

- Runtime: **Bun** (≥ 1.1). `bun` is not yet installed on this machine; scaffold files are written by hand until it is.
- CLI framework: **citty**
- Validation: **Zod**
- Tests: **bun test**
- Language: TypeScript (strict), ESM, `.ts` imports via `allowImportingTsExtensions`
