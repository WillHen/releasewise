# releasewise

AI-powered CLI that turns a git diff into a high-quality release — semver bump, release notes, `CHANGELOG.md`, tag, push, and GitHub Release in one command.

> Status: pre-alpha. v1 under active development.

## Quick start

```bash
# Install (coming soon)
# brew install releasewise
# or: npm install -g releasewise

releasewise init
ANTHROPIC_API_KEY=sk-... releasewise release
```

## Features (v1)

- Three commit analysis modes: `conventional`, `mixed` (default), `manual`
- Four AI providers: Anthropic (default), OpenAI, Groq, Gemini
- `CHANGELOG.md` (Keep a Changelog) or per-release files
- Auto-links `#123` / `(#456)` / `Closes #789` to PRs/issues
- GitHub Releases via `gh` CLI (REST fallback)
- First-class CI/CD mode: `--yes`, `--dry-run`, `--estimate`, `--json`
- Safe by default: never commits secrets, `releasewise undo` for pre-push rollback
- SemVer pre-releases: `--pre beta` → `1.0.0-beta.0`

## Commands

| Command                                     | Purpose                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `releasewise init`                          | Detect project, write config, update `.gitignore` |
| `releasewise release [major\|minor\|patch]` | Run the full release flow                         |
| `releasewise undo`                          | Revert the last local (unpushed) release          |
| `releasewise estimate`                      | Show token + cost estimate for the current diff   |
| `releasewise doctor`                        | Verify setup                                      |

## License

MIT
