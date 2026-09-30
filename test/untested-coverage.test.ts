import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCoverageReport, readLcov, readIstanbulCoverage } from '../src/coverage.mjs'
import {
  checkUntestedCoverage,
  coverageFingerprint,
  uncoveredRangesByFile,
} from '../src/check-untested-coverage.mjs'
import { changedLineRanges } from '../src/producers.mjs'

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
      mkdirSync(join(dir, file.split('/').slice(0, -1).join('/')), { recursive: true })
      writeFileSync(join(dir, file), text)
    },
    addAll: () => git(['add', '.']),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('changedLineRanges (real git)', () => {
  it('a new file contributes one range over all its lines', () => {
    const repo = gitFixture()
    try {
      repo.write('src/calc.ts', 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
      repo.addAll()
      repo.commit('add calc')
      expect(changedLineRanges('main', 'src/calc.ts', repo.dir)).toEqual([[1, 4]])
    } finally {
      repo.cleanup()
    }
  })

  it('an edit contributes exactly its hunk, 1-based and half-open', () => {
    const repo = gitFixture()
    try {
      repo.write('src/calc.ts', 'l1\nl2\nl3\nl4\nl5\n')
      repo.addAll()
      repo.commit('add calc')
      repo.write('src/calc.ts', 'l1\nl2\nCHANGED\nl4\nl5\n')
      repo.addAll()
      repo.commit('edit line 3')
      expect(changedLineRanges('main', 'src/calc.ts', repo.dir)).toEqual([[1, 6]])
      // (the whole file is one branch diff vs the empty root commit — the next
      // case pins hunk precision against a base that has content)
    } finally {
      repo.cleanup()
    }
  })

  it('hunk precision: only the edited lines are new-side ranges', () => {
    const repo = gitFixture()
    try {
      repo.write('src/calc.ts', 'l1\nl2\nl3\nl4\nl5\n')
      repo.addAll()
      repo.commit('add calc on the branch base')
      // Re-base the fixture: make this content main's, then edit on a branch.
      repo.git(['checkout', '-q', 'main'])
      repo.git(['merge', '-q', '--ff-only', 'feature'])
      repo.git(['checkout', '-q', '-b', 'feature-2'])
      repo.write('src/calc.ts', 'l1\nl2\nCHANGED\nl4\nl5\n')
      repo.addAll()
      repo.commit('edit line 3')
      expect(changedLineRanges('main', 'src/calc.ts', repo.dir)).toEqual([[3, 4]])
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
      expect(changedLineRanges('main', 'src/calc.ts', repo.dir)).toEqual([])
    } finally {
      repo.cleanup()
    }
  })
})

describe('readCoverageReport over real frozen reports', () => {
  // lcov: real backend report (see the fixture header). istanbul: a real jest
  // coverage-final.json captured 2026-09-30 from immediately-run-site-main —
  // `jest src/filesystem/mountPath.test.ts --coverage --coverageReporters=json
  // --collectCoverageFrom=src/filesystem/mountPath.ts` — whose statementMap
  // carries one unexecuted statement at line 35.
  it('reads lcov DA records into per-line coverage (real backend report)', () => {
    const covered = readCoverageReport(join(REPO_ROOT, 'test/fixtures/coverage/node-lcov.snapshot.info'), {
      cwd: '/repo',
    })
    expect([...covered.keys()]).toEqual(['src/spaceQuota.ts'])
    expect(covered.get('src/spaceQuota.ts')?.has(1)).toBe(true)
    expect(covered.get('src/spaceQuota.ts')?.size).toBeGreaterThan(80)
  })

  it('reads istanbul coverage-final.json (real site-main report)', () => {
    const covered = readCoverageReport(join(REPO_ROOT, 'test/fixtures/coverage/jest-coverage-final.snapshot.json'), {
      cwd: '/home/dev/workspaces/playful-otter/immediately-run-site-main',
    })
    const mountPath = covered.get('src/filesystem/mountPath.ts')
    expect(mountPath).toBeDefined()
    expect(mountPath?.has(16)).toBe(true) // the isSafeMountSegment statement, 75 hits
    expect(mountPath?.size).toBeGreaterThan(20)
  })

  it('istanbul hits discipline: a 0-hit location is not covered, an overlapping 1-hit location covers its span', () => {
    // A minimal report object (unit input, not the frozen fixture): the 0-hit
    // statement at line 5 must not mark it; the executed statement spanning
    // lines 8-10 must mark all three.
    const report = {
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
    const covered = readIstanbulCoverage(report, { cwd: '/repo' })
    expect(covered.get('src/x.ts')?.has(5)).toBe(false)
    expect([8, 9, 10].every((l) => covered.get('src/x.ts')?.has(l))).toBe(true)
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

  it('covered, uncovered, and partially covered changed hunks', () => {
    const coveredByFile = new Map([
      ['src/covered.ts', new Set([1, 2, 3])],
      ['src/partial.ts', new Set([10, 11, 13])], // 12 never ran
    ])
    const rangesByFile = new Map([
      ['src/covered.ts', [[1, 4]] as [number, number][]],
      ['src/partial.ts', [[10, 14]] as [number, number][]],
      ['src/bare.ts', [[1, 6]] as [number, number][]], // no coverage record at all
    ])
    const { gaps } = uncoveredRangesByFile({
      files: ['src/covered.ts', 'src/partial.ts', 'src/bare.ts'],
      rangesByFile,
      coveredByFile,
      logicPaths,
    })
    expect(gaps).toEqual([
      { file: 'src/bare.ts', ranges: [[1, 6]] },
      { file: 'src/partial.ts', ranges: [[12, 13]] },
    ])
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
      coveredByFile: new Map(),
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
      coveredByFile: new Map(),
      logicPaths,
    })
    expect(gaps).toEqual([])
  })

  it('the fingerprint is a stable digest of the line ranges', () => {
    const a = coverageFingerprint({ file: 'src/x.ts', ranges: [[12, 13]] })
    const b = coverageFingerprint({ file: 'src/x.ts', ranges: [[12, 13]] })
    const c = coverageFingerprint({ file: 'src/x.ts', ranges: [[12, 14]] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^src\/x\.ts\|[0-9a-f]{16}$/)
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

  function repoWithCalc() {
    const repo = gitFixture()
    repo.write('lib/calc.js', CALC)
    repo.write('lib/calc.test.js', CALC_TEST)
    repo.addAll()
    repo.commit('add classify')
    return repo
  }

  it('an uncovered changed hunk fails with the NEW fingerprint; the baseline then passes it', () => {
    const repo = repoWithCalc()
    try {
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = {
        base: 'main',
        logicPaths: { include: ['lib/**'] },
        coverageReportPath: 'coverage.info',
        baselinePath: 'verify-baselines/untested.json',
        cwd: repo.dir,
      }
      // No baseline yet: the check directs to --write-baseline.
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined

      // Seed, and the same state passes (the gap is baselined).
      checkUntestedCoverage({ ...opts, argv: ['--write-baseline'] })
      expect(process.exitCode).toBeUndefined()
      const seeded = JSON.parse(readFileSync(join(repo.dir, 'verify-baselines/untested.json'), 'utf8'))
      expect(seeded).toHaveLength(1)
      expect(seeded[0]).toMatch(/^lib\/calc\.js\|[0-9a-f]{16}$/)
      repo.addAll()
      repo.commit('seed the untested baseline')
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBeUndefined()

      // A new UNCOVERED change on top fails: the baseline covers only the old gap.
      repo.write('lib/calc.js', CALC + 'export function uncovered() {\n  return 42\n}\n')
      repo.addAll()
      repo.commit('add a function no test reaches')
      checkUntestedCoverage(opts)
      expect(process.exitCode).toBe(1)
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
      const opts = {
        base: 'main',
        logicPaths: { include: ['lib/**'] },
        coverageReportPath: 'coverage.info',
        baselinePath: 'verify-baselines/untested.json',
        cwd: repo.dir,
      }
      // The branch holds the full calc.js addition, ALL of it executed now.
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

  it('a baseline entry for a file this change did not touch is NOT stale (scoped ratchet)', () => {
    const repo = repoWithCalc()
    try {
      // Cover calc's negative path too, so the whole branch is executed and
      // only the scoped-stale behaviour is under test.
      repo.write(
        'lib/calc.test.js',
        CALC_TEST + "test('negative', () => assert.equal(classify(-2), 'negative'))\n",
      )
      repo.write('lib/other.js', 'export const other = 1\n')
      repo.write(
        'lib/other.test.js',
        `import { test } from 'node:test'
import assert from 'node:assert'
import { other } from './other.js'
test('other', () => assert.equal(other, 1))
`,
      )
      repo.addAll()
      repo.commit('add other, with a pre-existing gap baselined')
      mkdirSync(join(repo.dir, 'verify-baselines'), { recursive: true })
      writeFileSync(
        join(repo.dir, 'verify-baselines/untested.json'),
        `${JSON.stringify(['lib/untouched.ts|0123456789abcdef'], null, 2)}\n`,
      )
      repo.addAll()
      repo.commit('commit the baseline')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      // lib/untouched.ts is in the baseline but NOT in this change set: no
      // STALE failure. The change itself is fully covered: no NEW failure.
      checkUntestedCoverage({
        base: 'main',
        logicPaths: { include: ['lib/**'] },
        coverageReportPath: 'coverage.info',
        baselinePath: 'verify-baselines/untested.json',
        cwd: repo.dir,
      })
      expect(process.exitCode).toBeUndefined()
    } finally {
      process.exitCode = undefined
      repo.cleanup()
    }
  })
})
