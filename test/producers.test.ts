import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FINGERPRINTED_CLASSES, knipFingerprints } from '../src/producers.mjs'

// R3-572. `knipFingerprints` read two of the four issue classes knip emits, so every `types`
// and `dependencies` finding was discarded before the baseline saw it — and a baseline that
// never records a class can never fail on it. The evidence is a captured report rather
// than a hand-written one, because the thing under test is whether this code understands
// knip's actual output shape; a report I typed would assert my belief about that shape, which
// is precisely the belief that was wrong.
const REPORT = JSON.parse(
  readFileSync(join(new URL('.', import.meta.url).pathname, 'fixtures/knip-backend.json'), 'utf8'),
)

describe('knipFingerprints over knip’s real output', () => {
  const fingerprints = knipFingerprints(REPORT)

  it('carries the `types` class, which was silently dropped', () => {
    expect(fingerprints).toContain('src/telemetry.ts:TelemetryTier')
    // Not one favourite member: the fixture holds fifteen, and all of them must survive.
    const types = REPORT.issues.flatMap((e: { file: string; types?: { name: string }[] }) =>
      (e.types ?? []).map((t) => `${e.file}:${t.name}`),
    )
    expect(types.length).toBe(15)
    for (const t of types) expect(fingerprints).toContain(t)
  })

  it('carries the `dependencies` class — the sharper half, since it is supply-chain surface', () => {
    expect(fingerprints).toContain('package.json:axios')
  })

  it('still carries what it carried before — `exports` and the `:(file)` form', () => {
    // The regression guard for the widening itself: adding classes must not drop any.
    const before = REPORT.issues.flatMap((e: { file: string; files?: unknown[]; exports?: { name: string }[] }) => [
      ...(e.files ?? []).map(() => `${e.file}:(file)`),
      ...(e.exports ?? []).map((x) => `${e.file}:${x.name}`),
    ])
    expect(before.length).toBeGreaterThan(0)
    for (const f of before) expect(fingerprints).toContain(f)
  })

  it('emits nothing beyond the four classes for this report', () => {
    // A regression guard on the widening, not a pin on the decision: every other knip class
    // is empty in this fixture, so this expectation moves with the implementation. The pin
    // lives in the next describe, against a report that populates every class knip emits.
    const expected = REPORT.issues.flatMap(
      (e: { file: string; files?: unknown[]; exports?: { name: string }[]; types?: { name: string }[]; dependencies?: { name: string }[] }) => [
        ...(e.files ?? []).map(() => `${e.file}:(file)`),
        ...(e.exports ?? []).map((x) => `${e.file}:${x.name}`),
        ...(e.types ?? []).map((x) => `${e.file}:${x.name}`),
        ...(e.dependencies ?? []).map((x) => `${e.file}:${x.name}`),
      ],
    )
    expect([...fingerprints].sort()).toEqual([...expected].sort())
  })
})

describe('the classes deliberately left out', () => {
  // Constructed, and the reason is the point: knip leaves most of its classes empty on the
  // captured backend report, so an exclusion asserted against that fixture is asserted against
  // nothing — adding six real classes to the list left the whole suite green. All seventeen
  // classes `initRow()` can emit are covered (fifteen here, plus the two array-shaped ones
  // below), so the exclusion is a claim the suite can actually falsify.
  const everyClass = {
    issues: [
      {
        file: 'package.json',
        files: [],
        exports: [{ name: 'keptExport' }],
        types: [{ name: 'KeptType' }],
        dependencies: [{ name: 'axios' }],
        devDependencies: [{ name: 'eslint' }],
        optionalPeerDependencies: [{ name: 'react' }],
        unlisted: [{ name: 'typescript' }],
        unresolved: [{ name: './missing' }],
        binaries: [{ name: 'tsc' }],
        enumMembers: [{ name: 'Mode.Unused' }],
        namespaceMembers: [{ name: 'ns.unused' }],
        catalog: [{ name: 'someCatalog' }],
        catalogReferences: [{ name: 'someRef' }],
        nsExports: [{ name: 'ns.export' }],
        nsTypes: [{ name: 'ns.Type' }],
      },
    ],
  }

  // `duplicates` and `cycles` are the two knip renders as arrays of symbols rather than
  // `{name}` objects, so they cannot share a row with the rest: admitting either would trip
  // the throw below rather than produce a fingerprint. Kept separate so the exclusion above
  // stays a clean equality.
  const arrayShaped = {
    issues: [{ file: 'a.ts', duplicates: [[{ name: 'a' }, { name: 'b' }]], cycles: [[{ name: 'a.ts' }, { name: 'b.ts' }]] }],
  }

  it('fingerprints only the four, whatever else knip reports', () => {
    expect(knipFingerprints(everyClass).sort()).toEqual([
      'package.json:KeptType',
      'package.json:axios',
      'package.json:keptExport',
    ])
  })

  it('ignores the array-shaped classes too, rather than throwing on them', () => {
    // They are excluded, so they are never read — the throw is for a class someone adds to
    // the list without giving it a rendering, not for one knip merely reports.
    expect(knipFingerprints(arrayShaped)).toEqual([])
  })

  it('names the four, so widening the list is a deliberate edit rather than a silent one', () => {
    expect(FINGERPRINTED_CLASSES).toEqual(['files', 'exports', 'types', 'dependencies'])
  })

  it('refuses loudly if a listed class is not shaped {name}', () => {
    // `duplicates` and `cycles` push arrays of symbols, not `{name}` objects. Admitting one
    // without its own rendering would write `<file>:undefined` into a committed baseline —
    // 42 of them in site-main — where it can never be diffed away.
    expect(() => knipFingerprints({ issues: [{ file: 'a.ts', types: [['x', 'y']] }] })).toThrow(
      /no string \.name/,
    )
  })
})

describe('knipFingerprints — shapes it must survive', () => {
  it('contributes nothing for a class present but empty', () => {
    expect(knipFingerprints({ issues: [{ file: 'a.ts', files: [], exports: [], types: [], dependencies: [] }] })).toEqual([])
  })

  it('skips an entry with no `file`, rather than emitting `undefined:…`', () => {
    expect(knipFingerprints({ issues: [{ exports: [{ name: 'x' }] }, null, { file: 'b.ts', types: [{ name: 'T' }] }] })).toEqual([
      'b.ts:T',
    ])
  })

  it('handles a report with no issues at all', () => {
    expect(knipFingerprints({})).toEqual([])
    expect(knipFingerprints({ issues: [] })).toEqual([])
  })
})
