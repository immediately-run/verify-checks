import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// app-no-web-storage — invariant registry entry (R3-1170): no identifier
// reference to the browser's web-storage or Cache APIs anywhere under src/.
// An app runs at an opaque origin (a sandboxed iframe without
// allow-same-origin), where even READING these throws SecurityError, so a
// typeof guard cannot catch it — the throw is on property access, not on
// the value. State goes to the SDK's openLocalStore()/openSettings().
//
// "Identifier reference" is decided over the parse tree (the TypeScript
// AST, never a text scan — strings, comments and template literals do not
// parse as identifiers), in two parts:
//
//   SYNTAX — a bare mention references; a member access references only on
//     a global receiver (window.sessionStorage — the receiver names the
//     global even where a local shadows the member name); props.caches is
//     that object's property, and the check has no type information to
//     tell receivers apart by kind; a declaring position (an object key, a
//     class/interface member, a JSX attribute, an import renaming token)
//     binds or labels — it references nothing.
//   SCOPE — a bare mention of a name the file BINDS (a variable, a
//     parameter, a function/class/enum/interface/type name, an import
//     binding, a destructuring binding, a catch variable) is the file's
//     own local, never the platform global. File-granular by design: a
//     full scope walk would re-derive the binder, and a banned name bound
//     anywhere in an app file is that file's vocabulary, not the
//     platform's. An object-literal KEY is not a binding — { caches: x }
//     labels a property without shadowing anything.
//
// A dynamically-spelled access (window['local' + 'Storage']) or an aliased
// receiver is invisible to this check — by design; the rule is about not
// spelling the identifier at all.

const BANNED = ['localStorage', 'sessionStorage', 'indexedDB', 'caches']
const GLOBAL_RECEIVERS = ['window', 'globalThis', 'self']

export function check({ cwd, files, getTs }) {
  const ts = getTs()
  const findings = []
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue
    const text = readFileSync(join(cwd, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const bound = new Set()
    collectBoundNames(source, ts, bound)
    const visit = (node) => {
      if (ts.isIdentifier(node) && BANNED.includes(node.text) && referencesGlobal(node, ts, bound)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        findings.push({
          file,
          line,
          detail: node.text,
          message: `${node.text} is unavailable at an opaque origin (even reading it throws SecurityError) — use openLocalStore()/openSettings() from the SDK`,
        })
      }
      node.forEachChild(visit)
    }
    source.forEachChild(visit)
  }
  return findings
}

/** Does this Identifier reference the platform global? See the header:
 *  syntax first (what references at all), scope second (what the file
 *  binds). */
function referencesGlobal(node, ts, bound) {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return ts.isIdentifier(parent.expression) && GLOBAL_RECEIVERS.includes(parent.expression.text)
  }
  if (isNamePosition(node, ts)) return false
  return !bound.has(node.text)
}

/** Declaring/labeling positions: the parent uses the Identifier as its
 *  .name (or an import specifier's propertyName, which renames the
 *  module's export). Computed names are not plain Identifiers here. */
function isNamePosition(node, ts) {
  const parent = node.parent
  const namesWith =
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isJsxAttribute(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent)
  if (namesWith && parent.name === node) return true
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) return true
  return false
}

/** Scope bindings: declarations that introduce a NAME the file can then
 *  speak of. An object-literal key is NOT one. A destructuring element's
 *  propertyName READS (`{ localStorage: x } = window`) and does not bind. */
function isScopeBinding(node, ts) {
  const parent = node.parent
  const binds =
    ts.isVariableDeclaration(parent) ||
    ts.isBindingElement(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isCatchClause(parent)
  if (!binds) return false
  if (ts.isBindingElement(parent)) return parent.name === node && parent.propertyName !== node
  if (ts.isImportSpecifier(parent)) return parent.name === node
  return parent.name === node
}

function collectBoundNames(node, ts, bound) {
  if (ts.isIdentifier(node) && isScopeBinding(node, ts)) bound.add(node.text)
  node.forEachChild((child) => collectBoundNames(child, ts, bound))
}
