import type { FillRequest, RequestImage } from '@fieldfox/shared';
import { createTrigger, type TriggerHandle } from './trigger.js';
import { introspectForms, type IntrospectionResult } from './introspect.js';
import { createPopover, type PopoverHandle } from './popover.js';
import { requestFill, FillRequestError } from './client.js';
import { applyFillPlan, type FillReport } from './fill.js';
import { disableDuringFill } from './effects.js';

// <field-fox> — the mount point. It never wraps, moves, or injects children into
// the host form (RESEARCH §4); its own UI lives entirely in an OPEN shadow root.
//
// Two mount modes:
//   (a) target:   <field-fox target="#checkout-form"> — selector against document
//   (b) wrapping: <field-fox>…descendant <form>…</field-fox> — discovers forms
//
// Scope boundary: registration + mount modes + form discovery + the anchored
// trigger (C1), introspection (C2), and the input popover (C3). Clicking the
// trigger fires `fieldfox:trigger` and opens the popover; the popover collects
// context + images and emits `fieldfox:fill`. The network call + fill executor
// are C4.

export const ELEMENT_NAME = 'field-fox';

// The fieldfox server's fill endpoint; overridable via `<field-fox endpoint="…">`.
const DEFAULT_ENDPOINT = '/api/fill';

// Wire schemaVersion sent in every FillRequest. Mirrors `SCHEMA_VERSION` in
// @fieldfox/shared (a drift-guard test pins it there), but declared LOCALLY as a
// literal: value-importing it from shared would pull that package's zod runtime
// (~20KB gzip) into the eager bundle and blow the 35KB budget (PLAN §0 "widget
// imports shared TYPES, not zod runtime"; RESEARCH §4 top risk #3).
const WIRE_SCHEMA_VERSION = 2;

// Caps for the form-level embedder inputs, mirrored locally from the shared
// contract's MAX_FORM_CONTEXT / MAX_FORM_ID (same zod-free-bundle reasoning as
// WIRE_SCHEMA_VERSION). Over-cap attribute values are truncated here so the
// request is well-formed; the server re-validates regardless.
const MAX_FORM_CONTEXT = 2000;
const MAX_FORM_ID = 128;

const STYLES = `
:host {
  all: initial;
  /* Explicit resets so host-page inherited props don't bleed in and the widget
     doesn't bleed out (RESEARCH §4). all:initial handles most; these pin the
     text rendering the trigger relies on. */
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: inherit;
  --fieldfox-accent: #e2622c;
  --fieldfox-trigger-offset: 6px;
}
.ff-trigger {
  position: fixed;
  z-index: 2147483646;
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--fieldfox-accent) 60%, transparent);
  border-radius: 50%;
  background: #fff;
  color: var(--fieldfox-accent);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  line-height: 0;
}
.ff-trigger:hover {
  background: color-mix(in srgb, var(--fieldfox-accent) 12%, #fff);
}
.ff-trigger:focus-visible {
  outline: 2px solid var(--fieldfox-accent);
  outline-offset: 2px;
}
`;

export class FieldFoxElement extends HTMLElement {
  private trigger: TriggerHandle | null = null;
  // Not named `popover` — HTMLElement already reflects a `popover` string attr.
  private popoverPanel: PopoverHandle | null = null;
  readonly forms: HTMLFormElement[] = [];
  // A `target` that resolves to a container with NO <form> (common on shadcn/
  // React cards): that container is the introspection root and trigger anchor,
  // so a form-less page still fills instead of walking the empty widget host
  // (pilot finding 1). Null in wrapping-mode or when a form was found.
  private formlessRoot: HTMLElement | null = null;

  // In-flight fill: the AbortController cancels the network call and the restore
  // fn reverts the disable/shimmer effect. Both are cleared when the fill settles.
  private inflight: AbortController | null = null;
  private restoreEffect: (() => void) | null = null;
  // The element the fill listener is bound to (the anchor at mount time), kept so
  // teardown detaches from the exact same target even after `forms` is cleared.
  private fillListenerTarget: HTMLElement | null = null;
  private readonly onFillRequest = (event: Event): void => {
    void this.runFill(event as CustomEvent);
  };

  static readonly observedAttributes = ['target', 'endpoint', 'context', 'form-id'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    // Guard against double-mount (re-connection): only attach once.
    if (this.trigger) return;
    this.mount();
  }

