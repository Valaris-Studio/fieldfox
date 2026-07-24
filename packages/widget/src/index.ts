import { FieldFoxElement, registerFieldFox } from './element.js';

export const WIDGET_VERSION = '0.0.0';

export { FieldFoxElement, registerFieldFox };
export { triggerPosition } from './trigger.js';
export { introspectForms, type IntrospectionResult } from './introspect.js';
export { createPopover, type PopoverHandle } from './popover.js';

// Side-effect: the IIFE snippet self-registers on load (RESEARCH §4). Vite's lib
// mode also exposes the module's exports on the global `FieldFox`.
registerFieldFox();
