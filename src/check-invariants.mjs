import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastGlob from 'fast-glob'
import { fingerprint, ratchet } from './baseline.mjs'
import * as appNoWebStorage from './invariants/app-no-web-storage.mjs'
import * as appMainTsxInert from './invariants/app-main-tsx-inert.mjs'
import * as appNoRemoteCssImport from './invariants/app-no-remote-css-import.mjs'
import * as workflowSecretPair from './invariants/workflow-secret-pair-gated-together.mjs'

// check-invariants — the invariant registry's runner (R3-1170). The registry
// lives at the package's invariants/registry.json: one entry per invariant, a
// statement with sources and scope, enforced by a self-tested check (code in
// src/invariants/<id>.mjs plus fixtures under test/invariants/<id>/) or marked
// review-enforced (no code; R3-1173 serves those to reviewers). The runner
// executes, in one repo, every entry whose scope matches that repo, and
// ratchets the findings against the consumer's
// verify-baselines/invariants.json — a fingerprint set that only shrinks,
// like every other baseline here.
//
// Scope classes (the registry's `scope.repos`): "core" is the five core
// repos below by name, "apps" is any repo whose root package.json has an
// "immediately.run" key or that has src/App.tsx, "all" is every repo, and a
// name array is matched by name. Repo names are the short forms
// (landing-page, sdk, …); a git remote's immediately-run- prefix is
// stripped. An entry in scope whose `paths` match no file in the repo is a
// REGISTRY finding, not a baselined one — a scope that rots is a defect in
// the registry, and absorbing it into a baseline would hide it forever.
//
// Self-test is mandatory (the gate-completeness defence the review-gate
// overview asked for): the runner refuses a check entry whose violating
// fixture produces no finding or whose clean fixture produces one. The
// fixtures ship with the package (files: test/invariants), so a consumer's
// verify run re-proves every check it runs against its own fixtures.

export const CORE_REPOS = ['landing-page', 'sdk', 'sandbox', 'site-main', 'backend']

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_PATH = join(PACKAGE_ROOT, 'invariants', 'registry.json')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'invariants')

/** The id → module map. A registry entry with `enforcement: "check"` whose id
 *  is missing here is refused at load: the map and the registry are one
 *  surface, and a check entry without code is a registry defect. */
const CHECK_MODULES = {
  'app-no-web-storage': appNoWebStorage,
  'app-main-tsx-inert': appMainTsxInert,
  'app-no-remote-css-import': appNoRemoteCssImport,
  'workflow-secret-pair-gated-together': workflowSecretPair,
}

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/
const CLASS_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const ITEM_ID = /^R3-\d+$/
const ESCAPE_ID = /^escape-classification (E\d+)$/
const FINDINGS_LOG_DATE = /^findings-log (\d{4}-\d{2}-\d{2})$/
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const STATEMENT_MAX = 300

/** Short repo name: the remote's basename minus `.git`, with the
 *  immediately-run- prefix folded away (immediately-run-sdk → sdk). */
export function normalizeRepoName(raw) {
  let name = raw
  if (name.endsWith('.git')) name = name.slice(0, -4)
  name = basename(name)
  const stripped = name.replace(/^immediately-run-/, '')
  return stripped === '' ? name : stripped
}

/** The repo's name from its origin remote, or null when it cannot be
 *  determined (no git, no remote) — the wrapper names the repo instead. */
export function repoNameFromGit(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (url === '') return null
    return normalizeRepoName(url)
  } catch {
    return null
  }
}

/** { core, app } for a checkout: core by name, app by the registry's
 *  detection (an "immediately.run" key in the root package.json, or
 *  src/App.tsx). */
export function detectRepoKind(cwd, name) {
  const core = CORE_REPOS.includes(name)
  let app = false
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    app = Object.prototype.hasOwnProperty.call(pkg, 'immediately.run')
  } catch {
    // no readable package.json — fall through to the App.tsx probe
  }
  app = app || existsSync(join(cwd, 'src', 'App.tsx'))
  return { core, app }
}

/** Does the entry's `scope.repos` cover this repo? */
export function scopeMatches(entry, { name, kind }) {
  const repos = entry.scope.repos
  if (repos === 'all') return true
  if (repos === 'core') return kind.core
  if (repos === 'apps') return kind.app
  return repos.map(normalizeRepoName).includes(name)
}

export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) {
    throw new Error(`check-invariants: registry not found at ${path}`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`check-invariants: registry ${path} is not valid JSON: ${err.message}`)
  }
  return parsed
}

/** Validate one source string against the docs checkout. Returns
 *  { ok: true } | { warn: reason } | { error: reason } — item ids, docs
 *  paths, escape-classification records and findings-log dates are checked
 *  when a sibling docs checkout exists (warned, not failed, when it does
 *  not); a sibling-repo file is checked when the sibling is checked out. */
