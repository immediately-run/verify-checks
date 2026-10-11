import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import fastGlob from 'fast-glob'
import { baselineMissing, baselineOverwriteRefusal } from './baseline.mjs'
import { readCoverageReport } from './coverage.mjs'
import { changedLineRanges, changedSince, commitTrailers } from './producers.mjs'
import { IS_TEST_FILE, matchesAny } from './untested-core.mjs'

// check:untested, coverage mode (R3-580; plans/untested-coverage). The name
// check asked "does a file with the same stem exist?"; this asks "are the
// CHANGED lines executed by the test run?" — the only signal that catches
// backend #59 (a sibling test that drove everything except the changed hunk).
//
// The verdict is per file, by count. A file's gap is the number of its lines
// the coverage report marks executable and never executed. The baseline
// records that number for every file that had a gap on the day the check was
// seeded, and a changed logic file fails as NEW when its count now exceeds
// the recorded one (zero when it has no entry). No line number is stored, so
// a comment, a blank line, an import or a moved function — anything that
// changes no coverage — changes no count and no verdict, and two branches
// that both shift a file's lines do not touch the baseline at all.
//
// A file absent from the report (the test run never loaded it) has no
// measurable count: nothing says which of its lines are executable, and
// counting all of them would make a comment a finding. Its entry is the
// string "unloaded" instead. A changed file that is unloaded and has no such
// entry is NEW; one that has it passes with a printed note, because the
// change cannot be measured.
//
// An entry goes STALE when its file is gone or left the logic paths, when
// the count dropped (lower the number, or delete the entry at zero), or when
// an "unloaded" file is now loaded. The count is re-checked for every changed
// logic file and for every recorded file the report has a record for, so the
// branch that closes a gap — a test-only change included — is the one told
// to shrink the baseline.
//
// What a count cannot see: lines inside one file can trade (cover three
// recorded lines, add three new uncovered ones) and the count stays put.

// The on-disk shape: { "format": <this>, "files": { "<path>": <count> | "unloaded" } },
// one line per file, keys sorted. The line-range format this replaced was a
// bare JSON array of "file|start-end" strings, so the two cannot be confused.
export const UNTESTED_BASELINE_FORMAT = 'uncovered-lines-per-file/1'
export const UNLOADED = 'unloaded'

// The refusal for a baseline written by verify-checks 0.9 and earlier. Its
// entries are line ranges; nothing here reads them as counts.
export function legacyBaselineRefusal(baselinePath) {
  return (
    `untested: ${baselinePath} is a line-range baseline ("file|start-end" entries, verify-checks 0.9 and earlier). ` +
    'This version records one uncovered-line count per file and does not read line ranges. ' +
    `Re-seed it: rm ${baselinePath} && npm run check:untested -- --write-baseline, then commit the new file.`
  )
}

// Parsed JSON → { legacy: true } for the line-range array, else
// { legacy: false, files: Map<path, count | "unloaded"> }. Anything else throws.
export function parseUntestedBaseline(parsed, baselinePath) {
  if (Array.isArray(parsed)) return { legacy: true }
  const files = parsed?.files
  if (parsed?.format !== UNTESTED_BASELINE_FORMAT || files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error(
      `untested baseline ${baselinePath} must be { "format": ${JSON.stringify(UNTESTED_BASELINE_FORMAT)}, "files": { "<path>": <count> | "${UNLOADED}" } }`,
    )
  }
  for (const [file, recorded] of Object.entries(files)) {
    if (recorded !== UNLOADED && !(Number.isInteger(recorded) && recorded > 0)) {
      throw new Error(
        `untested baseline ${baselinePath}: ${JSON.stringify(file)} records ${JSON.stringify(recorded)} — ` +
          `an entry is a positive line count or "${UNLOADED}"; a file with no gap has no entry`,
      )
    }
  }
  return { legacy: false, files: new Map(Object.entries(files)) }
}

