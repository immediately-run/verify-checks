// app-main-tsx-inert — invariant registry entry (R3-1170): the local dev
// entry stays inert. It imports no CSS file (global CSS belongs in the entry
// the platform renders — App.tsx or the package.json "main") and nothing
// from the @immediately-run/sdk PACKAGE ROOT: the root reaches for the host
// transport at module load and throws under vite dev, while the narrow
// subpaths are exactly what main.tsx is supposed to import (R3-553:
// `@immediately-run/sdk/boot`, `/routing`, `/urlUtils`, …). Banning the
// whole namespace would flag every compliant app — the check therefore
// flags only the bare-root spellings.
//
// Module specifiers are read from the parse tree (ImportDeclaration /
// ExportDeclaration module specifiers, plus dynamic import() and require()
// call arguments), never by scanning text for quoted strings.

const CSS_SPECIFIER = /\.css$/
const SDK_ROOT = '@immediately-run/sdk'

/** Only the package-root spellings are banned; deeper subpaths (sdk/boot,
 *  sdk/routing, …) are the prescribed shape R3-553 names. */
export function isSdkRoot(specifier) {
  return specifier === SDK_ROOT || specifier === `${SDK_ROOT}/`
}

export function reasonFor(specifier) {
  return CSS_SPECIFIER.test(specifier)
    ? 'a CSS import — global CSS belongs in the entry the platform renders'
    : 'the SDK package root — it reaches for the host transport at module load and throws under vite dev; import a narrow subpath (R3-553)'
}

export async function check({ cwd, files, getTs }) {
  const ts = getTs()
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const findings = []
  for (const file of files) {
    const text = readFileSync(join(cwd, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const flag = (node, specifierNode) => {
      const specifier = specifierNode.text
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push({
        file,
        line: line + 1,
        detail: specifier,
        message: `src/main.tsx imports ${specifier} (${reasonFor(specifier)})`,
      })
    }
    const banned = (specifierNode) =>
      ts.isStringLiteral(specifierNode) &&
      (CSS_SPECIFIER.test(specifierNode.text) || isSdkRoot(specifierNode.text))
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        banned(node.moduleSpecifier)
      ) {
        flag(node, node.moduleSpecifier)
      } else if (
        ts.isCallExpression(node) &&
        ((node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length >= 1 &&
        banned(node.arguments[0])
      ) {
        flag(node, node.arguments[0])
      }
      node.forEachChild(visit)
    }
    source.forEachChild(visit)
  }
  return findings
}
