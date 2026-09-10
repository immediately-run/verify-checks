import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
    const args = [
      '--no-install',
      'jscpd',
      ...patterns,
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
  return run('git', ['diff', '--name-only', '--diff-filter=ACMRT', `${mb}..HEAD`], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
  return run('git', ['ls-files', '*.test.*', '*.spec.*'], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
