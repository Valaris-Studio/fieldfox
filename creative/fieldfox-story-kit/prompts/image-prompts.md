# FieldFox — tiny field laboratory raster assets

Generated on 2026-09-18 with the built-in `image_gen` tool. No API/CLI fallback, no Python image editing, and no deterministic image retouching was used. Original generated files remain in the tool output directory. These are illustrative metaphors for review, not product screenshots, architecture guarantees, or ready-to-publish security claims.

## Visual language

Warm off-white cotton paper and matte ceramic dominate. Burnt orange identifies the fox-inspired device and source values; cobalt provides a small inspection accent; graphite supplies drafting grids, abstract ruled lines, and registration crosses. Shapes distinguish tokens without depending on color. No readable text is baked in; explanatory copy and exact technical labels belong in live HTML/SVG overlays.

## Deliverables

All four files are 1536 × 1024 PNG (3:2). Use the full composition where possible. Generated detail is intentionally tactile; these are background/still-frame assets, not transparent cutouts or production 3D geometry.

| Asset | Intended role | Original tool file |
| --- | --- | --- |
| `../assets/sorting-machine.png` | Main metaphor: source cards, distinct tokens, field slots, inspection | `exec-2ee3f7ff-73a6-4f9f-bc5c-041af9133f8b.png` |
| `../assets/sorting-machine-exploded.png` | Same scene with separated machine assembly for a crossfade reveal | `exec-4b31c59a-c013-4512-aa54-97572931cdca.png` |
| `../assets/source-specimen.png` | A source document becomes distinguishable candidate values | `exec-0df10a20-867f-4f78-bdd7-fc64cbaf3054.png` |
| `../assets/review-station.png` | Human review and correction, expressed by an idle pencil and inspection lens | `exec-55496876-840b-4234-b5ff-4af1b8afeb0c.png` |

Tool originals: `/Users/seba/.codex/generated_images/01a0b51c-7292-7a30-9fa5-cf087d37f6a3/`.

## Inspection and limits

All four outputs were visually inspected at generation. The main asset was additionally loaded with `view_image` before the edit request. The exploded variant preserves the principal camera, material, source cards, tokens, remote cube, inspection lens, and destination tray; it separates the roof/front assembly and exposes channels. Small geometry changes are inherent to the generated edit, so use a crossfade rather than pretending this pair is a mathematically exact mesh animation.

No visible letters, numbers, logos, approval seals, automatic submission controls, padlocks, or shields appear. The review still life includes harmless incidental paperclips and a small dried sprig. Source-specimen uses a pyramidal blue token rather than a strict triangular prism; the visual identity remains triangular, and no text should describe its geometry more narrowly.

The physical sorter is only an explanatory metaphor. Technical overlays should explain the actual sequence: source plus form schema → server → model → validated plan → supported field writes and readback → human review. Readback checks what the form contains; it does not establish factual accuracy. The images must not imply universal form support, automatic submission, production readiness, or particular security certification. The same widget is intended for hosted and MIT self-hosted delivery.

## Exact generation prompts

### sorting-machine.png — new generation

```text
Use case: stylized-concept
Asset type: premium editorial 3D illustration for an educational scrollytelling resource library; landscape 3:2.
Primary request: a tiny field laboratory: a wonderfully simple physical sorting machine that makes a complicated form understandable, sophisticated and quietly playful like a child's science museum seen through the art direction of a high-end industrial design studio.
Scene/backdrop: seamless warm off-white paper tabletop and backdrop, extremely faint graphite drafting grid only on tabletop, a few restrained registration crosses at outer corners.
Subject: one beautiful compact burnt-orange ceramic device at the center, approximately shoebox-sized, with two subtle triangular fox-ear-like top corners, no face. On its left are three physical ivory source cards with abstract graphite ruled lines; between source cards and machine float three small orange and cobalt geometric tokens, each plainly different in shape. On the right a flat ivory tray with three destination form slots accepts the matching shapes. This is a visual metaphor for helping to fill fields, not a literal product screenshot. A thin graphite wire from the machine travels to a small remote ceramic cube behind it, subtle server cue. A tiny cobalt inspection lens faces the output tray, suggesting inspection rather than any guarantee of truth.
Style/medium: beautiful tactile miniature diorama, physical ceramic, dense thick paper, sandblasted aluminum details, museum product photography; soft bevels, crisp silhouettes, restrained cute.
Composition/framing: 3/4 orthographic view, whole object arrangement fully visible, centered lower-middle, at least 18% clean breathing room around the scene. Strong simple visual hierarchy, readable at thumbnail size.
Lighting/mood: broad soft studio key from upper left, warm diffuse ambient occlusion, no dramatic neon, subtle real tactile imperfections.
Color palette: 75% warm ivory paper, graphite details, one burnt orange ceramic main object, tiny vivid cobalt accents. No rainbow.
Text: none.
Constraints: no letters, words, numbers, logos, watermarks or readable writing; abstract line marks only; no padlocks, shields, checkmarks, screens, terminals, robots, glowing circuitry, human figures or automated submit button. Uncluttered; maximum three source cards and three tokens.
```

### sorting-machine-exploded.png — image edit

