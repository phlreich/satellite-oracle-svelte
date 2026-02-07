# Notes Maintenance Protocol

Last Updated: 2026-02-07

## Commit Gate
Before finalizing a commit:
1. Update `00-current-truth.md` (`What Works Now`, max 5 bullets).
2. Set `Head Commit` in `00-current-truth.md` from `git rev-parse --short HEAD`.
3. Sync `notes/INDEX.md` status snapshot commit to the same `HEAD`.
4. Add one entry in `05-change-log.md`.
5. Add one risk line in `04-known-issues.md` if behavior changed.
6. Add at least one concrete engineering learning to `08-working-notes.md`.

## Writing Rules
- Prefer short, stable facts.
- Keep one sentence per bullet.
- Avoid duplicates; point to canonical file.
- Record uncertainty explicitly when needed.
