import type { RequestImage } from '@fieldfox/shared';

// Card C3 — the input panel. Lives in the widget's OWN open shadow tree; the host
// form is never touched (RESEARCH §4). Opens into the browser top layer via the
// Popover API when available, falling back to a fixed high-z panel otherwise.
//
// Scope boundary: this card collects `{ contextText, images }` and emits
// `fieldfox:fill`; the network call + fill executor are C4. The handle exposes
// setBusy / showError / close so C4 can drive the panel through the `applying`
// phase — during which the focus trap is SUSPENDED (PLAN §0 "Focus vs trap":
// real per-field focus/blur during fill is otherwise in tension with the trap).

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded, matching the server cap
const DOWNSCALE_MAX_EDGE = 1280; // longest-side target before base64 encoding
const VIEWPORT_MARGIN = 8; // keep the panel this many px clear of every viewport edge (matches the open-position clamp)

interface Point {
  x: number;
  y: number;
}

// Pure viewport clamp for the panel's top-left corner: keep the whole panel
// inside [margin, viewport - size - margin]. When the panel is larger than the
// viewport on an axis the lower bound wins (pin to the top/left margin) so the
// header stays reachable rather than scrolling the panel off the top. Extracted
// as a pure function because jsdom has no layout — the drag/clamp MATH is
// unit-tested here, not through getBoundingClientRect (see test/setup.ts).
function clampToViewport(
  pos: Point,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = VIEWPORT_MARGIN,
): Point {
  const clampAxis = (v: number, extent: number, panelExtent: number): number => {
    const max = Math.max(margin, extent - panelExtent - margin);
    return Math.min(Math.max(v, margin), max);
  };
  return {
    x: clampAxis(pos.x, viewport.width, size.width),
    y: clampAxis(pos.y, viewport.height, size.height),
  };
}

export interface PopoverHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  // Busy = the C4 `applying` phase: inputs disabled, focus trap suspended.
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  showError(message: string): void;
  // Non-error informational status — the C4 fill report ("Filled 3, left 1").
  // A success report is the panel's "done" state, so it also minimizes the panel
  // so the just-filled fields are visible for review (pilot-finding 5).
  showStatus(message: string): void;
  // Collapse to a status-only strip / restore the full panel. Minimizing keeps
  // the panel OPEN (the user can re-expand); it is not a close.
  expand(): void;
  isMinimized(): boolean;
  // Introspection hooks for tests / C4; not part of the day-to-day surface.
  isTrapActive(): boolean;
  destroy(): void;
}

const PANEL_STYLES = `
:host { --fieldfox-z-index: 2147483647; }
.ff-panel {
  box-sizing: border-box;
  width: min(360px, 90vw);
  max-height: 80vh;
  overflow: auto;
  padding: 14px;
  margin: 0;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 10px;
  background: #fff;
  color: #1a1a1a;
  box-shadow: 0 8px 30px rgba(0,0,0,0.18);
  font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.ff-panel[popover] { inset: unset; }
/* The title doubles as the drag handle (RESEARCH: no separate chrome — the panel
   is intentionally minimal). grab/grabbing signal draggability; user-select:none
   stops the pointerdown from starting a text selection mid-drag. touch-action:none
   lets pointermove fire on touch without the browser claiming the gesture to scroll. */
.ff-title {
  margin: 0 0 8px; font-size: 15px; font-weight: 600;
  cursor: grab; user-select: none; touch-action: none;
}
.ff-panel.ff-dragging .ff-title { cursor: grabbing; }
/* A minimized strip is click-to-expand, so its header is not a drag handle. */
.ff-panel.ff-minimized .ff-title { cursor: pointer; }
.ff-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 84px;
  resize: vertical;
  padding: 8px;
  border: 1px solid rgba(0,0,0,0.2);
  border-radius: 6px;
  font: inherit;
}
.ff-drop {
  margin-top: 8px;
  padding: 10px;
  border: 1px dashed rgba(0,0,0,0.3);
  border-radius: 6px;
  text-align: center;
  color: #555;
}
.ff-drop.ff-dragover { border-color: var(--fieldfox-accent, #e2622c); background: rgba(226,98,44,0.06); }
.ff-file-label { cursor: pointer; text-decoration: underline; }
.ff-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.ff-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ff-thumb { position: relative; width: 56px; height: 56px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(0,0,0,0.15); }
.ff-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ff-thumb-remove {
  position: absolute; top: 0; right: 0;
  width: 18px; height: 18px; line-height: 16px;
  padding: 0; border: 0; border-radius: 0 0 0 6px;
  background: rgba(0,0,0,0.6); color: #fff; cursor: pointer; font-size: 13px;
}
.ff-status { margin-top: 8px; min-height: 1em; font-size: 13px; }
.ff-status.ff-error { color: #b3261e; }
/* Done state: collapse to a title + status strip so the filled fields behind the
   panel are visible for review (pilot-finding 5). Click anywhere on the strip to
   re-expand. The title/status stay; the bulky intake controls hide. */
.ff-panel.ff-minimized { cursor: pointer; }
.ff-panel.ff-minimized .ff-textarea,
.ff-panel.ff-minimized .ff-drop,
.ff-panel.ff-minimized .ff-thumbs,
.ff-panel.ff-minimized .ff-actions { display: none; }
.ff-panel.ff-minimized .ff-status { margin-top: 4px; }
.ff-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.ff-fill {
  padding: 8px 14px;
  border: 0; border-radius: 6px;
  background: var(--fieldfox-accent, #e2622c); color: #fff;
  font: inherit; font-weight: 600; cursor: pointer;
}
.ff-fill:disabled { opacity: 0.6; cursor: default; }
`;

