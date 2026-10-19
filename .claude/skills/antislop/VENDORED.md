# Vendored: miqdadbadjuber/anti-slop

- Source: https://github.com/miqdadbadjuber/anti-slop (`skills/`)
- Commit: `439a2ef5b9dd0ebe74e8113ff43f5928d0fe2a6a`, release 3.2.21 (see `VERSION`)
- License: MIT, see `LICENSE` in this directory. It covers all six antislop skill folders.
- Skills: `antislop` (core), `antislop-code`, `antislop-ui`, `antislop-copywriting`,
  `antislop-layoutmobile`, `antislop-human`.
- Local changes: none. This file and `LICENSE` were added alongside the upstream files.

Claude Code loads these from `.claude/skills/` by their descriptions, so the core's first-run wizard
and its `CLAUDE.md` pointer block are not needed here. The core asks once per session whether to apply
the rules during work or as an audit afterwards.

To update, copy the six `skills/antislop*` folders from a newer upstream release over these, keep
`LICENSE` and this file, and update the commit above. `antislop-human/contrast-check.py` and
`contrast-mcp.py` are run by the agent under Python: review their diff on every update.
