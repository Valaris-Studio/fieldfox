import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPopover, type PopoverHandle } from '../src/popover.js';

// jsdom ships FileReader but NOT ClipboardEvent/DataTransfer, and its <canvas>
// getContext returns null (no native canvas). The popover feature-detects both:
// paste reads clipboardData off a plain Event we synthesize here; downscale
// falls back to the raw FileReader data URL when the 2d context is unavailable.

interface Harness {
  handle: PopoverHandle;
  host: HTMLElement;
  trigger: HTMLButtonElement;
  root: ShadowRoot;
}

let harness: Harness | null = null;

function mount(): Harness {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  const shadowHost = document.createElement('div');
  const root = shadowHost.attachShadow({ mode: 'open' });
  const trigger = document.createElement('button');
  trigger.type = 'button';
  document.body.append(host, shadowHost, trigger);

  const handle = createPopover(root, host, trigger);
  harness = { handle, host, trigger, root };
  return harness;
}

// A 1x1 red PNG — enough bytes for FileReader to produce a real image/png data URL.
function pngFile(name = 'shot.png', byteLength = 64): File {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], name, { type: 'image/png' });
}

// jsdom has no ClipboardEvent; dispatch a bare paste Event carrying a synthetic
// clipboardData with the shape the popover reads (files + items).
function firePaste(target: EventTarget, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((f) => ({
        kind: 'file',
        type: f.type,
        getAsFile: () => f,
      })),
    },
  });
  target.dispatchEvent(event);
}

function fileInput(root: ShadowRoot): HTMLInputElement {
  return root.querySelector('input[type="file"]') as HTMLInputElement;
}

