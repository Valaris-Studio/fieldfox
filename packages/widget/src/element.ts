import { createTrigger, type TriggerHandle } from './trigger.js';
import { introspectForms, type IntrospectionResult } from './introspect.js';

// <field-fox> — the mount point. It never wraps, moves, or injects children into
// the host form (RESEARCH §4); its own UI lives entirely in an OPEN shadow root.
//
// Two mount modes:
//   (a) target:   <field-fox target="#checkout-form"> — selector against document
//   (b) wrapping: <field-fox>…descendant <form>…</field-fox> — discovers forms
//
// Scope boundary (card C1): registration + mount modes + form discovery + the
// anchored trigger only. The popover panel, introspection, and fill land in
// C2/C3/C4. Clicking the trigger fires `fieldfox:trigger` and calls openPanel(),
// a no-op stub those cards replace.

export const ELEMENT_NAME = 'field-fox';

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
  readonly forms: HTMLFormElement[] = [];

  static readonly observedAttributes = ['target'];

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
    this.trigger?.destroy();
    this.trigger = null;
    this.forms.length = 0;
  }

  attributeChangedCallback(): void {
    // Re-resolve the mount if `target` changes while connected.
    if (this.isConnected && this.trigger) {
      this.disconnectedCallback();
      this.mount();
    }
  }

  // The element whose top-right corner the trigger anchors to: the resolved
  // target form in target-mode, else the first discovered form, else the
  // element itself (so the trigger is still placed and testable).
  private get anchor(): HTMLElement {
    return this.forms[0] ?? this;
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
  }

  private discoverForms(): void {
    this.forms.length = 0;
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
      return;
    }
    // wrapping-mode: descendant forms in the light DOM. The host form is never
    // moved — we only reference it.
    this.forms.push(...this.querySelectorAll('form'));
  }

  // Introspects the discovered form(s) into a FormSchema plus an id→element
  // resolver (card C2). Falls back to the host element itself when no form was
  // discovered so form-less containers are still walked. C3/C4 call this to
  // build the fill request and later map FillPlan entries back to live elements.
  introspect(): IntrospectionResult {
    const roots = this.forms.length > 0 ? this.forms : [this];
    return introspectForms(roots);
  }

  // No-op panel stub. Cards C3/C4 replace this with the real Popover-API panel.
  private openPanel(): void {
    /* intentionally empty until card C3 */
  }
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