export function validateSource(source, docsRoot) {
  if (typeof source !== 'string' || source.trim() === '') {
    return { error: 'a source must be a non-empty string' }
  }
  if (ITEM_ID.test(source)) {
    if (!docsRoot) return { warn: `item id ${source} unchecked — no sibling docs checkout` }
    const live = join(docsRoot, 'content', 'roadmap', `${source}.mdx`)
    const archived = join(docsRoot, 'content', 'roadmap', 'archive', `${source}.mdx`)
    return existsSync(live) || existsSync(archived)
      ? { ok: true }
      : { error: `item id ${source} is neither a live nor an archived roadmap item` }
  }
  if (ESCAPE_ID.test(source)) {
    if (!docsRoot) return { warn: `escape record ${source} unchecked — no sibling docs checkout` }
    const data = join(docsRoot, 'scripts', 'data', 'escape-classification.json')
    if (!existsSync(data)) return { warn: `escape record ${source} unchecked — ${data} absent` }
    try {
      const records = JSON.parse(readFileSync(data, 'utf8'))
      return records.some((record) => record.id === ESCAPE_ID.exec(source)[1])
        ? { ok: true }
        : { error: `escape record ${source} is not in scripts/data/escape-classification.json` }
    } catch (err) {
      return { error: `escape-classification.json is not valid JSON: ${err.message}` }
    }
  }
  const findingsLog = source.match(FINDINGS_LOG_DATE)
  if (findingsLog) {
    if (!docsRoot) return { warn: `findings-log ${findingsLog[1]} unchecked — no sibling docs checkout` }
    const log = join(docsRoot, 'content', 'plans', 'review-gate', 'pr-findings.mdx')
    if (!existsSync(log)) return { warn: `findings-log ${findingsLog[1]} unchecked — ${log} absent` }
    const text = readFileSync(log, 'utf8')
    return text.includes(`| ${findingsLog[1]} |`)
      ? { ok: true }
      : { error: `no findings-log row is dated ${findingsLog[1]}` }
  }
  if (source.startsWith('content/') || source.startsWith('docs/')) {
    const relative = source.replace(/^docs\//, '').split(/\s+/, 1)[0]
    if (!docsRoot) return { warn: `docs path ${relative} unchecked — no sibling docs checkout` }
    const path = join(docsRoot, relative)
    return existsSync(path)
      ? { ok: true }
      : { error: `docs path ${relative} does not exist in the docs checkout` }
  }
  if (source.includes('/')) {
    // <repo>/<path> … — a file in a sibling checkout; annotated tails are prose.
    const token = source.split(/\s+/, 2)[0]
    const [repo, ...rest] = token.split('/')
    const path = rest.join('/')
    if (path === '') {
      return { error: `"${source}" names a repo but no file in it` }
    }
    const workspaceRoot = dirname(docsRoot || PACKAGE_ROOT)
    // Workspaces keep either spelling for a checkout's directory (grove,
    // immediately-run-sdk); try the name as given first, then folded, then
    // prefixed — first existing directory wins.
    const candidates = [repo, repo.replace(/^immediately-run-/, ''), `immediately-run-${repo}`]
    const sibling = candidates
      .map((candidate) => join(workspaceRoot, candidate))
      .find((directory) => existsSync(directory))
    if (!sibling) {
      return { warn: `repo file ${repo}/${path} unchecked — sibling checkout ${repo} absent` }
    }
    return existsSync(join(sibling, path))
      ? { ok: true }
      : { error: `${repo}/${path} does not exist in the sibling checkout` }
  }
  return { error: `"${source}" matches no source shape (item id | docs path | E-id | findings-log date | repo/file)` }
}

/** Validate the registry itself: shape, sources, and (for check entries)
 *  module + fixture presence. Returns { findings: string[], warnings: string[] }
 *  — findings are registry defects and fail whatever ran the validation. */
export function validateRegistry(registry, { docsRoot = null } = {}) {
  const findings = []
  const warnings = []
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return { findings: ['the registry must be a JSON object'], warnings }
  }
  if (registry.format !== 'invariants-registry/1') {
    findings.push(`registry format must be "invariants-registry/1" (found ${JSON.stringify(registry.format)})`)
    return { findings, warnings }
  }
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    findings.push('registry.entries must be a non-empty array')
    return { findings, warnings }
  }
  const seen = new Set()
  registry.entries.forEach((entry, index) => {
    const where = entry && typeof entry.id === 'string' ? entry.id : `entry ${index}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push(`${where}: an entry must be an object`)
      return
    }
    if (typeof entry.id !== 'string' || !ID_SHAPE.test(entry.id)) {
      findings.push(`${where}: id must be lowercase kebab-case`)
    } else if (seen.has(entry.id)) {
      findings.push(`${where}: duplicate id ${entry.id}`)
    } else {
      seen.add(entry.id)
    }
    if (typeof entry.statement !== 'string' || entry.statement.trim() === '') {
      findings.push(`${where}: statement must be a non-empty string`)
    } else if (entry.statement.length > STATEMENT_MAX) {
      findings.push(`${where}: statement is ${entry.statement.length} characters (max ${STATEMENT_MAX})`)
    }
    if (entry.class !== undefined && (typeof entry.class !== 'string' || !CLASS_SHAPE.test(entry.class))) {
      findings.push(`${where}: class must be a defect-class slug (lowercase kebab-case)`)
    }
    if (typeof entry.added !== 'string' || !DATE_SHAPE.test(entry.added)) {
      findings.push(`${where}: added must be an ISO date (YYYY-MM-DD)`)
    }
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      findings.push(`${where}: sources must be a non-empty array — an entry without sources is refused`)
    } else {
      for (const source of entry.sources) {
        const verdict = validateSource(source, docsRoot)
        if (verdict.error) findings.push(`${where}: source "${source}" — ${verdict.error}`)
        if (verdict.warn) warnings.push(`${where}: source "${source}" — ${verdict.warn}`)
      }
    }
    const scope = entry.scope
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
      findings.push(`${where}: scope must be an object`)
    } else {
      const repos = scope.repos
      const reposOk =
        repos === 'core' || repos === 'apps' || repos === 'all' ||
        (Array.isArray(repos) && repos.length > 0 && repos.every((name) => typeof name === 'string' && name.trim() !== ''))
      if (!reposOk) findings.push(`${where}: scope.repos must be "core"|"apps"|"all" or a non-empty name array`)
      if (!Array.isArray(scope.paths) || scope.paths.length === 0 || !scope.paths.every((p) => typeof p === 'string' && p.trim() !== '')) {
        findings.push(`${where}: scope.paths must be a non-empty array of globs`)
      }
    }
    if (entry.enforcement !== 'check' && entry.enforcement !== 'review') {
      findings.push(`${where}: enforcement must be "check" or "review"`)
    } else if (entry.enforcement === 'check') {
      if (!CHECK_MODULES[entry.id]) {
        findings.push(`${where}: enforcement is "check" but src/invariants/${entry.id}.mjs does not exist`)
      }
      for (const fixture of ['violating', 'clean']) {
        if (!existsSync(join(FIXTURE_ROOT, entry.id, fixture))) {
          findings.push(`${where}: no ${fixture} fixture under test/invariants/${entry.id}/ — self-test is mandatory`)
        }
      }
    }
  })
  return { findings, warnings }
}

/** Files under `cwd` matched by the entry's `paths`. */
export function entryFiles(entry, cwd) {
  return fastGlob(entry.scope.paths, { cwd })
}

/** One memoized TypeScript parser for the whole run, resolved like
 *  check-comment-refs resolves its scanner: the target repo's typescript
 *  first, then its typescript-ast alias, then this package's own alias. */
export function parserProvider(cwd, loaders) {
  const chain = loaders ?? [
    () => createRequire(join(cwd, 'package.json')),
    () => createRequire(import.meta.url),
  ].flatMap((req) => [
    () => req()('typescript'),
    () => req()('typescript-ast'),
  ])
  let cached = null
  return () => {
    if (cached) return cached
    for (const load of chain) {
      try {
        const mod = load()
        if (mod && typeof mod.createSourceFile === 'function') {
          cached = mod
          return mod
        }
      } catch {
        // try the next loader
      }
    }
    throw new Error(
      'check-invariants: no TypeScript parser API found (the target repo’s typescript is TS 7 and no typescript-ast alias resolves) — the src/ invariants need one',
    )
  }
}

/** Run one check entry over a fixture tree and assert it behaves. Returns
 *  null when the fixtures behave, or the refusal reason. */
export async function selfTestEntry(entry, { fixtureRoot = FIXTURE_ROOT } = {}) {
  const module = CHECK_MODULES[entry.id]
  if (!module) return `src/invariants/${entry.id}.mjs does not exist`
  for (const [fixture, expectFindings] of [['violating', true], ['clean', false]]) {
    const fixtureDir = join(fixtureRoot, entry.id, fixture)
    if (!existsSync(fixtureDir)) return `${fixture} fixture missing under test/invariants/${entry.id}/`
    const files = await entryFiles(entry, fixtureDir)
    const findings = await module.check({
      cwd: fixtureDir,
      files,
      getTs: parserProvider(fixtureDir),
    })
    if (expectFindings && findings.length === 0) {
      return `${fixture} fixture produces no finding — the check or the fixture rotted`
    }
    if (!expectFindings && findings.length > 0) {
      return `${fixture} fixture produces ${findings.length} finding(s) — the check or the fixture rotted`
    }
  }
  return null
}

/** A sibling docs checkout (…/docs with content/roadmap), or null. Searched
 *  beside the target repo, because that is where the workspace keeps it. */
export function findDocsRoot(cwd) {
  const candidate = resolve(cwd, '..', 'docs')
  if (existsSync(join(candidate, 'content', 'roadmap'))) return candidate
  return null
}

/** The findings fingerprints: `${id}|${file}|${detail}`. No line numbers —
 *  moving code does not change a finding's identity (the comment-refs
 *  precedent); the detail (the identifier, the specifier, the URL, the lone
 *  secret) is the discriminator, so violations with DIFFERENT details in one
 *  file stay distinct. Two occurrences of the same detail in one file share
 *  one fingerprint by design: the (file, detail) pair is the debt unit a
 *  baseline absorbs, not the occurrence count. */
export function findingFingerprint(id, finding) {
  return fingerprint(`${id}|${finding.file}|${finding.detail}`)
}

/** Run every in-scope entry over `cwd`. Returns { run: [...findings with
 *  entry ids], registry: [...registry defects], review: [ids], warnings } —
 *  `registry` defects fail the run outright (never baselined). */
export async function runInvariants({ cwd, name, kind, registry = loadRegistry(), fixtureRoot }) {
  const { findings: registryFindings, warnings } = validateRegistry(registry, {
    docsRoot: findDocsRoot(cwd),
  })
  const run = []
  const review = []
  const skipped = []
  if (registryFindings.length > 0) {
    return { run, registry: registryFindings, review, warnings, skipped }
  }
  for (const entry of registry.entries) {
    if (!scopeMatches(entry, { name, kind })) continue
    // Scope rot is checked for EVERY in-scope entry, review-enforced ones
    // included, and PER GLOB: the item's rule is "a `paths` glob that
    // matches no file in a repo in scope is a finding" — a dead glob beside
    // a live one must not hide inside the union.
    const rotted = []
    for (const pattern of entry.scope.paths) {
      if ((await entryFiles({ scope: { paths: [pattern] } }, cwd)).length === 0) rotted.push(pattern)
    }
    if (rotted.length === entry.scope.paths.length) {
      registryFindings.push(
        `REGISTRY ${entry.id}: paths [${entry.scope.paths.join(', ')}] match no file in ${name} (scope ${JSON.stringify(entry.scope.repos)}) — the scope or the repo shape rotted`,
      )
      continue
    }
    if (rotted.length > 0) {
      registryFindings.push(
        `REGISTRY ${entry.id}: glob(s) [${rotted.join(', ')}] match no file in ${name} — a live glob beside them does not excuse a dead one`,
      )
    }
    const files = await entryFiles(entry, cwd)
    if (entry.enforcement === 'review') {
      review.push(entry.id)
      continue
    }
    const refusal = await selfTestEntry(entry, { fixtureRoot })
    if (refusal) {
      registryFindings.push(`${entry.id}: ${refusal}`)
      continue
    }
    const findings = await CHECK_MODULES[entry.id].check({
      cwd,
      files,
      getTs: parserProvider(cwd),
    })
    for (const finding of findings) run.push({ id: entry.id, ...finding })
  }
  return { run, registry: registryFindings, review, warnings, skipped }
}

/** The consumer entry point: run the registry over a repo and ratchet the
 *  findings against verify-baselines/invariants.json. */
export async function checkInvariants({
  cwd = process.cwd(),
  repo = null,
  baselinePath = 'verify-baselines/invariants.json',
  argv = process.argv.slice(2),
} = {}) {
  const name = repo || repoNameFromGit(cwd)
  if (!name) {
    console.error('check-invariants: cannot determine the repo name — pass it as { repo } (no origin remote?)')
    process.exitCode = 1
    return
  }
  const kind = detectRepoKind(cwd, name)
  const { run, registry, review, warnings } = await runInvariants({ cwd, name, kind })
  for (const warning of warnings) console.error(`check-invariants: warning — ${warning}`)
  for (const defect of registry) console.error(`check-invariants: REGISTRY ${defect}`)
  const fingerprints = run.map((finding) => findingFingerprint(finding.id, finding))
  for (const finding of run) {
    console.error(`check-invariants: ${finding.id} — ${finding.file}: ${finding.message}`)
  }
  if (registry.length > 0) {
    console.error(`check-invariants: ${registry.length} registry defect(s) — fix the registry, not the baseline`)
    process.exitCode = 1
    return
  }
  if (review.length > 0) {
    console.log(`check-invariants: ${review.length} review-enforced entr${review.length === 1 ? 'y' : 'ies'} in scope (${review.join(', ')}) — served to reviewers, not run`)
  }
  await ratchet({
    check: `invariants:${name}`,
    findings: fingerprints,
    baselinePath,
    cwd,
    argv,
  })
}
