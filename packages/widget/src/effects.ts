// Card C4 — the in-flight effect shown while a fill request is on the wire
// (PLAN §1 "requesting: fields disabled + border-tracer"). Two independent
// surfaces, composed by `startInflightEffect`:
//
//   1. disableDuringFill(fields): the SAFETY invariant. Every field the plan
//      could target is disabled so the user can't race the fill; already-disabled
//      fields are left disabled on restore (we only undo what we changed). This is
//      unchanged in behaviour from the shimmer era — only its cosmetics moved.
//
//   2. a BORDER-TRACER overlay around the anchor (the host form / form-less
//      container): a bright light segment circling the container perimeter,
//      signalling "the AI is working on this". It lives in the widget's SHADOW
//      root (self-contained, no head injection) as a position:fixed box tracking
//      the anchor's getBoundingClientRect().
//
// WHY THIS TECHNIQUE IS WEBKIT-SAFE (load-bearing): the traveling light is an
// OVERSIZED conic-gradient wheel spun with `transform: rotate()` — NOT an
// animated `@property <angle>`, whose interpolation Safari only shipped recently
// and still renders inconsistently. Rotating a transform is the oldest, most
// uniformly-accelerated animation on both engines.
//
// LAYERING (load-bearing): the band mask and the spinning wheel live on
// DIFFERENT elements. Each visible layer is an overlay-sized FRAME (inset:0)
// masked to a perimeter band via the padding + content-box `mask-composite`
// trick (standard `exclude` + the legacy `-webkit-mask-composite: xor` alias,
// both understood by Safari 15.4+); the wheel is the frame's oversized ::before,
// and the frame's mask clips everything it paints down to the band. Masking the
// WHEEL itself would carve the band at the wheel's own edge — 250%-sized, that
// edge lies entirely outside the overlay box and nothing renders at all.
//
// prefers-reduced-motion: reduce → the rotation is suppressed and a static soft
// glow border is shown instead (still communicates "in progress", no motion).

const STYLE_MARKER = 'data-ff-effect';
const OVERLAY_CLASS = 'ff-inflight-overlay';
const OVERLAY_PART = 'inflight-overlay';
// A subtle opacity dim on targeted fields replaces the per-field shimmer; the
// tracer now carries the "working" signal, the fields just recede a touch.
const DIM_CLASS = 'ff-fill-dim';

// Corner rounding + band thickness of the tracer ring, and how far the light's
// soft glow bleeds. Named so the geometry reads without hunting through the CSS.
// GLOW_BAND_PX is a wider mask band than the crisp ring so the blurred glow reads
// as a soft halo hugging the perimeter — never a wedge sweeping the form interior.
const RING_RADIUS_PX = 12;
const RING_BAND_PX = 3;
const GLOW_BAND_PX = RING_BAND_PX * 5;
const GLOW_BLUR_PX = 10;

// The dim is injected into document.head for the SAME reason the shimmer was:
// the affected fields live in the HOST's LIGHT DOM, which a shadow-root
// stylesheet cannot reach. The tracer overlay, by contrast, lives in the shadow
// root and needs no head injection.
const DIM_CSS = `
.${DIM_CLASS} {
  opacity: 0.72 !important;
  transition: opacity 120ms ease !important;
  cursor: progress !important;
}
`;

// Public surface unchanged in shape (returns an idempotent restore) so element.ts
// keeps calling it exactly where it did. Only the cosmetic moved: dim, not shimmer.
export function disableDuringFill(elements: Element[]): () => void {
  const style = injectDimStyle();

  // Capture each field's prior disabled state so an ALREADY-disabled field stays
  // disabled after restore — we only undo what we changed (safety invariant).
  const toggled: Array<{ el: HTMLElement; wasDisabled: boolean }> = [];
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const control = el as HTMLInputElement;
    const wasDisabled = control.disabled === true;
    if (!wasDisabled) control.disabled = true;
    el.classList.add(DIM_CLASS);
    toggled.push({ el, wasDisabled });
  }

  let restored = false;
  return function restore(): void {
    if (restored) return; // idempotent: completion + abort can both call this
    restored = true;
    for (const { el, wasDisabled } of toggled) {
      if (!wasDisabled) (el as HTMLInputElement).disabled = false;
      el.classList.remove(DIM_CLASS);
    }
    style?.remove();
  };
}

// The whole in-flight effect: disable the affected fields AND mount the tracer
// overlay around the anchor. Returns one idempotent cleanup that reverses both,
// so element.ts's settle/abort/disconnect paths call a single function. The
// success path re-enables fields BEFORE writing values, so `restore()` on the
// returned handle also lifts the tracer early there — that's why cleanup is
// idempotent (it can run twice: once to re-enable, once at settle).
export function startInflightEffect(
  shadowRoot: ShadowRoot,
  anchor: HTMLElement,
  affectedFields: Element[],
): () => void {
  const restoreFields = disableDuringFill(affectedFields);
  const removeOverlay = mountTracerOverlay(shadowRoot, anchor);

  let cleaned = false;
  return function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    restoreFields();
    removeOverlay();
  };
}

function injectDimStyle(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = DIM_CSS;
  document.head.appendChild(style);
  return style;
}

