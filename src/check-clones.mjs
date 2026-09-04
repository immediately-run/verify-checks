import { fingerprint, ratchet } from './baseline.mjs'
import { cloneFingerprints, runJscpd } from './producers.mjs'

export { cloneFingerprints, runJscpd }

export async function checkClones({
  patterns,
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
  const report = runJscpd({ patterns, minLines, minTokens, cwd })
  const findings = (report.duplicates ?? []).map((dup) => fingerprint(dup.fragment))
  await ratchet({ check: 'clones', findings, baselinePath, cwd })
}
