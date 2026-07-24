// <field-fox> is a plain custom element; teach React 19's JSX about it and its
// embed attributes (React sets unknown props on custom elements as attributes).
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type FieldFoxAttributes = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  /** CSS selector (against the document) of the form to attach to. */
  target?: string;
  /** Your fieldfox server's fill endpoint; defaults to /api/fill. */
  endpoint?: string;
  /** Public ffx_pk_ site key registered on that server. */
  'site-key'?: string;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'field-fox': FieldFoxAttributes;
    }
  }
}
