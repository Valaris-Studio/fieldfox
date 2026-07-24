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

export interface PopoverHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  // Busy = the C4 `applying` phase: inputs disabled, focus trap suspended.
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  showError(message: string): void;
  // Non-error informational status — the C4 fill report ("Filled 3, left 1").
  showStatus(message: string): void;
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
.ff-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
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

  const usePopoverApi = (): boolean =>
    typeof (panel as unknown as { showPopover?: unknown }).showPopover ===
    'function';

  function positionFallback(): void {
    // Anchor near the host's top-right; the top layer isn't available so pin the
    // panel with fixed positioning and the theming z-index.
    const rect = host.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.zIndex = 'var(--fieldfox-z-index)';
    panel.style.top = `${Math.max(rect.top, 8)}px`;
    panel.style.left = `${Math.max(rect.left, 8)}px`;
    panel.style.display = 'block';
  }

  function doOpen(): void {
    if (open) return;
    open = true;
    clearStatus();
    if (usePopoverApi()) {
      (panel as unknown as { showPopover: () => void }).showPopover();
    } else {
      positionFallback();
    }
    // Focus the textarea so keyboard users land inside the trap immediately.
    textarea.focus();
  }

  function doClose(): void {
    if (!open) return;
    open = false;
    if (usePopoverApi()) {
      (panel as unknown as { hidePopover: () => void }).hidePopover();
    } else {
      panel.style.display = 'none';
    }
    trigger.focus();
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
    if (event.key === 'Escape') {
      event.preventDefault();
      doClose();
      return;
    }
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

  // --- Status + busy ----------------------------------------------------------
  function showError(message: string): void {
    status.textContent = message;
    status.classList.add('ff-error');
  }
  function showStatus(message: string): void {
    status.textContent = message;
    status.classList.remove('ff-error');
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
    isTrapActive: trapActive,
    destroy(): void {
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
