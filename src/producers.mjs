import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(cmd, args, cwd, { maxBuffer = 1024 * 1024 } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err.code === 'ENOBUFS') {
      throw new Error(`${cmd} ${args[0]} output exceeded the ${maxBuffer}-byte maxBuffer — split the call or raise the bound`)
    }
    throw err
  }
}

function toolMissing(err) {
  const text = `${err.message} ${err.stderr ?? ''}`
  return /not found|could not resolve|not installed|canceled due to missing packages|no yes option/i.test(text)
}

// jscpd writes its JSON reporter output as jscpd-report.json under the
// --output directory (html/ sits beside it when the html reporter is on; we
// never turn it on). Verified against jscpd 5.x, and exercised by the fixture
// test in test/baseline.test.ts, which runs the real CLI.
function readJscpdReport(outDir) {
  for (const name of ['jscpd-report.json', 'report.json']) {
    const direct = join(outDir, name)
    if (fileReadable(direct)) return JSON.parse(readFileSync(direct, 'utf8'))
  }
  for (const entry of readdirSync(outDir)) {
    for (const name of ['jscpd-report.json', 'report.json']) {
      const nested = join(outDir, entry, name)
      if (fileReadable(nested)) return JSON.parse(readFileSync(nested, 'utf8'))
    }
  }
  throw new Error(`jscpd produced no jscpd-report.json under ${outDir}`)
}

function fileReadable(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

export function runJscpd({ patterns, ignore = [], minLines = 6, minTokens = 50, cwd = process.cwd() }) {
  const outDir = mkdtempSync(join(tmpdir(), 'verify-checks-jscpd-'))
  try {
    // R3-674: patterns go through -p/--pattern, NOT positionally — jscpd 5.x
    // treats positional arguments as literal PATHS, so a glob scanned zero
    // files and check:clones passed vacuously in every consumer. (A bare
    // directory positional happens to work — which is exactly why the old
    // fixture test, which passed one, never saw this.)
    const args = [
      '--no-install',
      'jscpd',
      ...patterns.flatMap((pattern) => ['--pattern', pattern]),
      '--reporters',
      'json',
      '--output',
      outDir,
      '--min-lines',
      String(minLines),
      '--min-tokens',
      String(minTokens),
      '--silent',
    ]
    if (ignore.length > 0) args.push('--ignore', ignore.join(','))
    try {
      run('npx', args, cwd)
    } catch (err) {
      if (toolMissing(err)) {
        throw new Error('jscpd is required but not installed. It is a dependency of @immediately-run/verify-checks — run: npm install')
      }
      throw new Error(`jscpd failed: ${err.message}\n${err.stderr ?? ''}`)
    }
    return readJscpdReport(outDir)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

export function cloneFragments(report) {
  return (report.duplicates ?? []).map((dup) => dup.fragment)
}

export function runKnip({ cwd = process.cwd() }) {
  // knip exits non-zero whenever it finds issues (its exit code IS a finding
  // signal), with the full JSON report on stdout. execFileSync throws on that
  // exit code carrying err.stdout, so both paths below converge on the parse.
  const args = ['--no-install', 'knip', '--reporter', 'json', '--no-progress']
  let raw
  try {
    raw = run('npx', args, cwd)
  } catch (err) {
    if (typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
      raw = err.stdout
    } else if (toolMissing(err)) {
      throw new Error('knip is required but not installed. It is a dependency of @immediately-run/verify-checks — run: npm install')
    } else {
      throw new Error(`knip failed: ${err.message}\n${err.stderr ?? ''}`)
    }
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`knip stdout was not JSON: ${err.message}`)
  }
}

// The knip issue classes this check baselines.
//
// One list, walked once, rather than a loop per class: reading only `files` and `exports`
// silently discarded the other two classes knip reported — 15 unused exported types and one
// unused dependency in `immediately-run-backend` alone, none of which any baseline recorded
// and none of which `verify` could fail on (R3-572). A fifth class should be one array entry,
// not a fifth loop someone forgets to add.
//
// Measured with knip 6.34.0 today: `immediately-run-backend` emits exactly these four, but the
// repo set as a whole emits more — `site-main` alone reports 123 `unlisted` and 42
// `duplicates`, and `sdk`, `sandbox` and `landing-page` each report `devDependencies`. So the
// exclusions below are decisions, not an absence:
//
//   * `devDependencies` — a devDependency unused in *source* is routine (a CLI invoked from a
//     script), so baselining it produces a list nobody trims;
//   * `unlisted` — fires on these repos' own workspace layout;
//   * `duplicates`, `cycles` — knip's JSON reporter pushes arrays of symbols for these, not
//     `{name}` objects (see its `initRow`), so they would need their own rendering rather than
//     a place in this list. The guard below is what stops that being discovered in a baseline;
//   * `unresolved`, `binaries`, `enumMembers`, `namespaceMembers`, `catalog`,
//     `catalogReferences`, `nsExports`, `nsTypes`, `optionalPeerDependencies` — not yet argued
//     either way, and adding one is a deliberate edit here rather than a silent widening.
//
// That is all thirteen `initRow()` emits and this list does not.
//
// Exported so a test can assert the membership rather than re-deriving it from the same names.
export const FINGERPRINTED_CLASSES = ['files', 'exports', 'types', 'dependencies']

// knip 6's JSON reporter emits a flat array of per-file issue objects, each with one key per
// issue class. Every class here carries a `.name`, `files` included — its name is the file
// path. `files` is nonetheless rendered `<file>:(file)` because that is the fingerprint the
// consuming baselines already contain — 59 entries across four of the five repos
// (landing-page's is empty) — and changing it would orphan every one of them.
export function knipFingerprints(report) {
  const out = []
  for (const entry of report.issues ?? []) {
    if (!entry || typeof entry.file !== 'string') continue
    for (const cls of FINGERPRINTED_CLASSES) {
      for (const issue of entry[cls] ?? []) {
        if (cls === 'files') {
          out.push(`${entry.file}:(file)`)
          continue
        }
        // Loudly, not `:undefined`. A class whose entries are not `{name}` objects would
        // otherwise write an unmatched fingerprint into a committed baseline, where it can
        // never be diffed away — the exact silent-failure shape `ratchet` exists to avoid.
        if (typeof issue?.name !== 'string') {
          throw new Error(
            `knipFingerprints: knip's "${cls}" entry for ${entry.file} has no string .name ` +
              `(got ${JSON.stringify(issue)}). That class needs its own rendering, not a place ` +
              `in FINGERPRINTED_CLASSES.`,
          )
        }
        out.push(`${entry.file}:${issue.name}`)
      }
    }
  }
  return out
}

export function mergeBase(base, cwd = process.cwd()) {
  try {
    return run('git', ['merge-base', 'HEAD', base], cwd).trim()
  } catch {
    throw new Error(`cannot resolve ${base} — run: git fetch origin ${base.replace(/^origin\//, '')}`)
  }
}

export function changedSince(base, cwd = process.cwd()) {
  const mb = mergeBase(base, cwd)
  // ACMRT excludes D: a deleted logic file must not be demanded a sibling
  // test — complete deletion (logic AND test gone together) is the shape the
  // repos' review asks for, and listing deleted paths would push the opposite.
  // -z: NUL-terminated and UNQUOTED — newline output C-quotes non-ASCII paths
  // ("lib/caf\303\251.js"), which then fail every downstream path compare.
  return run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRT', `${mb}..HEAD`], cwd)
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean)
}

// Git's C-style path quoting (core.quotePath), reversed: "\"b/lib/caf\\303\\251.js\""
// → "lib/café.js". The +++ headers of a patch quote non-ASCII paths this way
// and append a TAB after space-bearing names; both are handled by the caller
// (parseUnifiedDiffRanges) before this runs.
export function unquoteGitPath(raw) {
  let path = raw
  if (path.startsWith('"')) {
    const body = path.slice(1, path.lastIndexOf('"'))
    const bytes = []
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== '\\') {
        bytes.push(...Buffer.from(body[i], 'utf8'))
        continue
      }
      const next = body[i + 1]
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
        i += 3
      } else {
        const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[next]
        if (simple === undefined) throw new Error(`unquoteGitPath: unknown escape \\${next} in ${raw}`)
        bytes.push(...Buffer.from(simple, 'utf8'))
        i += 1
      }
    }
    path = Buffer.from(bytes).toString('utf8')
  }
  return path
}

