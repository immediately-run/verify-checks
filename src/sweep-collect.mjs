// sweep-collect — the page-side half of check-sweep (R3-745; plans/
// design-system-conformance step C1). collectLayout is handed to the
// CONSUMER's browser (Playwright's page.evaluate ships its source text), so
// it references nothing outside its own body: no imports, no closures, no
// module bindings — only browser globals. The serialisability test in
// test/sweep.test.ts pins that. All judgement lives in sweep.mjs's pure
// functions; this file only measures.

export function collectLayout(selectors) {
  const controlsSelector = selectors && selectors.controls
  const overlaysSelector = selectors && selectors.overlays

  function stableId(el) {
    const override = el.getAttribute('data-sweep-id')
    if (override) return override
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel
    const testid = el.getAttribute('data-testid')
    if (testid) return testid
    const tag = el.tagName.toLowerCase()
    const firstClass = (el.getAttribute('class') || '').trim().split(/\s+/)[0] || ''
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    return tag + (firstClass ? '.' + firstClass : '') + (text ? ' "' + text + '"' : '')
  }

  // Visibility, defined once: painted (a client rect), computed visibility
  // not hidden (it inherits, so the element's own value answers for
  // ancestors), no opacity:0 on the element or an ancestor, and not inert or
  // inside [aria-hidden=true].
  function isVisible(el) {
    if (el.getClientRects().length === 0) return false
    if (getComputedStyle(el).visibility === 'hidden') return false
    for (let node = el; node; node = node.parentElement) {
      if (getComputedStyle(node).opacity === '0') return false
      if (node.hasAttribute('inert')) return false
      if (node.getAttribute('aria-hidden') === 'true') return false
    }
    return true
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }

  // The topmost element at the rect's centre is the element or inside it.
  // null (unknown) when the centre is outside the viewport — elementFromPoint
  // answers null there whether or not anything occludes the control, and a
  // below-the-fold control is not an occlusion finding.
  function hitSelf(el, rect) {
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null
    const hit = document.elementFromPoint(cx, cy)
    return hit !== null && (hit === el || el.contains(hit))
  }

  // The clipped visible rect: the box intersected with every ancestor whose
  // overflow is not visible (overflow: clip clips too — only scrolling
  // differs) or that sets contain: paint. Overflow clips at the padding box,
  // so the clip bounds come from clientLeft/clientTop + clientWidth/
  // clientHeight, not the border box.
  function visibleRectOf(el, rect) {
    const vis = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      const containPaint = (style.contain || '').indexOf('paint') !== -1
      const clipX = containPaint || style.overflowX !== 'visible'
      const clipY = containPaint || style.overflowY !== 'visible'
      if (!clipX && !clipY) continue
      const ar = node.getBoundingClientRect()
      if (clipX) {
        vis.left = Math.max(vis.left, ar.left + node.clientLeft)
        vis.right = Math.min(vis.right, ar.left + node.clientLeft + node.clientWidth)
      }
      if (clipY) {
        vis.top = Math.max(vis.top, ar.top + node.clientTop)
        vis.bottom = Math.min(vis.bottom, ar.top + node.clientTop + node.clientHeight)
      }
    }
    return {
      x: vis.left,
      y: vis.top,
      width: Math.max(0, vis.right - vis.left),
      height: Math.max(0, vis.bottom - vis.top),
    }
  }

  // The trigger an overlay answers to: the element whose aria-controls names
  // the overlay's id, preferring the one currently expanded.
  function triggerOf(overlay) {
    const id = overlay.getAttribute('id')
    if (!id) return null
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
    // ~= : aria-controls is an IDREF LIST — a trigger naming several overlays
    // still controls this one.
    return (
      document.querySelector('[aria-controls~="' + escaped + '"][aria-expanded="true"]') ||
      document.querySelector('[aria-controls~="' + escaped + '"]')
    )
  }

  function controlRecord(el) {
    const rect = rectOf(el)
    const style = getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight)
    return {
      id: stableId(el),
      rect,
      hitSelf: hitSelf(el, rect),
      lineHeight: Number.isNaN(lineHeight) ? null : lineHeight,
      paddingBlock: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      borderBlock: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
    }
  }

  function overlayRecord(el) {
    const rect = rectOf(el)
    const trigger = triggerOf(el)
    return {
      id: stableId(el),
      rect,
      visibleRect: visibleRectOf(el, rect),
      triggerId: trigger ? stableId(trigger) : null,
      triggerRect: trigger ? rectOf(trigger) : null,
    }
  }

  const collect = (selector, record) =>
    selector
      ? Array.from(document.querySelectorAll(selector)).filter(isVisible).map(record)
      : []

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    controls: collect(controlsSelector, controlRecord),
    overlays: collect(overlaysSelector, overlayRecord),
  }
}
