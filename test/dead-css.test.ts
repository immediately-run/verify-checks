import { describe, expect, it } from 'vitest'
import { extractSelectors, findDeadSelectors, sourceWords } from '../src/check-dead-css.mjs'
import selectorsExpected from './fixtures/app-css-selectors.expected.json'
import deadExpected from './fixtures/app-css-dead.expected.json'
import { readFileSync } from 'node:fs'

// Frozen inputs: a dated snapshot of landing-page's real src/App.css and its
// real sources (see the fixture headers). R3-532/R3-533 rewrite that file, so
// a fixture from a stale checkout would freeze selectors that no longer
// exist; these were snapshotted 2026-09-04 from origin/main.
describe('extractSelectors over landing-page\'s real App.css (frozen fixture)', () => {
  const css = readFileSync(new URL('./fixtures/app-css.snapshot.css', import.meta.url), 'utf8')
  const usage = readFileSync(new URL('./fixtures/app-css-usage.snapshot.txt', import.meta.url), 'utf8')

  it('extraction is frozen: the exact selector set the snapshot held on 2026-09-04', () => {
    expect(extractSelectors(css, { filePath: 'src/App.css' })).toEqual(selectorsExpected.selectors)
  })

  it('the measured dead set is exactly what the real tree yielded on 2026-09-04', () => {
    const dead = findDeadSelectors({
      cssFiles: [{ path: 'src/App.css', text: css }],
      sourceTexts: [usage],
    })
    expect(dead).toEqual(deadExpected.dead)
  })
})

describe('extractSelectors + findDeadSelectors', () => {
  const css = `
/* .commented is in a comment and must not appear */
.used { color: red; }
.dead { color: blue; }
.hovered:hover { color: green; }
.before::before { content: ""; }
input[type="text"] { color: black; }
.keyf { animation: spin 1s; }
@keyframes spin { from { transform: none; } to { transform: rotate(1turn); } }
.also-dead, .used-twice { margin: 0; }
.used-twice .nested { padding: 0; }
`

  it('a selector used in a .tsx passes; one used only in the .css fails', () => {
    const sources = ['export const A = () => <div className="used" />']
    const dead = findDeadSelectors({ cssFiles: [{ path: 'fixture.css', text: css }], sourceTexts: sources })
    expect(dead).toContain('fixture.css:.dead')
    expect(dead).not.toContain('fixture.css:.used')
  })

  it(':hover, ::before and attribute selectors are ignored', () => {
    const sources = ['const x = "hovered before keyf"']
    const dead = findDeadSelectors({ cssFiles: [{ path: 'fixture.css', text: css }], sourceTexts: sources })
    expect(dead.some((entry) => entry.includes('hovered'))).toBe(false)
    expect(dead.some((entry) => entry.includes('before'))).toBe(false)
    expect(dead.some((entry) => entry.includes('input'))).toBe(false)
  })

  it('@keyframes blocks and comments produce no selectors', () => {
    const all = extractSelectors(css, { filePath: 'fixture.css' })
    expect(all).not.toContain('fixture.css:from')
    expect(all).not.toContain('fixture.css:to')
    expect(all).not.toContain('fixture.css:commented')
  })

  it('the first rule inside @media/@supports is extracted, not just later ones', () => {
    const media = '@media (max-width: 900px) { .mq-only { color: red; } .mq-second { color: blue; } }'
    expect(extractSelectors(media, { filePath: 'm.css' }).sort()).toEqual([
      'm.css:.mq-only',
      'm.css:.mq-second',
    ])
    const nested = '.top { a: 1 } @supports (display: grid) { .sup { b: 2 } @media print { .pr { c: 3 } } }'
    expect(extractSelectors(nested, { filePath: 'n.css' }).sort()).toEqual([
      'n.css:.pr',
      'n.css:.sup',
      'n.css:.top',
    ])
  })

  it('an unquoted url() body with braces cannot split blocks', () => {
    const tricky = `.icon { background: url(data:image/svg+xml;{,a}); }\n.after-url { color: red; }`
    expect(extractSelectors(tricky, { filePath: 'u.css' })).toEqual(['u.css:.icon', 'u.css:.after-url'])
  })

  it('a string containing a brace does not split blocks', () => {
    const tricky = `.with-content::after { content: "}"; }\n.after-str { color: red; }`
    const all = extractSelectors(tricky, { filePath: 't.css' })
    expect(all).toEqual(['t.css:.after-str'])
  })

  it('sourceWords splits on non-word chars but keeps hyphens', () => {
    expect([...sourceWords(['a-b c.d'])].sort()).toEqual(['a-b', 'c', 'd'])
  })
})