// Drive the file <input> the way a browser would: attach a real FileList-like
// and dispatch change (jsdom won't let us set input.files from arbitrary Files).
function fireUpload(root: ShadowRoot, files: File[]): void {
  const input = fileInput(root);
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// addFiles reads each file via FileReader (a macrotask) sequentially, so N files
// settle across N ticks. Poll a few macrotasks rather than guess a single tick.
async function flush(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  harness?.handle.destroy();
  harness = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('open shows a textarea, a Fill button, and a file input', () => {
  const { handle, root } = harness!;
  handle.open();

  expect(root.querySelector('textarea')).not.toBeNull();
  expect(root.querySelector('input[type="file"]')).not.toBeNull();
  const fill = root.querySelector('[part="fill-button"]') as HTMLButtonElement;
  expect(fill).not.toBeNull();
  expect(fill.textContent).toMatch(/fill/i);
});

test('uses the Popover API (showPopover) when available', () => {
  const { handle, root } = harness!;
  const panel = root.querySelector('[part="panel"]') as HTMLElement & {
    showPopover?: () => void;
  };
  const showPopover = vi.fn();
  // Stub the Popover API onto the panel element before opening.
  (panel as unknown as { showPopover: () => void }).showPopover = showPopover;
  (panel as unknown as { hidePopover: () => void }).hidePopover = () => {};

  handle.open();
  expect(showPopover).toHaveBeenCalledOnce();
});

test('falls back to a fixed high-z panel when showPopover is absent', () => {
  const { handle, root } = harness!;
  const panel = root.querySelector('[part="panel"]') as HTMLElement;
  // jsdom has no showPopover natively; assert the fallback made the panel visible
  // via fixed positioning rather than the top layer.
  expect((panel as unknown as { showPopover?: unknown }).showPopover).toBeUndefined();

  handle.open();
  expect(panel.style.position).toBe('fixed');
  expect(handle.isOpen()).toBe(true);
});

test('Esc closes the panel and returns focus to the trigger', () => {
  const { handle, trigger } = harness!;
  handle.open();
  expect(handle.isOpen()).toBe(true);

  // Escape is owned by the capture-phase document listener now. A real key event
  // is composed:true and reaches the document from inside the shadow tree; the
  // panel's own keydown no longer handles Escape.
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
  );

  expect(handle.isOpen()).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

// --- Esc etiquette inside a host dialog (pilot-finding 5) --------------------
// A host framework (Radix) closes its own dialog on a document-level Esc. While
// the fieldfox panel is open it must be the SINGLE owner of Escape: intercept in
// the capture phase (before the host's document handlers) and close ONLY the
// panel, so the keystroke never reaches the host.

test('Esc with the panel open is stopped before a host document listener sees it', () => {
  const { handle } = harness!;
  // Simulate Radix: a bubble-phase document listener that would close the host
  // dialog. It must NEVER fire while the fieldfox panel owns the Escape.
  const hostEscape = vi.fn();
  document.addEventListener('keydown', hostEscape);
  try {
    handle.open();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(handle.isOpen()).toBe(false); // only the fieldfox panel closed
    expect(hostEscape).not.toHaveBeenCalled(); // host dialog never saw the key
  } finally {
    document.removeEventListener('keydown', hostEscape);
  }
});

test('the capture Escape listener is removed once the panel closes (no host interception when closed)', () => {
  const { handle } = harness!;
  const hostEscape = vi.fn();
  document.addEventListener('keydown', hostEscape);
  try {
    handle.open();
    handle.close();
    // Panel is closed: fieldfox no longer owns Escape, so the host handler runs.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(hostEscape).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('keydown', hostEscape);
  }
});

test('destroy() removes the capture Escape listener (no leak after teardown)', () => {
  const { handle } = harness!;
  const hostEscape = vi.fn();
  document.addEventListener('keydown', hostEscape);
  try {
    handle.open();
    handle.destroy();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(hostEscape).toHaveBeenCalledTimes(1); // listener gone → host sees it
  } finally {
    document.removeEventListener('keydown', hostEscape);
  }
});

// --- Review visibility after a successful fill (pilot-finding 5) -------------
// The success report (showStatus, the sole post-fill success call from C4) must
// collapse the panel so it stops occluding the just-filled fields; the user can
// re-expand.

test('a successful fill report minimizes the panel; the status stays visible', () => {
  const { handle, root } = harness!;
  handle.open();
  expect(handle.isMinimized()).toBe(false);

  handle.showStatus('Filled 3 fields, left 1.');

  expect(handle.isMinimized()).toBe(true);
  const panel = root.querySelector('[part="panel"]') as HTMLElement;
  expect(panel.classList.contains('ff-minimized')).toBe(true);
  // The status line the user is asked to review stays visible.
  const status = root.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toContain('Filled 3 fields, left 1.');
  // Panel is still open (minimized ≠ closed) so re-expansion is possible.
  expect(handle.isOpen()).toBe(true);
});

test('a minimized panel can be re-expanded', () => {
  const { handle, root } = harness!;
  handle.open();
  handle.showStatus('Filled 2 fields.');
  expect(handle.isMinimized()).toBe(true);

  handle.expand();

  expect(handle.isMinimized()).toBe(false);
  const panel = root.querySelector('[part="panel"]') as HTMLElement;
  expect(panel.classList.contains('ff-minimized')).toBe(false);
});

test('an error report does NOT minimize (the full panel stays up to retry)', () => {
  const { handle } = harness!;
  handle.open();
  handle.showError('Could not fill the form. Please try again.');
  expect(handle.isMinimized()).toBe(false);
});

test('re-opening a closed panel starts expanded', () => {
  const { handle } = harness!;
  handle.open();
  handle.showStatus('Filled 1 field.');
  expect(handle.isMinimized()).toBe(true);
  handle.close();
  handle.open();
  expect(handle.isMinimized()).toBe(false);
});

test('pasting an image adds a thumbnail; the × button removes it', async () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = root.querySelector('[part="panel"]') as HTMLElement;

  firePaste(panel, [pngFile()]);
  await flush();

  const thumbs = () => root.querySelectorAll('[part="thumbnail"]');
  expect(thumbs()).toHaveLength(1);

  const remove = root.querySelector(
    '[part="thumbnail"] button',
  ) as HTMLButtonElement;
  expect(remove.textContent).toContain('×');
  remove.click();
  expect(thumbs()).toHaveLength(0);
});

test('an oversized image is rejected with an inline error and not added', async () => {
  const { handle, root } = harness!;
  handle.open();

  // > 5MB decoded; the popover estimates size from the data URL length.
  const huge = pngFile('huge.png', 6 * 1024 * 1024);
  fireUpload(root, [huge]);
  await flush();

  expect(root.querySelectorAll('[part="thumbnail"]')).toHaveLength(0);
  const status = root.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toMatch(/too large|5\s?MB|size/i);
});

test('the image count cap is enforced', async () => {
  const { handle, root } = harness!;
  handle.open();

  fireUpload(root, [
    pngFile('a.png'),
    pngFile('b.png'),
    pngFile('c.png'),
    pngFile('d.png'),
    pngFile('e.png'),
  ]);
  await flush();

  expect(root.querySelectorAll('[part="thumbnail"]').length).toBe(4);
  const status = root.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toMatch(/most 4|maximum|limit|too many/i);
});

test('Fill form emits fieldfox:fill with { contextText, images } and sets busy', async () => {
  const { handle, host, root } = harness!;
  handle.open();

  const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'Jane Doe, jane@example.com';
  firePaste(
    root.querySelector('[part="panel"]') as HTMLElement,
    [pngFile()],
  );
  await flush();

  const onFill = vi.fn();
  host.addEventListener('fieldfox:fill', onFill as EventListener);

  const fill = root.querySelector('[part="fill-button"]') as HTMLButtonElement;
  fill.click();

  expect(onFill).toHaveBeenCalledOnce();
  const detail = (onFill.mock.calls[0][0] as CustomEvent).detail;
  expect(detail.contextText).toBe('Jane Doe, jane@example.com');
  expect(detail.images).toHaveLength(1);
  expect(detail.images[0].dataUrl.startsWith('data:image/png')).toBe(true);
  expect(handle.isBusy()).toBe(true);
});

test('setBusy(true) disables inputs and suspends the focus trap; setBusy(false) restores', () => {
  const { handle, root } = harness!;
  handle.open();

  const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
  const fill = root.querySelector('[part="fill-button"]') as HTMLButtonElement;

  handle.setBusy(true);
  expect(textarea.disabled).toBe(true);
  expect(fill.disabled).toBe(true);
  expect(handle.isBusy()).toBe(true);
  expect(handle.isTrapActive()).toBe(false);

  handle.setBusy(false);
  expect(textarea.disabled).toBe(false);
  expect(fill.disabled).toBe(false);
  expect(handle.isBusy()).toBe(false);
  expect(handle.isTrapActive()).toBe(true);
});

test('showError renders into the status region; close hides the panel', () => {
  const { handle, root } = harness!;
  handle.open();
  handle.showError('Could not reach the server');

  const status = root.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toContain('Could not reach the server');
  expect(status.getAttribute('aria-live')).toBeTruthy();

  handle.close();
  expect(handle.isOpen()).toBe(false);
});

test('Tab from the last focusable cycles to the first (focus trap)', () => {
  const { handle, root } = harness!;
  handle.open();

  const focusables = root.querySelectorAll<HTMLElement>(
    'textarea, button, input, [tabindex]',
  );
  const last = focusables[focusables.length - 1];
  last.focus();

  const panel = root.querySelector('[part="panel"]') as HTMLElement;
  const tab = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  panel.dispatchEvent(tab);

  // The trap prevents the browser default (which would leave the panel).
  expect(tab.defaultPrevented).toBe(true);
});

// --- Dragging the header (draggable-panel card) -----------------------------
// jsdom has no layout (getBoundingClientRect → zeros), no PointerEvent, and no
// pointer capture. Stub a fixed panel rect + viewport size so the drag/clamp
// MATH is exercised (mirrors test/setup.ts: the positioning math is verified
// here, not through a real engine), and synthesize pointer events by hand.

const PANEL_W = 360;
const PANEL_H = 300;

// Give the panel a stable rect that follows its own style.left/top (which the
// drag code writes), so a move-then-read round-trips like a real engine would.
function stubPanelLayout(panel: HTMLElement, vw = 1000, vh = 800): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: vw });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: vh });
  panel.getBoundingClientRect = () => {
    const left = parseFloat(panel.style.left || '0') || 0;
    const top = parseFloat(panel.style.top || '0') || 0;
    return {
      x: left, y: top, left, top,
      width: PANEL_W, height: PANEL_H,
      right: left + PANEL_W, bottom: top + PANEL_H,
      toJSON: () => {},
    } as DOMRect;
  };
}

