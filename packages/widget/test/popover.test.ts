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
