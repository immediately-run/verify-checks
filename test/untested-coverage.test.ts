import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCoverageReport, readLcov, readIstanbulCoverage } from '../src/coverage.mjs'
import {
  checkUntestedCoverage,
  compareToBaseline,
  fileGap,
  formatUntestedBaseline,
  legacyBaselineRefusal,
  parseUntestedBaseline,
  seedUntestedBaseline,
  uncoveredRangesByFile,
  UNLOADED,
  UNTESTED_BASELINE_FORMAT,
} from '../src/check-untested-coverage.mjs'
import { changedLineRanges, parseUnifiedDiffRanges, unquoteGitPath } from '../src/producers.mjs'
import { globToRegex, matchesAny } from '../src/untested-core.mjs'

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

describe('globToRegex (the check AND the seeder match through this)', () => {
  it('expands braces; a globstar matches zero or more directories', () => {
    const braced = globToRegex('src/**/*.{ts,tsx}')
    expect(braced.test('src/a.ts')).toBe(true) // root-level: **/ is zero dirs
    expect(braced.test('src/deep/b.tsx')).toBe(true)
    expect(braced.test('src/a.css')).toBe(false)

    expect(globToRegex('src/**').test('src/x.js')).toBe(true)
    expect(globToRegex('src/**').test('src/x/y.js')).toBe(true)
    expect(globToRegex('src/lib/**').test('src/other/a.ts')).toBe(false)
    expect(globToRegex('scripts/*.mjs').test('scripts/deep/a.mjs')).toBe(false)
    expect(globToRegex('**/*.test.ts').test('a.test.ts')).toBe(true) // leading **/
    expect(globToRegex('src/**/*.test.ts').test('src/a.test.ts')).toBe(true)
  })

  it('matchesAny consults include then exclude', () => {
    const paths = { include: ['src/**/*.{ts,tsx}'], exclude: ['src/gen/**'] }
    expect(matchesAny('src/a.ts', paths)).toBe(true)
    expect(matchesAny('src/gen/a.ts', paths)).toBe(false)
    expect(matchesAny('lib/a.ts', paths)).toBe(false)
  })
})

