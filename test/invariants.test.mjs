import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORE_REPOS,
  checkInvariants,
  detectRepoKind,
  loadRegistry,
  normalizeRepoName,
  parserProvider,
  repoNameFromGit,
  runInvariants,
  scopeMatches,
  selfTestEntry,
  validateRegistry,
  validateSource,
} from '../src/check-invariants.mjs'
import { check as webStorageCheck } from '../src/invariants/app-no-web-storage.mjs'
import { check as mainTsxCheck } from '../src/invariants/app-main-tsx-inert.mjs'
import { remoteImportUrls } from '../src/invariants/app-no-remote-css-import.mjs'
import { check as workflowCheck, ifConditions, loneSecrets } from '../src/invariants/workflow-secret-pair-gated-together.mjs'
import { readBaseline } from '../src/baseline.mjs'

// R3-1170 — the invariant registry and its runner. The three anchors the
// item's Tests section names: the registry validates; every check entry's
// self-test fixtures behave; the runner over this repo's own tree matches
// its baseline. The escape-classification producer drives the review-entry
// count, so the seed cannot silently drift from the data it came from.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS_ROOT = existsSync(join(REPO_ROOT, '..', 'docs', 'content', 'roadmap'))
  ? join(REPO_ROOT, '..', 'docs')
  : null

const tempDirs = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
})

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'invariants-'))
  tempDirs.push(dir)
  return dir
}

describe('the registry', () => {
  it('validates with no findings (a docs sibling answers for paths, ids and records)', () => {
    const { findings, warnings } = validateRegistry(loadRegistry(), { docsRoot: DOCS_ROOT })
    expect(findings).toEqual([])
    // grove/CLAUDE.md warnings are expected wherever grove is not checked out
    for (const warning of warnings) expect(warning).toMatch(/unchecked — /)
  })

  it('holds at least four check entries (the initial four of the item)', () => {
    const check = loadRegistry().entries.filter((entry) => entry.enforcement === 'check')
    expect(check.length).toBeGreaterThanOrEqual(4)
    expect(check.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'app-no-web-storage',
      'app-main-tsx-inert',
      'app-no-remote-css-import',
      'workflow-secret-pair-gated-together',
    ]))
  })

  it('carries every det-repo escape record as a review entry, verbatim (the producer drives the seed)', () => {
    if (!DOCS_ROOT) return // no docs sibling: the count is unchecked, not zero
    const records = JSON.parse(readFileSync(join(DOCS_ROOT, 'scripts', 'data', 'escape-classification.json'), 'utf8'))
      .filter((record) => record.primary === 'det-repo')
    const byId = new Map(loadRegistry().entries.map((entry) => [entry.id, entry]))
    for (const record of records) {
      const entry = byId.get(record.id.toLowerCase())
      expect(entry, `review entry for ${record.id}`).toBeDefined()
      expect(entry.statement).toBe(record.invariant)
      expect(entry.enforcement).toBe('review')
    }
  })

  it('refuses a check entry whose sources, shape or fixtures are wrong (fail loudly, not silently)', () => {
    const registry = loadRegistry()
    const broken = {
      ...registry,
      entries: [
        ...registry.entries,
        { id: 'not-a-check', statement: 'x'.repeat(301), sources: [], scope: { repos: 'everywhere', paths: [] }, enforcement: 'check', added: 'yesterday' },
      ],
    }
    const { findings } = validateRegistry(broken, { docsRoot: DOCS_ROOT })
    expect(findings.some((finding) => finding.includes('statement is 301'))).toBe(true)
    expect(findings.some((finding) => finding.includes('sources must be a non-empty array'))).toBe(true)
    expect(findings.some((finding) => finding.includes('scope.repos must be'))).toBe(true)
    expect(findings.some((finding) => finding.includes('src/invariants/not-a-check.mjs does not exist'))).toBe(true)
  })
})

