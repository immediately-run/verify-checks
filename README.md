# @immediately-run/verify-checks

Deterministic quality checks shared by the immediately.run core repos
(landing-page, sdk, sandbox, site-main, backend), consumed as an ordinary
pinned dependency and driven by each repo's ten-line `scripts/check-*.mjs`
wrapper.

Seven checks, one ratchet:

| check | producer | baseline fingerprint |
|---|---|---|
| `check-clones` | jscpd (JSON reporter) | sha256-16 of the clone's `fragment` text |
| `check-unused` | knip (JSON reporter) | `file:name` across knip's `files`/`exports`/`types`/`dependencies`; `file:(file)` for `files` |
| `check-untested` | git (merge-base diff + trailers); coverage mode: changed-line ranges ∩ the test run's lcov/istanbul report | name mode: failing file path (not baselined); coverage mode: `file\|start-end` line ranges in `verify-baselines/untested.json`, matched by line membership, re-checked for staleness when the file is touched |
| `check-dead-css` | selector scan vs source usage | `file:.selector` string |
| `check-tokens` | postcss + postcss-value-parser declaration walk; lexical `var()` scan of sources | `undeclared\|file\|--name` for a `var()` no scanned CSS declares (a fallback does not excuse it); `literal\|file\|selector\|property\|literal` for a colour literal outside a custom-property declaration; `stale-allow\|--name` for a rotten allow entry |
| `check-sweep` (`./sweep`) | pure geometry judges over a `LayoutSnapshot` collected in the consumer's browser | `overflow-x\|route\|vp`; `offscreen\|route\|vp\|control`; `occluded\|route\|vp\|control`; `target-small\|route\|vp\|control`; `wrapped\|route\|vp\|control`; `overlay-offscreen\|route\|vp\|trigger`; `overlay-clipped\|route\|vp\|trigger`; `overlay-detached\|route\|vp\|trigger`; `empty\|route\|vp\|controls` and `overlay-missing\|route\|vp\|trigger` so a broken selector turns red |
| `check-comment-refs` (`./comment-refs`) | TypeScript scanner (`skipTrivia: false`, with the parser's template-substitution re-scan reimplemented) for comment ranges + an AST walk (`ts.isIdentifier`) for the code's identifier set | `file\|span` for a backticked span in a comment that names no existing path/identifier; `stale-allow\|name` for an allow entry no comment cites |

`check-untested`'s coverage mode (opted-in repos) asks the question the name
check cannot: are the CHANGED lines executed by the test run? The consumer's
wrapper runs its own suite with the runner's coverage flag (`node --test
--enable-source-maps --experimental-test-coverage --test-reporter=lcov`;
jest/vitest's json report), then calls `checkUntestedCoverage`. A changed line
neither executed nor trailer-declared nor baseline-allowed is the finding. The
`Untested:` trailer survives verbatim, with a tightened meaning: the reason
must say why *coverage* is the wrong instrument for the file (self-testing
scripts, declarative files, operator-session-only paths) — never "tested
elsewhere".

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
