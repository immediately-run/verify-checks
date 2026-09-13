import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain .mjs source, no types published for the internals
import { assertFreshInstall } from '../src/installFreshness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'install-freshness')

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'install-freshness-'))
  temps.push(dir)
  return dir
}

/**
 * Materialise one of the frozen npm-produced pairs at the paths npm itself uses. The
 * fixture is stored flat because `node_modules` is gitignored — see the fixture
 * README — so the directory shape is rebuilt here rather than committed.
 */
const treeWith = (installed: 'fresh' | 'stale'): string => {
  const dir = scratch()
  copyFileSync(join(fixtures, 'project.lock.json'), join(dir, 'package-lock.json'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  copyFileSync(join(fixtures, `installed.${installed}.json`), join(dir, 'node_modules', '.package-lock.json'))
  return dir
}

describe('assertFreshInstall over REAL npm lock pairs (R3-628)', () => {
  it('says nothing when the installed tree matches the lockfile', () => {
    expect(() => assertFreshInstall({ cwd: treeWith('fresh'), check: 'unused' })).not.toThrow()
  })

  it('refuses, and names the package, both versions and the fix, when the tree is behind', () => {
    let message = ''
    try {
      assertFreshInstall({ cwd: treeWith('stale'), check: 'unused' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/^unused: refusing to render a verdict/)
    expect(message).toContain('node_modules/leven')
    expect(message).toContain('4.0.0') // what the lockfile wants
    expect(message).toContain('3.1.0') // what is installed
    expect(message).toContain('npm ci')
  })

  it('refuses when the hidden lockfile is absent — undetermined is not a pass', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    expect(() => assertFreshInstall({ cwd: dir, check: 'clones' })).toThrow(/cannot be determined/i)
  })

  it('passes a directory with no lockfile at all — nothing to be stale against', () => {
    expect(() => assertFreshInstall({ cwd: scratch(), check: 'unused' })).not.toThrow()
  })

  it('carries the calling check’s name, so the reader knows what refused', () => {
    expect(() => assertFreshInstall({ cwd: treeWith('stale'), check: 'clones' })).toThrow(/^clones:/)
  })
})

describe('the guard actually gates the checks it is wired into', () => {
  // Inspection cannot show a guard fires. These drive the real exported checks against
  // a stale tree and assert they refuse BEFORE producing a verdict — the whole point
  // being that no STALE advice is ever printed in that state.
  it('checkUnused refuses on a stale tree instead of rendering findings', async () => {
    // @ts-expect-error — plain .mjs source
    const { checkUnused } = await import('../src/check-unused.mjs')
    await expect(
      checkUnused({ baselinePath: 'verify-baselines/unused.json', cwd: treeWith('stale') }),
    ).rejects.toThrow(/refusing to render a verdict/)
  })

  it('checkClones refuses on a stale tree instead of rendering findings', async () => {
    // @ts-expect-error — plain .mjs source
    const { checkClones } = await import('../src/check-clones.mjs')
    await expect(
      checkClones({
        patterns: ['src/**/*.mjs'],
        baselinePath: 'verify-baselines/clones.json',
        cwd: treeWith('stale'),
      }),
    ).rejects.toThrow(/refusing to render a verdict/)
  })
})
