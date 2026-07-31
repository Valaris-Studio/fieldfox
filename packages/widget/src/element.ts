import type { FillRequest, RequestImage, RequestDocument } from '@fieldfox/shared';
import { createTrigger, type TriggerHandle } from './trigger.js';
import { introspectForms, type IntrospectionResult } from './introspect.js';
import { createPopover, type PopoverHandle } from './popover.js';
import { requestFill, FillRequestError } from './client.js';
import { applyFillPlan, type FillReport } from './fill.js';
import { startInflightEffect } from './effects.js';
import { createAdjustMode, type AdjustHandle } from './adjust.js';

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

// The hosted service's fill endpoint, used when `<field-fox>` carries no
// `endpoint` attribute — the zero-config snippet (CLOUD-1). It is ABSOLUTE on
// purpose: a relative default resolves against the HOST page's origin, so a bare
// snippet on acme.com would POST to acme.com/api/fill and 404, which is why the
// attribute used to be effectively required.
//
// A compile-time constant, never a runtime lookup: no discovery round-trip
// before the first fill, and no eager weight beyond the string itself.
//
// Injected at build time from FIELDFOX_HOSTED_ENDPOINT (see vite.config.ts),
// because we deploy behind a provider-generated URL and cut a domain over later
// (P0-2) — the hostname is a build flag, not a source edit. It is still resolved
// at COMPILE time; only where the string comes from changed.
//
// NOTE: this hostname is baked into every CDN-pinned snippet in the wild, so
// changing it later strands them. It is deliberately the ONLY place the hosted
// host appears (P4-1 owns standing the deployment up behind it).
export const HOSTED_FILL_ENDPOINT = __HOSTED_FILL_ENDPOINT__;

// Wire schemaVersion sent in every FillRequest. Mirrors `SCHEMA_VERSION` in
// @fieldfox/shared (a drift-guard test pins it there), but declared LOCALLY as a
// literal: value-importing it from shared would pull that package's zod runtime
// (~20KB gzip) into the eager bundle and blow the 35KB budget (PLAN §0 "widget
// imports shared TYPES, not zod runtime"; RESEARCH §4 top risk #3).
const WIRE_SCHEMA_VERSION = 4;

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
/* Bare fox glyph, no circular chrome: transparent box (no border/background/
   shadow) keeps the 28px hit target while the icon reads as a standalone mark.
   Hover is a subtle opacity/scale nudge rather than a filled pill. */
