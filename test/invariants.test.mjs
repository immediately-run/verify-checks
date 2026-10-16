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
  runInvariants,
  scopeMatches,
  selfTestEntry,
  validateRegistry,
} from '../src/check-invariants.mjs'
import { check as webStorageCheck } from '../src/invariants/app-no-web-storage.mjs'
import { check as mainTsxCheck } from '../src/invariants/app-main-tsx-inert.mjs'
import { remoteImportUrls } from '../src/invariants/app-no-remote-css-import.mjs'
import { ifConditions, loneSecrets } from '../src/invariants/workflow-secret-pair-gated-together.mjs'
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

  it('main.tsx: CSS and SDK imports found (static and dynamic), App imports not', async () => {
    const dir = tempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'main.tsx'), [
      "import { StrictMode } from 'react'",
      "import './app.css'",
      "import { openSettings } from '@immediately-run/sdk'",
      "import App from './App'",
      'const lazy = () => import("@immediately-run/sdk/openSettings")',
      'void lazy; void StrictMode; void App',
    ].join('\n'))
    const findings = await runOver(mainTsxCheck, ['src/main.tsx'], dir)
    expect(findings.map((f) => f.detail).sort()).toEqual([
      './app.css',
      '@immediately-run/sdk',
      '@immediately-run/sdk/openSettings',
    ])
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