function firePointer(
  target: EventTarget,
  type: string,
  { clientX, clientY, pointerId = 1, button = 0 }: { clientX: number; clientY: number; pointerId?: number; button?: number },
): Event {
  // jsdom lacks PointerEvent; a MouseEvent carries clientX/clientY/button, and
  // we bolt pointerId on so the handler's pointer-tracking sees it.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
  return event;
}

function header(root: ShadowRoot): HTMLElement {
  return root.querySelector('[part="panel-header"]') as HTMLElement;
}

function panelOf(root: ShadowRoot): HTMLElement {
  return root.querySelector('[part="panel"]') as HTMLElement;
}

// jsdom elements have no pointer-capture methods; add inert stubs so the drag
// code's set/releasePointerCapture calls don't throw (it also try/catches them).
function stubPointerCapture(el: HTMLElement): void {
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};
}

test('dragging the header moves the panel by the pointer delta', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel);
  stubPointerCapture(handleEl);

  // Anchor the panel somewhere known, then grab the header at (150,20) inside it.
  panel.style.left = '100px';
  panel.style.top = '50px';

  firePointer(handleEl, 'pointerdown', { clientX: 250, clientY: 70 });
  firePointer(handleEl, 'pointermove', { clientX: 350, clientY: 190 }); // +100x, +120y
  firePointer(handleEl, 'pointerup', { clientX: 350, clientY: 190 });

  // The grab offset (150,20) is preserved: corner = pointer - offset.
  expect(parseFloat(panel.style.left)).toBe(200);
  expect(parseFloat(panel.style.top)).toBe(170);
});

