import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

// Coverage-report readers for check:untested's coverage mode (R3-580,
// plans/untested-coverage Q3). Two wire formats, both produced by the runners
// the repos already have:
//
//   - lcov (`DA:<line>,<hits>` records; node --test --test-reporter=lcov, with
//     --enable-source-maps so the backend's compiled lib-test run remaps to
//     src/ coordinates)
//   - istanbul coverage-final.json (jest --coverageReporters=json; vitest's
//     json reporter on the v8 provider)
//
// Both answer, per repo-relative path:
//   covered    — the 1-based lines executed at least once
//   executable — the 1-based lines ANY location spans (a comment, blank, or
//                type-only line is in neither set, which is how istanbul-mode
//                changed comment lines avoid becoming permanent findings; in
//                lcov mode node marks those lines covered anyway)
//
// A file ABSENT from the report is different from a file with no covered
// lines: absence means the test run never loaded it, so nothing about it is
// known — the check treats every changed line of an absent file as uncovered
// (the backend-#59 discrimination: imported-but-not-executed lines carry hits
// 0; a never-imported file has no record at all).

function normalizePath(path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  return relative(cwd, absolute)
}

function record(map, file, cwd) {
  const key = normalizePath(file, cwd)
  const entry = map.get(key) ?? { covered: new Set(), executable: new Set() }
  map.set(key, entry)
  return entry
}

// lcov: SF:<file> opens a record, DA:<line>,<hits> fills it, end_of_record closes.
export function readLcov(text, { cwd = process.cwd() } = {}) {
  const report = new Map()
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('SF:')) {
      current = record(report, line.slice(3), cwd)
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',').map(Number)
      current.executable.add(lineNo)
      if (hits > 0) current.covered.add(lineNo)
    } else if (line === 'end_of_record') {
      current = null
    }
  }
  return report
}

// istanbul coverage-final.json: { <file>: { statementMap, s, fnMap, f, branchMap, b } }.
// A location is executable by virtue of being mapped; covered when its hit
// count is > 0. A location contributes its START LINE ONLY — istanbul's own
// line coverage (getLineCoverage) works this way, and it matters: a
// never-called arrow function is one executed DECLARATION statement spanning
// the whole body, so span-flattening would paint the unexecuted body as
// covered and the #59-shaped probe of a whole unused function would pass.
export function readIstanbulCoverage(json, { cwd = process.cwd() } = {}) {
  const report = new Map()
  for (const [file, data] of Object.entries(json)) {
    const entry = record(report, file, cwd)
    const mark = (loc, hits) => {
      if (!loc?.start?.line) return
      entry.executable.add(loc.start.line)
      if (hits > 0) entry.covered.add(loc.start.line)
    }
    for (const [id, loc] of Object.entries(data.statementMap ?? {})) mark(loc, data.s?.[id])
    for (const [id, fn] of Object.entries(data.fnMap ?? {})) mark(fn.decl ?? fn.loc, data.f?.[id])
    for (const [id, branch] of Object.entries(data.branchMap ?? {})) {
      mark(branch.loc, undefined) // the branch's own loc is executable; hits live per-arm below
      ;(branch.locations ?? []).forEach((loc, i) => mark(loc, data.b?.[id]?.[i]))
    }
  }
  return report
}

// Format sniffing, never extension guessing: lcov is line-oriented text with
// SF:/DA: records; istanbul coverage-final.json is a JSON object keyed by path.
export function readCoverageReport(reportPath, { cwd = process.cwd() } = {}) {
  const resolved = resolve(cwd, reportPath)
  const text = readFileSync(resolved, 'utf8')
  if (text.trim() === '') {
    throw new Error(`coverage report ${reportPath} is empty — the coverage run produced nothing`)
  }
  if (text.trimStart().startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`coverage report ${reportPath} looks like JSON but does not parse: ${err.message}`)
    }
    return readIstanbulCoverage(parsed, { cwd })
  }
  if (/(^|\n)SF:/.test(text)) return readLcov(text, { cwd })
  throw new Error(`coverage report ${reportPath} is neither lcov (no SF: records) nor istanbul JSON`)
}
