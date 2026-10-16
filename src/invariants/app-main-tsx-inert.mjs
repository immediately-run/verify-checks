// app-main-tsx-inert — src/main.tsx exists for local dev/build only; the
// platform renders the default export of src/App.tsx and IGNORES main.tsx at
// runtime (app CLAUDE.md hard rules 1–2). Anything the rendered tree needs —
// global CSS imports, providers, app logic — must be reachable from
// App.tsx, so a CSS import or an SDK import in main.tsx is dead weight that
// looks load-bearing: it works on the local dev server and silently does
// nothing in production.
//
// Module specifiers are read from the parse tree (ImportDeclaration /
// ExportDeclaration module specifiers, plus dynamic import() and require()
// call arguments), never by scanning text for quoted strings.

const CSS_SPECIFIER = /\.css$/
const SDK_PREFIX = '@immediately-run/sdk'

function specifierFinding(file, line, specifier) {
  const reason = CSS_SPECIFIER.test(specifier)
    ? 'a CSS import — global CSS belongs in App.tsx, which the platform renders'
    : `an @immediately-run/sdk import — providers and app logic belong in App.tsx, which the platform renders`
  return {
    file,
    line,
    detail: specifier,
    message: `src/main.tsx imports ${specifier} (${reason})`,
  }
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
      if (CSS_SPECIFIER.test(specifier) || specifier.startsWith(SDK_PREFIX)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        findings.push(specifierFinding(file, line + 1, specifier))
      }
    }
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        flag(node, node.moduleSpecifier)
      } else if (
        ts.isCallExpression(node) &&
        ((node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments.length >= 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        flag(node, node.arguments[0])
      }
      node.forEachChild(visit)
    }
    source.forEachChild(visit)
  }
  return findings
}
