import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findTokenFindings } from '../src/check-tokens.mjs'
import expected from './fixtures/landing-tokens.expected.json'

// The real-producer input: a dated snapshot of landing-page's src/index.css +
// src/sections/docs/docs.css (see the fixture headers), as dead-css.test.ts
// does with App.css. The --muted reference resolves to nothing in the real
// repo today — this test is what keeps the check honest against real CSS.
describe('check-tokens over landing-page’s real stylesheets (frozen fixture)', () => {
  const cssFiles = [
    {
      path: 'src/index.css',
      text: readFileSync(new URL('./fixtures/landing-index-css.snapshot.css', import.meta.url), 'utf8'),
    },
    {
      path: 'src/sections/docs/docs.css',
      text: readFileSync(new URL('./fixtures/landing-docs-css.snapshot.css', import.meta.url), 'utf8'),
    },
  ]
  const findings = findTokenFindings({ cssFiles, sourceFiles: [] })

  it('catches the --muted reference that resolves to nothing', () => {
    expect(findings).toContain('undeclared|src/sections/docs/docs.css|--muted')
  })

  it('the measured finding set is exactly what the snapshot yielded on 2026-09-30', () => {
    expect(findings).toEqual(expected.findings)
  })
})
