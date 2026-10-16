# @immediately-run/verify-checks

Deterministic quality checks shared by the immediately.run core repos
(landing-page, sdk, sandbox, site-main, backend), consumed as an ordinary
pinned dependency and driven by each repo's ten-line `scripts/check-*.mjs`
wrapper.

Eight checks, one ratchet, one registry:

| check | producer | baseline fingerprint |
|---|---|---|
| `check-clones` | jscpd (JSON reporter) | sha256-16 of the clone's `fragment` text |
| `check-unused` | knip (JSON reporter) | `file:name` across knip's `files`/`exports`/`types`/`dependencies`; `file:(file)` for `files` |
| `check-untested` | git (merge-base diff + trailers); coverage mode: changed-line ranges ∩ the test run's lcov/istanbul report | name mode: failing file path (not baselined); coverage mode: one uncovered-executable-line count per file in `verify-baselines/untested.json` (`"unloaded"` for a file the test run never loads) — the one baseline here that is a count, see below |
| `check-dead-css` | selector scan vs source usage | `file:.selector` string |
| `check-tokens` | postcss + postcss-value-parser declaration walk; lexical `var()` scan of sources | `undeclared\|file\|--name` for a `var()` no scanned CSS declares (a fallback does not excuse it); `literal\|file\|selector\|property\|literal` for a colour literal outside a custom-property declaration; `stale-allow\|--name` for a rotten allow entry |
| `check-sweep` (`./sweep`) | pure geometry judges over a `LayoutSnapshot` collected in the consumer's browser | `overflow-x\|route\|vp`; `offscreen\|route\|vp\|control`; `occluded\|route\|vp\|control`; `target-small\|route\|vp\|control`; `wrapped\|route\|vp\|control`; `overlay-offscreen\|route\|vp\|trigger`; `overlay-clipped\|route\|vp\|trigger`; `overlay-detached\|route\|vp\|trigger`; `empty\|route\|vp\|controls` and `overlay-missing\|route\|vp\|trigger` so a broken selector turns red |
| `check-comment-refs` (`./comment-refs`) | TypeScript scanner (`skipTrivia: false`, with the parser's template-substitution re-scan reimplemented) for comment ranges + an AST walk (`ts.isIdentifier`) for the code's identifier set | `file\|span` for a backticked span in a comment that names no existing path/identifier; `stale-allow\|name` for an allow entry no comment cites |
| `check-invariants` (`./invariants`, R3-1170) | the invariant registry at `invariants/registry.json`: one entry per invariant, parsed sources (TypeScript AST for `src/**`, postcss + postcss-value-parser for CSS, the `yaml` package for workflows), self-test fixtures re-proved on every run | `${id}\|file\|detail` (sha256-16) per finding, ratcheted against `verify-baselines/invariants.json`; REGISTRY defects (scope rot, failed self-tests) are never baselined |

`check-untested`'s coverage mode (opted-in repos) asks the question the name
check cannot: are the CHANGED lines executed by the test run? The consumer's
wrapper runs its own suite with the runner's coverage flag (`node --test
--enable-source-maps --experimental-test-coverage --test-reporter=lcov`;
jest/vitest's json report), then calls `checkUntestedCoverage`. A changed
logic file whose uncovered-line count exceeds its baseline entry, and that no
trailer declares, is the finding. The
`Untested:` trailer survives verbatim, with a tightened meaning: the reason
must say why *coverage* is the wrong instrument for the file (self-testing
scripts, declarative files, operator-session-only paths) — never "tested
elsewhere".

Its baseline is `{ "format": "uncovered-lines-per-file/1", "files": { "<path>":
<count> } }`. A changed logic file is NEW when its uncovered-executable line
count exceeds the recorded one (zero with no entry), and an entry is STALE
when the count dropped, the file is gone, or it left the logic paths — the
message names the number to write. It stores no line numbers on purpose: the
line-range format before 0.10.0 went STALE whenever a line was inserted above
a recorded gap, a comment included. The price is that lines inside one file
can trade, which a fingerprint set would catch and a count cannot. A file
absent from the report is recorded as `"unloaded"`: its changes are not
measured (the check prints a note) until a test loads it, which turns the
entry STALE. A renamed file's entry moves by hand to the new path. NEW is
asked only of files the branch changed: a count that rose with its file
untouched (a test removed, or growth under an `Untested:` trailer) meets the
next branch that edits the file. On node's own lcov report every line has a
record, so a comment or blank line added inside a block that never ran counts
as one more uncovered line; a wrapper on that runner should rewrite the report
to statement lines first, or expect such an edit to be NEW. A
line-range baseline from 0.9 or earlier is refused, never reinterpreted —
re-seed with `rm verify-baselines/untested.json && npm run check:untested --
--write-baseline`.

Every other baseline is a **fingerprint set, not a count**, and they only shrink: a found
fingerprint missing from the baseline fails the check; a baseline entry that
no longer matches anything fails it too, naming the entry. `--write-baseline`
exists only for the first commit and refuses to run when the file already
exists — a regenerated golden asserts nothing.

## The invariant registry (R3-1170)

An invariant is a statement that holds across a scope, with its sources and
its enforcement: a **self-tested check** (code in `src/invariants/<id>.mjs`
with `violating`/`clean` fixtures under `test/invariants/<id>/` that the
runner re-proves on every run — a broken check can never pass silently) or a
**review-enforced line** (no code; R3-1173 serves those to reviewers). The
registry lives at `invariants/registry.json`, one entry per invariant:

```
{ "id": "app-no-web-storage",
  "statement": "…≤300 chars…",
  "sources": ["R3-315", "escape-classification E01", "findings-log 2026-09-15", "grove/CLAUDE.md Hard rules 8"],
  "scope": { "repos": "core"|"apps"|"all"|[names], "paths": ["src/**"] },
  "enforcement": "check"|"review", "class?": "defect-class slug", "added": "2026-10-16" }
```

`sources` are validated (item ids, docs paths, escape-classification records
and findings-log dates against a sibling docs checkout when one exists; a
repo file against the sibling repo) and an entry without sources is refused.
`core` is the five core repos by name; `apps` is any repo whose root
`package.json` has an `immediately.run` key or that has `src/App.tsx`; `all`
is every repo. An in-scope entry whose `paths` match no file is a REGISTRY
finding — scope rot is a registry defect, never baseline debt. The four
initial checks are the app hard rules (`app-no-web-storage`,
`app-main-tsx-inert`, `app-no-remote-css-import`) and
`workflow-secret-pair-gated-together` (the 44-row `cache.yml` escape,
whose violating fixture is the real pre-fix `cache.yml` cited in its README);
the `det-repo` escape records are seeded as `review` entries. R3-1171 runs
the registry fleet-wide; R3-1173 builds reviewer context packs from it.

Nothing here renders, fetches, or needs a browser; every check fails loudly
naming what it could not determine (a missing `origin/main`, a missing tool,
an unreadable baseline) rather than passing. The sweep module is the one
exception in shape, not in spirit: it never launches a browser itself — it
hands a self-contained collector function to the consumer's browser
(`page.evaluate`) and judges the plain data that comes back.
