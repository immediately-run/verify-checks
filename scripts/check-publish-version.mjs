#!/usr/bin/env node
// check-publish-version.mjs — a PR that changes shipped bytes must bump
// `version` in the SAME PR. Ported (compact) from platform-constants' R3-327
// check: on `main` the release job refuses a re-publish of an existing
// version, but PRs never run the release job — so without this the cost lands
// on `main` and on whoever pushes next.
//
// Scoped to what ships: `files:` from package.json (src/) plus package.json
// itself and the lockfile. Tests, fixtures, CI config and docs demand no bump.
//
// An unreachable registry or unknown base is a THIRD OUTCOME — "not published"
// and "could not tell" are different answers; both fail here with the reason.
//
// Run: `node scripts/check-publish-version.mjs`
//      `node scripts/check-publish-version.mjs --base <ref>`
//      `node scripts/check-publish-version.mjs --self-test`

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const git = (args) => execFileSync('git', args, { encoding: 'utf8' })

function changedSince(base) {
  let mb
  try {
    mb = git(['merge-base', 'HEAD', base]).trim()
  } catch {
    console.error(`check:publish-version: cannot resolve ${base} — run: git fetch origin`)
    process.exit(1)
  }
  return git(['diff', '--name-only', '--diff-filter=ACMRT', `${mb}..HEAD`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function shipsChanges(changed) {
  return changed.some((path) => {
    if (path === 'package.json' || path === 'package-lock.json') return true
    if (path.startsWith('src/')) {
      if (/(^|\/)(test|tests)\//.test(path)) return false
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false
      return true
    }
    return false
  })
}

function versionPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch (err) {
    const text = `${err.stdout ?? ''} ${err.stderr ?? ''}`
    if (/E404/.test(text)) return false
    console.error(`check:publish-version: registry unreachable or indeterminate for ${name}@${version} — refusing to guess. (${text.trim().split('\n')[0]})`)
    process.exit(1)
  }
}

const selfTest = process.argv.includes('--self-test')
if (selfTest) {
  const same = shipsChanges(['src/producers.mjs'])
  const testsOnly = shipsChanges(['test/baseline.test.ts', 'README.md', '.github/workflows/ci.yml'])
  if (same !== true || testsOnly !== false) {
    console.error('check:publish-version: self-test failed')
    process.exit(1)
  }
  console.log('check:publish-version: self-test passed')
  process.exit(0)
}

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const baseIndex = process.argv.indexOf('--base')
const base = baseIndex !== -1 ? process.argv[baseIndex + 1] : 'origin/main'
const changed = changedSince(base)
if (!shipsChanges(changed)) {
  console.log(`check:publish-version: no shipped bytes changed — no bump needed`)
  process.exit(0)
}
if (versionPublished(name, version)) {
  console.error(`check:publish-version: ${name}@${version} is already published but shipped bytes changed in this PR — bump the version.`)
  process.exit(1)
}
console.log(`check:publish-version: ${name}@${version} is unpublished — bump is consistent`)
