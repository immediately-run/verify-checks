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

// knip 6's JSON reporter emits a flat array of per-file issue objects, each
// with one key per issue class; `files` and `exports` are the two classes this
// check baselines (dependencies are out of scope — the repos have their own
// pin checks). Verified against knip 6.34.0's real output on this repo.
export function knipFingerprints(report) {
  const out = []
  for (const entry of report.issues ?? []) {
    if (!entry || typeof entry.file !== 'string') continue
    for (const issue of entry.files ?? []) out.push(`${entry.file}:(file)`)
    for (const issue of entry.exports ?? []) out.push(`${entry.file}:${issue.name}`)
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
