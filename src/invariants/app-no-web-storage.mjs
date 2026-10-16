import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// app-no-web-storage — invariant registry entry (R3-1170): no identifier
// reference to the browser's web-storage or Cache APIs anywhere under src/.
// An app runs at an opaque origin (a sandboxed iframe without
// allow-same-origin), where even READING these throws SecurityError, so a
// typeof guard cannot catch it — the throw is on property access, not on
// the value. State goes to the SDK's openLocalStore()/openSettings().
//
// "Identifier reference" means an Identifier node in the TypeScript AST: a
// bare mention (caches.keys()), or a member of the global receivers
// window/globalThis/self (window.sessionStorage). Strings, comments and
// template literals never parse as identifiers; a property named the same
// on some other object (props.caches) or a declaring position (an
// object-literal key, a JSX attribute) is not a reference. A dynamically
// spelled access (window['local' + 'Storage']) or an aliased receiver is
// invisible to this check — by design; the rule is about not spelling the
// identifier at all.

const BANNED = ['localStorage', 'sessionStorage', 'indexedDB', 'caches']
const GLOBAL_RECEIVERS = ['window', 'globalThis', 'self']

export function check({ cwd, files, getTs }) {
  const ts = getTs()
  const findings = []
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue
    const text = readFileSync(join(cwd, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    walk(source, file, ts, findings)
  }
  return findings
}

function walk(node, file, ts, findings) {
  if (ts.isIdentifier(node) && BANNED.includes(node.text) && !isDeclarationName(node, ts) && isGlobalReference(node, ts)) {
    const source = node.getSourceFile()
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    findings.push({
      file,
      line,
      detail: node.text,
      message: `${node.text} is unavailable at an opaque origin (even reading it throws SecurityError) — use openLocalStore()/openSettings() from the SDK`,
    })
  }
  node.forEachChild((child) => walk(child, file, ts, findings))
}

/** A banned identifier counts when spelled bare (caches.keys()) or as a
 *  member of a global receiver (window.sessionStorage). A member of any
 *  other object (props.caches, config.localStorage) is that object's
 *  property, not the platform global — flagging it would be noise, and the
 *  check runs with no type information to tell receivers apart by kind. */
function isGlobalReference(node, ts) {
  const parent = node.parent
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return ts.isIdentifier(parent.expression) && GLOBAL_RECEIVERS.includes(parent.expression.text)
  }
  return true
}

/** Declaration-shaped positions: an Identifier that names an object-literal
 *  key, a class/interface/enum member, a method/accessor, or a JSX attribute
 *  declares the name, it does not reference the global. Computed names are
 *  not plain Identifier nodes in these positions, so the name check already
 *  excludes them. */
function isDeclarationName(node, ts) {
  const parent = node.parent
  if (!parent) return false
  const namesIt = ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isJsxAttribute(parent)
  return namesIt && parent.name === node
}
