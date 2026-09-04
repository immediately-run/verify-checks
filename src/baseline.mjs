import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function fingerprint(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

export function diffAgainstBaseline(found, baseline) {
  const baselined = new Set(baseline)
  const present = new Set(found)
  return {
    new: found.filter((entry) => !baselined.has(entry)).sort(),
    stale: baseline.filter((entry) => !present.has(entry)).sort(),
  }
}

export function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (err) {
    throw new Error(`baseline ${baselinePath} is not valid JSON: ${err.message}`)
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`baseline ${baselinePath} must be a JSON array of fingerprint strings`)
  }
  return parsed
}

export function writeBaselineFile(baselinePath, entries) {
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, `${JSON.stringify([...new Set(entries)].sort(), null, 2)}\n`)
}

export async function ratchet({
  check,
  findings,
  baselinePath,
  cwd = process.cwd(),
  argv = process.argv.slice(2),
}) {
  const unique = [...new Set(findings)]
  if (argv.includes('--write-baseline')) {
    if (existsSync(baselinePath)) {
      console.error(
        `${check}: refusing to overwrite ${baselinePath} — a baseline file already exists there. ` +
          'Baselines only shrink: fix the findings, or delete the stale entries by hand and let the check confirm.',
      )
      process.exitCode = 1
      return
    }
    writeBaselineFile(baselinePath, unique)
    console.log(`${check}: wrote ${unique.length} fingerprint(s) to ${baselinePath}`)
    return
  }
  const baseline = readBaseline(baselinePath)
  if (baseline === null) {
    console.error(
      `${check}: no baseline at ${baselinePath} (cwd ${cwd}). ` +
        `Create it once with --write-baseline, commit it, and never regenerate it.`,
    )
    process.exitCode = 1
    return
  }
  const { new: fresh, stale } = diffAgainstBaseline(unique, baseline)
  for (const entry of fresh) console.error(`${check}: NEW ${entry}`)
  for (const entry of stale) {
    console.error(`${check}: STALE ${entry} — no longer matches anything; remove it from the baseline`)
  }
  if (fresh.length > 0 || stale.length > 0) {
    console.error(`${check}: ${fresh.length} new, ${stale.length} stale (baseline ${baselinePath})`)
    process.exitCode = 1
  }
}
