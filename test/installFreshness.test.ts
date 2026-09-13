import { describe, expect, it } from 'vitest'

// @ts-expect-error — plain .mjs source, no types published for the internals
import { compareInstallToLock, describeStaleInstall } from '../src/installFreshness.mjs'

/** A lockfile-shaped object. Paths are npm's: "" is the project, dependencies live
 *  under node_modules/. */
const lockOf = (packages: Record<string, unknown>) => ({
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: { '': { name: 'demo', version: '1.0.0' }, ...packages },
})

describe('compareInstallToLock (R3-628)', () => {
  it('a tree that matches the lock is fresh', () => {
    const packages = { 'node_modules/left-pad': { version: '1.3.0' } }
    const result = compareInstallToLock({ lock: lockOf(packages), installed: lockOf(packages) })
    expect(result).toEqual({ fresh: true, mismatches: [], missing: [] })
  })

  it('names both versions when a package is installed at the wrong one', () => {
    const result = compareInstallToLock({
      lock: lockOf({ 'node_modules/left-pad': { version: '1.3.0' } }),
      installed: lockOf({ 'node_modules/left-pad': { version: '1.2.0' } }),
    })
    expect(result.fresh).toBe(false)
    expect(result.mismatches).toEqual([
      { path: 'node_modules/left-pad', wanted: '1.3.0', installed: '1.2.0' },
    ])
  })

  it('reports a package the lock names and the tree does not have', () => {
    // The site-main shape: whole packages absent from the installed tree.
    const result = compareInstallToLock({
      lock: lockOf({ 'node_modules/knip': { version: '5.0.0' } }),
      installed: lockOf({}),
    })
    expect(result.fresh).toBe(false)
    expect(result.missing).toEqual([{ path: 'node_modules/knip', wanted: '5.0.0' }])
  })

  it('an empty installed tree is stale, not fresh', () => {
    const result = compareInstallToLock({
      lock: lockOf({ 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' } }),
      installed: { packages: {} },
    })
    expect(result.fresh).toBe(false)
    expect(result.missing).toHaveLength(2)
  })

  it('a package present ONLY in the tree is not staleness', () => {
    // A link or an extra install does not mean the tree is behind; flagging it would
    // make the guard cry wolf on working checkouts.
    const result = compareInstallToLock({
      lock: lockOf({ 'node_modules/a': { version: '1.0.0' } }),
      installed: lockOf({
        'node_modules/a': { version: '1.0.0' },
        'node_modules/extra': { version: '9.9.9' },
      }),
    })
    expect(result.fresh).toBe(true)
  })

  it('ignores the project root entry, whose version legitimately differs mid-bump', () => {
    const result = compareInstallToLock({
      lock: { packages: { '': { name: 'demo', version: '2.0.0' } } },
      installed: { packages: { '': { name: 'demo', version: '1.0.0' } } },
    })
    expect(result.fresh).toBe(true)
  })

  it('ignores link and optional entries, which need not be installed here', () => {
    const result = compareInstallToLock({
      lock: lockOf({
        'node_modules/linked': { version: '1.0.0', link: true },
        'node_modules/platform-only': { version: '1.0.0', optional: true },
      }),
      installed: lockOf({}),
    })
    expect(result.fresh).toBe(true)
  })

  it('ignores a lock entry with no concrete version', () => {
    const result = compareInstallToLock({
      lock: lockOf({ 'node_modules/weird': { resolved: 'file:../weird' } }),
      installed: lockOf({}),
    })
    expect(result.fresh).toBe(true)
  })

  it('is total for a malformed lockfile rather than throwing mid-check', () => {
    expect(compareInstallToLock({ lock: null, installed: null }).fresh).toBe(true)
    expect(compareInstallToLock({ lock: { packages: 'nope' }, installed: {} }).fresh).toBe(true)
  })
})

describe('describeStaleInstall — the reader must be able to act on it', () => {
  it('names the package, both versions, and the command that fixes it', () => {
    const text = describeStaleInstall(
      {
        mismatches: [{ path: 'node_modules/left-pad', wanted: '1.3.0', installed: '1.2.0' }],
        missing: [],
      },
      { cwd: '/repo' },
    )
    expect(text).toContain('node_modules/left-pad')
    expect(text).toContain('1.3.0')
    expect(text).toContain('1.2.0')
    expect(text).toContain('npm ci')
    expect(text).toContain('/repo')
  })

  it('says why it refused, not only what it saw', () => {
    const text = describeStaleInstall({ mismatches: [], missing: [{ path: 'node_modules/a', wanted: '1.0.0' }] })
    expect(text).toMatch(/refusing to render a verdict/i)
    expect(text).toMatch(/baseline entries that are correct/i)
  })

  it('summarises a long list instead of printing 180 lines', () => {
    const missing = Array.from({ length: 180 }, (_, i) => ({ path: `node_modules/p${i}`, wanted: '1.0.0' }))
    const text = describeStaleInstall({ mismatches: [], missing })
    expect(text).toContain('…and 175 more')
    expect(text.split('\n').length).toBeLessThan(12)
  })
})