describe('self-test fixtures', () => {
  it('every check entry refuses nothing — violating produces a finding, clean produces none', async () => {
    for (const entry of loadRegistry().entries.filter((entry) => entry.enforcement === 'check')) {
      expect(await selfTestEntry(entry), entry.id).toBeNull()
    }
  })

  it('the workflow violating fixture is the real cache.yml and its finding names the lone secret', async () => {
    const fixtureRoot = join(REPO_ROOT, 'test', 'invariants', 'workflow-secret-pair-gated-together')
    const readme = readFileSync(join(fixtureRoot, 'violating', 'README.md'), 'utf8')
    expect(readme).toMatch(/copied verbatim from\s+`?([\w.-]+)@([0-9a-f]{40})/)
    const findings = await import('../src/invariants/workflow-secret-pair-gated-together.mjs').then((m) =>
      m.check({ cwd: join(fixtureRoot, 'violating'), files: ['.github/workflows/cache.yml'] }),
    )
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((finding) => finding.detail === 'DEPLOY_APP_ID')).toBe(true)
  })
})

describe('scope', () => {
  it('core five, apps detection, name arrays, and the remote-name fold', () => {
    expect(CORE_REPOS).toEqual(['landing-page', 'sdk', 'sandbox', 'site-main', 'backend'])
    expect(normalizeRepoName('git@github.com:immediately-run/immediately-run-sdk.git')).toBe('sdk')
    expect(normalizeRepoName('https://github.com/immediately-run/landing-page.git')).toBe('landing-page')
    const entry = (repos) => ({ scope: { repos } })
    expect(scopeMatches(entry('all'), { name: 'grove', kind: { core: false, app: false } })).toBe(true)
    expect(scopeMatches(entry('core'), { name: 'site-main', kind: { core: true, app: false } })).toBe(true)
    expect(scopeMatches(entry('core'), { name: 'grove', kind: { core: false, app: true } })).toBe(false)
    expect(scopeMatches(entry('apps'), { name: 'grove', kind: { core: false, app: true } })).toBe(true)
    expect(scopeMatches(entry(['grove', 'reckoner']), { name: 'reckoner', kind: { core: false, app: true } })).toBe(true)
  })

  it('an app is detected by the package.json key or src/App.tsx', () => {
    const withKey = tempRepo()
    writeFileSync(join(withKey, 'package.json'), JSON.stringify({ name: 'x', 'immediately.run': {} }))
    expect(detectRepoKind(withKey, 'x')).toEqual({ core: false, app: true })
    const withApp = tempRepo()
    writeFileSync(join(withApp, 'package.json'), JSON.stringify({ name: 'y' }))
    mkdirSync(join(withApp, 'src'), { recursive: true })
    writeFileSync(join(withApp, 'src', 'App.tsx'), 'export default function App() {}\n')
    expect(detectRepoKind(withApp, 'y')).toEqual({ core: false, app: true })
    expect(detectRepoKind(withApp, 'site-main')).toEqual({ core: true, app: true })
  })
})

describe('source validation (validateSource over a synthetic docs checkout)', () => {
  // A minimal docs checkout: one archived item, one live item, one escape
  // record, one findings-log date, one content file. Every branch of the
  // source grammar is driven against it (or its absence).
  const makeDocs = () => {
    const docs = tempRepo()
    mkdirSync(join(docs, 'content', 'roadmap', 'archive'), { recursive: true })
    writeFileSync(join(docs, 'content', 'roadmap', 'R3-2.mdx'), '---\nid: R3-2\n---\n')
    writeFileSync(join(docs, 'content', 'roadmap', 'archive', 'R3-315.mdx'), '---\nid: R3-315\n---\n')
    mkdirSync(join(docs, 'content', 'plans', 'review-gate'), { recursive: true })
    writeFileSync(join(docs, 'content', 'plans', 'review-gate', 'pr-findings.mdx'), '| 2026-09-15 | x |\n')
    mkdirSync(join(docs, 'content', 'specs'), { recursive: true })
    writeFileSync(join(docs, 'content', 'specs', 'REAL.mdx'), 'real\n')
    mkdirSync(join(docs, 'scripts', 'data'), { recursive: true })
    writeFileSync(join(docs, 'scripts', 'data', 'escape-classification.json'), '[{"id":"E01"}]')
    return docs
  }

  it('item ids resolve against live and archived roadmap items', () => {
    const docs = makeDocs()
    expect(validateSource('R3-2', docs)).toEqual({ ok: true })
    expect(validateSource('R3-315', docs)).toEqual({ ok: true })
    expect(validateSource('R3-999', docs)).toEqual({ error: 'item id R3-999 is neither a live nor an archived roadmap item' })
    expect(validateSource('R3-999', null).warn).toMatch(/no sibling docs checkout/)
  })

  it('escape-classification records resolve against the data file', () => {
    const docs = makeDocs()
    expect(validateSource('escape-classification E01', docs)).toEqual({ ok: true })
    expect(validateSource('escape-classification E99', docs)).toEqual({ error: 'escape record escape-classification E99 is not in scripts/data/escape-classification.json' })
    mkdirSync(join(docs, 'scripts', 'data', 'broken'), { recursive: true })
    writeFileSync(join(docs, 'scripts', 'data', 'escape-classification.json'), 'not json')
    expect(validateSource('escape-classification E01', docs).error).toMatch(/not valid JSON/)
  })

  it('findings-log dates resolve against the log rows', () => {
    const docs = makeDocs()
    expect(validateSource('findings-log 2026-09-15', docs)).toEqual({ ok: true })
    expect(validateSource('findings-log 2020-01-01', docs)).toEqual({ error: 'no findings-log row is dated 2020-01-01' })
  })

  it('docs paths resolve under content/, repo files against the sibling when it is checked out', () => {
    const docs = makeDocs()
    expect(validateSource('content/specs/REAL.mdx §4', docs)).toEqual({ ok: true })
    expect(validateSource('docs/content/specs/GONE.mdx', docs)).toEqual({ error: 'docs path content/specs/GONE.mdx does not exist in the docs checkout' })
    // grove is not a sibling in CI: warned, not failed
    expect(validateSource('grove/CLAUDE.md rules', docs).warn).toMatch(/sibling checkout grove absent/)
    // a sibling that IS present is checked, both ways
    const workspace = tempRepo()
    const present = join(workspace, 'docs')
    mkdirSync(present, { recursive: true })
    mkdirSync(join(workspace, 'grove'), { recursive: true })
    writeFileSync(join(workspace, 'grove', 'CLAUDE.md'), '# grove\n')
    expect(validateSource('grove/CLAUDE.md Hard rules 6', present)).toEqual({ ok: true })
    expect(validateSource('grove/GONE.md Hard rules 6', present).error).toMatch(/does not exist in the sibling checkout/)
    // nested paths validate the WHOLE path, not only the first directory
    mkdirSync(join(workspace, 'grove', 'src', 'lib'), { recursive: true })
    writeFileSync(join(workspace, 'grove', 'src', 'lib', 'theme.ts'), 'export const t = 1\n')
    expect(validateSource('grove/src/lib/theme.ts cites', present)).toEqual({ ok: true })
    expect(validateSource('grove/src/lib/GONE.ts cites', present).error).toMatch(/does not exist in the sibling checkout/)
    expect(validateSource('grove/ alone', present).error).toMatch(/names a repo but no file/)
    // a workspace that keeps the immediately-run- prefixed directory resolves both spellings
    const prefixed = tempRepo()
    const docsIn = join(prefixed, 'docs')
    mkdirSync(docsIn, { recursive: true })
    mkdirSync(join(prefixed, 'immediately-run-sdk', 'src'), { recursive: true })
    writeFileSync(join(prefixed, 'immediately-run-sdk', 'src', 'vcs.ts'), 'export const v = 1\n')
    expect(validateSource('sdk/src/vcs.ts cites', docsIn)).toEqual({ ok: true })
    expect(validateSource('immediately-run-sdk/src/GONE.ts cites', docsIn).error).toMatch(/does not exist in the sibling checkout/)
  })

  it('a source that names a repo but no file under it is an error', () => {
    expect(validateSource('grove/', null)).toEqual({ error: '"grove/" names a repo but no file in it' })
  })

  it('an unrecognised source shape is an error, never a silent pass', () => {
    expect(validateSource('somewhere over the rainbow', null).error).toMatch(/matches no source shape/)
    expect(validateSource('', null).error).toMatch(/non-empty string/)
    expect(validateSource(42, null).error).toMatch(/non-empty string/)
  })
})

describe('the checks', () => {
  const runOver = async (check, files, dir) => check({ cwd: dir, files, getTs: parserProvider(dir) })

  it('web storage: references found, declaring names, strings and non-global members not', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'App.tsx'), [
      'const shim = { localStorage: "key names a property" }',
      'export default function App() {',
      '  const a = localStorage.getItem("a")',
      '  const b = window.sessionStorage',
      '  void caches',
      '  const note = "localStorage in a string is not a reference"',
      '  const props = { caches: "a member of an ordinary object" }',
      '  void props.caches',
      '  void shim',
      '  void note',
      '  void a',
      '  void b',
      '  return null',
      '}',
    ].join('\n'))
    const findings = await runOver(webStorageCheck, ['src/App.tsx'], dir)
    expect(findings.map((f) => f.detail).sort()).toEqual(['caches', 'localStorage', 'sessionStorage'])
    expect(findings.every((f) => f.file === 'src/App.tsx' && typeof f.line === 'number')).toBe(true)
  })

  it('web storage: a cast-wrapped global receiver is still the receiver (as/paren/non-null/satisfies)', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'casts.ts'), [
      'const { localStorage } = window as any',
      'const a = (window as any).sessionStorage',
      'const b = globalThis.caches!',
      'const props = { indexedDB: 1 } as const',
      'const { indexedDB } = props',
      'export const out = { localStorage, a, b, indexedDB }',
    ].join('\n'))
    const findings = await runOver(webStorageCheck, ['src/casts.ts'], dir)
    // line 1 reads window.localStorage through the cast; lines 2-3 name the
    // receiver directly; lines 4-5 destructure a CAST LOCAL and bind, so
    // line 6's shorthand spread flags only the window-derived localStorage.
    expect(findings.map((f) => f.line).sort()).toEqual([1, 2, 3, 6])
  })

  it('web storage: type-space declarations bind — a use of a locally declared interface/type/enum named like a banned global is clean', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'types.ts'), [
      'interface caches { size: number }',
      'type localStorage = string',
      'enum indexedDB { A, B }',
      'export const t: caches = { size: 1 }',
      'export const s: localStorage = "x"',
      'export const e = indexedDB.A',
    ].join('\n'))
    const findings = await runOver(webStorageCheck, ['src/types.ts'], dir)
    expect(findings).toEqual([])
  })

  it('web storage: destructuring judges the initializer — window destructures flag, local destructures do not', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'destructure.ts'), [
      'const { localStorage } = window',
      'const { sessionStorage: renamed } = globalThis',
      'const props = { caches: 1, indexedDB: 2 }',
      'const { caches: mine } = props',
      'const { indexedDB } = props',
      'export const out = { localStorage, renamed, mine, indexedDB }',
    ].join('\n'))
    const findings = await runOver(webStorageCheck, ['src/destructure.ts'], dir)
    // line 1 reads window.localStorage (the shorthand name itself), line 2
    // reads globalThis.sessionStorage, line 6 re-spreads the window-derived
    // local (not a scope binding — its origin is the global read); lines 4-5
    // read props' own properties and never appear.
    expect(findings.map((f) => f.line).sort()).toEqual([1, 2, 6])
  })

  it('web storage: a member of a non-global receiver is that object\'s property, not the platform global', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'props.tsx'), [
      'type Props = { caches?: string; localStorage?: string }',
      'export const Shadow = (props: Props) => {',
      '  void props.caches',
      '  void props.localStorage',
      '  void globalThis.sessionStorage',
      '  return null',
      '}',
    ].join('\n'))
    const findings = await runOver(webStorageCheck, ['src/props.tsx'], dir)
    // props.caches and props.localStorage are members of a local object;
    // globalThis.sessionStorage is the global, wherever it is spelled.
    expect(findings.map((f) => f.detail)).toEqual(['sessionStorage'])
  })

  it('main.tsx: the message names which rule each specifier broke', async () => {
    const { reasonFor } = await import('../src/invariants/app-main-tsx-inert.mjs')
    expect(reasonFor('./app.css')).toMatch(/CSS import/)
    expect(reasonFor('@immediately-run/sdk')).toMatch(/package root/)
    expect(reasonFor('@immediately-run/sdk/boot')).toMatch(/package root/)
  })

  it('main.tsx: CSS and SDK imports found (static and dynamic), App imports not', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'main.tsx'), [
      "import { StrictMode } from 'react'",
      "import './app.css'",
      "import { openSettings } from '@immediately-run/sdk'",
      "import App from './App'",
      'const lazy = () => import("@immediately-run/sdk/boot")',
      'void lazy; void StrictMode; void App',
    ].join('\n'))
    const findings = await runOver(mainTsxCheck, ['src/main.tsx'], dir)
    expect(findings.map((f) => f.detail).sort()).toEqual(['./app.css', '@immediately-run/sdk'])
  })

  it('main.tsx: the sdk package root is banned with and without a trailing slash; subpaths are not', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'main.tsx'), [
      "import { boot } from '@immediately-run/sdk/boot'",
      "import { routing } from '@immediately-run/sdk/routing'",
      "const root = () => import('@immediately-run/sdk')",
      "const slashed = () => import('@immediately-run/sdk/')",
      'void boot; void routing; void root; void slashed',
    ].join('\n'))
    const findings = await runOver(mainTsxCheck, ['src/main.tsx'], dir)
    expect(findings.map((f) => f.detail).sort()).toEqual(['@immediately-run/sdk', '@immediately-run/sdk/'])
    expect(findings.every((f) => /SDK package root/.test(f.message))).toBe(true)
  })

  it('css: both @import spellings carry the URL, local imports are clean', () => {
    expect(remoteImportUrls(`url("https://fonts.example.com/x.css")`)).toEqual(['https://fonts.example.com/x.css'])
    expect(remoteImportUrls(`'https://cdn.example.com/reset.css'`)).toEqual(['https://cdn.example.com/reset.css'])
    expect(remoteImportUrls(`'./tokens.css'`)).toEqual(['./tokens.css'])
    expect(remoteImportUrls(`url(./local.css) screen`)).toEqual(['./local.css'])
  })

  it('workflow: a lone pair member in if: is found, both or neither are clean, at any depth', () => {
    expect(loneSecrets('env.DEPLOY_APP_ID != ""')).toEqual([['DEPLOY_APP_ID', 'DEPLOY_APP_PRIVATE_KEY']])
    expect(loneSecrets('env.DEPLOY_APP_ID != "" && env.DEPLOY_APP_PRIVATE_KEY != ""')).toEqual([])
    expect(loneSecrets('secrets.DEPLOY_APP_PRIVATE_KEY != ""')).toEqual([['DEPLOY_APP_PRIVATE_KEY', 'DEPLOY_APP_ID']])
    expect(loneSecrets('github.event_name == "push"')).toEqual([])
    expect(loneSecrets('env.NOT_THE_APP_ID != ""')).toEqual([])
    const conditions = ifConditions({ jobs: { build: { steps: [{ if: 'a', run: 'x' }, { if: 'b' }] } } })
    expect(conditions.map((c) => c.path)).toEqual(['jobs.build.steps[0].if', 'jobs.build.steps[1].if'])
  })
})

describe('the runner and its ratchet', () => {
  it('over this repo own tree: zero findings, matching the committed empty baseline', async () => {
    const result = await runInvariants({
      cwd: REPO_ROOT,
      name: 'verify-checks',
      kind: detectRepoKind(REPO_ROOT, 'verify-checks'),
    })
    expect(result.registry).toEqual([])
    expect(result.run).toEqual([])
    expect(readBaseline(join(REPO_ROOT, 'verify-baselines', 'invariants.json'))).toEqual([])
  })

  it('a finding is NEW against an empty baseline, absorbed by its own, and STALE once fixed (shrink-only)', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'cache.yml'), 'jobs: {a: {steps: [{if: env.DEPLOY_APP_ID != "", run: x}]}}\n')
    const run = () => runInvariants({ cwd: dir, name: 'scratch', kind: { core: false, app: false } })
    expect((await run()).run.length).toBe(1)

    const baseline = join(dir, 'verify-baselines', 'invariants.json')
    mkdirSync(dirname(baseline), { recursive: true })
    const { findingFingerprint } = await import('../src/check-invariants.mjs')
    const first = await run()
    writeFileSync(baseline, JSON.stringify(first.run.map((f) => findingFingerprint(f.id, f)), null, 2) + '\n')
    expect((await run()).run.length).toBe(1) // still reported, but ratcheted below

    writeFileSync(join(dir, '.github', 'workflows', 'cache.yml'), 'jobs: {a: {steps: [{if: true, run: x}]}}\n')
    expect((await run()).run.length).toBe(0) // the baseline entry is now stale — shrink-only refuses
  })

  it('an in-scope entry whose paths match nothing is a REGISTRY finding, not a baselined one', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', 'immediately.run': {} }))
    const result = await runInvariants({ cwd: dir, name: 'scratch', kind: { core: false, app: true } })
    expect(result.registry.every((finding) => finding.includes('REGISTRY'))).toBe(true)
    expect(result.registry.some((finding) => finding.includes('app-main-tsx-inert'))).toBe(true)
  })

  it('a dead glob beside a live one is its own REGISTRY finding, named (per-glob rot, not per-entry)', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'App.tsx'), 'export default 1\n')
    const { loadRegistry: load } = await import('../src/check-invariants.mjs')
    const registry = load()
    const entry = registry.entries.find((candidate) => candidate.id === 'app-no-web-storage')
    const withDeadGlob = {
      ...registry,
      entries: registry.entries.map((candidate) =>
        candidate === entry
          ? { ...candidate, scope: { ...candidate.scope, paths: [...candidate.scope.paths, 'no/such/dir/**'] } }
          : candidate,
      ),
    }
    const result = await runInvariants({ cwd: dir, name: 'grove', kind: { core: false, app: true }, registry: withDeadGlob })
    expect(result.registry.some((finding) => finding.includes("glob(s) [no/such/dir/**] match no file"))).toBe(true)
    expect(result.registry.some((finding) => finding.includes('match no file in grove (scope') && finding.includes('app-no-web-storage: paths'))).toBe(false)
  })

  it('an in-scope REVIEW entry whose paths match nothing is a REGISTRY finding too (rot has no enforcement exception)', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch' }))
    // site-main is in scope of e02/e25/e29 (paths src/**) — no src/ here
    const result = await runInvariants({ cwd: dir, name: 'site-main', kind: { core: true, app: false } })
    expect(result.registry.some((finding) => finding.includes('REGISTRY e02'))).toBe(true)
    expect(result.review).toEqual([])
  })

  it('a protocol-relative @import is the same remote finding', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.css'), "@import '//cdn.example.com/typo.css';\n")
    const { check } = await import('../src/invariants/app-no-remote-css-import.mjs')
    const findings = await check({ cwd: dir, files: ['src/index.css'] })
    expect(findings.map((f) => f.detail)).toEqual(['//cdn.example.com/typo.css'])
  })

  it('the CLI runs end to end over this repo', () => {
    const output = execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'check-invariants.mjs'), '--repo', 'verify-checks'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    expect(output.trim()).toBe('')
  })
})

describe('the five consumers this ships to', () => {
  it('each sibling checkout in scope runs clean or reports only baselined debt (the wiring preview)', async () => {
    const siblings = [
      ['landing-page', 'landing-page'],
      ['sdk', 'immediately-run-sdk'],
      ['sandbox', 'sandbox'],
      ['site-main', 'immediately-run-site-main'],
      ['backend', 'immediately-run-backend'],
    ]
    for (const [name, directory] of siblings) {
      const cwd = resolve(REPO_ROOT, '..', directory)
      if (!existsSync(cwd)) continue // a consumer not checked out is unchecked, not clean
      const result = await runInvariants({ cwd, name, kind: detectRepoKind(cwd, name) })
      expect(result.registry, name).toEqual([])
      for (const finding of result.run) {
        expect(['app-no-web-storage', 'app-no-remote-css-import', 'app-main-tsx-inert', 'workflow-secret-pair-gated-together']).toContain(finding.id)
      }
    }
  })
})

describe('checkInvariants wiring', () => {
  it('ratchets findings against the repo baseline via the shared ratchet', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    cpSync(join(REPO_ROOT, 'test', 'invariants', 'workflow-secret-pair-gated-together', 'violating', '.github'), join(dir, '.github'), { recursive: true })
    const baseline = join(dir, 'verify-baselines', 'invariants.json')
    await checkInvariants({ cwd: dir, repo: 'scratch', baselinePath: 'verify-baselines/invariants.json', argv: ['--write-baseline'] })
    expect(readBaseline(baseline).length).toBeGreaterThan(0)
  })
})

describe('loud failure paths', () => {
  it('loadRegistry refuses an absent registry and invalid JSON, naming the path', () => {
    expect(() => loadRegistry(join(tmpdir(), 'no-such-registry.json'))).toThrow(/registry not found/)
    const dir = tempRepo()
    writeFileSync(join(dir, 'registry.json'), 'not json')
    expect(() => loadRegistry(join(dir, 'registry.json'))).toThrow(/not valid JSON/)
  })

  it('repoNameFromGit: this repo resolves, a directory with no git returns null', () => {
    expect(repoNameFromGit(REPO_ROOT)).toBe('verify-checks')
    expect(repoNameFromGit(tmpdir())).toBeNull()
  })

  it('validateRegistry refuses shape defects: non-registry, wrong format, empty entries, bad entries', () => {
    expect(validateRegistry(null).findings[0]).toMatch(/registry must be a JSON object/)
    expect(validateRegistry([]).findings[0]).toMatch(/registry must be a JSON object/)
    expect(validateRegistry({ format: 'other/1', entries: [] }).findings[0]).toMatch(/format must be/)
    expect(validateRegistry({ format: 'invariants-registry/1' }).findings[0]).toMatch(/non-empty array/)
    const entry = (over) => ({ format: 'invariants-registry/1', entries: [{ id: 'x', statement: 's', sources: ['R3-2'], scope: { repos: 'all', paths: ['**'] }, enforcement: 'review', added: '2026-10-16', ...over }] })
    const registryOf = (entries) => ({ format: 'invariants-registry/1', entries })
    expect(validateRegistry(entry({ id: 'NOPE' })).findings.join(' ')).toMatch(/id must be lowercase kebab-case/)
    expect(validateRegistry(registryOf([null])).findings.join(' ')).toMatch(/an entry must be an object/)
    expect(validateRegistry(registryOf(['x'])).findings.join(' ')).toMatch(/an entry must be an object/)
    expect(validateRegistry({ format: 'invariants-registry/1', entries: entry({}).entries.concat(entry({}).entries) }).findings.join(' ')).toMatch(/duplicate id/)
    expect(validateRegistry(entry({ statement: ' ' })).findings.join(' ')).toMatch(/statement must be a non-empty string/)
    expect(validateRegistry(entry({ statement: 'x'.repeat(301) })).findings.join(' ')).toMatch(/statement is 301 characters/)
    expect(validateRegistry(entry({ class: 'Bad Slug' })).findings.join(' ')).toMatch(/class must be a defect-class slug/)
    expect(validateRegistry(entry({ added: 'once' })).findings.join(' ')).toMatch(/added must be an ISO date/)
    expect(validateRegistry(entry({ sources: [] })).findings.join(' ')).toMatch(/sources must be a non-empty array/)
    expect(validateRegistry(entry({ sources: [7] })).findings.join(' ')).toMatch(/a source must be a non-empty string/)
    expect(validateRegistry(entry({ scope: null })).findings.join(' ')).toMatch(/scope must be an object/)
    expect(validateRegistry(entry({ scope: { repos: 'everywhere', paths: ['**'] } })).findings.join(' ')).toMatch(/scope.repos must be/)
    expect(validateRegistry(entry({ scope: { repos: ['ok', ''] } })).findings.join(' ')).toMatch(/scope.repos must be/)
    expect(validateRegistry(entry({ scope: { repos: 'all', paths: [] } })).findings.join(' ')).toMatch(/scope.paths must be/)
    expect(validateRegistry(entry({ scope: { repos: 'all', paths: ['ok', ' '] } })).findings.join(' ')).toMatch(/scope.paths must be/)
    expect(validateRegistry(entry({ enforcement: 'maybe' })).findings.join(' ')).toMatch(/enforcement must be/)
    expect(validateRegistry(entry({ enforcement: 'check' })).findings.join(' ')).toMatch(/does not exist/)
  })

  it('an unparsable workflow is a finding, not a skip; a scalar-root YAML is ignored', () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'broken.yml'), 'name: [unclosed')
    writeFileSync(join(dir, '.github', 'workflows', 'scalar.yml'), 'just a string\n')
    const findings = workflowCheck({ cwd: dir, files: ['.github/workflows/broken.yml', '.github/workflows/scalar.yml'] })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toMatch(/not valid YAML/)
  })

  it('selfTestEntry refuses every way a fixture can rot, with the reason', async () => {
    expect(await selfTestEntry({ id: 'no-such-invariant', scope: { paths: ['src/**'] } })).toContain('does not exist')
    expect(await selfTestEntry({ id: 'app-no-web-storage', scope: { paths: ['src/**'] } }, { fixtureRoot: REPO_ROOT })).toContain('violating fixture missing')
    expect(await selfTestEntry({ id: 'app-no-web-storage', scope: { paths: ['src/**'] } }, { fixtureRoot: join(REPO_ROOT, 'test', 'invariants') })).toBeNull()
    expect(await selfTestEntry({ id: 'workflow-secret-pair-gated-together', scope: { paths: ['src/**'] } }, { fixtureRoot: join(REPO_ROOT, 'test', 'invariants') })).toContain('produces no finding')
    // a clean fixture that FINDS something refuses the run — the fixture rotted
    const root = tempRepo()
    for (const half of ['violating', 'clean']) {
      mkdirSync(join(root, 'workflow-secret-pair-gated-together', half, '.github', 'workflows'), { recursive: true })
      cpSync(
        join(REPO_ROOT, 'test', 'invariants', 'workflow-secret-pair-gated-together', 'violating', '.github', 'workflows', 'cache.yml'),
        join(root, 'workflow-secret-pair-gated-together', half, '.github', 'workflows', 'cache.yml'),
      )
    }
    expect(await selfTestEntry(
      { id: 'workflow-secret-pair-gated-together', scope: { paths: ['.github/workflows/*.yml'] } },
      { fixtureRoot: root },
    )).toContain('clean fixture produces 1 finding(s)')
  })

  it('parserProvider throws loudly when no loader can produce a TypeScript parser', () => {
    const getTs = parserProvider(REPO_ROOT, [() => null, () => { throw new Error('no typescript here') }])
    expect(() => getTs()).toThrow(/no TypeScript parser API found/)
  })

  it('runInvariants stops before running anything when the registry itself is invalid', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'cache.yml'), 'jobs: {a: {steps: [{if: env.DEPLOY_APP_ID != "", run: x}]}}\n')
    const broken = { format: 'invariants-registry/1', entries: [{ id: 'bad', statement: '', sources: [], scope: { repos: 'all', paths: ['**'] }, enforcement: 'review', added: 'x' }] }
    const result = await runInvariants({ cwd: dir, name: 'scratch', kind: { core: false, app: false }, registry: broken })
    expect(result.run).toEqual([])
    expect(result.registry.length).toBeGreaterThan(0)
  })

  it('runInvariants reports a failed self-test as a REGISTRY defect and never runs that check', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'cache.yml'), 'jobs: {a: {steps: [{run: x}]}}\n')
    const result = await runInvariants({ cwd: dir, name: 'scratch', kind: { core: false, app: false }, fixtureRoot: join(REPO_ROOT, 'no-such-fixtures') })
    expect(result.registry.some((defect) => defect.includes('fixture missing'))).toBe(true)
    expect(result.run).toEqual([])
  })

  it('checkInvariants without a repo name and without git fails loudly rather than guessing', async () => {
    const errors = []
    const originalError = console.error
    console.error = (...args) => errors.push(args.join(' '))
    try {
      await checkInvariants({ cwd: tempRepo(), repo: null, baselinePath: 'verify-baselines/invariants.json', argv: [] })
    } finally {
      console.error = originalError
    }
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('cannot determine the repo name')
    process.exitCode = undefined
  })

  it('review entries in scope are announced, not run', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\n')
    const logs = []
    const originalLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    try {
      await checkInvariants({ cwd: dir, repo: 'site-main', baselinePath: 'verify-baselines/invariants.json', argv: ['--write-baseline'] })
    } finally {
      console.log = originalLog
    }
    expect(logs.join('\n')).toMatch(/review-enforced entries in scope/)
    expect(logs.join('\n')).toMatch(/e02/)
    process.exitCode = undefined
  })

  it('a registry-defect run fails outright through checkInvariants, naming the registry not the baseline', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', 'immediately.run': {} }))
    const errors = []
    const originalError = console.error
    console.error = (...args) => errors.push(args.join(' '))
    try {
      await checkInvariants({ cwd: dir, repo: 'scratch', baselinePath: 'verify-baselines/invariants.json', argv: [] })
    } finally {
      console.error = originalError
    }
    expect(errors.join('\n')).toMatch(/REGISTRY/)
    expect(errors.join('\n')).toMatch(/fix the registry, not the baseline/)
  })
})