interface PanelImage extends RequestImage {
  name: string;
}

export function createPopover(
  shadowRoot: ShadowRoot,
  host: HTMLElement,
  trigger: HTMLElement,
): PopoverHandle {
  ensureStyles(shadowRoot);

  const panel = document.createElement('div');
  panel.className = 'ff-panel';
  panel.setAttribute('part', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Fill this form with Fieldfox');
  panel.setAttribute('popover', 'manual'); // no-op attribute where the API is absent

  const title = document.createElement('p');
  title.className = 'ff-title';
  title.setAttribute('part', 'panel-header');
  title.textContent = 'Describe what to fill';

  const textarea = document.createElement('textarea');
  textarea.className = 'ff-textarea';
  textarea.setAttribute('part', 'context-input');
  textarea.placeholder =
    'Paste details or an image (e.g. an email, a business card) and let Fieldfox fill the form.';

  const drop = document.createElement('div');
  drop.className = 'ff-drop';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.className = 'ff-file-input';
  fileInput.id = 'ff-file';
  const fileLabel = document.createElement('label');
  fileLabel.className = 'ff-file-label';
  fileLabel.htmlFor = 'ff-file';
  fileLabel.textContent = 'add images';
  drop.append(document.createTextNode('Drop, paste, or '), fileLabel, fileInput);

  const thumbs = document.createElement('div');
  thumbs.className = 'ff-thumbs';

  const status = document.createElement('div');
  status.className = 'ff-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'ff-actions';
  const fillButton = document.createElement('button');
  fillButton.type = 'button';
  fillButton.className = 'ff-fill';
  fillButton.setAttribute('part', 'fill-button');
  fillButton.textContent = 'Fill form';
  actions.append(fillButton);

  panel.append(title, textarea, drop, thumbs, status, actions);
  shadowRoot.appendChild(panel);

  const images: PanelImage[] = [];
  let open = false;
  let busy = false;
  let minimized = false;
  // Once the user drags, THEIR position wins for the rest of this open session:
  // auto-positioning (positionNearHost, expand-restore) must not override it.
  // Stored in fixed/viewport coords; reset on close so the next open re-anchors.
  let draggedPos: Point | null = null;
  let dragPointerId: number | null = null;

  const usePopoverApi = (): boolean =>
    typeof (panel as unknown as { showPopover?: unknown }).showPopover ===
    'function';

  // BOTH open paths must pin the panel: a [popover] in the top layer with
  // inset:unset otherwise renders at its static flow position (the <field-fox>
  // element's spot, often the page bottom) — position:fixed there is
  // unreachable by scrolling (e2e finding #2, WebKit). Called after the panel
  // is rendered so its own rect is measurable for viewport clamping.
  function positionNearHost(): void {
    // The user's drag wins for the session: once they've moved the panel, this
    // auto-anchor is a no-op so re-open/expand/reflow can't yank it back.
    if (draggedPos) return applyPosition(draggedPos);
    const rect = host.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    applyPosition({ x: rect.left, y: rect.top });
  }

  // Write a fixed-coordinate top-left, clamped fully inside the current viewport.
  function applyPosition(pos: Point): void {
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    const panelRect = panel.getBoundingClientRect();
    const clamped = clampToViewport(
      pos,
      { width: panelRect.width, height: panelRect.height },
      { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    );
    panel.style.left = `${clamped.x}px`;
    panel.style.top = `${clamped.y}px`;
  }

  function positionFallback(): void {
    // No top layer available: fixed positioning + the theming z-index.
    panel.style.zIndex = 'var(--fieldfox-z-index)';
    panel.style.display = 'block';
    positionNearHost();
  }

  // Minimized/done placement: dock the status strip to a viewport corner that is
  // CLEAR of the host form, so the just-filled fields are visible for review
  // (pilot-finding 5). Prefer the gap to the right of the form; if the form runs
  // to the viewport edge, drop to the bottom-right corner instead.
  function positionMinimized(): void {
    const formRect = host.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.margin = '0';
    const panelRect = panel.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    const vw = window.innerWidth || 0;
    const gapRightOfForm = vw - formRect.right;
    if (gapRightOfForm >= panelRect.width + 16) {
      // Beside the form, aligned to its top.
      panel.style.left = `${vw - panelRect.width - 8}px`;
      panel.style.top = `${Math.max(8, formRect.top)}px`;
    } else {
      // Bottom-right corner, below a short form / clear of a centered one.
      panel.style.left = `${Math.max(8, vw - panelRect.width - 8)}px`;
      panel.style.top = `${Math.max(8, vh - panelRect.height - 8)}px`;
    }
  }

  // --- Dragging (header as handle) --------------------------------------------
  // The title is the drag handle. A drag records draggedPos so the user's chosen
  // spot survives reflow, minimize/expand, and window resize for this session.
  let dragGrab: Point | null = null; // pointer→panel-corner offset, so the corner tracks the cursor

  function onHandlePointerDown(event: PointerEvent): void {
    // Left button / primary pointer only; a minimized strip is click-to-expand,
    // not draggable; drags that begin on an interactive control (a future close
    // button, a link) belong to that control, not the drag.
    if (event.button !== 0 || minimized) return;
    if ((event.target as Element | null)?.closest('button, a, input, textarea, select, [tabindex]')) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    dragGrab = { x: event.clientX - panelRect.left, y: event.clientY - panelRect.top };
    dragPointerId = event.pointerId;
    panel.classList.add('ff-dragging');
    // preventDefault backstops user-select:none (belt-and-suspenders against a
    // text selection starting) and setPointerCapture keeps move/up flowing to the
    // handle even when the cursor outruns the panel.
    event.preventDefault();
    try {
      title.setPointerCapture(event.pointerId);
    } catch {
      // jsdom/older engines may lack pointer capture; document listeners below
      // still deliver the move/up sequence.
    }
    title.addEventListener('pointermove', onHandlePointerMove);
    title.addEventListener('pointerup', onHandlePointerUp);
    title.addEventListener('pointercancel', onHandlePointerUp);
  }

  function onHandlePointerMove(event: PointerEvent): void {
    if (dragGrab === null || event.pointerId !== dragPointerId) return;
    event.preventDefault();
    const next = { x: event.clientX - dragGrab.x, y: event.clientY - dragGrab.y };
    const panelRect = panel.getBoundingClientRect();
    draggedPos = clampToViewport(
      next,
      { width: panelRect.width, height: panelRect.height },
      { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    );
    panel.style.left = `${draggedPos.x}px`;
    panel.style.top = `${draggedPos.y}px`;
  }

  function onHandlePointerUp(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    dragGrab = null;
    dragPointerId = null;
    panel.classList.remove('ff-dragging');
    try {
      title.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may not have been taken; nothing to release */
    }
    title.removeEventListener('pointermove', onHandlePointerMove);
    title.removeEventListener('pointerup', onHandlePointerUp);
    title.removeEventListener('pointercancel', onHandlePointerUp);
  }
  title.addEventListener('pointerdown', onHandlePointerDown);

  // Keep the panel inside the viewport when the window shrinks; re-clamp the
  // dragged spot if there is one, otherwise the current (auto) position. Added
  // only while open (doOpen) and removed on close/destroy so nothing fires for a
  // closed panel.
  function onWindowResize(): void {
    if (!open) return;
    if (minimized) {
      positionMinimized();
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const current = draggedPos ?? { x: panelRect.left, y: panelRect.top };
    applyPosition(current);
    if (draggedPos) {
      draggedPos = clampToViewport(
        current,
        { width: panelRect.width, height: panelRect.height },
        { width: window.innerWidth || 0, height: window.innerHeight || 0 },
      );
    }
  }

  function doOpen(): void {
    if (open) return;
    open = true;
    clearStatus();
    draggedPos = null; // a fresh open re-anchors to the host; drag state does not persist across opens
    setMinimized(false); // every open starts in the full intake state
    if (usePopoverApi()) {
      (panel as unknown as { showPopover: () => void }).showPopover();
      positionNearHost();
    } else {
      positionFallback();
    }
    // While open, fieldfox is the SINGLE owner of Escape (pilot-finding 5):
    // a capture-phase document listener runs before the host's (Radix's)
    // document handlers and before the Popover API's own light-dismiss.
    document.addEventListener('keydown', captureEscape, true);
    // Keep the panel on-screen through viewport changes; scoped to the open
    // session so a closed panel holds no window listener.
    window.addEventListener('resize', onWindowResize);
    // Focus the textarea so keyboard users land inside the trap immediately.
    textarea.focus();
  }

  function doClose(): void {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', captureEscape, true);
    window.removeEventListener('resize', onWindowResize);
    draggedPos = null; // closing resets to default anchoring for the next open
    if (usePopoverApi()) {
      (panel as unknown as { hidePopover: () => void }).hidePopover();
    } else {
      panel.style.display = 'none';
    }
    trigger.focus();
  }

  // Capture-phase Escape owner. Runs before host document handlers; claims the
  // key entirely (stopImmediatePropagation blocks even other document-capture
  // listeners like Radix's; preventDefault suppresses the native Popover
  // light-dismiss) and closes ONLY this panel. If the panel is merely minimized,
  // Escape closes it too — one predictable Escape behavior while it is open.
  function captureEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
    event.preventDefault();
    doClose();
  }

  // --- Focus trap -------------------------------------------------------------
  // Active whenever the panel is open AND not busy. The busy suspension is the
  // PLAN §0 rule: during the `applying` phase C4 moves real focus per field, so
  // the trap must release rather than yank focus back into the panel.
  const trapActive = (): boolean => open && !busy;

  function focusables(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'textarea, button, input, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
  }

  function onKeydown(event: KeyboardEvent): void {
    // Escape is owned by the capture-phase document listener (captureEscape), so
    // it is deliberately NOT handled here — one owner avoids a double-close and
    // the host-dialog fight (pilot-finding 5).
    if (event.key !== 'Tab' || !trapActive()) return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const activeInShadow = shadowRoot.activeElement as HTMLElement | null;
    if (event.shiftKey && activeInShadow === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeInShadow === last) {
      event.preventDefault();
      first.focus();
    }
  }
  panel.addEventListener('keydown', onKeydown);

  // --- Image intake -----------------------------------------------------------
  function estimateBytes(dataUrl: string): number {
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  async function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function normalizeImage(file: File): Promise<string> {
    const raw = await readAsDataUrl(file);
    // Downscale to ~1280px longest side via an offscreen canvas. jsdom (and any
    // env without a real 2d context or decodable Image) returns null from
    // getContext — feature-detect and fall back to the raw data URL there.
    try {
      const downscaled = await downscale(raw, file.type);
      return downscaled ?? raw;
    } catch {
      return raw;
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    const incoming = files.filter((f) => f.type.startsWith('image/'));
    if (incoming.length === 0) return;

    let rejectedOversize = false;
    let hitCap = false;

    for (const file of incoming) {
      if (images.length >= MAX_IMAGES) {
        hitCap = true;
        break;
      }
      const dataUrl = await normalizeImage(file);
      if (estimateBytes(dataUrl) > MAX_IMAGE_BYTES) {
        rejectedOversize = true;
        continue;
      }
      images.push({ dataUrl, name: file.name });
      renderThumb(images[images.length - 1]);
    }

    if (rejectedOversize) {
      showError(`Some images are too large (max 5MB each).`);
    } else if (hitCap) {
      showError(`You can add at most ${MAX_IMAGES} images.`);
    } else {
      clearStatus();
    }
  }

  function renderThumb(image: PanelImage): void {
    const wrap = document.createElement('div');
    wrap.className = 'ff-thumb';
    wrap.setAttribute('part', 'thumbnail');
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ff-thumb-remove';
    remove.setAttribute('aria-label', `Remove ${image.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const index = images.indexOf(image);
      if (index >= 0) images.splice(index, 1);
      wrap.remove();
      clearStatus();
    });
    wrap.append(img, remove);
    thumbs.appendChild(wrap);
  }

  // --- Wiring -----------------------------------------------------------------
  function onPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    const files = collectPasteFiles(data);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }
  panel.addEventListener('paste', onPaste as EventListener);

  fileInput.addEventListener('change', () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    void addFiles(files).then(() => {
      fileInput.value = '';
    });
  });

  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    drop.classList.add('ff-dragover');
  };
  const onDragLeave = (): void => drop.classList.remove('ff-dragover');
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    drop.classList.remove('ff-dragover');
    const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
    void addFiles(files);
  };
  drop.addEventListener('dragover', onDragOver as EventListener);
  drop.addEventListener('dragleave', onDragLeave);
  drop.addEventListener('drop', onDrop as EventListener);

  fillButton.addEventListener('click', () => {
    if (busy) return;
    setBusy(true);
    const detail = {
      contextText: textarea.value,
      images: images.map(({ dataUrl }): RequestImage => ({ dataUrl })),
    };
    host.dispatchEvent(
      new CustomEvent('fieldfox:fill', { detail, bubbles: true, composed: true }),
    );
  });

  // --- Minimize (done-state review visibility) --------------------------------
  function setMinimized(next: boolean): void {
    minimized = next;
    panel.classList.toggle('ff-minimized', next);
    if (next) {
      panel.setAttribute('title', 'Click to expand');
    } else {
      panel.removeAttribute('title');
    }
    // Reposition for the new size/role: docked away from the form when minimized,
    // and on expand back to the user's dragged spot if they moved it (re-clamped
    // to the current viewport by positionNearHost) or near the host otherwise.
    // (No-op before the panel is first opened.)
    if (open) {
      if (next) positionMinimized();
      else positionNearHost();
    }
  }
  function expand(): void {
    if (minimized) setMinimized(false);
  }
  // A minimized panel is a status strip the user clicks to get the intake UI
  // back. Ignore clicks while expanded (normal controls handle their own).
  panel.addEventListener('click', () => {
    if (minimized) expand();
  });

  // --- Status + busy ----------------------------------------------------------
  function showError(message: string): void {
    status.textContent = message;
    status.classList.add('ff-error');
    // Errors need the full panel (the user retries), so an error un-minimizes.
    setMinimized(false);
  }
  function showStatus(message: string): void {
    status.textContent = message;
    status.classList.remove('ff-error');
    // A success report is the done state → collapse so the filled fields behind
    // the panel are reviewable (pilot-finding 5).
    setMinimized(true);
  }
  function clearStatus(): void {
    status.textContent = '';
    status.classList.remove('ff-error');
  }

  function setBusy(next: boolean): void {
    busy = next;
    textarea.disabled = next;
    fileInput.disabled = next;
    fillButton.disabled = next;
    thumbs
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => (b.disabled = next));
    panel.setAttribute('aria-busy', String(next));
  }

  return {
    open: doOpen,
    close: doClose,
    isOpen: () => open,
    setBusy,
    isBusy: () => busy,
    showError,
    showStatus,
    expand,
    isMinimized: () => minimized,
    isTrapActive: trapActive,
    destroy(): void {
      // Match doClose's teardown even if destroyed while open (avoid leaked
      // document/window listeners firing after the panel is gone).
      document.removeEventListener('keydown', captureEscape, true);
      window.removeEventListener('resize', onWindowResize);
      panel.remove();
    },
  };
}

function ensureStyles(shadowRoot: ShadowRoot): void {
  if (shadowRoot.querySelector('style[data-ff-popover]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-ff-popover', '');
  style.textContent = PANEL_STYLES;
  shadowRoot.appendChild(style);
}

// clipboardData exposes both `files` and `items`; prefer files, fall back to
// item.getAsFile() for browsers/paths that only populate items.
function collectPasteFiles(data: DataTransfer): File[] {
  const fromFiles = data.files ? Array.from(data.files) : [];
  if (fromFiles.length > 0) return fromFiles.filter((f) => f.type.startsWith('image/'));
  const items = data.items ? Array.from(data.items) : [];
  return items
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f != null);
}

// Returns a downscaled data URL, or null when the environment can't render a
// canvas (jsdom) or decode the image — the caller then keeps the raw data URL.
async function downscale(dataUrl: string, mimeType: string): Promise<string | null> {
  if (typeof document.createElement !== 'function' || typeof Image === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null; // jsdom: no real 2d context

  const bitmap = await loadImage(dataUrl).catch(() => null);
  if (!bitmap || !bitmap.width || !bitmap.height) return null;

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > DOWNSCALE_MAX_EDGE ? DOWNSCALE_MAX_EDGE / longest : 1;
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const outType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = outType === 'image/jpeg' ? 0.85 : undefined;
  const encoded = canvas.toDataURL(outType, quality);
  return encoded.startsWith('data:') ? encoded : null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}
