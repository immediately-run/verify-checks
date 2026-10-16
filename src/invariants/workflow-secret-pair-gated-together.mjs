import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

// workflow-secret-pair-gated-together — invariant registry entry (R3-1170):
// a workflow `if:` that references one member of a declared secret pair must
// reference both. The fleet defect behind it (34 escaped findings-log rows,
// escape E01): the replicated cache.yml gated the Pages-token mint on
// DEPLOY_APP_ID alone, so an id present with the private key absent ran the
// mint with an empty key and aborted before the github.token fallback.
//
// Workflows are parsed with the yaml package (never a regex over source);
// every `if:` string anywhere in the document is checked, whatever its
// depth (job level, step level), and both spellings count — secrets.NAME
// and env.NAME — because the word-boundary test is on the NAME.

const SECRET_PAIRS = [
  ['DEPLOY_APP_ID', 'DEPLOY_APP_PRIVATE_KEY'],
]

export function loneSecrets(condition) {
  const lone = []
  for (const [a, b] of SECRET_PAIRS) {
    const hasA = new RegExp(`\\b${a}\\b`).test(condition)
    const hasB = new RegExp(`\\b${b}\\b`).test(condition)
    if (hasA !== hasB) lone.push(hasA ? [a, b] : [b, a])
  }
  return lone
}

/** Every `if:` string in a parsed workflow, with its path in the document
 *  (e.g. "jobs.deploy.steps[3].if") — better than a line number for
 *  workflows, because the path survives reformatting. */
export function ifConditions(workflow) {
  const found = []
  const visit = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'if' && typeof value === 'string') found.push({ path: path ? `${path}.if` : 'if', condition: value })
      else visit(value, path ? `${path}.${key}` : key)
    }
  }
  visit(workflow, '')
  return found
}

export function check({ cwd, files }) {
  const findings = []
  for (const file of files) {
    if (!/\.(yml|yaml)$/.test(file)) continue
    let workflow
    const text = readFileSync(join(cwd, file), 'utf8')
    try {
      workflow = YAML.parse(text)
    } catch (err) {
      findings.push({
        file,
        detail: 'yaml-parse',
        message: `not valid YAML — refusing to skip it: ${err.message.split('\n')[0]}`,
      })
      continue
    }
    for (const { path, condition } of ifConditions(workflow)) {
      for (const [present, absent] of loneSecrets(condition)) {
        findings.push({
          file,
          detail: present,
          message: `${path} references ${present} without ${absent} — gate the pair together or fall back to github.token explicitly`,
        })
      }
    }
  }
  return findings
}
