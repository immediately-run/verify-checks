import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fastGlob from 'fast-glob'
import {
  baselineMissing,
  baselineOverwriteRefusal,
  readBaseline,
  writeBaselineFile,
} from './baseline.mjs'
import { readCoverageReport } from './coverage.mjs'
import { changedLineRanges, changedSince, commitTrailers } from './producers.mjs'
import { IS_TEST_FILE, matchesAny } from './untested-core.mjs'

// check:untested, coverage mode (R3-580; plans/untested-coverage). The name
// check asked "does a file with the same stem exist?"; this asks "are the
// CHANGED lines executed by the test run?" — the only signal that catches
// backend #59 (a sibling test that drove everything except the changed hunk).
//
// Finding = new-side lines of a changed logic file ∩ executable ∩ not
// executed by the coverage report − trailer-declared − baseline-recorded.
// A changed file ABSENT from the report (the test run never loaded it) counts
// every changed line as uncovered — imported-but-not-executed lines carry
// hits 0, a never-imported file has no record at all.
//
// The baseline is a set of LINE RANGES (`file|start-end`, 1-based inclusive),
// matched by line membership: a PR's uncovered changed lines pass when every
// one of them lies inside a recorded historical gap (plan Q4's ratchet —
// touching a pre-existing gap must not fail; a NEW uncovered line must). The
// string-equality ratchet in baseline.mjs cannot express subset matching, so
// this module drives read/write itself and shares the refusal/missing
// messages. An entry goes STALE when the gap it records is re-checked and
// found resolved — its lines now covered, or past the file's end — computed
// whenever the file is in the changed set, plus a hard rule for every entry:
// a file that no longer exists at HEAD fossilizes nothing.

export function parseBaselineEntry(entry) {
  const match = entry.match(/^(.+)\|(\d+)(?:-(\d+))?$/)
  if (!match) {
    throw new Error(`untested baseline entry ${JSON.stringify(entry)} is not "file|line" or "file|start-end"`)
  }
  const start = Number(match[2])
  const end = match[3] === undefined ? start : Number(match[3])
  if (end < start) throw new Error(`untested baseline entry ${JSON.stringify(entry)} has end before start`)
  return { file: match[1], start, end }
}

export function formatBaselineEntry(file, [start, endExclusive]) {
  const end = endExclusive - 1
  return `${file}|${start}${end === start ? '' : `-${end}`}`
}