Edit target: `../assets/sorting-machine.png`, inspected before editing. Only the target image was supplied.

```text
Use case: precise-object-edit
Input image 1 is the edit target: the FieldFox sorting-machine illustration.
Create a deliberate exploded assembly variant for a scroll reveal. Preserve exactly the same warm off-white paper, faint graphite drafting grid, registration crosses, 3:2 framing, orthographic camera, broad soft light from upper left, palette, card and token positions, output tray, remote cube and wire. Preserve the identity and material of the burnt-orange ceramic fox-ear machine.
Change only the machine assembly: lift its orange roof with both fox-ear corners upward by about one quarter of the machine height, lift the orange front plate slightly forward, and reveal three clean separated sandblasted-aluminum internal channels underneath. Thin subtle dotted graphite vertical construction lines connect roof and base. This should look like a beautiful textbook exploded parts diagram of the same object, with only four understandable structural layers and enough air between them. Keep the output tray empty, lens beside it, and the source geometric tokens detached on the left. No new colors or new objects. No letters, numbers, words, labels, arrows, logos, watermarks, checkmarks, shields or locks. The image is a metaphorical concept illustration, not a technical diagram of the real product.
```

### source-specimen.png — new generation

```text
Use case: stylized-concept
Asset type: educational scrollytelling editorial illustration, landscape 3:2.
Primary request: a tiny field laboratory source specimen. A beautiful simple physical paper product specification card with detached pieces of information shown as geometric specimen tokens. It should feel immediately understandable to a child and meticulously engineered to a developer.
Scene/backdrop: warm off-white seamless paper tabletop with extremely faint graphite square drafting grid and four small graphite registration crosses near the image corners.
Subject: one large tilted upright thick ivory paper card on the left, held by a small sandblasted aluminum clip; the card contains only three abstract line rows and a tiny embossed graphite geometric diagram of a simple box. Three little offset cutout specimen tokens sit in front and right, floating just above the table: burnt-orange sphere, cobalt blue triangular prism, burnt-orange cube. Each is paired with an empty flat cream card tab and aligned with a fine dashed graphite horizontal construction line. The tokens communicate distinct kinds of source information, not verified facts.
Style/medium: tactile miniature museum diorama, sophisticated restrained cute, premium industrial design editorial 3D render, ceramic tokens, cotton paper with gently visible fibers, soft bevels and impeccable clean silhouettes.
Composition/framing: three-quarter orthographic camera, cropped to whole subjects with broad 18% breathing room, uncomplicated hierarchy, the tall main card on left balanced by token grouping on right; no machine required.
Lighting/mood: soft broad studio key from upper left, warm natural diffuse ambient occlusion.
Color palette: 80% warm ivory, delicate graphite, burnt-orange and a very small cobalt accent.
Text: none. All card lines are purely abstract rules, no glyphs.
Constraints: no letters, numbers, words, logos, watermarks, padlocks, shields, checkmarks, robots, screens, terminals, neon or people. No submission or automatic action. Three tokens only. This is an explanatory metaphor, not a product screenshot.
```

### review-station.png — new generation

```text
Use case: stylized-concept
Asset type: premium educational scrollytelling illustration, landscape 3:2.
Primary request: a tiny field laboratory human review station. A beautiful physical still life that makes 'the person reviews the filled form' understandable with a simple pencil and tray. Sophisticated restrained cute, like a child's science museum art-directed by an industrial design studio.
Scene/backdrop: seamless warm off-white paper tabletop and backdrop; extremely faint graphite drafting grid; small precise registration crosses near corners.
Subject: centered on the tabletop is a broad ivory ceramic form tray with three horizontal rounded-rectangle slots arranged vertically. In those slots sit three thick ivory cards, each containing one tiny distinct ceramic geometric token at its left and a short fine abstract graphite ruled line beside it: burnt-orange sphere, cobalt blue triangle, burnt-orange cube. A natural wood pencil with burnt-orange lacquer end lies diagonally across the lower right edge of the tray, clearly at rest and available for a person. Beside the tray is a small cobalt-rimmed magnifying inspection lens on a short sandblasted aluminum pedestal. A modest burnt-orange ceramic two-ear fox-inspired paperweight sits in the rear left; no face. Leave an empty margin beneath the three rows so review appears unfinished and open to correction.
Style/medium: high craft tactile editorial 3D diorama, dense cotton paper, matte unglazed ceramic, aluminum detail, sophisticated object photography, soft bevels and clean silhouettes.
Composition/framing: three-quarter orthographic angle, whole scene visible, broad 18% breathing room, quiet natural arrangement. No hands needed; the pencil stands for the user's choice.
Lighting/mood: broad soft studio key upper left, subtle warm contact shadows, quiet and inviting.
Palette: 80% warm ivory and wood, graphite lines, burnt orange accents, restrained cobalt inspection lens.
Text: none; abstract horizontal rules only.
Constraints: no letters, numbers, words, logos, watermarks, arrows, checkmarks, stamps, shields, padlocks, terminal windows, screens, people, automatic submit buttons, neon or robots. Do not show a completed approval seal. This is a metaphorical human review station, not a claim of verified factual correctness.
```
