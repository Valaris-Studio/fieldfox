// The anchored trigger button lives in the widget's OPEN shadow tree, fixed to
// the viewport, and is re-positioned to the host's top-right corner on every
// scroll/resize. Observer discipline (RESEARCH §4): every listener/observer is
// attached only while the host is connected and torn down on disconnect.

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Fixed-position coordinates for a trigger of `size` px pinned to the host's
// top-right corner. `offset` nudges it outward (right/up) so the button visually
// overhangs the corner rather than sitting inside it. Coordinates are viewport-
// relative because the button is `position: fixed`.
export function triggerPosition(hostRect: Rect, size: number, offset: number): { top: number; left: number } {
  return {
    top: hostRect.top - offset,
    left: hostRect.left + hostRect.width - size + offset,
  };
}

export interface TriggerHandle {
  button: HTMLButtonElement;
  destroy(): void;
}

const TRIGGER_SIZE = 28;

// A minimal fox glyph — inline SVG keeps the widget dependency-free and avoids a
// network fetch for the icon.
const FOX_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M12 3 5 6l1 5c0 4 3 7 6 8 3-1 6-4 6-8l1-5-7-3Zm0 2.2 4.7 2-.7 3.3c0 2.7-1.9 4.9-4 5.8-2.1-.9-4-3.1-4-5.8L7.3 7.2 12 5.2Z"/>' +
  '<circle cx="9.5" cy="10.5" r="1" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1" fill="currentColor"/>' +
  '</svg>';

// jsdom (and other non-layout DOM impls used in tests) ship neither observer;
// guarding lets the widget mount there without throwing.
const hasResizeObserver = typeof ResizeObserver !== 'undefined';
const hasIntersectionObserver = typeof IntersectionObserver !== 'undefined';

// Mounts the trigger into `shadowRoot`, anchored to `host`, and wires the
// reposition/visibility observers. Clicking dispatches `fieldfox:trigger` on the
// host element and invokes `onActivate` (a no-op panel stub until card C3).
export function createTrigger(
  shadowRoot: ShadowRoot,
  host: HTMLElement,
  onActivate: () => void,
): TriggerHandle {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ff-trigger';
  button.setAttribute('part', 'trigger');
  button.setAttribute('aria-label', 'Fill this form with Fieldfox');
  button.innerHTML = FOX_SVG;

  const reposition = (): void => {
    const rect = host.getBoundingClientRect();
    const { top, left } = triggerPosition(rect, TRIGGER_SIZE, offsetFromHost(host));
    button.style.top = `${top}px`;
    button.style.left = `${left}px`;
  };

  const onScrollOrResize = (): void => reposition();

  button.addEventListener('click', () => {
    host.dispatchEvent(new CustomEvent('fieldfox:trigger', { bubbles: true, composed: true }));
    onActivate();
  });

  // Passive: we only read layout, never preventDefault. Capture so we still fire
  // when an overflow ancestor (not window) is the actual scroller.
  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });

  const resizeObserver = hasResizeObserver ? new ResizeObserver(() => reposition()) : null;
  resizeObserver?.observe(host);

  // Hide the trigger while the host is scrolled off-screen so it never floats
  // over unrelated content.
  const intersectionObserver = hasIntersectionObserver
    ? new IntersectionObserver((entries) => {
        const visible = entries[entries.length - 1]?.isIntersecting ?? true;
        button.style.visibility = visible ? 'visible' : 'hidden';
      })
    : null;
  intersectionObserver?.observe(host);

  shadowRoot.appendChild(button);
  reposition();

  return {
    button,
    destroy(): void {
      window.removeEventListener('scroll', onScrollOrResize, { capture: true });
      window.removeEventListener('resize', onScrollOrResize);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      button.remove();
    },
  };
}

// Reads the `--fieldfox-trigger-offset` custom property off the host (falls back
// to a small default). Parsed lazily so page-level theming is honored.
function offsetFromHost(host: HTMLElement): number {
  const raw = getComputedStyle(host).getPropertyValue('--fieldfox-trigger-offset').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 6;
}