test('a pointerdown on an interactive control in the header does not start a drag', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '50px';

  // Simulate a future close button living inside the header.
  const button = document.createElement('button');
  handleEl.appendChild(button);

  firePointer(button, 'pointerdown', { clientX: 250, clientY: 70 });
  firePointer(handleEl, 'pointermove', { clientX: 350, clientY: 190 });

  // No drag was armed, so the panel stayed put.
  expect(parseFloat(panel.style.left)).toBe(100);
  expect(parseFloat(panel.style.top)).toBe(50);
});

test('dragging past a viewport edge clamps the panel fully inside', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '100px';

  // Grab at the panel's top-left corner (offset 0,0) and yank far past the
  // top-left edge; the corner must clamp to the 8px margin, not go negative.
  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: -500, clientY: -500 });
  expect(parseFloat(panel.style.left)).toBe(8);
  expect(parseFloat(panel.style.top)).toBe(8);

  // Now yank far past the bottom-right edge; clamp to viewport - size - margin.
  firePointer(handleEl, 'pointermove', { clientX: 5000, clientY: 5000 });
  expect(parseFloat(panel.style.left)).toBe(1000 - PANEL_W - 8);
  expect(parseFloat(panel.style.top)).toBe(800 - PANEL_H - 8);
  firePointer(handleEl, 'pointerup', { clientX: 5000, clientY: 5000 });
});

test('the dragged position survives minimize → expand (re-clamped to the viewport)', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '100px';

  // Drag to a distinct spot.
  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: 400, clientY: 300 });
  firePointer(handleEl, 'pointerup', { clientX: 400, clientY: 300 });
  expect(parseFloat(panel.style.left)).toBe(400);
  expect(parseFloat(panel.style.top)).toBe(300);

  // Minimizing docks the strip (position changes) …
  handle.showStatus('Filled 2 fields.');
  expect(handle.isMinimized()).toBe(true);

  // … and expanding restores the user's dragged spot, not the host anchor.
  handle.expand();
  expect(handle.isMinimized()).toBe(false);
  expect(parseFloat(panel.style.left)).toBe(400);
  expect(parseFloat(panel.style.top)).toBe(300);
});

test('after a drag, a re-anchor (showError → expand) keeps the dragged position', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '100px';

  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: 450, clientY: 350 });
  firePointer(handleEl, 'pointerup', { clientX: 450, clientY: 350 });

  // An error un-minimizes via positionNearHost; the dragged spot must win.
  handle.showError('Could not fill the form. Please try again.');
  expect(parseFloat(panel.style.left)).toBe(450);
  expect(parseFloat(panel.style.top)).toBe(350);
});

test('closing then re-opening resets to default anchoring (drag position does not persist)', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '100px';

  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: 500, clientY: 400 });
  firePointer(handleEl, 'pointerup', { clientX: 500, clientY: 400 });
  expect(parseFloat(panel.style.left)).toBe(500);

  handle.close();
  handle.open();
  // The host rect is (0,0) under jsdom, so re-anchoring clamps to the 8px margin
  // rather than keeping the old dragged 500/400.
  expect(parseFloat(panel.style.left)).toBe(8);
  expect(parseFloat(panel.style.top)).toBe(8);
});

test('window resize re-clamps a dragged panel back inside a shrunken viewport', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);
  panel.style.left = '100px';
  panel.style.top = '100px';

  // Drag to the far bottom-right of the large viewport.
  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: 900, clientY: 700 });
  firePointer(handleEl, 'pointerup', { clientX: 900, clientY: 700 });
  expect(parseFloat(panel.style.left)).toBe(1000 - PANEL_W - 8);

  // Shrink the viewport; the resize handler must pull the panel back in.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
  window.dispatchEvent(new Event('resize'));

  expect(parseFloat(panel.style.left)).toBe(500 - PANEL_W - 8);
  expect(parseFloat(panel.style.top)).toBe(400 - PANEL_H - 8);
});

test('dragging is disabled while the panel is minimized (strip is click-to-expand)', () => {
  const { handle, root } = harness!;
  handle.open();
  const panel = panelOf(root);
  const handleEl = header(root);
  stubPanelLayout(panel, 1000, 800);
  stubPointerCapture(handleEl);

  handle.showStatus('Filled 1 field.'); // minimizes + docks
  const dockedLeft = panel.style.left;
  const dockedTop = panel.style.top;

  firePointer(handleEl, 'pointerdown', { clientX: 100, clientY: 100 });
  firePointer(handleEl, 'pointermove', { clientX: 400, clientY: 400 });

  // No drag: the docked position is unchanged.
  expect(panel.style.left).toBe(dockedLeft);
  expect(panel.style.top).toBe(dockedTop);
});
