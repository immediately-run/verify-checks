# @immediately-run/verify-checks

Deterministic quality checks shared by the immediately.run core repos
(landing-page, sdk, sandbox, site-main, backend), consumed as an ordinary
pinned dependency and driven by each repo's ten-line `scripts/check-*.mjs`
wrapper.

Four checks, one ratchet:

| check | producer | baseline fingerprint |
|---|---|---|
| `check-clones` | jscpd (JSON reporter) | sha256-16 of the clone's `fragment` text |
| `check-unused` | knip (JSON reporter) | `file:export` string |
| `check-untested` | git (merge-base diff + trailers) | failing file path (not baselined) |
| `check-dead-css` | selector scan vs source usage | `file:.selector` string |

Baselines are **fingerprint sets, not counts**, and they only shrink: a found
fingerprint missing from the baseline fails the check; a baseline entry that
no longer matches anything fails it too, naming the entry. `--write-baseline`
exists only for the first commit and refuses to run when the file already
exists — a regenerated golden asserts nothing.

Nothing here renders, fetches, or needs a browser; every check fails loudly
naming what it could not determine (a missing `origin/main`, a missing tool,
an unreadable baseline) rather than passing.