  disconnectedCallback(): void {
    this.abortFill();
    this.fillListenerTarget?.removeEventListener('fieldfox:fill', this.onFillRequest);
    this.fillListenerTarget = null;
    this.trigger?.destroy();
    this.trigger = null;
    this.popoverPanel?.destroy();
    this.popoverPanel = null;
    this.forms.length = 0;
    this.formlessRoot = null;
  }

  attributeChangedCallback(name: string): void {
    // `context` / `form-id` are read fresh when a request is built, so a change
    // needs no re-mount. Only the mount-shaping attributes force a re-resolve.
    if (name !== 'target' && name !== 'endpoint') return;
    if (this.isConnected && this.trigger) {
      this.disconnectedCallback();
      this.mount();
    }
  }

  // The element whose top-right corner the trigger anchors to: the first
  // discovered form, else a resolved form-less target container, else the
  // element itself (so the trigger is still placed and testable).
  private get anchor(): HTMLElement {
    return this.forms[0] ?? this.formlessRoot ?? this;
  }

  // The resolved anchor, exposed read-only for embedders and tests (mirrors the
  // public `forms` / `panel` getters). Reference identity, not pixel geometry.
  get anchorElement(): HTMLElement {
    return this.anchor;
  }

  private mount(): void {
    const shadow = this.shadowRoot;
    if (!shadow) return;

    if (!shadow.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = STYLES;
      shadow.appendChild(style);
    }

    this.discoverForms();
    this.trigger = createTrigger(shadow, this.anchor, () => this.openPanel());
    this.popoverPanel = createPopover(shadow, this.anchor, this.trigger.button);
    // The popover dispatches `fieldfox:fill` on the anchor (the form in
    // target-mode is a sibling, not a descendant, so bubbling alone can't reach
    // us — listen on the anchor directly).
    this.fillListenerTarget = this.anchor;
    this.fillListenerTarget.addEventListener('fieldfox:fill', this.onFillRequest);
  }

  private discoverForms(): void {
    this.forms.length = 0;
    this.formlessRoot = null;
    const targetSelector = this.getAttribute('target');
    if (targetSelector) {
      // target-mode: resolve against the document; accept a form or the first
      // descendant form of a container.
      const resolved = document.querySelector(targetSelector);
      const form =
        resolved instanceof HTMLFormElement
          ? resolved
          : (resolved?.querySelector('form') ?? null);
      if (form) this.forms.push(form);
      // No <form>, but the target itself exists: introspect and anchor to it
      // (form-less shadcn/React cards) instead of the empty widget host.
      else if (resolved instanceof HTMLElement) this.formlessRoot = resolved;
      return;
    }
    // wrapping-mode: descendant forms in the light DOM. The host form is never
    // moved — we only reference it.
    this.forms.push(...this.querySelectorAll('form'));
  }

  // Introspects the discovered root(s) into a FormSchema plus an id→element
  // resolver (card C2): the discovered form(s), else a resolved form-less target
  // container, else the host element itself (wrapping-mode with no form). C3/C4
  // call this to build the fill request and map FillPlan entries back to live
  // elements.
  introspect(): IntrospectionResult {
    const roots: Element[] =
      this.forms.length > 0 ? this.forms : [this.formlessRoot ?? this];
    return introspectForms(roots);
  }

  // Opens the input popover (C3). Fill (C4) is driven by the `fieldfox:fill`
  // handler below, which introspects, calls /api/fill, and applies the plan.
  private openPanel(): void {
    this.popoverPanel?.open();
  }

  // Deliberately NOT named `endpoint`: React 19 assigns a JSX attribute as a
  // PROPERTY when the name exists on the element (`'endpoint' in el`), and a
  // getter-only property throws and unmounts the entire React tree (e2e
  // finding #1). Accessor names must stay disjoint from embed attribute names
  // so React falls through to setAttribute.
  private get fillEndpoint(): string {
    return this.getAttribute('endpoint') || DEFAULT_ENDPOINT;
  }

  private get siteKey(): string | undefined {
    return this.getAttribute('site-key') || undefined;
  }

  // Form-level embedder inputs (PLAN §0). Accessor names stay disjoint from the
  // `context` / `form-id` attribute names for the same React 19 reason as
  // `fillEndpoint` above. Empty/whitespace-only reads as absent so an optional
  // schema field never ships as "" on the wire; over-cap values are truncated.
  private get formContext(): string | undefined {
    const value = this.getAttribute('context')?.trim();
    return value ? value.slice(0, MAX_FORM_CONTEXT) : undefined;
  }

