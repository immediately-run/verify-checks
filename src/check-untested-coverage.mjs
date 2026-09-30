import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { diffAgainstBaseline, fingerprint, readBaseline, writeBaselineFile } from './baseline.mjs'
import { readCoverageReport } from './coverage.mjs'
import { changedLineRanges, changedSince, commitTrailers } from './producers.mjs'
import { IS_TEST_FILE, matchesAny } from './untested-core.mjs'

// check:untested, coverage mode (R3-580; plans/untested-coverage). The name
// check asked "does a file with the same stem exist?"; this asks "are the
// CHANGED lines executed by the test run?" — the only signal that catches
// backend #59 (a sibling test that drove everything except the changed hunk).
//
// Finding = new-side lines of a changed logic file ∩ not executed by the
// coverage report − trailer-declared − baseline-allowed. The fingerprint is
// `file|digest(line-ranges)` (the knipFingerprints idiom): a stable digest, so
// an unrelated edit above a gap does not churn the baseline. The ratchet's
// stale check is SCOPED to the files this run changed — a baseline entry for
// a file this PR did not touch is not stale, it is just not in play.

export function uncoveredRangesByFile({ files, rangesByFile, coveredByFile, trailers = [], logicPaths }) {
  const trailerByFile = new Map(trailers.map((trailer) => [trailer.file, trailer.reason]))
  const gaps = []
  const declared = []
  for (const file of files) {
    if (IS_TEST_FILE.test(file)) continue
    if (!matchesAny(file, logicPaths)) continue
    const reason = trailerByFile.get(file)
    if (reason !== undefined) {
      declared.push({ file, reason })
      continue
    }
    const ranges = rangesByFile.get(file) ?? []
    if (ranges.length === 0) continue // a pure deletion or mode change has no lines to cover
    const covered = coveredByFile.get(file) ?? new Set()
    const uncovered = []
    for (const [start, end] of ranges) {
      let run = null
      for (let line = start; line < end; line += 1) {
        if (!covered.has(line)) {
          run = run ?? [line, line + 1]
          run[1] = line + 1
        } else if (run) {
          uncovered.push(run)
          run = null
        }
      }
      if (run) uncovered.push(run)
    }
    if (uncovered.length > 0) gaps.push({ file, ranges: uncovered })
  }
  gaps.sort((a, b) => a.file.localeCompare(b.file))
  declared.sort((a, b) => a.file.localeCompare(b.file))
  return { gaps, declared }
}

export function coverageFingerprint({ file, ranges }) {
  const text = ranges.map(([start, end]) => `${start}-${end}`).join(',')
  return `${file}|${fingerprint(text)}`
}

export function checkUntestedCoverage({
  base = 'origin/main',
  logicPaths,
  coverageReportPath,
  baselinePath,
  cwd = process.cwd(),
  argv = process.argv.slice(2),
} = {}) {
  if (!logicPaths) {
    throw new Error(
      'check-untested-coverage: logicPaths is required (e.g. { include: ["src/lib/**", "scripts/**"] })',
    )
  }
  if (!coverageReportPath) {
    throw new Error('check-untested-coverage: coverageReportPath is required — coverage mode reads a real report')
  }
  if (!baselinePath) {
    throw new Error(
      'check-untested-coverage: baselinePath is required (e.g. "verify-baselines/untested.json") — ' +
        'coverage mode is ratcheted so day-one gaps cannot block every PR',
    )
  }
  const changed = changedSince(base, cwd)
  const trailers = commitTrailers(base, cwd)
  const coveredByFile = readCoverageReport(coverageReportPath, { cwd })
  const rangesByFile = new Map(changed.map((file) => [file, changedLineRanges(base, file, cwd)]))
  const { gaps, declared } = uncoveredRangesByFile({
    files: changed,
    rangesByFile,
    coveredByFile,
    trailers,
    logicPaths,
  })
  for (const entry of declared) {
    console.log(`untested: ${entry.file} — declared: ${entry.reason}`)
  }
  for (const gap of gaps) {
    console.error(
      `untested: ${gap.file} — changed lines not executed by the test run: ` +
        gap.ranges.map(([start, end]) => (end === start + 1 ? `${start}` : `${start}-${end - 1}`)).join(', '),
    )
  }
  const findings = gaps.map(coverageFingerprint)
  const resolvedBaseline = resolve(cwd, baselinePath)
  if (argv.includes('--write-baseline')) {
    if (existsSync(resolvedBaseline)) {
      console.error(
        `untested: refusing to overwrite ${baselinePath} — a baseline file already exists there. ` +
          'Baselines only shrink: fix the findings, or delete the stale entries by hand and let the check confirm.',
      )
      process.exitCode = 1
      return
    }
    writeBaselineFile(resolvedBaseline, findings)
    console.log(`untested: wrote ${findings.length} fingerprint(s) to ${baselinePath}`)
    return
  }
  const fullBaseline = readBaseline(resolvedBaseline)
  if (fullBaseline === null) {
    console.error(
      `untested: no baseline at ${baselinePath} (cwd ${cwd}). ` +
        'Create it once with --write-baseline, commit it, and never regenerate it.',
    )
    process.exitCode = 1
    return
  }
  // The baseline is scoped to the files THIS run changed: an entry for an
  // untouched file is not stale, it is not in play.
  const changedSet = new Set(changed)
  const scopedBaseline = fullBaseline.filter((entry) => changedSet.has(entry.split('|')[0]))
  const { new: fresh, stale } = diffAgainstBaseline(findings, scopedBaseline)
  for (const entry of fresh) console.error(`untested: NEW ${entry}`)
  for (const entry of stale) {
    console.error(`untested: STALE ${entry} — the gap it recorded is gone; remove it from the baseline`)
  }
  if (fresh.length > 0 || stale.length > 0) {
    console.error(`untested: ${fresh.length} new, ${stale.length} stale (baseline ${baselinePath})`)
    process.exitCode = 1
  }
}
