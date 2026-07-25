import { FieldFoxElement, registerFieldFox } from './element.js';

// Injected from package.json at build time via vite `define` (see vite.config.ts)
// so the published version and this constant can never skew.
export const WIDGET_VERSION = __WIDGET_VERSION__;

export { FieldFoxElement, registerFieldFox };
export { triggerPosition } from './trigger.js';
export { introspectForms, type IntrospectionResult } from './introspect.js';
export { createPopover, type PopoverHandle } from './popover.js';

// Side-effect: the IIFE snippet self-registers on load (RESEARCH §4). Vite's lib
// mode also exposes the module's exports on the global `FieldFox`.
registerFieldFox();
