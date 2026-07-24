// Card C4 — the animated field-disable effect shown while a fill request is in
// flight (PLAN §1 "requesting: fields disabled + shimmer"). `disableDuringFill`
// returns a `restore()` that fully reverses everything it did — the
// non-destructive invariant (PLAN §0) covers this UI state, not just field values.
//
// REACH CONSTRAINT (load-bearing): the affected fields live in the HOST's LIGHT
// DOM, not the widget's shadow tree, so a stylesheet in the widget's shadow root
// CANNOT style them. We therefore inject a namespaced <style> into document.head
// (which reaches light-DOM elements) for the shimmer keyframes, and add a class
// to each field. Both the style element and the class are removed on restore().

const STYLE_MARKER = 'data-ff-effect';
const SHIMMER_CLASS = 'ff-fill-shimmer';

const SHIMMER_CSS = `
@keyframes ff-fill-shimmer-kf {
  0%   { background-position: -320px 0; }
  100% { background-position: 320px 0; }
}
.${SHIMMER_CLASS} {
  background-image: linear-gradient(
    90deg,
    rgba(226, 98, 44, 0) 0%,
    rgba(226, 98, 44, 0.18) 50%,
    rgba(226, 98, 44, 0) 100%
  ) !important;
  background-size: 320px 100% !important;
  background-repeat: no-repeat !important;
  animation: ff-fill-shimmer-kf 1.1s linear infinite !important;
  cursor: progress !important;
}
`;

export function disableDuringFill(elements: Element[]): () => void {
  const style = injectShimmerStyle();

  // Capture each field's prior disabled state so an ALREADY-disabled field stays
  // disabled after restore — we only undo what we changed.
  const toggled: Array<{ el: HTMLElement; wasDisabled: boolean }> = [];
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const control = el as HTMLInputElement;
    const wasDisabled = control.disabled === true;
    if (!wasDisabled) control.disabled = true;
    el.classList.add(SHIMMER_CLASS);
    toggled.push({ el, wasDisabled });
  }

  let restored = false;
  return function restore(): void {
    if (restored) return; // idempotent: completion + abort can both call this
    restored = true;
    for (const { el, wasDisabled } of toggled) {
      if (!wasDisabled) (el as HTMLInputElement).disabled = false;
      el.classList.remove(SHIMMER_CLASS);
    }
    style?.remove();
  };
}

function injectShimmerStyle(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = SHIMMER_CSS;
  document.head.appendChild(style);
  return style;
}
