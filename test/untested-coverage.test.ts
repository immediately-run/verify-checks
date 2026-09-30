import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCoverageReport, readLcov, readIstanbulCoverage } from '../src/coverage.mjs'
import {
  checkUntestedCoverage,
  formatBaselineEntry,
  parseBaselineEntry,
  staleEntries,
  uncoveredRangesByFile,
  unexcusedGaps,
} from '../src/check-untested-coverage.mjs'
import { changedLineRanges, parseUnifiedDiffRanges } from '../src/producers.mjs'

const REPO_ROOT = new URL('..', import.meta.url).pathname

// ── git fixture helper: a real repo in a tmp dir, the PR shape the check
// consumes (merge-base(main, HEAD) is the root commit; the branch holds the
// change). The same harness as baseline.test.ts's changedSince suite.
function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-coverage-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const commit = (message: string, extra: string[] = []) =>
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', ...extra, '-m', message])
  git(['init', '-q', '-b', 'main'])
  commit('init', ['--allow-empty'])
  git(['checkout', '-q', '-b', 'feature'])
  return {
    dir,
    git,
    commit,
    write: (file: string, text: string) => {
      const parent = file.split('/').slice(0, -1).join('/')
      if (parent) mkdirSync(join(dir, parent), { recursive: true })
      writeFileSync(join(dir, file), text)
    },
    addAll: () => git(['add', '.']),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('parseUnifiedDiffRanges (pure)', () => {
  it('parses hunk headers into per-file half-open ranges and merges adjoining hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@',
      '@@ -20 +22,0 @@', // pure deletion: nothing
      '@@ -30 +31 @@',
      '@@ -31 +32 @@', // adjoins the previous range [31,32) → [31,33)
      'diff --git a/src/b.ts b/src/b.ts',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,5 @@',
    ].join('\n')
    const ranges = parseUnifiedDiffRanges(diff)
    expect(ranges.get('src/a.ts')).toEqual([
      [11, 13],
      [31, 33],
    ])
    expect(ranges.get('src/b.ts')).toEqual([[1, 6]])
  })

  it('a deleted file (+++ /dev/null) contributes no ranges', () => {
    const diff = ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n')
    expect([...parseUnifiedDiffRanges(diff).keys()]).toEqual([])
  })
})

describe('changedLineRanges (real git)', () => {
  it('hunk precision across two files in one diff: only the edited lines are new-side ranges', () => {
    const repo = gitFixture()
    try {
      repo.write('src/calc.ts', 'l1\nl2\nl3\nl4\nl5\n')
      repo.write('src/other.ts', 'x1\nx2\n')
      repo.addAll()
      repo.commit('add files')
      repo.git(['checkout', '-q', 'main'])
      repo.git(['merge', '-q', '--ff-only', 'feature'])
      repo.git(['checkout', '-q', '-b', 'feature-2'])
      repo.write('src/calc.ts', 'l1\nl2\nCHANGED\nl4\nl5\n')
      repo.write('src/other.ts', 'x1\nx2\nx3\n')
      repo.addAll()
      repo.commit('edit line 3, append one')
      const ranges = changedLineRanges('main', ['src/calc.ts', 'src/other.ts'], repo.dir)
      expect(ranges.get('src/calc.ts')).toEqual([[3, 4]])
      expect(ranges.get('src/other.ts')).toEqual([[3, 4]])
    } finally {
      repo.cleanup()
    }
  })

  it('a pure deletion contributes no new-side lines', () => {
    const repo = gitFixture()
    try {
      repo.write('src/calc.ts', 'l1\nl2\nl3\n')
      repo.addAll()
      repo.commit('add calc')
      repo.git(['checkout', '-q', 'main'])
      repo.git(['merge', '-q', '--ff-only', 'feature'])
      repo.git(['checkout', '-q', '-b', 'feature-2'])
      repo.write('src/calc.ts', 'l1\n')
      repo.addAll()
      repo.commit('delete two lines')
      expect(changedLineRanges('main', ['src/calc.ts'], repo.dir).get('src/calc.ts') ?? []).toEqual([])
    } finally {
      repo.cleanup()
    }
  })
})