// Pure: the changed lines of each logic file that the coverage report does
// not execute. `report` maps file → { covered, executable } (see
// coverage.mjs); ranges are half-open [start, end).
export function uncoveredRangesByFile({ files, rangesByFile, report, trailers = [], logicPaths }) {
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
    const entry = report.get(file)
    const uncovered = []
    for (const [start, end] of ranges) {
      let run = null
      for (let line = start; line < end; line += 1) {
        // A file the report never loaded: every line is uncovered. A line no
        // location spans (comment, blank, type-only) is not executable and is
        // never a finding.
        const isUncovered = entry === undefined ? true : entry.executable.has(line) && !entry.covered.has(line)
        if (isUncovered) {
          run = run ?? [line, line]
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

// The gap lines a baseline does not excuse: per file, the gap runs minus
// every recorded range, returned as runs of unexcused lines.
export function unexcusedGaps(gaps, baselineEntries) {
  const byFile = new Map()
  for (const entry of baselineEntries) {
    const ranges = byFile.get(entry.file) ?? []
    ranges.push([entry.start, entry.end + 1]) // to half-open
    byFile.set(entry.file, ranges)
  }
  const findings = []
  for (const { file, ranges } of gaps) {
    const excused = byFile.get(file) ?? []
    const remaining = []
    for (const [start, end] of ranges) {
      let run = null
      for (let line = start; line < end; line += 1) {
        const inBaseline = excused.some(([s, e]) => line >= s && line < e)
        if (!inBaseline) {
          run = run ?? [line, line]
          run[1] = line + 1
        } else if (run) {
          remaining.push(run)
          run = null
        }
      }
      if (run) remaining.push(run)
    }
    if (remaining.length > 0) findings.push({ file, ranges: remaining })
  }
  return findings
}

// The recorded gaps that no longer exist: entry lines whose file vanished at
// HEAD (checked for EVERY entry — a deleted file's record fossilizes
// otherwise), and — for files this run changed, where a fresh re-check is
// meaningful — entry lines now covered or past the file's end.
export function staleEntries({ baselineEntries, changedFiles, report, cwd }) {
  const changedSet = new Set(changedFiles)
  const stale = []
  for (const entry of baselineEntries) {
    const path = resolve(cwd, entry.file)
    if (!existsSync(path)) {
      stale.push({ entry, why: 'the file no longer exists' })
      continue
    }
    if (!changedSet.has(entry.file)) continue
    const lineCount = readFileSync(path, 'utf8').split('\n').length - 1
    const reportEntry = report.get(entry.file)
    const deadLines = []
    for (let line = entry.start; line <= entry.end; line += 1) {
      if (line > lineCount) deadLines.push(line)
      else if (reportEntry !== undefined && reportEntry.covered.has(line)) deadLines.push(line)
      // A line now outside every location span keeps the entry: re-deriving
      // executability under line shifts misfires; covering the line is the
      // unambiguous resolution.
    }
    if (deadLines.length > 0) {
      stale.push({
        entry,
        why: `line(s) ${deadLines.join(', ')} are now covered or gone — shrink or delete the entry`,
      })
    }
  }
  return stale
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
  const report = readCoverageReport(coverageReportPath, { cwd })
  const resolvedBaseline = resolve(cwd, baselinePath)

  if (argv.includes('--write-baseline')) {
    // Seeding records the gaps that EXIST at HEAD over every logic file — the
    // day-one state plan Q4's ratchet exists to excuse — never merely the
    // current diff's. (The string-ratchet's refusal is shared verbatim.)
    if (existsSync(resolvedBaseline)) {
      console.error(baselineOverwriteRefusal('untested', baselinePath))
      process.exitCode = 1
      return
    }
    const files = fastGlob
      .sync([...logicPaths.include, ...(logicPaths.exclude ?? []).map((p) => `!${p}`)], { cwd })
      .filter((file) => !IS_TEST_FILE.test(file))
      .sort()
    const entries = []
    for (const file of files) {
      const lineCount = readFileSync(resolve(cwd, file), 'utf8').split('\n').length - 1
      if (lineCount === 0) continue
      const reportEntry = report.get(file)
      const ranges = []
      let run = null
      for (let line = 1; line <= lineCount; line += 1) {
        const isUncovered =
          reportEntry === undefined ? true : reportEntry.executable.has(line) && !reportEntry.covered.has(line)
        if (isUncovered) {
          run = run ?? [line, line]
          run[1] = line + 1
        } else if (run) {
          ranges.push(run)
          run = null
        }
      }
      if (run) ranges.push(run)
      for (const range of ranges) entries.push(formatBaselineEntry(file, range))
    }
    writeBaselineFile(resolvedBaseline, entries)
    console.log(
      `untested: wrote ${entries.length} baseline range(s) over ${files.length} logic file(s) to ${baselinePath}`,
    )
    return
  }

  const fullBaseline = readBaseline(resolvedBaseline)
  if (fullBaseline === null) {
    console.error(baselineMissing('untested', baselinePath, cwd))
    process.exitCode = 1
    return
  }
  const baselineEntries = fullBaseline.map(parseBaselineEntry)

  const changed = changedSince(base, cwd)
  const trailers = commitTrailers(base, cwd)
  const rangesByFile = changedLineRanges(base, changed, cwd)
  const { gaps, declared } = uncoveredRangesByFile({
    files: changed,
    rangesByFile,
    report,
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
  const findings = unexcusedGaps(gaps, baselineEntries)
  for (const finding of findings) {
    console.error(`untested: NEW ${finding.file}|${finding.ranges.map((r) => formatRange(r)).join(',')}`)
  }
  const stale = staleEntries({ baselineEntries, changedFiles: changed, report, cwd })
  for (const { entry, why } of stale) {
    console.error(`untested: STALE ${entry.file}|${entry.start}${entry.end === entry.start ? '' : `-${entry.end}`} — ${why}`)
  }
  if (findings.length > 0 || stale.length > 0) {
    console.error(`untested: ${findings.length} new, ${stale.length} stale (baseline ${baselinePath})`)
    process.exitCode = 1
  }
}

function formatRange([start, endExclusive]) {
  return endExclusive === start + 1 ? `${start}` : `${start}-${endExclusive - 1}`
}
