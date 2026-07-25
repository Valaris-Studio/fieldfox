import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPopover, type PopoverHandle } from '../src/popover.js';

// Card: accept-documents. The popover gains an opt-in document lane — PDFs ride
// the wire's `documents` field, text-like files inline into contextText, and
// unsupported types surface a friendly (non-error) message. With the flag off
// the intake is images-only, exactly as before (covered in popover.test.ts).
//
// jsdom ships FileReader (readAsText + readAsDataURL) but no ClipboardEvent; the
// upload path drives the file <input> like popover.test.ts does.

interface Harness {
  handle: PopoverHandle;
  host: HTMLElement;
  trigger: HTMLButtonElement;
  root: ShadowRoot;
}

let harness: Harness | null = null;

function mount(acceptDocuments: boolean): Harness {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  const shadowHost = document.createElement('div');
  const root = shadowHost.attachShadow({ mode: 'open' });
  const trigger = document.createElement('button');
  trigger.type = 'button';
  document.body.append(host, shadowHost, trigger);
  const handle = createPopover(root, host, trigger, { acceptDocuments });
  harness = { handle, host, trigger, root };
  return harness;
}

function pdfFile(name = 'resume.pdf', byteLength = 128): File {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x25, 0x50, 0x44, 0x46]); // %PDF
  return new File([bytes], name, { type: 'application/pdf' });
}

function textFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type });
}

function fileInput(root: ShadowRoot): HTMLInputElement {
  return root.querySelector('input[type="file"]') as HTMLInputElement;
}

function fireUpload(root: ShadowRoot, files: File[]): void {
  const input = fileInput(root);
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

function chips(root: ShadowRoot): NodeListOf<Element> {
  return root.querySelectorAll('[part="attachment"]');
}

function status(root: ShadowRoot): HTMLElement {
  return root.querySelector('[role="status"]') as HTMLElement;
}

// Fires Fill and returns the emitted detail.
function fillDetail(harness: Harness): { contextText: string; images: unknown[]; documents: unknown[] } {
  const onFill = vi.fn();
  harness.host.addEventListener('fieldfox:fill', onFill as EventListener);
  (harness.root.querySelector('[part="fill-button"]') as HTMLButtonElement).click();
  return (onFill.mock.calls[0][0] as CustomEvent).detail;
}

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  harness?.handle.destroy();
  harness = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// --- Flag gating ------------------------------------------------------------

test('flag OFF: the file input accepts images only and the hint says images', () => {
  const { handle, root } = mount(false);
  handle.open();
  expect(fileInput(root).accept).toBe('image/*');
  const label = root.querySelector('.ff-file-label') as HTMLElement;
  expect(label.textContent).toBe('add images');
});

test('flag ON: the file input also accepts PDF + text formats and the hint mentions documents', () => {
  const { handle, root } = mount(true);
  handle.open();
  const accept = fileInput(root).accept;
  expect(accept).toContain('image/*');
  expect(accept).toContain('application/pdf');
  expect(accept).toContain('text/plain');
  const label = root.querySelector('.ff-file-label') as HTMLElement;
  expect(label.textContent).toMatch(/document/i);
});

test('flag OFF: a dropped PDF is not accepted — no chip, a friendly note, no documents on the wire', async () => {
  const { handle, root } = mount(false);
  handle.open();
  fireUpload(root, [pdfFile()]);
  await flush();
  expect(chips(root)).toHaveLength(0);
  const s = status(root);
  expect(s.textContent).toMatch(/only images|not accepted/i);
  expect(s.classList.contains('ff-error')).toBe(false); // friendly, not an error state
  expect(fillDetail(harness!).documents).toEqual([]);
});

// --- PDF intake -------------------------------------------------------------

test('flag ON: a PDF adds a chip and rides the wire documents field', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [pdfFile('cv.pdf')]);
  await flush();

  expect(chips(root)).toHaveLength(1);
  expect((chips(root)[0].querySelector('.ff-chip-name') as HTMLElement).textContent).toBe('cv.pdf');

  const detail = fillDetail(harness!);
  expect(detail.documents).toHaveLength(1);
  const doc = detail.documents[0] as { name: string; mediaType: string; dataUrl: string };
  expect(doc.name).toBe('cv.pdf');
  expect(doc.mediaType).toBe('application/pdf');
  expect(doc.dataUrl.startsWith('data:application/pdf')).toBe(true);
});

