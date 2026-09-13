// Refuse a verdict the installed tree cannot support (R3-628).
//
// knip resolves the repo's module graph. With `node_modules` behind
// `package-lock.json` it resolves almost nothing, so findings that are genuinely
// present are reported ABSENT — and the ratchet reads that absence as "the baseline
// is stale" and prints the one instruction that permanently erodes it: remove the
// entry. Observed twice on 2026-09-13: one entry in the SDK (removed as instructed,
// then reported NEW again after `npm ci` — the baseline had been right), and 180
// entries in site-main, all of which disappeared after `npm ci`.
//
// The check cannot tell "this finding is gone" from "I could not look". So before a
// resolution-dependent check renders anything, it asks whether the tree it is about
// to read matches the lockfile, and refuses if it does not. Undetermined is a third
// outcome, not a pass.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** npm writes this on every install; it describes the tree AS INSTALLED, which is
 *  exactly the question being asked. Comparing mtimes would be a heuristic that a
 *  checkout or a `touch` defeats. */
const HIDDEN_LOCK = join('node_modules', '.package-lock.json')
const PROJECT_LOCK = 'package-lock.json'

/** The packages map of a lockfile-shaped object, keyed by install path. */
const packagesOf = (parsed) =>
  parsed && typeof parsed === 'object' && parsed.packages && typeof parsed.packages === 'object'
    ? parsed.packages
    : {}

/** The root entry ("") is the project itself, not a dependency; it carries the repo's
 *  own version, which legitimately differs between the two files mid-bump. */
const isDependencyPath = (path) => typeof path === 'string' && path.startsWith('node_modules/')

/**
 * Compare a project lockfile against the installed tree. PURE — both arguments are
 * already-parsed JSON, so the decision is testable without a filesystem or npm.
 *
 * What counts as stale:
 *  - a package present in BOTH at different versions — unambiguous;
 *  - a package the lock names that the tree does not have at all (the site-main
 *    shape, where whole packages were missing).
 *
 * What does NOT count:
 *  - a package present only in the tree. A link, or an extra install, is not evidence
 *    that the tree is behind, and flagging it would make the guard cry wolf.
 */
export function compareInstallToLock({ lock, installed }) {
  const lockPackages = packagesOf(lock)
  const treePackages = packagesOf(installed)
  const mismatches = []
  const missing = []
  for (const [path, entry] of Object.entries(lockPackages)) {
    if (!isDependencyPath(path)) continue
    // A lock entry can describe something that is never installed on its own (a link
    // target, an optional package skipped on this platform). Only entries carrying a
    // concrete version are comparable.
    const wanted = entry && typeof entry === 'object' ? entry.version : undefined
    if (typeof wanted !== 'string') continue
    if (entry.link === true || entry.optional === true) continue
    const present = treePackages[path]
    if (!present || typeof present !== 'object') {
      missing.push({ path, wanted })
      continue
    }
    if (typeof present.version === 'string' && present.version !== wanted) {
      mismatches.push({ path, wanted, installed: present.version })
    }
  }
  return { fresh: mismatches.length === 0 && missing.length === 0, mismatches, missing }
}

/** How many disagreements to name before summarising — enough to recognise the
 *  shape, not so many that the message buries its own instruction. */
const SHOWN = 5

/** The refusal a reader gets: what disagreed, and the one command that fixes it. */
export function describeStaleInstall({ mismatches, missing }, { cwd = '.' } = {}) {
  const lines = [
    `refusing to render a verdict: node_modules does not match package-lock.json in ${cwd}.`,
    '  A stale install makes this check report findings it simply could not see, and its advice',
    '  would be to delete baseline entries that are correct. Run `npm ci`, then re-run.',
  ]
  for (const { path, wanted, installed } of mismatches.slice(0, SHOWN)) {
    lines.push(`  · ${path}: lockfile wants ${wanted}, installed ${installed}`)
  }
  for (const { path, wanted } of missing.slice(0, SHOWN - Math.min(mismatches.length, SHOWN))) {
    lines.push(`  · ${path}: lockfile wants ${wanted}, not installed`)
  }
  const total = mismatches.length + missing.length
  if (total > SHOWN) lines.push(`  · …and ${total - SHOWN} more`)
  return lines.join('\n')
}

/**
 * Read both lockfiles and throw unless the tree matches. Called by the checks whose
 * verdict depends on module resolution, before they produce one.
 *
 * A missing `node_modules/.package-lock.json` is a refusal rather than a pass: with
 * no evidence the guard cannot answer, and answering "fine" is the failure mode this
 * exists to remove.
 */
export function assertFreshInstall({ cwd = process.cwd(), check = 'check' } = {}) {
  const projectLockPath = join(cwd, PROJECT_LOCK)
  // A repo with no lockfile is not npm-managed in the way this guard understands;
  // it has nothing to be stale against.
  if (!existsSync(projectLockPath)) return
  const hiddenLockPath = join(cwd, HIDDEN_LOCK)
  if (!existsSync(hiddenLockPath)) {
    throw new Error(
      `${check}: refusing to render a verdict: ${HIDDEN_LOCK} is missing, so whether the installed ` +
        'tree matches package-lock.json cannot be determined. Run `npm ci`, then re-run.',
    )
  }
  const parse = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`${check}: could not read ${path}: ${err.message}`)
    }
  }
  const result = compareInstallToLock({ lock: parse(projectLockPath), installed: parse(hiddenLockPath) })
  if (!result.fresh) {
    throw new Error(`${check}: ${describeStaleInstall(result, { cwd })}`)
  }
}
