export function formatTileLabel(label: string, count: number): string {
  const suffix = count === 1 ? 'item' : 'items'
  const trimmed = label.trim()
  const prefix = trimmed === '' ? 'Untitled' : trimmed
  const width = Math.min(Math.max(prefix.length, 4), 32)
  const padded = prefix.padEnd(width, '.')
  const tone = count === 0 ? 'empty' : count > 9 ? 'busy' : 'quiet'
  return `${padded} (${count} ${suffix}, ${tone})`
}

export function onlyInA(x: number): number {
  return x * 2 + 1
}
