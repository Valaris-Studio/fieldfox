# FieldFox: a tiny field laboratory

A friendly tabletop sorter explains the work; precise annotations explain its boundaries. This is a reviewable resource kit. The six beats can become a scrollytelling sequence, six standalone panels, or a short illustrated walkthrough.

**Primary line:** From the information you have to the form you need.

**Visual rule:** the toy is a metaphor for the workflow. Always show the outbound processing route when discussing how it works. Never imply that the toy runs a model inside the browser.

**Availability:** pre-launch, checked September 18, 2026. Cloud is the intended default; the public zero-config snippet is not ready for adoption. Self-hosting is available for evaluation.

## 01 · Gather

### Bring the bits you already have.

A message. A labelled photo. A supplier sheet. Give FieldFox the source beside the form you already use.

**Technical annotation:** Text and images are supported inputs. Enable document attachments with accept-documents; extraction depends on the chosen model.

**Motion direction:** A folded source sheet and two small information tiles settle into the intake tray. Keep the source visible throughout.

**Image description:** A source sheet with a product SKU, material and dimensions sits beside an empty product form.

**Claim references:** inputs, existing-form.

## 02 · Map

### Meet the little boxes.

FieldFox reads your form’s labels and supported controls. You can add hints and mark a field hands-off.

**Technical annotation:** The widget builds a form schema. data-ff-ignore excludes a field or subtree from introspection and filling.

**Motion direction:** A cobalt frame follows each supported field; a dotted boundary steps around the manual-note field.

**Image description:** The form becomes a labelled map. A separate internal-note field stays outside the map.

**Claim references:** schema, ignore.

## 03 · Propose

### Ask for a plan.

The source and the form map travel to your configured server and model provider. The model proposes where the information belongs.

**Technical annotation:** Browser → FieldFox server → compatible provider. Site-author guidance is separated from source content; the server validates the proposed fill plan.

**Motion direction:** One visible packet crosses the browser boundary, enters the server, reaches the provider and returns through the plan-validation gate.

**Image description:** Source and schema leave the browser for the server and model provider. A proposed plan returns to the server for validation.

**Claim references:** data-route, prompt-lanes, plan-validation.

## 04 · Check

### Did it land in the box?

FieldFox applies supported values, then reads the fields back. That checks the write—not whether the source was understood correctly.

**Technical annotation:** Skipped and omitted fields stay as they were. A failed confirmation triggers a restore attempt for that field. Cancellation is not an all-or-nothing rollback.

**Motion direction:** Three value tiles settle into matching fields. A small readback loop visits each field. Weight remains empty; the manual note does not move.

**Image description:** SKU, material and dimensions are filled, then read back. Weight remains empty and the excluded manual note is preserved.

**Claim references:** apply, readback, skip, cancellation.

## 05 · Review

### Your eyes. Your next move.

Compare the filled values with the source. Correct what needs correcting. FieldFox never submits the form.

**Technical annotation:** The widget reports its result. Your application keeps its own validation and submission flow. A readback match is not factual proof.

**Motion direction:** The camera eases back to show the source and filled form side by side. A human review marker arrives; no submit animation plays.

**Image description:** A person compares the source with the filled form, edits a value and retains control of the next action.

**Claim references:** human-review, never-submit, readback.

## 06 · Choose a home

### One fox. Two homes.

Cloud is the planned easy starting point. Or run the MIT widget and server yourself, with a compatible model provider.

**Technical annotation:** Cloud is pre-launch: a free first fill before signup is the intended experience. Self-hosting is available for evaluation. The widget and fill engine are shared.

**Motion direction:** The same little fox device stays centered while two infrastructure trays slide into view: planned Cloud and self-hosted evaluation.

**Image description:** An identical FieldFox widget connects to either pre-launch Cloud or a self-hosted server. Both use a configured model provider.

**Claim references:** hosting, availability, provider-costs.

## One concrete example

Use an invented supplier sheet for a little wooden stool: SKU `STOOL-014`, material `wood`, width `32 cm`, depth `32 cm`, height `45 cm`. Show those facts on the source itself. A picture of a stool alone is not evidence for any of them.

Show weight as empty because it is absent from this example. Show the manually entered note “Check finish with supplier.” preserved outside the FieldFox map with `data-ff-ignore`. This illustrates omission and exclusion, not a guarantee that a model will always identify missing facts correctly.

Label the whole example **Illustration · invented values · review required**. If replaced by a recording of the existing mock demo, relabel it **Deterministic mock · workflow demonstration · not extraction accuracy**.

## The two reading speeds

| First glance | Closer look |
|---|---|
| Bring your source. | Supplied text, images and enabled documents. |
| Meet your form. | Schema, field hints and excluded subtrees. |
| Ask for a plan. | Server/provider boundary and validated structured plan. |
| Check the write. | Readback, skipped fields and restore attempts. |
| You decide. | Human factual review; application-owned submission. |
| Choose a home. | Same widget; different operating responsibility. |

## Art and interaction notes

- Ivory is the working surface; dark ink carries all essential copy. Orange marks the fox and source tiles; cobalt marks routes and technical annotations; sage groups passive support surfaces. Color always has a second cue: labels, line style or shape.
- Give every connection a visible start, destination and label. Treat the browser/server/provider boundary as part of the story rather than background decoration.
- Readback gets a loop-arrow, not a certification shield or “truth” badge. Human review gets equal visual weight to extraction.
- Keep diagrams as SVG text and shapes. Raster art can sit behind or beside them, never replace the technical labels.
- Use the static panels as the reduced-motion and no-WebGL experience. Mobile reading should put one panel at a time above its technical line; do not shrink an entire desktop canvas into tiny text.
- Decorative travel can follow scroll; factual labels stay in the HTML reading order and visible without interaction.

## Standalone diagrams

- `source-to-form.svg` — six literal steps from source to human review.
- `trust-boundaries.svg` — browser, server and provider; outbound source data and distinct key roles.
- `same-widget-two-homes.svg` — planned Cloud first, with first-class self-hosted evaluation.

Each SVG has a viewBox, accessible title/description and editable live text. They scale without rasterization. For narrow layouts, present a zoom/open control or rebuild their text as HTML panels from `story.json`; do not rely on tiny scaled SVG text.
