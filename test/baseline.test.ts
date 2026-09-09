import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cloneFragments, commitTrailers, changedSince, knipFingerprints, runJscpd, runKnip } from '../src/producers.mjs'
import { diffAgainstBaseline, fingerprint, readBaseline } from '../src/baseline.mjs'
import { untestedFiles } from '../src/check-untested.mjs'

const REPO_ROOT = new URL('..', import.meta.url).pathname

describe('diffAgainstBaseline', () => {
  it('a new fingerprint fails (shows up in .new)', () => {
    const { new: fresh, stale } = diffAgainstBaseline(['aaa'], [])
    expect(fresh).toEqual(['aaa'])
    expect(stale).toEqual([])
  })

  it('a stale entry fails, with the entry named', () => {
    const { new: fresh, stale } = diffAgainstBaseline([], ['bbb'])
    expect(fresh).toEqual([])
    expect(stale).toEqual(['bbb'])
  })

  it('identical sets pass', () => {
    const { new: fresh, stale } = diffAgainstBaseline(['x', 'y'], ['y', 'x'])
    expect(fresh).toEqual([])
    expect(stale).toEqual([])
  })
})

// One case runs the REAL producer — jscpd over the committed two-file fixture —
// so fingerprinting consumes jscpd's actual output shape, not a hand-typed
// object shaped like what we believe jscpd emits.
describe('runJscpd (real producer)', () => {
  it('reports the duplicated fixture function and its fragments feed the ratchet', { timeout: 180_000 }, () => {
    const report = runJscpd({
      patterns: ['test/fixtures/clones'],
      cwd: REPO_ROOT,
    })
    const fragments = cloneFragments(report)
    expect(fragments.length).toBeGreaterThan(0)
    expect(fragments.some((fragment) => fragment.includes('formatTileLabel'))).toBe(true)

    const found = fragments.map((fragment) => fingerprint(fragment))
    const { new: fresh, stale } = diffAgainstBaseline(found, [])
    expect(fresh).toEqual([...found].sort())
    expect(stale).toEqual([])
  })
})

describe('untestedFiles', () => {
  const logicPaths = { include: ['src/lib/**', 'scripts/**'] }

  it('a logic file with a sibling test passes', () => {
    const { untested } = untestedFiles({
      changed: ['src/lib/foo.ts'],
      tests: ['src/lib/foo.test.ts'],
      logicPaths,
    })
    expect(untested).toEqual([])
  })

  it('a logic file without one fails; files outside logicPaths are ignored', () => {
    const { untested } = untestedFiles({
      changed: ['src/lib/foo.ts', 'src/ui/bar.tsx'],
      tests: [],
      logicPaths,
    })
    expect(untested).toEqual(['src/lib/foo.ts'])
  })

  it('a trailer passes the file and its reason appears in the declared output', () => {
    const { untested, declared } = untestedFiles({
      changed: ['src/lib/foo.ts'],
      tests: [],
      trailers: [{ file: 'src/lib/foo.ts', reason: 'drives the live host only' }],
      logicPaths,
    })
    expect(untested).toEqual([])
    expect(declared).toEqual([{ file: 'src/lib/foo.ts', reason: 'drives the live host only' }])
  })

  it('a test file under the logic paths is the supply, never a file that owes a test', () => {
    const { untested } = untestedFiles({
      changed: ['src/lib/routes.test.ts', 'scripts/check-x.test.mjs', 'src/lib/foo.ts'],
      tests: [],
      logicPaths,
    })
    expect(untested).toEqual(['src/lib/foo.ts'])
  })
})

