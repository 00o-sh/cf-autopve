# Vendored: cloudflare/security-audit-skill

- Source: https://github.com/cloudflare/security-audit-skill (`skills/security-audit/`)
- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` ("Clarify guidance and full audit modes")
- License: MIT, see `LICENSE` in this directory.
- Local changes: none. This file and `LICENSE` were added alongside the upstream files.

The skill loads in Claude Code sessions opened on this repository. Ask for "a security audit of this
repo" to run the full workflow; security questions use its guidance mode. Full-audit reports are written
outside the repository (default `~/security-audit-skill/cf-autopve/run-<N>`), never into it.

To update, copy `skills/security-audit/` from a newer upstream commit over this directory, keep
`LICENSE` and this file, and update the commit above. Review the diff like any other code: the two
`.cjs` validators run under Node during an audit.