describe('git path quoting (reversed, never silently dropped)', () => {
  it('+++ headers: TAB after space-bearing names, C-quoted non-ASCII', () => {
    const diff = [
      '+++ b/lib/with space.ts\t',
      '@@ -0,0 +1,2 @@',
      '+++ "b/lib/caf\\303\\251.ts"',
      '@@ -0,0 +1 @@',
    ].join('\n')
    const ranges = parseUnifiedDiffRanges(diff)
    expect(ranges.get('lib/with space.ts')).toEqual([[1, 3]])
    expect(ranges.get('lib/café.ts')).toEqual([[1, 2]])
  })

  it('unquoteGitPath round-trips octal and simple escapes', () => {
    expect(unquoteGitPath('b/lib/plain.ts')).toBe('b/lib/plain.ts')
    expect(unquoteGitPath('"b/lib/caf\\303\\251.ts"')).toBe('b/lib/café.ts')
    expect(unquoteGitPath('"b/lib/a\\"b.ts"')).toBe('b/lib/a"b.ts')
    expect(() => unquoteGitPath('"b/lib/a\\q.ts"')).toThrow(/unknown escape/)
  })
})

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
    // Statements-only, start-line-only (istanbul's getLineCoverage): 15 of
    // the file's statement lines are executed; executable == covered here
    // because this fixture's one 0-hit statement shares line 35 with an
    // executed one.
    expect(mountPath?.covered.size).toBe(15)
    expect(mountPath?.executable.size).toBeGreaterThanOrEqual(mountPath?.covered.size ?? 0)
  })

  it('istanbul hits discipline: a 0-hit statement is executable but not covered (unit-shaped)', () => {
    const reportJson = {
      '/repo/src/x.ts': {
        statementMap: {
          a: { start: { line: 5, column: 2 }, end: { line: 5, column: 20 } },
          b: { start: { line: 8, column: 0 }, end: { line: 10, column: 1 } },
          c: { start: { line: 9, column: 2 }, end: { line: 9, column: 12 } },
        },
        s: { a: 0, b: 3, c: 0 },
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
    expect(entry?.covered.has(8)).toBe(true)
    expect(entry?.covered.has(9)).toBe(false)
    expect(entry?.executable.has(10)).toBe(false)
  })

  // Frozen 2026-09-30: the REAL istanbul report from landing-page's vitest
  // run while src/lib/navigation.ts carried a never-called probe function
  // (`__coverageProbe`, appended for the R3-580 discrimination probe and then
  // reverted). This is the shape that defeated span-flattening: the probe's
  // declaration (line 92) executes at module load while its body never runs.
  it('the real landing-page probe report: a never-called function body is uncovered (frozen producer output)', () => {
    const report = readCoverageReport(
      join(REPO_ROOT, 'test/fixtures/coverage/landing-probe-coverage-final.snapshot.json'),
      { cwd: '/home/dev/workspaces/playful-otter/landing-page' },
    )
    const nav = report.get('src/lib/navigation.ts')
    expect(nav).toBeDefined()
    expect(nav?.covered.has(92)).toBe(true) // export const __coverageProbe = … — the declaration runs
    expect(nav?.executable.has(93)).toBe(true)
    expect(nav?.covered.has(93)).toBe(false) // if (n < 0) — never reached
    expect(nav?.covered.has(94)).toBe(false) // return -1
    expect(nav?.covered.has(96)).toBe(false) // return n
    expect(nav?.executable.has(97)).toBe(false) // the closing brace starts no statement
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

  it('covered and partially covered changed hunks; a file with no coverage record lists nothing', () => {
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
    // src/bare.ts has no line the report can call executable: fileGap answers for it.
    expect(gaps).toEqual([{ file: 'src/partial.ts', ranges: [[12, 13]] }])
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

const reportFrom = (entries: Record<string, { covered: number[]; executable: number[] }>) =>
  new Map(
    Object.entries(entries).map(([file, { covered, executable }]) => [
      file,
      { covered: new Set(covered), executable: new Set(executable) },
    ]),
  )

const baselineJson = (files: Record<string, number | string>) =>
  `${JSON.stringify({ format: UNTESTED_BASELINE_FORMAT, files }, null, 2)}\n`

describe('the per-file count baseline: format', () => {
  it('round-trips, one line per file, keys sorted whatever the insertion order', () => {
    const text = formatUntestedBaseline(
      new Map<string, number | string>([
        ['src/z.ts', 3],
        ['src/a.ts', UNLOADED],
        ['src/B.ts', 1],
      ]),
    )
    expect(text).toBe(
      [
        '{',
        '  "format": "uncovered-lines-per-file/1",',
        '  "files": {',
        '    "src/B.ts": 1,',
        '    "src/a.ts": "unloaded",',
        '    "src/z.ts": 3',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    const parsed = parseUntestedBaseline(JSON.parse(text), 'b.json')
    expect(parsed.legacy).toBe(false)
    expect([...(parsed.files ?? [])]).toEqual([
      ['src/B.ts', 1],
      ['src/a.ts', UNLOADED],
      ['src/z.ts', 3],
    ])
    expect(parseUntestedBaseline(JSON.parse(formatUntestedBaseline(new Map())), 'b.json').files?.size).toBe(0)
  })

  it('a line-range array is legacy — every shape of it, the empty one included — and is never read as counts', () => {
    // "src/baseline.mjs|24" is a real entry of this repo's 0.9.0 baseline: a
    // single LINE NUMBER, which a count reader would take for 24 lines.
    expect(parseUntestedBaseline(['src/baseline.mjs|24', 'src/baseline.mjs|70-72'], 'b.json')).toEqual({ legacy: true })
    expect(parseUntestedBaseline([], 'b.json')).toEqual({ legacy: true })
    const refusal = legacyBaselineRefusal('verify-baselines/untested.json')
    expect(refusal).toContain('rm verify-baselines/untested.json && npm run check:untested -- --write-baseline')
    expect(refusal).toContain('does not read line ranges')
  })

  it('refuses anything that is neither: a foreign format, a zero or negative or fractional count, another string', () => {
    const wrap = (files: unknown, format: unknown = UNTESTED_BASELINE_FORMAT) => ({ format, files })
    expect(() => parseUntestedBaseline(wrap({ 'src/a.ts': 1 }, 'uncovered-lines-per-file/2'), 'b.json')).toThrow(/must be \{ "format"/)
    expect(() => parseUntestedBaseline({ 'src/a.ts': 1 }, 'b.json')).toThrow(/must be \{ "format"/)
    expect(() => parseUntestedBaseline(wrap(['src/a.ts|1']), 'b.json')).toThrow(/must be \{ "format"/)
    expect(() => parseUntestedBaseline(null, 'b.json')).toThrow(/must be \{ "format"/)
    for (const bad of [0, -1, 1.5, '3', 'loaded', null]) {
      expect(() => parseUntestedBaseline(wrap({ 'src/a.ts': bad }), 'b.json')).toThrow(/positive line count or "unloaded"/)
    }
  })
})

describe('fileGap and the seeder', () => {
  it('counts the executable lines that never ran; an unloaded file has no count; an empty file counts zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-gap-'))
    try {
      writeFileSync(join(dir, 'empty.ts'), '')
      writeFileSync(join(dir, 'never-loaded.ts'), '// only a comment\n')
      const report = reportFrom({
        'partial.ts': { covered: [1, 5], executable: [1, 3, 4, 5, 9] },
        'full.ts': { covered: [1, 2], executable: [1, 2] },
      })
      expect(fileGap('partial.ts', report, dir)).toBe(3)
      expect(fileGap('full.ts', report, dir)).toBe(0)
      expect(fileGap('never-loaded.ts', report, dir)).toBe(UNLOADED)
      expect(fileGap('empty.ts', report, dir)).toBe(0)
      expect([
        ...seedUntestedBaseline({ files: ['empty.ts', 'full.ts', 'never-loaded.ts', 'partial.ts'], report, cwd: dir }),
      ]).toEqual([
        ['never-loaded.ts', UNLOADED],
        ['partial.ts', 3],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the real landing-page probe report: the count is of statement lines, the never-called body included', () => {
    const report = readCoverageReport(
      join(REPO_ROOT, 'test/fixtures/coverage/landing-probe-coverage-final.snapshot.json'),
      { cwd: '/home/dev/workspaces/playful-otter/landing-page' },
    )
    // Lines 70-72, 84-86, 88-89 and the probe body 93, 94, 96.
    expect(fileGap('src/lib/navigation.ts', report, '/nonexistent')).toBe(11)
  })
})

describe('compareToBaseline (the ratchet)', () => {
  const logicPaths = { include: ['src/**'] }

  function tree(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'vc-ratchet-'))
    mkdirSync(join(dir, 'src'))
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
    return dir
  }

  it('the same count on different line numbers is no finding: nothing in the comparison reads a line number', () => {
    const dir = tree({ 'src/x.ts': 'x\n' })
    try {
      const baseline = new Map<string, number | string>([['src/x.ts', 2]])
      for (const uncovered of [[47, 48], [48, 49], [3, 900]]) {
        const report = reportFrom({ 'src/x.ts': { covered: [1], executable: [1, ...uncovered] } })
        expect(compareToBaseline({ baseline, changedFiles: ['src/x.ts'], report, logicPaths, cwd: dir })).toEqual({
          fresh: [],
          stale: [],
          unmeasured: [],
        })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('NEW: a changed file above its recorded count, or with a gap and no entry; an unchanged file is never NEW', () => {
    const dir = tree({ 'src/grew.ts': 'x\n', 'src/fresh.ts': 'x\n', 'src/bystander.ts': 'x\n' })
    try {
      const report = reportFrom({
        'src/grew.ts': { covered: [], executable: [1, 2, 3] },
        'src/fresh.ts': { covered: [1], executable: [1, 2] },
        'src/bystander.ts': { covered: [], executable: [1, 2, 3] },
      })
      const baseline = new Map<string, number | string>([
        ['src/grew.ts', 2],
        ['src/bystander.ts', 2],
      ])
      const result = compareToBaseline({
        baseline,
        changedFiles: ['src/grew.ts', 'src/fresh.ts'],
        report,
        logicPaths,
        cwd: dir,
      })
      expect(result.fresh).toEqual([
        { file: 'src/fresh.ts', current: 1, recorded: 0 },
        { file: 'src/grew.ts', current: 3, recorded: 2 },
      ])
      expect(result.stale).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('STALE: a lower count names the number to write, zero says delete — for an unchanged file the report covers too', () => {
    const dir = tree({ 'src/shrunk.ts': 'x\n', 'src/closed.ts': 'x\n', 'src/absent.ts': 'x\n' })
    try {
      const report = reportFrom({
        'src/shrunk.ts': { covered: [1, 2], executable: [1, 2, 3] },
        'src/closed.ts': { covered: [1, 2], executable: [1, 2] },
      })
      const baseline = new Map<string, number | string>([
        ['src/shrunk.ts', 4],
        ['src/closed.ts', 2],
        ['src/absent.ts', 5], // not changed, not in the report: nothing is known, nothing is said
      ])
      // Nothing changed on the branch (a test-only change): both are still told to shrink.
      const { fresh, stale } = compareToBaseline({ baseline, changedFiles: [], report, logicPaths, cwd: dir })
      expect(fresh).toEqual([])
      expect(stale).toEqual([
        { file: 'src/closed.ts', recorded: 2, why: '0 uncovered executable line(s) now; delete the entry' },
        { file: 'src/shrunk.ts', recorded: 4, why: '1 uncovered executable line(s) now; lower the entry to 1' },
      ])
      // The report a wrapper writes when it skipped the coverage run ("{}"): no verdict on any entry.
      expect(compareToBaseline({ baseline, changedFiles: [], report: new Map(), logicPaths, cwd: dir })).toEqual({
        fresh: [],
        stale: [],
        unmeasured: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('STALE: an entry whose file is gone, or that left the logic paths, whether or not the branch touched it', () => {
    const dir = tree({ 'src/x.test.ts': 'x\n' })
    try {
      mkdirSync(join(dir, 'tools'))
      writeFileSync(join(dir, 'tools/moved.ts'), 'x\n')
      const baseline = new Map<string, number | string>([
        ['src/gone.ts', 9],
        ['tools/moved.ts', 1],
        ['src/x.test.ts', UNLOADED],
      ])
      const { stale } = compareToBaseline({ baseline, changedFiles: [], report: new Map(), logicPaths, cwd: dir })
      expect(stale.map(({ file, why }) => [file, why])).toEqual([
        ['src/gone.ts', 'the file no longer exists; delete the entry'],
        ['tools/moved.ts', 'the file is no longer under the logic paths; delete the entry'],
        ['src/x.test.ts', 'the file is no longer under the logic paths; delete the entry'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unloaded: recorded and still unloaded is unmeasured; now loaded is STALE; unloaded with no such entry is NEW', () => {
    const dir = tree({
      'src/legacy.ts': 'a\nb\n',
      'src/adopted.ts': 'a\n',
      'src/covered-now.ts': 'a\n',
      'src/brand-new.ts': 'a\n',
      'src/dropped.ts': 'a\n',
    })
    try {
      const report = reportFrom({
        'src/adopted.ts': { covered: [1], executable: [1, 2, 3] },
        'src/covered-now.ts': { covered: [1], executable: [1] },
      })
      const baseline = new Map<string, number | string>([
        ['src/legacy.ts', UNLOADED],
        ['src/adopted.ts', UNLOADED],
        ['src/covered-now.ts', UNLOADED],
        ['src/dropped.ts', 4], // was loaded when seeded; the run no longer loads it
      ])
      const result = compareToBaseline({
        baseline,
        changedFiles: ['src/legacy.ts', 'src/brand-new.ts', 'src/dropped.ts'],
        report,
        logicPaths,
        cwd: dir,
      })
      expect(result.unmeasured).toEqual(['src/legacy.ts'])
      expect(result.fresh).toEqual([
        { file: 'src/brand-new.ts', current: UNLOADED, recorded: 0 },
        { file: 'src/dropped.ts', current: UNLOADED, recorded: 4 },
      ])
      expect(result.stale).toEqual([
        {
          file: 'src/adopted.ts',
          recorded: UNLOADED,
          why: 'the test run now loads it, with 2 uncovered executable line(s); record 2',
        },
        {
          file: 'src/covered-now.ts',
          recorded: UNLOADED,
          why: 'the test run now loads it, with 0 uncovered executable line(s); delete the entry',
        },
      ])
      // A comment added to the recorded-unloaded file changes nothing: no line count is read.
      writeFileSync(join(dir, 'src/legacy.ts'), '// a comment\na\nb\n')
      expect(
        compareToBaseline({ baseline, changedFiles: ['src/legacy.ts'], report: new Map(), logicPaths, cwd: dir }).fresh,
      ).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Runs the check and returns what it decided and said.
function runCheck(opts: Parameters<typeof checkUntestedCoverage>[0]) {
  const errors: string[] = []
  const logs: string[] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line) => void errors.push(String(line)))
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => void logs.push(String(line)))
  try {
    process.exitCode = undefined
    checkUntestedCoverage(opts)
    return { exitCode: process.exitCode, errors, logs }
  } finally {
    process.exitCode = undefined
    errorSpy.mockRestore()
    logSpy.mockRestore()
  }
}

describe('checkUntestedCoverage refuses loudly what it cannot run on', () => {
  it('a missing option, a seed over zero logic files, and a baseline that is not JSON all throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-refuse-'))
    try {
      writeFileSync(join(dir, 'coverage.info'), 'SF:lib/a.js\nDA:1,1\nend_of_record\n')
      const opts = {
        logicPaths: { include: ['lib/**'] },
        coverageReportPath: 'coverage.info',
        baselinePath: 'untested.json',
        cwd: dir,
      }
      expect(() => checkUntestedCoverage({ ...opts, logicPaths: undefined })).toThrow(/logicPaths is required/)
      expect(() => checkUntestedCoverage({ ...opts, coverageReportPath: undefined })).toThrow(/coverageReportPath is required/)
      expect(() => checkUntestedCoverage({ ...opts, baselinePath: undefined })).toThrow(/baselinePath is required/)
      expect(() => checkUntestedCoverage({ ...opts, argv: ['--write-baseline'] })).toThrow(/matched zero files for seeding/)
      writeFileSync(join(dir, 'untested.json'), '{ "format": ')
      expect(() => checkUntestedCoverage(opts)).toThrow(/baseline untested\.json is not valid JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The end-to-end proof on node's own lcov (the backend's runner): a tmp git
// repo whose tests really execute under node --test
// --experimental-test-coverage, so the covered/uncovered lines are measured,
// never hand-written.
describe('checkUntestedCoverage end-to-end (real git + a real node --test lcov run)', () => {
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

  it('seeds the historical gap, passes its re-touch and a shift, and fails a NEW uncovered line', () => {
    const repo = repoWithCalc()
    try {
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      // No baseline yet: the check directs to --write-baseline.
      const missing = runCheck(opts)
      expect(missing.exitCode).toBe(1)
      expect(missing.errors.join('\n')).toContain('Create it once with --write-baseline')

      // Seed over the whole tree (not the diff): calc.js's two unexecuted lines land as a count.
      expect(runCheck({ ...opts, argv: ['--write-baseline'] }).exitCode).toBeUndefined()
      expect(readFileSync(join(repo.dir, 'verify-baselines/untested.json'), 'utf8')).toBe(
        baselineJson({ 'lib/calc.js': 2 }),
      )
      // A second seed refuses: a regenerated baseline asserts nothing.
      const reseed = runCheck({ ...opts, argv: ['--write-baseline'] })
      expect(reseed.exitCode).toBe(1)
      expect(reseed.errors.join('\n')).toContain('refusing to overwrite')
      repo.addAll()
      repo.commit('seed the untested baseline')
      expect(runCheck(opts).exitCode).toBeUndefined()

      // A re-touch INSIDE the recorded historical gap passes (plan Q4's
      // anti-fire rule) and is named on stdout; a NEW uncovered function fails.
      repo.write(
        'lib/calc.js',
        CALC.replace("return 'negative'", "return 'NEGATIVE'") +
          'export function uncovered() {\n  return 42\n}\n',
      )
      repo.addAll()
      repo.commit('reword the gap, add a function no test reaches')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const grown = runCheck(opts)
      expect(grown.exitCode).toBe(1)
      expect(grown.errors[0]).toMatch(/^untested: NEW lib\/calc\.js — 4 uncovered executable line\(s\), 2 recorded; changed lines not executed by the test run: 3-4, 8-9;/)
      expect(grown.errors.at(-1)).toBe('untested: 1 new, 0 stale (baseline verify-baselines/untested.json)')

      // Drop the uncovered addition: the in-gap edit alone passes.
      repo.write('lib/calc.js', CALC.replace("return 'negative'", "return 'NEGATIVE'"))
      repo.addAll()
      repo.commit('drop the uncovered function')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const retouched = runCheck(opts)
      expect(retouched.exitCode).toBeUndefined()
      expect(retouched.logs).toContain(
        'untested: lib/calc.js — changed lines not executed by the test run: 3-4 (within the 2 recorded for the file)',
      )

      // The backend-#80 probe's shape, on the runner the backend uses: one
      // comment line prepended, every recorded line now one lower.
      repo.write('lib/calc.js', '// a comment above the gap\n' + CALC)
      repo.addAll()
      repo.commit('prepend a comment')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      // (`main` is this fixture's empty root commit, so the whole file is the
      // branch's change and its two recorded lines are named on stdout.)
      expect(runCheck(opts)).toEqual({
        exitCode: undefined,
        errors: [],
        logs: ['untested: lib/calc.js — changed lines not executed by the test run: 4-5 (within the 2 recorded for the file)'],
      })

      // The limit of this runner's report: node gives every line a DA record,
      // so a comment and a blank line inside the never-run block are two more
      // zero-hit lines. (The vitest suite below holds the same edit at exit 0.)
      repo.write('lib/calc.js', CALC.replace("    return 'negative'", "    // why negative\n\n    return 'negative'"))
      repo.addAll()
      repo.commit('comment the never-run block')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const inside = runCheck(opts)
      expect(inside.exitCode).toBe(1)
      expect(inside.errors[0]).toMatch(/^untested: NEW lib\/calc\.js — 4 uncovered executable line\(s\), 2 recorded;/)

      // New uncovered lines prepended (the old gap shifts down by three): the count grew.
      repo.write(
        'lib/calc.js',
        "export function brandNew() {\n  return 'never called'\n}\n" + CALC,
      )
      repo.addAll()
      repo.commit('prepend a new uncovered function (shifts the old gap)')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      expect(runCheck(opts).exitCode).toBe(1)
    } finally {
      repo.cleanup()
    }
  })

  it('a covered change passes with an empty baseline; a trailer-declared change is named and passes', () => {
    const repo = repoWithCalc()
    try {
      // Cover everything: test both paths, and commit an empty baseline.
      repo.write(
        'lib/calc.test.js',
        CALC_TEST + "test('negative', () => assert.equal(classify(-2), 'negative'))\n",
      )
      repo.write('verify-baselines/untested.json', baselineJson({}))
      repo.addAll()
      repo.commit('cover the negative path')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      expect(runCheck(opts).exitCode).toBeUndefined()

      // A trailer-declared change the test run never loads: named as declared, not NEW.
      repo.write('lib/self-testing.js', 'export const ok = true\n')
      repo.addAll()
      repo.commit('add self-testing script\n\nUntested: lib/self-testing.js — exercised by its own --self-test leg')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const declared = runCheck(opts)
      expect(declared.exitCode).toBeUndefined()
      expect(declared.logs).toContain('untested: lib/self-testing.js — declared: exercised by its own --self-test leg')

      // A trailer-declared file that is ALSO recorded and GROWS: the trailer
      // is the escape for the whole instrument, the count included.
      repo.write('lib/gen.js', 'export function a() {\n  return 1\n}\n')
      repo.write('lib/gen.test.js', "import './gen.js'\n")
      repo.write('verify-baselines/untested.json', baselineJson({ 'lib/gen.js': 2 }))
      repo.addAll()
      repo.commit('record a generated file\n\nUntested: lib/gen.js — generated file, no runtime path to test')
      repo.write('lib/gen.js', 'export function a() {\n  return 1\n}\nexport function b() {\n  return 2\n}\n')
      repo.addAll()
      repo.commit('regenerate\n\nUntested: lib/gen.js — generated file, no runtime path to test')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const report = readCoverageReport(join(repo.dir, 'coverage.info'), { cwd: repo.dir })
      expect(fileGap('lib/gen.js', report, repo.dir)).toBeGreaterThan(2) // it did grow
      expect(runCheck(opts).exitCode).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })

  it('a file the run never loads: NEW with no entry; seeded as unloaded it passes, comment or code, with a note', () => {
    const repo = repoWithCalc()
    try {
      repo.write('lib/orphan.js', 'export const orphan = 1\n')
      repo.addAll()
      repo.commit('add a file no test imports')
      writeFileSync(join(repo.dir, 'coverage.info'), runCoverage(repo.dir))
      const opts = OPTS(repo.dir)
      repo.write('verify-baselines/untested.json', baselineJson({ 'lib/calc.js': 2 }))
      const unrecorded = runCheck(opts)
      expect(unrecorded.exitCode).toBe(1)
      expect(unrecorded.errors[0]).toMatch(/^untested: NEW lib\/orphan\.js — the test run never loads it/)

      rmSync(join(repo.dir, 'verify-baselines/untested.json'))
      runCheck({ ...opts, argv: ['--write-baseline'] })
      expect(readFileSync(join(repo.dir, 'verify-baselines/untested.json'), 'utf8')).toBe(
        baselineJson({ 'lib/calc.js': 2, 'lib/orphan.js': 'unloaded' }),
      )
      repo.write('lib/orphan.js', '// a comment\nexport const orphan = 1\nexport const more = 2\n')
      repo.addAll()
      repo.commit('edit the unloaded file')
      const edited = runCheck(opts)
      expect(edited.exitCode).toBeUndefined()
      expect(edited.logs).toContain(
        'untested: lib/orphan.js — recorded as unloaded: the test run never loads it, so this change is not measured',
      )
    } finally {
      repo.cleanup()
    }
  })
})

// The line-shift cases (R3-1187), on a report with statement precision: a
// real vitest run with the v8 provider — this repo's own runner — inside the
// fixture repository. `main` holds the code and a baseline the check itself
// seeded; each case is a branch off it.
describe('line shifts change no verdict (real git + a real vitest coverage run)', () => {
  const TIMEOUT = 60_000
  const VITEST = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs')

  // Two never-run blocks: `negative` (lines 3-4 hold its one statement at 3)
  // and the whole of `unused` (statement at 9).
  const CALC = [
    'export function classify(n) {', //  1
    '  if (n < 0) {', //                 2
    "    return 'negative'", //          3  never executed
    '  }', //                            4
    '  return Math.abs(n)', //           5
    '}', //                              6
    '', //                               7
    'export function unused() {', //     8
    '  return 0', //                     9  never executed
    '}', //                             10
    '',
  ].join('\n')
  const CALC_TEST = `import { expect, test } from 'vitest'
import { classify } from './calc.js'
test('positive', () => expect(classify(2)).toBe(2))
`
  const NEGATIVE_TEST = "test('negative', () => expect(classify(-2)).toBe('negative'))\n"

  function fixture() {
    const repo = gitFixture()
    // The report keys are real paths; on macOS the tmp dir is a symlink.
    const dir = realpathSync(repo.dir)
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'))
    repo.write('.gitignore', 'node_modules\ncoverage\n')
    const opts = {
      base: 'main',
      logicPaths: { include: ['lib/**'] },
      coverageReportPath: 'coverage/coverage-final.json',
      baselinePath: 'verify-baselines/untested.json',
      cwd: dir,
    }
    const cover = () => {
      rmSync(join(dir, 'coverage'), { recursive: true, force: true })
      execFileSync(
        process.execPath,
        [VITEST, 'run', '--root', dir, '--coverage', '--coverage.reporter=json', '--coverage.include=lib/**'],
        { cwd: dir, stdio: 'pipe' },
      )
    }
    const commitAll = (message: string) => {
      repo.addAll()
      repo.commit(message)
    }
    repo.write('lib/calc.js', CALC)
    repo.write('lib/calc.test.js', CALC_TEST)
    commitAll('add classify')
    cover()
    expect(runCheck({ ...opts, argv: ['--write-baseline'] }).exitCode).toBeUndefined()
    commitAll('seed the untested baseline')
    repo.git(['checkout', '-q', 'main'])
    repo.git(['merge', '-q', '--ff-only', 'feature'])
    repo.git(['checkout', '-q', '-b', 'change'])
    const baselineText = () => readFileSync(join(dir, 'verify-baselines/untested.json'), 'utf8')
    return { ...repo, dir, opts, cover, commitAll, baselineText, check: () => runCheck(opts) }
  }

  it('the seed is one count for the file, and the untouched branch passes', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      expect(repo.baselineText()).toBe(baselineJson({ 'lib/calc.js': 2 }))
      expect(repo.check()).toEqual({ exitCode: undefined, errors: [], logs: [] })
    } finally {
      repo.cleanup()
    }
  })

  it('a comment line inserted above a recorded gap passes, with no baseline edit', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      repo.write('lib/calc.js', '// one comment line; every recorded gap is now a line lower\n' + CALC)
      repo.commitAll('prepend a comment')
      repo.cover()
      expect(repo.check()).toEqual({ exitCode: undefined, errors: [], logs: [] })
      expect(repo.git(['diff', '--name-only', 'main', '--', 'verify-baselines'])).toBe('')
    } finally {
      repo.cleanup()
    }
  })

  it('a line inserted inside a gap passes: a comment and a blank line in the never-run block', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      repo.write('lib/calc.js', CALC.replace("    return 'negative'", "    // why negative\n\n    return 'negative'"))
      repo.commitAll('comment the never-run block')
      repo.cover()
      expect(repo.check()).toEqual({ exitCode: undefined, errors: [], logs: [] })
    } finally {
      repo.cleanup()
    }
  })

  it('an import added and a function moved pass: the gaps travel, the count does not', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      const [classify, unused] = CALC.split('\n\n')
      repo.write('lib/calc.js', `import { sep } from 'node:path'\n\n${unused.trimEnd()}\n\n${classify}\n\nexport const SEP = sep\n`)
      repo.commitAll('add an import, move unused() above classify()')
      repo.cover()
      const result = repo.check()
      expect(result.errors).toEqual([])
      expect(result.exitCode).toBeUndefined()
      // The moved body is this branch's own unexecuted line: said, not failed.
      expect(result.logs).toEqual([
        'untested: lib/calc.js — changed lines not executed by the test run: 4 (within the 2 recorded for the file)',
      ])
    } finally {
      repo.cleanup()
    }
  })

  it('a new uncovered line in a file with a recorded gap fails as NEW, naming the line', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      repo.write('lib/calc.js', '// shifted as well\n' + CALC + 'export function added() {\n  return 1\n}\n')
      repo.commitAll('add a function no test reaches')
      repo.cover()
      expect(repo.check()).toEqual({
        exitCode: 1,
        errors: [
          'untested: NEW lib/calc.js — 3 uncovered executable line(s), 2 recorded; changed lines not executed by the test run: 13; ' +
            'cover the new lines, or declare the file with an Untested: trailer',
          'untested: 1 new, 0 stale (baseline verify-baselines/untested.json)',
        ],
        logs: [],
      })
    } finally {
      repo.cleanup()
    }
  })

  it('a covered gap line is reported STALE until the entry is lowered — on a test-only branch too', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      // Only the test file changes: lib/calc.js is not in the diff at all.
      repo.write('lib/calc.test.js', CALC_TEST + NEGATIVE_TEST)
      repo.commitAll('cover the negative path')
      repo.cover()
      expect(repo.check()).toEqual({
        exitCode: 1,
        errors: [
          'untested: STALE lib/calc.js (recorded 2) — 1 uncovered executable line(s) now; lower the entry to 1',
          'untested: 0 new, 1 stale (baseline verify-baselines/untested.json)',
        ],
        logs: [],
      })
      repo.write('verify-baselines/untested.json', baselineJson({ 'lib/calc.js': 1 }))
      repo.commitAll('the gap shrank; so does the entry')
      expect(repo.check().exitCode).toBeUndefined()

      // Close the last gap: the entry must go, not sit at a number nothing matches.
      repo.write('lib/calc.test.js', CALC_TEST.replace('{ classify }', '{ classify, unused }') + NEGATIVE_TEST + "test('unused', () => expect(unused()).toBe(0))\n")
      repo.commitAll('cover unused()')
      repo.cover()
      expect(repo.check().errors[0]).toBe(
        'untested: STALE lib/calc.js (recorded 1) — 0 uncovered executable line(s) now; delete the entry',
      )
      repo.write('verify-baselines/untested.json', baselineJson({}))
      repo.commitAll('no gap, no entry')
      expect(repo.check().exitCode).toBeUndefined()
    } finally {
      repo.cleanup()
    }
  })

  it("a deleted file's entry is STALE", { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      repo.git(['rm', '-q', 'lib/calc.js', 'lib/calc.test.js'])
      repo.write('lib/other.js', 'export const other = 1\n')
      repo.write('lib/other.test.js', "import { expect, test } from 'vitest'\nimport { other } from './other.js'\ntest('other', () => expect(other).toBe(1))\n")
      repo.commitAll('replace calc with other')
      repo.cover()
      expect(repo.check()).toEqual({
        exitCode: 1,
        errors: [
          'untested: STALE lib/calc.js (recorded 2) — the file no longer exists; delete the entry',
          'untested: 0 new, 1 stale (baseline verify-baselines/untested.json)',
        ],
        logs: [],
      })
    } finally {
      repo.cleanup()
    }
  })

  it('an old-format baseline is refused with the re-seed command, and seeding over it is refused too', { timeout: TIMEOUT }, () => {
    const repo = fixture()
    try {
      // What 0.9.0 seeded for this very tree: line ranges.
      const legacy = '[\n  "lib/calc.js|3",\n  "lib/calc.js|9"\n]\n'
      repo.write('verify-baselines/untested.json', legacy)
      repo.commitAll('a line-range baseline')
      const refusal =
        'untested: verify-baselines/untested.json is a line-range baseline ("file|start-end" entries, verify-checks 0.9 and earlier). ' +
        'This version records one uncovered-line count per file and does not read line ranges. ' +
        'Re-seed it: rm verify-baselines/untested.json && npm run check:untested -- --write-baseline, then commit the new file.'
      expect(repo.check()).toEqual({ exitCode: 1, errors: [refusal], logs: [] })
      expect(runCheck({ ...repo.opts, argv: ['--write-baseline'] })).toEqual({ exitCode: 1, errors: [refusal], logs: [] })
      expect(repo.baselineText()).toBe(legacy)

      // The command it names: remove, then seed.
      rmSync(join(repo.dir, 'verify-baselines/untested.json'))
      expect(runCheck({ ...repo.opts, argv: ['--write-baseline'] }).exitCode).toBeUndefined()
      expect(repo.baselineText()).toBe(baselineJson({ 'lib/calc.js': 2 }))
    } finally {
      repo.cleanup()
    }
  })
})