// Appends the tracer overlay to the shadow root, positions it over the anchor,
// and keeps it aligned on scroll/resize (rAF-throttled, listeners live only while
// the overlay is mounted). Returns a cleanup that removes the element AND detaches
// every listener. Guards jsdom (no rAF/getBoundingClientRect geometry) by simply
// mounting a rect-less overlay — unit tests assert presence/teardown, not pixels.
function mountTracerOverlay(shadowRoot: ShadowRoot, anchor: HTMLElement): () => void {
  if (typeof document === 'undefined') return () => {};

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute('part', OVERLAY_PART);
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = TRACER_MARKUP;

  const overlayStyle = document.createElement('style');
  overlayStyle.textContent = TRACER_CSS;
  overlay.appendChild(overlayStyle);

  shadowRoot.appendChild(overlay);

  const syncRect = (): void => {
    const rect = anchor.getBoundingClientRect();
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };
  syncRect();

  // rAF-throttle: scroll/resize can fire far faster than paint; coalesce to one
  // rect read per frame so a fast scroll can't thrash layout.
  let rafId = 0;
  const scheduleSync = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      syncRect();
    });
  };

  // Capture-phase scroll so we react to ANY scrolling ancestor, not just window
  // (the anchor may live inside a scrollable dialog/panel).
  window.addEventListener('scroll', scheduleSync, { capture: true, passive: true });
  window.addEventListener('resize', scheduleSync, { passive: true });

  let removed = false;
  return function removeOverlay(): void {
    if (removed) return;
    removed = true;
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', scheduleSync, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', scheduleSync);
    overlay.remove();
  };
}

// Two stacked band FRAMES inside the fixed overlay box (glow first = behind):
//   .ff-tracer-glow — wide band, blurred wheel: the soft halo
//   .ff-tracer-ring — thin band, crisp wheel: the traveling light itself
// Each frame is masked to its perimeter band; its ::before is the spinning conic
// wheel whose paint the frame's mask clips down to that band (see the LAYERING
// header note for why the mask must be on the frame, never the wheel).
const TRACER_MARKUP = `
<div class="ff-tracer-glow"></div>
<div class="ff-tracer-ring"></div>`;

// Scoped to the tracer subtree only: this <style> lives in the shadow tree, so a
// bare `*` would restyle the trigger/panel too. Every rule below targets the
// overlay class or its descendants.
const TRACER_CSS = `
.${OVERLAY_CLASS},
.${OVERLAY_CLASS} * { box-sizing: border-box; }

.${OVERLAY_CLASS} {
  position: fixed;
  z-index: 2147483645;
  pointer-events: none;
  /* top/left/width/height set inline from the anchor rect. */
}

/* Band frames: overlay-sized, masked so ONLY the perimeter band paints. The
   padding sets each band's thickness; content-box minus full-box under
   mask-composite exclude/xor leaves exactly that padding band. overflow:hidden
   is a backstop so the oversized wheel cannot spill even without mask support. */
.ff-tracer-ring,
.ff-tracer-glow {
  position: absolute;
  inset: 0;
  border-radius: ${RING_RADIUS_PX}px;
  overflow: hidden;
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}
.ff-tracer-ring { padding: ${RING_BAND_PX}px; }
.ff-tracer-glow { padding: ${GLOW_BAND_PX}px; }

/* The spinning wheel: a comet — long faint tail rising through the brand orange
   to a white head, sharp cutoff past the head so it reads as a light LEADING
   clockwise around the border. Stop angles are strictly increasing (conic stops
   never wrap past 360; out-of-order stops clamp and flatten the arc). 250%-sized
   and centered so no rotation angle of the rectangular wheel exposes a bare
   corner of the band (200% is marginal on tall forms — half-diagonal exceeds the
   inscribed radius). */
.ff-tracer-ring::before,
.ff-tracer-glow::before {
  content: '';
  position: absolute;
  top: -75%;
  left: -75%;
  width: 250%;
  height: 250%;
  /* The head stays a SATURATED warm orange, never white: the band rides the form
     edge over arbitrary host backgrounds, and a white-hot head vanishes on the
     common white page. */
  background: conic-gradient(
    from 0deg,
    rgba(226, 98, 44, 0) 0deg,
    rgba(226, 98, 44, 0) 210deg,
    rgba(226, 98, 44, 0.15) 250deg,
    rgba(232, 106, 52, 0.55) 310deg,
    rgba(255, 138, 66, 0.95) 345deg,
    rgba(255, 178, 122, 1) 357deg,
    rgba(226, 98, 44, 0) 360deg
  );
  animation: ff-tracer-spin 2.4s linear infinite;
}
.ff-tracer-glow::before {
  filter: blur(${GLOW_BLUR_PX}px);
  opacity: 0.7;
}

@keyframes ff-tracer-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  /* No travel. Hide the wheels and paint the masked frames directly — a static
     accent edge plus a soft uniform halo, band-only, no tint on the form
     interior, no motion. Still reads as "working". */
  .ff-tracer-ring::before,
  .ff-tracer-glow::before { display: none; }
  .ff-tracer-ring { background: rgba(226, 98, 44, 0.45); }
  .ff-tracer-glow { background: rgba(226, 98, 44, 0.18); }
}
`;