.ff-trigger {
  position: fixed;
  z-index: 2147483646;
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--fieldfox-accent);
  cursor: pointer;
  line-height: 0;
  opacity: 0.85;
  transition: opacity 120ms ease, transform 120ms ease;
}
.ff-trigger:hover {
  opacity: 1;
  transform: scale(1.08);
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
  // Target-mode only: watches the document so we react when the host removes the
  // resolved target (orphaned trigger/panel — pilot finding 4) or an SPA swaps a
  // new element under the same selector (re-anchor). Lives for the whole mounted
  // lifetime — a removal does NOT disconnect it, so a later re-add re-binds.
  private targetObserver: MutationObserver | null = null;
  // The element the trigger/panel are currently bound to; lets the observer tell
  // a stale binding (removed or replaced) from a still-valid one.
  private boundAnchor: HTMLElement | null = null;

  // In-flight fill: the AbortController cancels the network call and the restore
  // fn reverts the disable + border-tracer effect. Both are cleared when the fill
  // settles.
  private inflight: AbortController | null = null;
  private restoreEffect: (() => void) | null = null;
  // The element the fill listener is bound to (the anchor at mount time), kept so
  // teardown detaches from the exact same target even after `forms` is cleared.
  private fillListenerTarget: HTMLElement | null = null;
  private readonly onFillRequest = (event: Event): void => {
    void this.runFill(event as CustomEvent);
  };

  // Adjustment mode (attribute: adjust) — the dev/integration affordance for
  // seeing + live-editing each field's data-ff-* annotations. Null unless the
  // attribute is on; created alongside the trigger/popover in bindToAnchor.
  // NOT named `adjust`: a class field is an OWN instance property, so `this.adjust`
  // would make `'adjust' in el` true and trip React 19's property-vs-attribute
  // heuristic (see the fillEndpoint / adjustEnabled notes). The field name must
  // stay disjoint from the `adjust` attribute.
  private adjustMode: AdjustHandle | null = null;

  static readonly observedAttributes = ['target', 'endpoint', 'context', 'form-id', 'accept-documents', 'adjust'];

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
    this.unbindFromAnchor();
    this.targetObserver?.disconnect();
    this.targetObserver = null;
    this.forms.length = 0;
    this.formlessRoot = null;
  }

  attributeChangedCallback(name: string): void {
    // `context` / `form-id` are read fresh when a request is built, so a change
    // needs no re-mount. `accept-documents` shapes the popover's intake config,
    // which is fixed at creation time; `adjust` gates whether the adjust toggle is
    // created — both are fixed at bind time, so a toggle re-creates the binding
    // alongside the mount-shaping attributes.
    if (
      name !== 'target' &&
      name !== 'endpoint' &&
      name !== 'accept-documents' &&
      name !== 'adjust'
    ) {
      return;
    }
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
    this.bindToAnchor();
    this.observeTarget();
  }

  // Creates the trigger + popover against the current anchor and binds the fill
  // listener. Split out from mount() so a target replacement can re-bind without
  // tearing down the target observer (which must outlive individual bindings).
  private bindToAnchor(): void {
    const shadow = this.shadowRoot;
    if (!shadow) return;
    const anchor = this.anchor;
    this.boundAnchor = anchor;
    this.trigger = createTrigger(shadow, anchor, () => this.openPanel());
    this.popoverPanel = createPopover(shadow, anchor, this.trigger.button, {
      acceptDocuments: this.acceptDocuments,
    });
    // The popover dispatches `fieldfox:fill` on the anchor (the form in
    // target-mode is a sibling, not a descendant, so bubbling alone can't reach
    // us — listen on the anchor directly).
    this.fillListenerTarget = anchor;
    this.fillListenerTarget.addEventListener('fieldfox:fill', this.onFillRequest);

    // Adjust toggle: only mounted when the attribute is on. It re-introspects the
    // live anchor per open (introspect() reflects the current roots), so applied
    // edits ride the very next fill with no extra wiring.
    if (this.adjustEnabled) {
      this.adjustMode = createAdjustMode(shadow, anchor, () => this.introspectRoots());
    }
  }

  // Destroys the trigger + popover + adjust UI and detaches the fill listener.
  // Leaves the target observer and discovery state alone — the caller decides those.
  private unbindFromAnchor(): void {
    this.fillListenerTarget?.removeEventListener('fieldfox:fill', this.onFillRequest);
    this.fillListenerTarget = null;
    this.trigger?.destroy();
    this.trigger = null;
    this.popoverPanel?.destroy();
    this.popoverPanel = null;
    this.adjustMode?.destroy();
    this.adjustMode = null;
    this.boundAnchor = null;
  }

  // In target-mode, watch the document for the resolved target being removed or
  // replaced. Cheap: childList+subtree fires only on structural changes, and the
  // handler bails immediately unless the current binding is actually stale.
  private observeTarget(): void {
    if (this.targetObserver) return; // already watching
    if (typeof MutationObserver === 'undefined') return;
    if (!this.getAttribute('target')) return; // wrapping-mode has no selector
    this.targetObserver = new MutationObserver(() => this.handleTargetMutation());
    this.targetObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // A structural DOM change happened somewhere. Re-resolve the target selector
  // and reconcile: gone → tear the orphaned UI down (finding 4); a different node
  // under the same selector → re-anchor to it (SPA re-render); unchanged → no-op.
  private handleTargetMutation(): void {
    if (!this.isConnected) return;
    this.discoverForms();
    const resolved = this.anchor === this ? null : this.anchor;

    if (resolved === this.boundAnchor) return; // still the same live target

    // Supersede any in-flight fill; the fields it touched may be gone, but the
    // restore is reference-based and idempotent, so this never throws.
    this.abortFill();
    this.unbindFromAnchor();
    // Re-bind only when the selector resolves to a real element; a bare removal
    // leaves the UI down but keeps the observer running for a later re-add.
    if (resolved) this.bindToAnchor();
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
    return introspectForms(this.introspectRoots());
  }

  // The current introspection roots: the discovered form(s), else a resolved
  // form-less container, else the host element itself. Shared by introspect() and
  // the adjust mode's badge/export walk so both always reflect the live anchor.
  private introspectRoots(): Element[] {
    return this.forms.length > 0 ? this.forms : [this.formlessRoot ?? this];
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
    // An explicit value is passed through verbatim, relative ones included: a
    // self-hoster's `/api/fill` must stay same-origin, never be absolutized
    // against the hosted host. Empty/whitespace (an unset template variable)
    // reads as absent rather than POSTing to the current page URL.
    return this.getAttribute('endpoint')?.trim() || HOSTED_FILL_ENDPOINT;
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

  // Opt-in document intake (card: accept-documents). A bare `accept-documents`
  // attribute (or any non-"false" value) turns on PDF + text-like attachments in
  // the popover; default off means zero behavior change for hosts that omit it.
  // Named disjoint from the attribute for the same React 19 reason as the
  // accessors above (`'accept-documents' in el` must stay false).
  private get acceptDocuments(): boolean {
    return this.hasAttribute('accept-documents') && this.getAttribute('accept-documents') !== 'false';
  }

  // Adjustment mode gate (attribute: adjust). Same boolean-ish convention as
  // acceptDocuments. Named disjoint from the `adjust` attribute — a getter named
  // `adjust` would satisfy React 19's `'adjust' in el` and be assigned as a
  // (getter-only, throwing) property, unmounting the host tree; the disjoint name
  // keeps `'adjust' in el` false so React falls through to setAttribute.
  private get adjustEnabled(): boolean {
    return this.hasAttribute('adjust') && this.getAttribute('adjust') !== 'false';
  }

  // The full fill lifecycle (PLAN §1): introspect → disable affected fields +
  // mount the border-tracer overlay → POST /api/fill → apply the FillPlan
  // (readback-or-revert per field) → restore effects + report. The popover already
  // set itself busy when the user pressed Fill; we own re-enabling it. Any
  // error/abort restores every affected field, tears the overlay down, and
  // re-enables the panel.
  private async runFill(event: CustomEvent): Promise<void> {
    const panel = this.popoverPanel;
    if (!panel) return;
    this.abortFill(); // supersede any prior in-flight request

    const { schema, resolve } = this.introspect();
    // Only fields the plan could target get disabled + dimmed — never fields
    // outside the schema (PLAN §0 "never touch fields not in the plan").
    const affected = schema.fields
      .map((f) => resolve(f.id))
      .filter((el): el is Element => el != null);

    const detail = (event.detail ?? {}) as {
      contextText?: string;
      images?: RequestImage[];
      documents?: RequestDocument[];
    };
    const { formContext, formId } = this;
    // Text-like attachments are already inlined into contextText by the popover;
    // only PDFs ride the wire's `documents` field. Sent like `images` — always
    // present, empty when the flag is off or no PDF was attached (a v3 default).
    const request: FillRequest = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      formSchema: schema,
      contextText: detail.contextText ?? '',
      images: detail.images ?? [],
      documents: detail.documents ?? [],
      // Optional form-level inputs are spread in only when present, so absent
      // attributes never ship as empty strings (both fields are optional).
      ...(formContext !== undefined && { formContext }),
      ...(formId !== undefined && { formId }),
    };

    const controller = new AbortController();
    this.inflight = controller;
    // Adjust overlays are noise under the tracer (fields are disabled/dimmed): hide
    // them for the flight and restore on settle if the mode is still active.
    this.adjustMode?.hideForFlight();
    // The tracer overlay mounts into the widget's shadow root and tracks the
    // anchor rect; `shadowRoot` is non-null here (set in the constructor). If it
    // were ever absent we'd still get the field-disable safety from a bare
    // disable path, but the getter guarantees it, so pass it straight through.
    this.restoreEffect = this.shadowRoot
      ? startInflightEffect(this.shadowRoot, this.anchor, affected)
      : null;

    try {
      const plan = await requestFill(this.fillEndpoint, request, {
        siteKey: this.siteKey,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      // Lift the disable + tracer BEFORE applying: the `requesting` phase disabled
      // the fields, but the `applying` phase must write them, and the executor
      // refuses to fill a disabled control. Re-enable first, then set values.
      this.restoreEffect?.();
      this.restoreEffect = null;
      // Drivers make this await real (RESEARCH §9.7): a superseding fill or a
      // disconnect can land mid-sequence, so re-check the signal exactly as the
      // request path above does before touching the panel.
      const report = await applyFillPlan(plan, resolve, { signal: controller.signal });
      if (controller.signal.aborted) return;
      this.settleFill();
      panel.showStatus(summarize(report));
    } catch (error) {
      if (controller.signal.aborted) return; // a newer request/teardown owns cleanup
      this.settleFill();
      // The free allowance running out is the one refusal that is not a fault:
      // nothing broke, the visitor reached the end of the free tier and there is
      // a next step. It gets the offer surface instead of the error one. A
      // self-hosted server never sends this code, so that path is untouched.
      const offer = allowanceOfferFor(error);
      if (offer) {
        panel.showOffer(offer.message, OFFER_LINK_TEXT, offer.signupUrl, {
          url: SELF_HOST_URL,
          text: SELF_HOST_LINK_TEXT,
        });
      }
      else panel.showError(errorMessageFor(error));
    }
  }

  // Re-enable the panel and clear in-flight state, exactly once per fill. The
  // disable + tracer effect is already lifted on the success path; on error/abort
  // restoreEffect is still set, so undo it here too. Fields are back to their
  // planned-or-original values (the executor reverts per field); this only undoes
  // transient UI state.
  private settleFill(): void {
    this.restoreEffect?.();
    this.restoreEffect = null;
    this.inflight = null;
    this.popoverPanel?.setBusy(false);
    // Re-show the adjust overlays hidden for the flight (no-op if the mode is off
    // or was never hidden; idempotent restore mirrors the effect cleanup).
    this.adjustMode?.restoreAfterFlight();
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

// Call-to-action label on the exhaustion surface. Separate from the sentence so
// the link text stays short and the copy around it can change independently.
const OFFER_LINK_TEXT = 'Get a free account';

// The hosted free allowance is spent (server: 402 free_allowance_exhausted).
// Returns the copy + a validated link, or null when this error is anything else.
// Stating that the form was left untouched is the point: the user must know
// their data is intact, not half-written.
function allowanceOfferFor(error: unknown): { message: string; signupUrl?: string } | null {
  if (!(error instanceof FillRequestError) || error.errorCode !== 'free_allowance_exhausted') {
    return null;
  }
  return {
    // Says three things in one line, in the order the reader needs them: what
    // happened, that their data is safe, and what to do next. "Free fills" names
    // the thing that ran out, so the offer that follows reads as the answer to it
    // rather than an unrelated upsell.
    message: 'That used up the free fills for this site today — your form is unchanged.',
    signupUrl: safeHttpUrl(error.details?.signupUrl),
  };
}

// The second road, always offered. A developer who just hit the hosted ceiling
// is precisely the person who might rather run it themselves, and the project
// promises self-hosting as a first-class equal rather than a funnel dead-end —
// so this link is present even when no signupUrl is configured, which is exactly
// the self-hosted deployment's own case.
const SELF_HOST_URL = 'https://github.com/Valaris-Studio/fieldfox';
const SELF_HOST_LINK_TEXT = 'or self-host it';

// Only http(s) may reach an href. `signupUrl` is network input, so rendering it
// unvalidated would let a hostile or compromised endpoint run `javascript:` on
// the HOST page. Anything else degrades to copy with no link.
function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// Maps a caught fill error to user-facing copy. Known server refuse codes get a
// specific, friendly message; every other FillRequestError falls back to the
// generic retry surface, and anything non-typed to the catch-all.
function errorMessageFor(error: unknown): string {
  if (error instanceof FillRequestError) {
    if (error.errorCode === 'no_fillable_fields') {
      return 'Nothing here can be filled automatically.';
    }
    // Major schemaVersion skew (server refuses with 426): the SITE OWNER must
    // update the embedded snippet — nothing the end user can retry (PLAN §0
    // version-skew row).
    if (error.errorCode === 'schema_version_unsupported') {
      return 'This form helper is out of date — the site needs to update its Fieldfox snippet.';
    }
    return 'Could not fill the form. Please try again.';
  }
  return 'Something went wrong while filling the form.';
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
