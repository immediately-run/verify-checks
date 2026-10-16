import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'

// app-no-remote-css-import — invariant registry entry (R3-1170): no @import
// of a remote URL in an app's CSS (app CLAUDE.md hard rule 6, R3-315: "no
// @import to a third-party host remains in any shipped stylesheet"). A
// remote font or stylesheet breaks offline in every stance (the cache zip
// exists so a wiki works with no network), and a low-trust corpus's CSP
// blocks the import under compiled dispatch. Fonts are declared assets
// (data/themeFonts.ts): the engine reads the bytes off the mount and mints
// blob: @font-face rules.
//
// Remote means BOTH spellings of scheme-absolute: the http(s) URL and the
// protocol-relative '//host/path.css' (the same fetch, spelled shorter).
// CSS is parsed by postcss and the @import parameter list by
// postcss-value-parser (the check-tokens precedent) — never a regex over
// source.

const REMOTE = /^(?:https?:)?\/\//i

export function remoteImportUrls(params) {
  const urls = []
  for (const node of valueParser(params).nodes) {
    if (node.type === 'function' && node.value === 'url') {
      const inner = node.nodes && node.nodes[0]
      if (inner && (inner.type === 'string' || inner.type === 'word')) urls.push(inner.value)
    } else if (node.type === 'string') {
      urls.push(node.value)
    }
  }
  return urls
}

export function check({ cwd, files }) {
  const findings = []
  for (const file of files) {
    if (!/\.css$/.test(file)) continue
    const text = readFileSync(join(cwd, file), 'utf8')
    const root = postcss.parse(text, { from: file })
    root.walkAtRules('import', (atRule) => {
      for (const url of remoteImportUrls(atRule.params)) {
        if (REMOTE.test(url)) {
          findings.push({
            file,
            line: atRule.source.start.line,
            detail: url,
            message: `@import of a remote URL — breaks offline in every stance and is blocked under compiled dispatch; declare the font as an asset instead`,
          })
        }
      }
    })
  }
  return findings
}