export function formatUntestedBaseline(files) {
  const sorted = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return `${JSON.stringify({ format: UNTESTED_BASELINE_FORMAT, files: sorted }, null, 2)}\n`
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
        // mapped statement starts at (comment, blank, type-only, a mid-span
        // continuation) is not executable and is never a finding.
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


// A file's gap as the report measures it: the count of lines a mapped
// statement starts at that never ran — or UNLOADED when the report has no
// record of the file. An empty file has nothing to load and counts zero.
export function fileGap(file, report, cwd) {
  const entry = report.get(file)
  if (entry === undefined) return readFileSync(resolve(cwd, file), 'utf8') === '' ? 0 : UNLOADED
  let count = 0
  for (const line of entry.executable) {
    if (!entry.covered.has(line)) count += 1
  }
  return count
}

// The day-one state: every logic file's gap, files with none left out.
export function seedUntestedBaseline({ files, report, cwd }) {
  const seeded = new Map()
  for (const file of files) {
    const gap = fileGap(file, report, cwd)
    if (gap !== 0) seeded.set(file, gap)
  }
  return seeded
}

// The ratchet. `changedFiles` are the files this branch changed that are in
// the instrument (logic paths, not tests, not trailer-declared): only they
// can be NEW. STALE is asked of every entry.
export function compareToBaseline({ baseline, changedFiles, report, logicPaths, cwd }) {
  const changedSet = new Set(changedFiles)
  const fresh = []
  const stale = []
  const unmeasured = []
  const recheck = new Set(changedFiles)
  for (const [file, recorded] of baseline) {
    if (!existsSync(resolve(cwd, file))) {
      stale.push({ file, recorded, why: 'the file no longer exists; delete the entry' })
    } else if (IS_TEST_FILE.test(file) || !matchesAny(file, logicPaths)) {
      stale.push({ file, recorded, why: 'the file is no longer under the logic paths; delete the entry' })
    } else if (report.has(file)) {
      recheck.add(file)
    }
  }
  for (const file of [...recheck].sort()) {
    const recorded = baseline.get(file) ?? 0
    const current = fileGap(file, report, cwd)
    if (current === UNLOADED) {
      if (recorded === UNLOADED) unmeasured.push(file)
      else fresh.push({ file, current, recorded })
    } else if (recorded === UNLOADED) {
      stale.push({
        file,
        recorded,
        why:
          `the test run now loads it, with ${current} uncovered executable line(s); ` +
          (current === 0 ? 'delete the entry' : `record ${current}`),
      })
    } else if (current > recorded) {
      if (changedSet.has(file)) fresh.push({ file, current, recorded })
    } else if (current < recorded) {
      stale.push({
        file,
        recorded,
        why:
          `${current} uncovered executable line(s) now; ` +
          (current === 0 ? 'delete the entry' : `lower the entry to ${current}`),
      })
    }
  }
  return { fresh, stale, unmeasured }
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
  const stored = readStoredBaseline(resolvedBaseline, baselinePath)
  // A line-range file is refused before anything else, seeding included: the
  // overwrite refusal below would tell the reader to shrink it by hand.
  if (stored?.legacy) {
    console.error(legacyBaselineRefusal(baselinePath))
    process.exitCode = 1
    return
  }

  if (argv.includes('--write-baseline')) {
    // Seeding records the gaps that exist at HEAD over every logic file — the
    // day-one state plan Q4's ratchet exists to excuse — never merely the
    // current diff's. (The string-ratchet's refusal is shared verbatim.)
    if (stored !== null) {
      console.error(baselineOverwriteRefusal('untested', baselinePath))
      process.exitCode = 1
      return
    }
    // The file universe comes from fast-glob (a superset reader) but is then
    // filtered through matchesAny — the check's own matcher — so a pattern
    // the check cannot express seeds nothing the check would skip, and zero
    // matches is loud (R3-674), never a vacuous green.
    const files = fastGlob
      .sync(logicPaths.include, { cwd })
      .filter((file) => matchesAny(file, logicPaths))
      .filter((file) => !IS_TEST_FILE.test(file))
      .sort()
    if (files.length === 0) {
      throw new Error(
        `check-untested-coverage: logicPaths matched zero files for seeding (include: ${logicPaths.include.join(', ')}; cwd ${cwd})`,
      )
    }
    const seeded = seedUntestedBaseline({ files, report, cwd })
    mkdirSync(dirname(resolvedBaseline), { recursive: true })
    writeFileSync(resolvedBaseline, formatUntestedBaseline(seeded))
    const unloaded = [...seeded.values()].filter((gap) => gap === UNLOADED).length
    console.log(
      `untested: wrote ${seeded.size} file entr${seeded.size === 1 ? 'y' : 'ies'} (${unloaded} unloaded) ` +
        `over ${files.length} logic file(s) to ${baselinePath}`,
    )
    return
  }

  if (stored === null) {
    console.error(baselineMissing('untested', baselinePath, cwd))
    process.exitCode = 1
    return
  }
  const baseline = stored.files

  const changed = changedSince(base, cwd)
  const trailers = commitTrailers(base, cwd)
  const rangesByFile = changedLineRanges(base, changed, cwd)
  // The trailer escape (plan Q5): a declared file is out of the instrument,
  // so it is in neither `gaps` nor the files that can be NEW.
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
  const declaredFiles = new Set(declared.map((entry) => entry.file))
  const inInstrument = changed.filter(
    (file) => !declaredFiles.has(file) && !IS_TEST_FILE.test(file) && matchesAny(file, logicPaths),
  )
  const { fresh, stale, unmeasured } = compareToBaseline({
    baseline,
    changedFiles: inInstrument,
    report,
    logicPaths,
    cwd,
  })

  // This branch's own unexecuted lines, per file: what to cover when the
  // file is NEW, and a printed note when the recorded count absorbs them.
  const changedGapText = new Map(gaps.map((gap) => [gap.file, gap.ranges.map(formatRange).join(', ')]))
  const flagged = new Set([...fresh, ...stale].map((finding) => finding.file))
  for (const file of unmeasured) {
    console.log(`untested: ${file} — recorded as ${UNLOADED}: the test run never loads it, so this change is not measured`)
  }
  for (const [file, text] of changedGapText) {
    if (flagged.has(file) || !report.has(file)) continue
    console.log(
      `untested: ${file} — changed lines not executed by the test run: ${text} (within the ${baseline.get(file)} recorded for the file)`,
    )
  }
  for (const { file, current, recorded } of fresh) {
    const changedText = changedGapText.get(file)
    const what =
      current === UNLOADED
        ? 'the test run never loads it (no record in the coverage report), so none of its lines are measured'
        : `${current} uncovered executable line(s), ${recorded} recorded` +
          (changedText ? `; changed lines not executed by the test run: ${changedText}` : '')
    console.error(`untested: NEW ${file} — ${what}; cover the new lines, or declare the file with an Untested: trailer`)
  }
  for (const { file, recorded, why } of stale) {
    console.error(`untested: STALE ${file} (recorded ${recorded}) — ${why}`)
  }
  if (fresh.length > 0 || stale.length > 0) {
    console.error(`untested: ${fresh.length} new, ${stale.length} stale (baseline ${baselinePath})`)
    process.exitCode = 1
  }
}

// null when there is no baseline file; otherwise parseUntestedBaseline's answer.
function readStoredBaseline(resolvedBaseline, baselinePath) {
  if (!existsSync(resolvedBaseline)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(resolvedBaseline, 'utf8'))
  } catch (err) {
    throw new Error(`baseline ${baselinePath} is not valid JSON: ${err.message}`)
  }
  return parseUntestedBaseline(parsed, baselinePath)
}

function formatRange([start, endExclusive]) {
  return endExclusive === start + 1 ? `${start}` : `${start}-${endExclusive - 1}`
}
