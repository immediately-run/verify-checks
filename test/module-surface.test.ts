import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every published subpath imports under PLAIN node — no vitest transform, no
// bundler. A stale re-export is a link-time SyntaxError for every consumer,
// and vitest's transform masked exactly that on 2026-09-30 (a deleted
// function still named in a re-export, found by the review gate).
const REPO_ROOT = new URL('..', import.meta.url).pathname

describe('the published module surface', () => {
  it('every exports entry imports under plain node', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8'))
    const entries = Object.values(pkg.exports) as string[]
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      const result = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(`${REPO_ROOT}${entry.slice(1)}`)}).then(() => {})`], {
        encoding: 'utf8',
      })
      expect(result).toBe('')
    }
  })
})
