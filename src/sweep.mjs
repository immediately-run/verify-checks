// check-sweep (R3-745; plans/design-system-conformance step C1) — pure
// geometry judges over boxes collected from a rendered page. The collector
// (sweep-collect.mjs) runs in the CONSUMER's browser; these judges run in
// Node on the plain LayoutSnapshot it returns, which is what makes them
// unit-testable without a browser. Nothing here imports playwright, reads
// pixels, or launches anything.
//
// Fingerprints (the ratchet's contract, asserted exactly in the tests):
//   overflow-x|<route>|<vp>                 document scrollWidth exceeds clientWidth by > 1px
//   offscreen|<route>|<vp>|<control>        a visible control's box extends past the left/right
//                                           viewport edge or above the top
//   occluded|<route>|<vp>|<control>         the topmost element at the control's centre is
//                                           neither the control nor inside it
//   target-small|<route>|<vp>|<control>     the box is under minTarget in either dimension
//   wrapped|<route>|<vp>|<control>          taller than 1.5× line-height + vertical padding
//                                           + border — a one-line label forced onto two
//   overlay-offscreen|<route>|<vp>|<trigger>  an open overlay's box is not inside the
//                                             viewport less gutter
//   overlay-clipped|<route>|<vp>|<trigger>    the overlay's visible rect (its box intersected
//                                             with every clipping ancestor) is smaller than
//                                             its box by > 1px
//   overlay-detached|<route>|<vp>|<trigger>   no horizontal overlap with the trigger, or its
//                                             top is more than gutter + 8px below the
//                                             trigger's bottom (R-IX-1)
//   empty|<route>|<vp>|controls             the controls selector matched nothing — a broken
//                                           selector turns the sweep red, never silently green
//   overlay-missing|<route>|<vp>|<trigger>  judgeOverlay was asked about a trigger no
//                                           collected overlay answers to

export { collectLayout } from './sweep-collect.mjs'

export function judgeLayout(snapshot, { route, viewport, minTarget } = {}) {
  const vp = String(viewport)
  const findings = []
  if (snapshot.document.scrollWidth - snapshot.document.clientWidth > 1) {
    findings.push(`overflow-x|${route}|${vp}`)
  }
  const controls = snapshot.controls ?? []
  if (controls.length === 0) {
    findings.push(`empty|${route}|${vp}|controls`)
    return findings.sort()
  }
  for (const control of controls) {
    const { rect } = control
    const key = `${route}|${vp}|${control.id}`
    if (rect.x < 0 || rect.x + rect.width > snapshot.viewport.w || rect.y < 0) {
      findings.push(`offscreen|${key}`)
    }
    if (control.hitSelf === false) {
      findings.push(`occluded|${key}`)
    }
    if (minTarget !== undefined && (rect.width < minTarget || rect.height < minTarget)) {
      findings.push(`target-small|${key}`)
    }
    // A one-line label forced onto two lines: the box is taller than 1.5× the
    // computed line-height plus the vertical padding and border. The padding
    // and border are in the budget so a deliberately padded control passes.
    if (typeof control.lineHeight === 'number' && control.lineHeight > 0) {
      const budget = 1.5 * control.lineHeight + (control.paddingBlock ?? 0) + (control.borderBlock ?? 0)
      if (rect.height > budget) findings.push(`wrapped|${key}`)
    }
  }
  return findings.sort()
}

export function judgeOverlay(snapshot, { route, viewport, trigger, gutter = 0 } = {}) {
  const vp = String(viewport)
  const key = `${route}|${vp}|${trigger}`
  const overlay = (snapshot.overlays ?? []).find((record) => record.triggerId === trigger)
  if (!overlay) {
    return [`overlay-missing|${key}`]
  }
  const { rect, visibleRect, triggerRect } = overlay
  const findings = []
  if (
    rect.x < gutter ||
    rect.y < gutter ||
    rect.x + rect.width > snapshot.viewport.w - gutter ||
    rect.y + rect.height > snapshot.viewport.h - gutter
  ) {
    findings.push(`overlay-offscreen|${key}`)
  }
  if (rect.width - visibleRect.width > 1 || rect.height - visibleRect.height > 1) {
    findings.push(`overlay-clipped|${key}`)
  }
  if (!triggerRect) {
    // No discoverable trigger (no aria-controls association): the overlay is
    // attached to nothing the sweep can name — that IS detached.
    findings.push(`overlay-detached|${key}`)
  } else {
    const overlapsHorizontally =
      rect.x < triggerRect.x + triggerRect.width && rect.x + rect.width > triggerRect.x
    const gapBelowTrigger = rect.y - (triggerRect.y + triggerRect.height)
    if (!overlapsHorizontally || gapBelowTrigger > gutter + 8) {
      findings.push(`overlay-detached|${key}`)
    }
  }
  return findings.sort()
}
