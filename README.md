# @immediately-run/verify-checks

Deterministic quality checks shared by the immediately.run core repos
(landing-page, sdk, sandbox, site-main, backend), consumed as an ordinary
pinned dependency and driven by each repo's ten-line `scripts/check-*.mjs`
wrapper.

Six checks, one ratchet:

| check | producer | baseline fingerprint |
|---|---|---|
| `check-clones` | jscpd (JSON reporter) | sha256-16 of the clone's `fragment` text |
| `check-unused` | knip (JSON reporter) | `file:name` across knip's `files`/`exports`/`types`/`dependencies`; `file:(file)` for `files` |
| `check-untested` | git (merge-base diff + trailers) | failing file path (not baselined) |
| `check-dead-css` | selector scan vs source usage | `file:.selector` string |
| `check-tokens` | postcss + postcss-value-parser declaration walk; lexical `var()` scan of sources | `undeclared\|file\|--name` for a `var()` no scanned CSS declares (a fallback does not excuse it); `literal\|file\|selector\|property\|literal` for a colour literal outside a custom-property declaration; `stale-allow\|--name` for a rotten allow entry |
| `check-sweep` (`./sweep`) | pure geometry judges over a `LayoutSnapshot` collected in the consumer's browser | `overflow-x\|route\|vp`; `offscreen\|route\|vp\|control`; `occluded\|route\|vp\|control`; `target-small\|route\|vp\|control`; `wrapped\|route\|vp\|control`; `overlay-offscreen\|route\|vp\|trigger`; `overlay-clipped\|route\|vp\|trigger`; `overlay-detached\|route\|vp\|trigger`; `empty\|route\|vp\|controls` and `overlay-missing\|route\|vp\|trigger` so a broken selector turns red |

Baselines are **fingerprint sets, not counts**, and they only shrink: a found
fingerprint missing from the baseline fails the check; a baseline entry that
no longer matches anything fails it too, naming the entry. `--write-baseline`
exists only for the first commit and refuses to run when the file already
exists — a regenerated golden asserts nothing.

Nothing here renders, fetches, or needs a browser; every check fails loudly
naming what it could not determine (a missing `origin/main`, a missing tool,
an unreadable baseline) rather than passing. The sweep module is the one
exception in shape, not in spirit: it never launches a browser itself — it
hands a self-contained collector function to the consumer's browser
(`page.evaluate`) and judges the plain data that comes back.
