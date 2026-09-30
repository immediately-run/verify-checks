import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

// Coverage-report readers for check:untested's coverage mode (R3-580,
// plans/untested-coverage Q3). Two wire formats, both produced by the runners
// the repos already have:
//
//   - lcov (`DA:<line>,<hits>` records; node --test --test-reporter=lcov)
//   - istanbul coverage-final.json (jest --coverageReporters=json; vitest's
//     json reporter on the v8 provider) — statement/fn/branch locations
//     flattened to lines
//
// Both answer ONE question: the set of 1-based source lines executed at least
// once, keyed by repo-relative path. A file absent from the report has no
// covered lines — that is the #59 discrimination (imported-but-not-executed
// lines carry hits 0, and an unimported file has no record at all).

function normalizePath(path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  return relative(cwd, absolute)
}

// lcov: SF:<file> opens a record, DA:<line>,<hits> fills it, end_of_record closes.
export function readLcov(text, { cwd = process.cwd() } = {}) {
  const covered = new Map()
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('SF:')) {
      const key = normalizePath(line.slice(3), cwd)
      current = covered.get(key) ?? new Set()
      covered.set(key, current)
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',').map(Number)
      if (hits > 0) current.add(lineNo)
    } else if (line === 'end_of_record') {
      current = null
    }
  }
  return covered
}

// istanbul coverage-final.json: { <file>: { statementMap, s, fnMap, f, branchMap, b } }.
// A location counts when its hit count is > 0; every line it spans is covered.
export function readIstanbulCoverage(json, { cwd = process.cwd() } = {}) {
  const covered = new Map()
  for (const [file, data] of Object.entries(json)) {
    const lines = covered.get(file === '' ? file : normalizePath(file, cwd)) ?? new Set()
    covered.set(normalizePath(file, cwd), lines)
    const mark = (loc, hits) => {
      if (!hits || !loc?.start?.line) return
      const end = loc.end?.line ?? loc.start.line
      for (let l = loc.start.line; l <= end; l += 1) lines.add(l)
    }
    for (const [id, loc] of Object.entries(data.statementMap ?? {})) mark(loc, data.s?.[id])
    for (const [id, fn] of Object.entries(data.fnMap ?? {})) mark(fn.decl ?? fn.loc, data.f?.[id])
    for (const [id, branch] of Object.entries(data.branchMap ?? {})) {
      for (const loc of branch.locations ?? []) mark(loc, data.b?.[id]?.[branch.locations.indexOf(loc)])
    }
  }
  return covered
}

// Format sniffing, never extension guessing: lcov is line-oriented text with
// SF:/DA: records; istanbul coverage-final.json is a JSON object keyed by path.
export function readCoverageReport(reportPath, { cwd = process.cwd() } = {}) {
  const text = readFileSync(resolve(cwd, reportPath), 'utf8')
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
