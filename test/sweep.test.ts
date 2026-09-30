import { describe, expect, it } from 'vitest'
import { collectLayout, judgeLayout, judgeOverlay } from '../src/sweep.mjs'
import clean from './fixtures/sweep/clean.json'
import empty from './fixtures/sweep/empty.json'
import overlayClipped from './fixtures/sweep/overlay-clipped.json'
import overlayDetached from './fixtures/sweep/overlay-detached.json'
import r3569Nav from './fixtures/sweep/r3-569-nav.json'
import r3738Progress from './fixtures/sweep/r3-738-progress.json'
import r3739Menu from './fixtures/sweep/r3-739-menu.json'
import targetSmall from './fixtures/sweep/target-small.json'
import wrapped from './fixtures/sweep/wrapped.json'

// Plain-data fixtures, each modelled on a measured bug and named after it
// (see the fixture _comment fields). Fingerprints are asserted exactly: they
// are the baseline's contract.

describe('judgeLayout', () => {
  it('r3-569-nav: a nav wider than the 390px viewport → overflow-x and offscreen for the burger', () => {
    expect(judgeLayout(r3569Nav as any, { route: '/', viewport: '390x844', minTarget: 44 })).toEqual([
      'offscreen|/|390x844|burger',
      'overflow-x|/|390x844',
    ])
  })

  it('r3-738-progress: a region painting over the header occludes the menu button', () => {
    expect(judgeLayout(r3738Progress as any, { route: '/', viewport: '390x844', minTarget: 44 })).toEqual([
      'occluded|/|390x844|menu-button',
    ])
  })

  it('a 40x40 control is under the 44px floor and over the 24px floor', () => {
    expect(judgeLayout(targetSmall as any, { route: '/', viewport: '390x844', minTarget: 44 })).toEqual([
      'target-small|/|390x844|tiny-button',
    ])
    expect(judgeLayout(targetSmall as any, { route: '/', viewport: '390x844', minTarget: 24 })).toEqual([])
  })

  it('a one-line label forced onto two lines is wrapped; a padded one-line control is not', () => {
    expect(judgeLayout(wrapped as any, { route: '/', viewport: '390x844', minTarget: 24 })).toEqual([
      'wrapped|/|390x844|signin',
    ])
  })

  it('a clean snapshot yields no findings', () => {
    expect(judgeLayout(clean as any, { route: '/', viewport: '390x844', minTarget: 44 })).toEqual([])
  })

  it('zero controls is empty — a broken selector turns the sweep red', () => {
    expect(judgeLayout(empty as any, { route: '/', viewport: '390x844', minTarget: 44 })).toEqual([
      'empty|/|390x844|controls',
    ])
  })
})

describe('judgeOverlay', () => {
  it('r3-739-menu: an open overlay at x = -60 is overlay-offscreen', () => {
    expect(
      judgeOverlay(r3739Menu as any, { route: '/', viewport: '1280x800', trigger: 'present-tab', gutter: 8 }),
    ).toEqual(['overlay-offscreen|/|1280x800|present-tab'])
  })

  it('an overlay clipped at the rail edge is overlay-clipped (the viewport check alone passes it)', () => {
    expect(
      judgeOverlay(overlayClipped as any, {
        route: '/',
        viewport: '1280x800',
        trigger: 'rail-menu-button',
        gutter: 8,
      }),
    ).toEqual(['overlay-clipped|/|1280x800|rail-menu-button'])
  })

  it('an overlay sharing no horizontal span with its trigger is overlay-detached', () => {
    expect(
      judgeOverlay(overlayDetached as any, {
        route: '/',
        viewport: '1920x1080',
        trigger: 'top-right-tab',
        gutter: 8,
      }),
    ).toEqual(['overlay-detached|/|1920x1080|top-right-tab'])
  })

  it('a trigger no collected overlay answers to is overlay-missing, never a silent pass', () => {
    expect(judgeOverlay(clean as any, { route: '/', viewport: '390x844', trigger: 'nope', gutter: 8 })).toEqual([
      'overlay-missing|/|390x844|nope',
    ])
  })
})

describe('collectLayout is serialisable', () => {
  it('its source runs through new Function and INVOKES with only browser globals provided', () => {
    // page.evaluate ships the function's source text; a reference to an
    // import or a closure would die in the page. Compiling alone would not
    // catch that (a free identifier only throws on call), so the rebuilt
    // function is invoked here behind stubbed browser globals: any
    // module-scope reference throws ReferenceError and turns this red.
    const source = collectLayout.toString()
    expect(source).not.toMatch(/\bimport\b|\brequire\b/)
    const rebuilt = new Function(`return (${source});`)()
    expect(typeof rebuilt).toBe('function')

    const styleStub = new Proxy({}, { get: () => '' })
    const saved: Record<string, unknown> = {}
    const globals: Record<string, unknown> = {
      document: {
        documentElement: { scrollWidth: 0, clientWidth: 0 },
        querySelectorAll: () => [],
        querySelector: () => null,
        elementFromPoint: () => null,
      },
      window: { innerWidth: 0, innerHeight: 0 },
      getComputedStyle: () => styleStub,
      CSS: { escape: (s: string) => s },
    }
    for (const [name, value] of Object.entries(globals)) {
      saved[name] = (globalThis as any)[name]
      ;(globalThis as any)[name] = value
    }
    try {
      expect(rebuilt({ controls: '.x', overlays: '.y' })).toEqual({
        viewport: { w: 0, h: 0 },
        document: { scrollWidth: 0, clientWidth: 0 },
        controls: [],
        overlays: [],
      })
    } finally {
      for (const name of Object.keys(globals)) {
        if (saved[name] === undefined) delete (globalThis as any)[name]
        else (globalThis as any)[name] = saved[name]
      }
    }
  })
})
