// The multi-glob consumer-shape fixture (R3-674 round 2): one of the ONLY two
// .mjs files here; renderSiblingCaption is cloned across the .mjs pair, so the
// second glob in the two-glob test is load-bearing — masking it loses a clone.
export function renderSiblingCaption(label, count) {
  const suffix = count === 1 ? 'entry' : 'entries'
  const trimmed = label.trim()
  const prefix = trimmed === '' ? 'Unnamed' : trimmed
  const width = Math.min(Math.max(prefix.length, 4), 32)
  const padded = prefix.padEnd(width, '.')
  const tone = count === 0 ? 'empty' : count > 9 ? 'busy' : 'quiet'
  return `${padded} — ${count} ${suffix}, ${tone}`
}
