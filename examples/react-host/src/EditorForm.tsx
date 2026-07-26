import { useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
// Side effect only: registers the <field-fox> custom element (this route mounts
// standalone, so it cannot rely on App.tsx's import).
import '@fieldfox/widget';

// Fidelity fixture for the contenteditable driver (card 5594ae4b, RESEARCH §9.3).
// REAL tiptap, not a stand-in: the whole reason this slice is narrow is that
// ProseMirror keeps a document model separate from the DOM and discards
// out-of-band writes, so only an editor that actually does that can prove the
// driver's execCommand path works. A hand-rolled contenteditable would happily
// accept a textContent write and prove nothing.
//
// The bare contenteditable below is the NEGATIVE control: no ProseMirror
// markers, so the driver must refuse to touch it and leave it exactly as found.

export function EditorForm() {
  const [saved, setSaved] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    // Applied to the contenteditable node ProseMirror creates — the element
    // fieldfox actually introspects. Props passed to <EditorContent> land on its
    // wrapper instead, where a label would never reach the field.
    editorProps: {
      attributes: { id: 'description-editor', 'aria-labelledby': 'description-label' },
    },
  });

  return (
    <main id="editor-section">
      <h1>Incident report (tiptap)</h1>
      <p className="muted">
        The description is a real tiptap editor. The &ldquo;internal notes&rdquo; box is a plain
        contenteditable with no editor behind it — fieldfox must leave that one alone.
      </p>

      <div id="editor-form">
        <label htmlFor="incident-title">Title</label>
        <input id="incident-title" name="incident-title" type="text" />

        <span className="field-label" id="description-label">
          Description
        </span>
        <EditorContent editor={editor} />

        <span className="field-label" id="notes-label">
          Internal notes
        </span>
        <div
          id="internal-notes"
          contentEditable
          suppressContentEditableWarning
          aria-labelledby="notes-label"
        >
          untouched
        </div>
      </div>

      <button type="button" onClick={() => setSaved(editor?.getText() ?? '')}>
        Save report
      </button>
      {saved !== null && <pre id="editor-saved">{saved}</pre>}

      <field-fox
        target="#editor-form"
        endpoint="http://localhost:8787/api/fill"
        site-key="ffx_pk_dev0000000000000000000000000000"
      ></field-fox>
    </main>
  );
}