test('flag ON: the PDF chip × removes it', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [pdfFile()]);
  await flush();
  expect(chips(root)).toHaveLength(1);

  (chips(root)[0].querySelector('.ff-chip-remove') as HTMLButtonElement).click();
  expect(chips(root)).toHaveLength(0);
  expect(fillDetail(harness!).documents).toEqual([]);
});

test('flag ON: an oversize PDF (>5MB) is rejected with an inline error, not added', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [pdfFile('huge.pdf', 6 * 1024 * 1024)]);
  await flush();
  expect(chips(root)).toHaveLength(0);
  expect(status(root).textContent).toMatch(/too large|5\s?MB/i);
});

test('flag ON: at most 3 PDFs are kept', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf'), pdfFile('d.pdf')]);
  await flush();
  expect(chips(root)).toHaveLength(3);
  expect(status(root).textContent).toMatch(/at most 3|most 3/i);
});

test('flag ON: a filename with path separators + control chars is sanitized on the chip and wire', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [pdfFile('../../etc/pass.pdf')]);
  await flush();

  const doc = fillDetail(harness!).documents[0] as { name: string };
  // Path stripped to the basename, the BEL control char removed.
  expect(doc.name).toBe('pass.pdf');
});

// --- Text intake (inlined into contextText) ---------------------------------

test('flag ON: a text file inlines into contextText between named delimiters; documents stays empty', async () => {
  const { handle, root } = mount(true);
  handle.open();
  const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'My name is Ada.';
  fireUpload(root, [textFile('notes.txt', 'Prefers afternoon sessions.')]);
  await flush();

  // A chip is shown for the text attachment too.
  expect(chips(root)).toHaveLength(1);

  const detail = fillDetail(harness!);
  expect(detail.documents).toEqual([]); // text does NOT ride the wire documents field
  expect(detail.contextText).toContain('My name is Ada.');
  expect(detail.contextText).toContain('BEGIN ATTACHED FILE: notes.txt');
  expect(detail.contextText).toContain('Prefers afternoon sessions.');
  expect(detail.contextText).toContain('END ATTACHED FILE: notes.txt');
});

test('flag ON: text content is capped at 20k chars per file', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [textFile('big.txt', 'x'.repeat(25_000))]);
  await flush();

  const detail = fillDetail(harness!);
  // The longest run of x's is the inlined body (the .txt in the fence contributes
  // only a single stray x). Capped at 20k, the 25k input's tail is dropped.
  const longestRun = (detail.contextText.match(/x+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  expect(longestRun).toBe(20_000);
});

test('flag ON: at most 3 text files are inlined', async () => {
  const { handle, root } = mount(true);
  handle.open();
  fireUpload(root, [
    textFile('a.txt', 'a'),
    textFile('b.txt', 'b'),
    textFile('c.txt', 'c'),
    textFile('d.txt', 'd'),
  ]);
  await flush();
  expect(chips(root)).toHaveLength(3);
  expect(status(root).textContent).toMatch(/at most 3|most 3/i);
});

test('flag ON: markdown/csv/json by extension are treated as text even with a vague mime', async () => {
  const { handle, root } = mount(true);
  handle.open();
  // Some browsers report application/octet-stream (or empty) for these.
  fireUpload(root, [textFile('data.csv', 'a,b\n1,2', 'application/octet-stream')]);
  await flush();

  const detail = fillDetail(harness!);
  expect(detail.documents).toEqual([]);
  expect(detail.contextText).toContain('BEGIN ATTACHED FILE: data.csv');
  expect(detail.contextText).toContain('a,b');
});

// --- Unsupported types ------------------------------------------------------

test('flag ON: an unsupported type shows a friendly message and is NOT an error state', async () => {
  const { handle, root } = mount(true);
  handle.open();
  const docx = new File(['zip-bytes'], 'contract.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  fireUpload(root, [docx]);
  await flush();

  expect(chips(root)).toHaveLength(0);
  const s = status(root);
  expect(s.textContent).toMatch(/can't read|contract\.docx|supported/i);
  // Not an error state: the ff-error class is not applied.
  expect(s.classList.contains('ff-error')).toBe(false);
});