export function commitTrailers(base, cwd = process.cwd()) {
  const mb = mergeBase(base, cwd)
  const bodies = run('git', ['log', `${mb}..HEAD`, '--format=%B'], cwd)
  const trailers = []
  for (const line of bodies.split('\n')) {
    const match = line.match(/^Untested:\s+(\S+)\s+(?:—|--)\s+(.+)$/)
    if (match) trailers.push({ file: match[1], reason: match[2].trim() })
  }
  return trailers
}

export function trackedTestFiles(cwd = process.cwd()) {
  // -z, as in changedSince: NUL-terminated and unquoted.
  return run('git', ['ls-files', '-z', '*.test.*', '*.spec.*'], cwd)
    .split('\0')
    .map((line) => line.trim())
    .filter(Boolean)
}

// The new-side line ranges of every changed file, parsed from ONE
// `git diff --unified=0 <merge-base>..HEAD` over the changed set — a
// diff-header parse over a wire format git guarantees (R12 governs parsing
// SOURCE, not plumbing output). `+++ b/<path>` opens a file's hunks; each
// `@@ -a[,b] +c[,d] @@` contributes the half-open range [c, c+d); d === 0 is
// a pure deletion and contributes nothing. Adjacent or overlapping ranges
// (git emits disjoint hunks, but hand-made or --inter-hunk-context diffs may
// adjoin) are merged so downstream digests are stable.
export function parseUnifiedDiffRanges(diffText) {
  const byFile = new Map()
  let current = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      // git appends a TAB after a space-bearing path in this header, and
      // C-quotes non-ASCII paths ("b/lib/caf\303\251.js") — patch output has
      // no -z form, so both are reversed here.
      const raw = line.slice(4).split('\t')[0]
      const unquoted = unquoteGitPath(raw)
      current = unquoted.startsWith('b/') ? unquoted.slice(2) : null
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!hunk || !current) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (count === 0) continue
    const ranges = byFile.get(current) ?? []
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], start + count)
    else ranges.push([start, start + count])
    byFile.set(current, ranges)
  }
  return byFile
}

export function changedLineRanges(base, files, cwd = process.cwd()) {
  const mb = mergeBase(base, cwd)
  if (files.length === 0) return new Map()
  // One diff over the whole changed set — the output scales with the PR, so
  // the buffer is explicit (64 MiB) and an overflow names the bound.
  const diff = run('git', ['diff', '--unified=0', `${mb}..HEAD`, '--', ...files], cwd, {
    maxBuffer: 64 * 1024 * 1024,
  })
  return parseUnifiedDiffRanges(diff)
}