  private get formId(): string | undefined {
    const value = this.getAttribute('form-id')?.trim();
    return value ? value.slice(0, MAX_FORM_ID) : undefined;
  }

  // The full fill lifecycle (PLAN §1): introspect → disable affected fields under
  // the shimmer → POST /api/fill → apply the FillPlan (readback-or-revert per
  // field) → restore effects + report. The popover already set itself busy when
  // the user pressed Fill; we own re-enabling it. Any error/abort restores every
  // affected field and re-enables the panel.
  private async runFill(event: CustomEvent): Promise<void> {
    const panel = this.popoverPanel;
    if (!panel) return;
    this.abortFill(); // supersede any prior in-flight request

    const { schema, resolve } = this.introspect();
    // Only fields the plan could target get disabled + shimmered — never fields
    // outside the schema (PLAN §0 "never touch fields not in the plan").
    const affected = schema.fields
      .map((f) => resolve(f.id))
      .filter((el): el is Element => el != null);

    const detail = (event.detail ?? {}) as {
      contextText?: string;
      images?: RequestImage[];
    };
    const { formContext, formId } = this;
    const request: FillRequest = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      formSchema: schema,
      contextText: detail.contextText ?? '',
      images: detail.images ?? [],
      // Optional form-level inputs are spread in only when present, so absent
      // attributes never ship as empty strings (both fields are optional).
      ...(formContext !== undefined && { formContext }),
      ...(formId !== undefined && { formId }),
    };

    const controller = new AbortController();
    this.inflight = controller;
    this.restoreEffect = disableDuringFill(affected);

    try {
      const plan = await requestFill(this.fillEndpoint, request, {
        siteKey: this.siteKey,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      // Lift the disable/shimmer BEFORE applying: the `requesting` phase disabled
      // the fields, but the `applying` phase must write them, and the executor
      // refuses to fill a disabled control. Re-enable first, then set values.
      this.restoreEffect?.();
      this.restoreEffect = null;
      const report = applyFillPlan(plan, resolve);
      this.settleFill();
      panel.showStatus(summarize(report));
    } catch (error) {
      if (controller.signal.aborted) return; // a newer request/teardown owns cleanup
      this.settleFill();
      const message =
        error instanceof FillRequestError
          ? 'Could not fill the form. Please try again.'
          : 'Something went wrong while filling the form.';
      panel.showError(message);
    }
  }

  // Re-enable the panel and clear in-flight state, exactly once per fill. The
  // disable/shimmer effect is already lifted on the success path; on error/abort
  // restoreEffect is still set, so undo it here too. Fields are back to their
  // planned-or-original values (the executor reverts per field); this only undoes
  // transient UI state.
  private settleFill(): void {
    this.restoreEffect?.();
    this.restoreEffect = null;
    this.inflight = null;
    this.popoverPanel?.setBusy(false);
  }

  // Abort an in-flight fill (supersession or disconnect): cancel the request and
  // restore every affected field + the panel to a clean state.
  private abortFill(): void {
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
    this.restoreEffect?.();
    this.restoreEffect = null;
    this.popoverPanel?.setBusy(false);
  }

  // The live popover handle so C4 can drive the panel through the fill lifecycle.
  get panel(): PopoverHandle | null {
    return this.popoverPanel;
  }
}

// A short, human-readable fill summary for the panel status region.
function summarize(report: FillReport): string {
  const filled = report.filled.length;
  const left = report.left.length;
  if (filled === 0 && left === 0) return 'No fields to fill.';
  const parts = [`Filled ${filled} field${filled === 1 ? '' : 's'}`];
  if (left > 0) parts.push(`left ${left} unchanged`);
  return `${parts.join(', ')}. Review, then submit the form.`;
}

// customElements.define throws on a duplicate name OR a re-used constructor; two
// fieldfox versions on one page must not crash it — first registration wins
// (RESEARCH §4). The try/catch also absorbs the constructor-reuse throw that
// arises across jsdom windows in tests.
export function registerFieldFox(): void {
  if (typeof customElements === 'undefined') return;
  if (customElements.get(ELEMENT_NAME)) return;
  try {
    customElements.define(ELEMENT_NAME, FieldFoxElement);
  } catch {
    /* name or constructor already registered — first-wins, no-op */
  }
}
