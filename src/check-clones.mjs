import { fingerprint, ratchet } from './baseline.mjs'
import { cloneFragments, runJscpd } from './producers.mjs'

export { cloneFragments, runJscpd }

export async function checkClones({
  patterns,
  ignore = [],
  minLines = 6,
  minTokens = 50,
  baselinePath,
  cwd = process.cwd(),
} = {}) {
  if (!patterns || patterns.length === 0) {
    throw new Error('check-clones: patterns is required (e.g. ["src/**/*.{ts,tsx,css}"])')
  }
  if (!baselinePath) {
    throw new Error('check-clones: baselinePath is required (e.g. "verify-baselines/clones.json")')
  }
  const report = runJscpd({ patterns, ignore, minLines, minTokens, cwd })
  const findings = cloneFragments(report).map((fragment) => fingerprint(fragment))
  await ratchet({ check: 'clones', findings, baselinePath, cwd })
}