// The git-reading path, exercised by the real producer: commits on a branch
// off main — the PR shape the check consumes — including a DELETED file, which
// must not be demanded a sibling test.
describe('changedSince + commitTrailers (real git)', () => {
  it('reads the merge-base diff (creations, edits, deletions) and the trailer bodies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-git-'))
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    try {
      git(['init', '-b', 'main'])
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
      // work on a branch off main, exactly the PR shape the check consumes:
      // merge-base(main, HEAD) is the first commit, so the diff is everything since
      git(['checkout', '-b', 'feature'])
      writeFileSync(join(dir, 'lib-logic-file.ts'), 'export const x = 1\n')
      writeFileSync(join(dir, 'lib-gone-file.ts'), 'export const y = 2\n')
      git(['add', '.'])
      git([
        '-c', 'user.email=t@t', '-c', 'user.name=t',
        'commit', '-m', 'add logic\n\nUntested: lib-logic-file.ts -- no runner in this fixture',
      ])
      writeFileSync(join(dir, 'lib-logic-file.ts'), 'export const x = 2\n')
      execFileSync('git', ['rm', '-q', 'lib-gone-file.ts'], { cwd: dir })
      git([
        '-c', 'user.email=t@t', '-c', 'user.name=t',
        'commit', '-q', '-m', 'drop a logic file (its test leaves with it)',
      ])
      const changed = changedSince('main', dir)
      expect(changed).toContain('lib-logic-file.ts')
      // the deletion is not listed: a deleted file owes nobody a test
      expect(changed).not.toContain('lib-gone-file.ts')
      expect(commitTrailers('main', dir)).toEqual([
        { file: 'lib-logic-file.ts', reason: 'no runner in this fixture' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// knip's REAL output over this repo feeds the parser, so a reporter shape
// change cannot pass a hand-typed fixture again.
describe('runKnip + knipFingerprints (real producer)', () => {
  it('reports this repo\'s unimported fixtures as unused files', { timeout: 180_000 }, () => {
    const report = runKnip({ cwd: REPO_ROOT })
    const fingerprints = knipFingerprints(report)
    expect(fingerprints).toContain('test/fixtures/clones/a.ts:(file)')
    expect(fingerprints).toContain('test/fixtures/clones/b.ts:(file)')
  })
})

describe('knipFingerprints', () => {
  // Recorded from knip 6.34.0's real `--reporter json` output (run over this
  // repo), so the parser consumes the shape knip actually emits.
  const recorded = {
    issues: [
      {
        file: 'test/fixtures/clones/a.ts',
        binaries: [],
        dependencies: [],
        exports: [],
        files: [{ name: 'test/fixtures/clones/a.ts' }],
      },
      {
        file: 'src/lib/legacy.ts',
        binaries: [],
        dependencies: [{ name: 'jscpd', line: 3, col: 6, pos: 90 }],
        exports: [{ name: 'oldHelper', line: 5, col: 14, pos: 120 }],
        files: [],
      },
      {
        file: 'package.json',
        binaries: [],
        dependencies: [{ name: 'jscpd', line: 30, col: 6, pos: 909 }],
        exports: [],
        files: [],
      },
    ],
  }

  // R3-572 widened this: until then the fingerprinter read `files` and `exports` only, and
  // this case pinned that as a decision ("dependencies are out of scope"). It was the wrong
  // decision — an unused dependency is supply-chain surface carried for nothing, and the
  // narrow read also discarded `types`, so 15 unused exported types passed `verify` in
  // `immediately-run-backend` with no baseline able to record them. The expectation below is
  // therefore larger on purpose; `test/producers.test.ts` holds the widened contract against
  // a real captured report.
  it('baselines files, exports and dependencies in one fingerprint vocabulary', () => {
    expect(knipFingerprints(recorded).sort()).toEqual([
      'package.json:jscpd',
      'src/lib/legacy.ts:jscpd',
      'src/lib/legacy.ts:oldHelper',
      'test/fixtures/clones/a.ts:(file)',
    ])
  })
})

describe('baseline ratchet', () => {
  it('writeBaselineFile dedupes and sorts', async () => {
    const { writeBaselineFile, readBaseline } = await import('../src/baseline.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'vc-write-'))
    try {
      const path = join(dir, 'b.json')
      writeBaselineFile(path, ['z', 'a', 'z'])
      expect(readBaseline(path)).toEqual(['a', 'z'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--write-baseline refuses to overwrite an existing baseline', async () => {
    const { ratchet } = await import('../src/baseline.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'vc-refuse-'))
    try {
      const path = join(dir, 'b.json')
      writeFileSync(path, '["existing"]\n')
      const errSpy = []
      const originalError = console.error
      console.error = (...args) => errSpy.push(args.join(' '))
      try {
        await ratchet({ check: 'clones', findings: ['x'], baselinePath: path, argv: ['--write-baseline'] })
      } finally {
        console.error = originalError
      }
      expect(process.exitCode).toBe(1)
      expect(errSpy.join('\n')).toMatch(/refusing to overwrite/)
      process.exitCode = 0
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matchesAny honours exclude', async () => {
    const { matchesAny } = await import('../src/check-untested.mjs')
    const config = { include: ['src/**'], exclude: ['src/index.ts'] }
    expect(matchesAny('src/lib/a.ts', config)).toBe(true)
    expect(matchesAny('src/index.ts', config)).toBe(false)
    expect(matchesAny('docs/a.md', config)).toBe(false)
  })
})

describe('check-publish-version helpers', () => {
  // versionPublished against stub npm executables — the three outcomes must
  // stay three: published, E404-not-published, and indeterminate.
  function stubNpm(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vc-npm-'))
    const path = join(dir, 'npm-stub')
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('versionPublished: true when the version answers, false on E404, throws when indeterminate', async () => {
    const { versionPublished } = await import('../scripts/check-publish-version.mjs')
    const published = stubNpm(`echo "0.1.0"`)
    const notPublished = stubNpm(`echo "npm error code E404" >&2; exit 1`)
    const broken = stubNpm(`echo "npm error network ECONNREFUSED" >&2; exit 1`)
    try {
      expect(versionPublished('p', '0.1.0', published)).toBe(true)
      expect(versionPublished('p', '0.1.0', notPublished)).toBe(false)
      expect(() => versionPublished('p', '0.1.0', broken)).toThrow(/indeterminate/)
    } finally {
      for (const p of [published, notPublished, broken]) rmSync(join(p, '..'), { recursive: true, force: true })
    }
  })

  it('shipsChanges: src counts, tests/docs/CI do not', async () => {
    const { shipsChanges } = await import('../scripts/check-publish-version.mjs')
    expect(shipsChanges(['src/producers.mjs'])).toBe(true)
    expect(shipsChanges(['package-lock.json'])).toBe(true)
    expect(shipsChanges(['src/index.test.ts', 'test/x.ts', 'README.md', '.github/workflows/ci.yml'])).toBe(false)
  })
})

describe('readBaseline', () => {
  it('rejects a non-array baseline loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-baseline-'))
    try {
      const path = join(dir, 'b.json')
      writeFileSync(path, '{"not":"an array"}')
      expect(() => readBaseline(path)).toThrow(/JSON array/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