describe('readCoverageReport over real frozen reports', () => {
  // lcov: real backend report (see the fixture header). istanbul: a real jest
  // coverage-final.json captured 2026-09-30 from immediately-run-site-main —
  // `jest src/filesystem/mountPath.test.ts --coverage --coverageReporters=json
  // --collectCoverageFrom=src/filesystem/mountPath.ts`.
  it('reads lcov DA records into covered + executable line sets (real backend report)', () => {
    const report = readCoverageReport(join(REPO_ROOT, 'test/fixtures/coverage/node-lcov.snapshot.info'), {
      cwd: '/repo',
    })
    expect([...report.keys()]).toEqual(['src/spaceQuota.ts'])
    const entry = report.get('src/spaceQuota.ts')
    expect(entry?.covered.has(1)).toBe(true)
    expect(entry?.executable.has(1)).toBe(true)
    expect(entry?.covered.size).toBeGreaterThan(80)
  })

  it('reads istanbul coverage-final.json (real site-main report)', () => {
    const report = readCoverageReport(join(REPO_ROOT, 'test/fixtures/coverage/jest-coverage-final.snapshot.json'), {
      cwd: '/home/dev/workspaces/playful-otter/immediately-run-site-main',
    })
    const mountPath = report.get('src/filesystem/mountPath.ts')
    expect(mountPath).toBeDefined()
    expect(mountPath?.covered.has(16)).toBe(true) // the isSafeMountSegment statement, 75 hits
    expect(mountPath?.covered.size).toBeGreaterThan(20)
    // executable ⊇ covered (equality is possible: this file's one 0-hit
    // statement shares line 35 with an executed location)
    expect(mountPath?.executable.size).toBeGreaterThanOrEqual(mountPath?.covered.size ?? 0)
  })

  it('istanbul hits discipline: a 0-hit location is executable but not covered', () => {
    const reportJson = {
      '/repo/src/x.ts': {
        statementMap: {
          a: { start: { line: 5, column: 2 }, end: { line: 5, column: 20 } },
          b: { start: { line: 8, column: 0 }, end: { line: 10, column: 1 } },
        },
        s: { a: 0, b: 3 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    }
    const report = readIstanbulCoverage(reportJson, { cwd: '/repo' })
    const entry = report.get('src/x.ts')
    expect(entry?.executable.has(5)).toBe(true)
    expect(entry?.covered.has(5)).toBe(false)
    expect([8, 9, 10].every((l) => entry?.covered.has(l))).toBe(true)
  })

  it('an empty report throws; a report that is neither format throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-report-'))
    try {
      writeFileSync(join(dir, 'empty.info'), '')
      expect(() => readCoverageReport(join(dir, 'empty.info'))).toThrow(/empty/)
      writeFileSync(join(dir, 'garbage.txt'), 'not a coverage report\n')
      expect(() => readCoverageReport(join(dir, 'garbage.txt'))).toThrow(/neither lcov/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('uncoveredRangesByFile (pure)', () => {
  const logicPaths = { include: ['src/**'] }
  const reportOf = (entries: Record<string, { covered: number[]; executable: number[] }>) =>
    new Map(
      Object.entries(entries).map(([file, { covered, executable }]) => [
        file,
        { covered: new Set(covered), executable: new Set(executable) },
      ]),
    )

  it('covered, uncovered, and partially covered changed hunks', () => {
    const report = reportOf({
      'src/covered.ts': { covered: [1, 2, 3], executable: [1, 2, 3] },
      'src/partial.ts': { covered: [10, 11, 13], executable: [10, 11, 12, 13] }, // 12 never ran
    })
    const rangesByFile = new Map([
      ['src/covered.ts', [[1, 4]] as [number, number][]],
      ['src/partial.ts', [[10, 14]] as [number, number][]],
      ['src/bare.ts', [[1, 6]] as [number, number][]], // no coverage record at all
    ])
    const { gaps } = uncoveredRangesByFile({
      files: ['src/covered.ts', 'src/partial.ts', 'src/bare.ts'],
      rangesByFile,
      report,
      logicPaths,
    })
    expect(gaps).toEqual([
      { file: 'src/bare.ts', ranges: [[1, 6]] },
      { file: 'src/partial.ts', ranges: [[12, 13]] },
    ])
  })

  it('a changed line no location spans (comment, blank, type-only) is not a finding', () => {
    const report = reportOf({ 'src/x.ts': { covered: [1], executable: [1] } })
    const { gaps } = uncoveredRangesByFile({
      files: ['src/x.ts'],
      rangesByFile: new Map([['src/x.ts', [[1, 4]]]]),
      report,
      logicPaths,
    })
    expect(gaps).toEqual([]) // lines 2-3 are in no location span: not executable
  })

  it('a trailer-declared file is declared, never a gap; test files and non-logic paths are skipped', () => {
    const rangesByFile = new Map([
      ['src/x.ts', [[1, 3]] as [number, number][]],
      ['src/x.test.ts', [[1, 3]] as [number, number][]],
      ['scripts/y.mjs', [[1, 3]] as [number, number][]],
    ])
    const { gaps, declared } = uncoveredRangesByFile({
      files: ['src/x.ts', 'src/x.test.ts', 'scripts/y.mjs'],
      rangesByFile,
      report: new Map(),
      trailers: [{ file: 'src/x.ts', reason: 'self-testing script shape' }],
      logicPaths,
    })
    expect(gaps).toEqual([])
    expect(declared).toEqual([{ file: 'src/x.ts', reason: 'self-testing script shape' }])
  })

  it('a pure-deletion change has no lines to cover', () => {
    const { gaps } = uncoveredRangesByFile({
      files: ['src/shrunk.ts'],
      rangesByFile: new Map([['src/shrunk.ts', []]]),
      report: new Map(),
      logicPaths,
    })
    expect(gaps).toEqual([])
  })
})

describe('the line-range baseline', () => {
  it('parses and formats entries (1-based inclusive), refusing malformed ones', () => {
    expect(parseBaselineEntry('src/x.ts|12')).toEqual({ file: 'src/x.ts', start: 12, end: 12 })
    expect(parseBaselineEntry('src/x.ts|12-15')).toEqual({ file: 'src/x.ts', start: 12, end: 15 })
    expect(() => parseBaselineEntry('src/x.ts|15-12')).toThrow(/end before start/)
    expect(() => parseBaselineEntry('src/x.ts')).toThrow(/not "file\|line"/)
    expect(formatBaselineEntry('src/x.ts', [12, 13])).toBe('src/x.ts|12')
    expect(formatBaselineEntry('src/x.ts', [12, 16])).toBe('src/x.ts|12-15')
  })

  it('subset matching: a gap inside a recorded historical range is excused; anything outside fails', () => {
    const baseline = [{ file: 'src/old.ts', start: 50, end: 60 }]
    // A touch inside the historical gap: the modified lines are the PR's, and
    // the baseline records they were already a gap (plan Q4's anti-fire rule).
    expect(
      unexcusedGaps([{ file: 'src/old.ts', ranges: [[52, 55]] }], baseline),
    ).toEqual([])
    // A new uncovered line outside any recorded range is the finding.
    expect(unexcusedGaps([{ file: 'src/old.ts', ranges: [[58, 62]] }], baseline)).toEqual([
      { file: 'src/old.ts', ranges: [[61, 62]] },
    ])
  })

  it('stale re-checks the recorded gap: covered-now or past-EOF lines are stale, only for changed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-stale-'))
    try {
      writeFileSync(join(dir, 'src-x.ts'), 'a\nb\nc\nd\ne\n')
      writeFileSync(join(dir, 'src-untouched.ts'), 'a\nb\nc\n')
      const baselineEntries = [
        { file: 'src-x.ts', start: 2, end: 3 }, // line 3 now covered, line 2 still a gap
        { file: 'src-untouched.ts', start: 1, end: 99 }, // not in play this run: NOT stale
      ]
      const report = new Map([
        ['src-x.ts', { covered: new Set([3]), executable: new Set([2, 3]) }],
        ['src-untouched.ts', { covered: new Set([1, 2, 3]), executable: new Set([1, 2, 3]) }],
      ])
      const stale = staleEntries({ baselineEntries, changedFiles: ['src-x.ts'], report, cwd: dir })
      expect(stale).toHaveLength(1)
      expect(stale[0].entry).toEqual({ file: 'src-x.ts', start: 2, end: 3 })
      expect(stale[0].why).toContain('3')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a baseline entry whose file was deleted is stale even when untouched this run (no fossilization)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-stale-'))
    try {
      const stale = staleEntries({
        baselineEntries: [{ file: 'src/gone.ts', start: 1, end: 9 }],
        changedFiles: [],
        report: new Map(),
        cwd: dir,
      })
      expect(stale).toHaveLength(1)
      expect(stale[0].why).toMatch(/no longer exists/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The end-to-end proof, on a REAL changed-file set with a REAL coverage run:
// a tmp git repo whose tests really execute under node --test
// --experimental-test-coverage, so the covered/uncovered lines are measured,
// never hand-written. (backend's exact mechanism: --enable-source-maps
// remaps to source coordinates; the fixture's plain .js needs no remap.)
describe('checkUntestedCoverage end-to-end (real git + real coverage run)', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  function runCoverage(dir: string) {
    // node --test expands the glob itself (execFileSync has no shell).
    return execFileSync(
      process.execPath,
      ['--test', '--experimental-test-coverage', '--test-reporter=lcov', 'lib/*.test.js'],
      { cwd: dir, encoding: 'utf8' },
    )
  }

  // classify() with the negative path on its OWN lines, so the lcov DA
  // records discriminate (a single-line if-body rides the if's DA line).
  const CALC = [
    'export function classify(n) {', //    line 1
    '  if (n < 0) {', //                   line 2
    "    return 'negative'", //            line 3 — never executed
    '  }', //                              line 4 — block never entered
    '  return Math.abs(n)', //             line 5 — executed
    '}', //                                line 6
    '',
  ].join('\n')
  const CALC_TEST = `import { test } from 'node:test'
import assert from 'node:assert'
import { classify } from './calc.js'
test('positive', () => assert.equal(classify(2), 2))
`

  const OPTS = (dir: string) => ({
    base: 'main',
    logicPaths: { include: ['lib/**'] },
    coverageReportPath: 'coverage.info',
    baselinePath: 'verify-baselines/untested.json',
    cwd: dir,
  })

  function repoWithCalc() {
    const repo = gitFixture()
    repo.write('lib/calc.js', CALC)
    repo.write('lib/calc.test.js', CALC_TEST)
    repo.addAll()
    repo.commit('add classify')
    return repo
  }

  it('seeds the historical gap, passes its re-touch, and fails a NEW uncovered line', () => {
    const repo = repoWithCalc()
    try {
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      // No baseline yet: the check directs to --write-baseline.
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined

      // Seed over the whole tree (not the diff): the calc.js gap at 3-4 lands.
      checkUntestedCoverage({ ...opts, argv: ['--write-baseline'] })
      expect(process.exitCode).toBeUndefined()
      const seeded = JSON.parse(readFileSync(join(repo.dir, 'verify-baselines/untested.json'), 'utf8'))
      expect(seeded).toEqual(['lib/calc.js|3-4'])
      repo.addAll()
      repo.commit('seed the untested baseline')
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()

      // A re-touch INSIDE the recorded historical gap passes (plan Q4's
      // anti-fire rule), and a NEW uncovered line outside it fails.
      repo.write(
        'lib/calc.js',
        CALC.replace("return 'negative'", "return 'NEGATIVE'") +
          'export function uncovered() {\n  return 42\n}\n',
      )
      repo.addAll()
      repo.commit('reword the gap, add a function no test reaches')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined

      // Drop the uncovered addition: the in-gap edit alone passes.
      repo.write('lib/calc.js', CALC.replace("return 'negative'", "return 'NEGATIVE'"))
      repo.addAll()
      repo.commit('drop the uncovered function')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()
    } finally {
      process.exitCode = undefined
      repo.cleanup()
    }
  })

  it('a covered change passes with an empty baseline; a trailer-declared change is named and passes', () => {
    const repo = repoWithCalc()
    try {
      // Cover everything: test both paths, and seed an empty baseline.
      repo.write(
        'lib/calc.test.js',
        CALC_TEST + "test('negative', () => assert.equal(classify(-2), 'negative'))\n",
      )
      repo.write('verify-baselines/untested.json', '[]\n')
      repo.addAll()
      repo.commit('cover the negative path')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()

      // A trailer-declared change: named as declared, not a finding.
      repo.write('lib/self-testing.js', 'export const ok = true\n')
      repo.addAll()
      repo.commit('add self-testing script\n\nUntested: lib/self-testing.js — exercised by its own --self-test leg')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()
    } finally {
      process.exitCode = undefined
      repo.cleanup()
    }
  })

  it('covering a recorded gap turns its entry STALE (the ratchet shrinks); deleting a baselined file is STALE', () => {
    const repo = repoWithCalc()
    try {
      repo.write('verify-baselines/untested.json', '["lib/calc.js|3-4"]\n')
      repo.addAll()
      repo.commit('commit a baseline holding the calc gap')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      // The gap still exists and the branch state matches: passes.
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()

      // Cover the gap: the entry must shrink or go.
      repo.write(
        'lib/calc.test.js',
        CALC_TEST + "test('negative', () => assert.equal(classify(-2), 'negative'))\n",
      )
      repo.addAll()
      repo.commit('cover the negative path')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1) // STALE lib/calc.js|3-4
      process.exitCode = undefined
      repo.write('verify-baselines/untested.json', '[]\n')
      repo.addAll()
      repo.commit('the gap is closed; the entry goes')
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()

      // A baselined file deleted from the tree: the entry fossilizes otherwise.
      repo.write('verify-baselines/untested.json', '["lib/gone.js|1-9"]\n')
      repo.addAll()
      repo.commit('a record whose file is gone')
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = undefined
      repo.cleanup()
    }
  })
})
