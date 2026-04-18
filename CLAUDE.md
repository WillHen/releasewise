# CLAUDE.md

Guidance for Claude Code when working in this repo.

**See [`AGENTS.md`](./AGENTS.md) for the canonical agent guidance** —
commit conventions, working style, review-before-commit workflow, and
the pre-commit checklist. Everything there applies to Claude Code.

The notes below are Claude-specific and supplement (not replace) `AGENTS.md`.

## Claude-specific: staging and committing must be separate tool calls

A `PreToolUse` Bash hook (`~/.claude/hooks/review-staged.sh`) runs a
senior-lead-dev review over `git diff --cached` whenever it sees a
`git commit` command. Because the hook fires **before** the bash
command runs, it can only review content that is _already staged_.

That means: do **not** combine staging and committing into a single
tool call (e.g. `git add X && git commit ...`). If you do, at hook
time nothing is staged, the review is skipped, and the commit lands
unreviewed.

The correct sequence is two Bash calls:

1. `git add <specific files>` (stages the content — hook does not fire).
2. `git commit -m "..."` (hook fires, reviews the staged diff, feeds
   the review back into context; act on `MUST FIX` before continuing).
