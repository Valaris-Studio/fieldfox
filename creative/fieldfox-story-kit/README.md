# FieldFox · The little field laboratory

A local creative resource collection for reviewing the visual language before building the public website. The illustrations and example data are conceptual, not recordings of model extraction.

## Open the collection

Open `index.html` directly for the portable artwork and diagram contact sheet. For the interactive React Three Fiber studio:

```sh
cd creative/fieldfox-story-kit/studio
npm ci
npm run dev -- --host 127.0.0.1 --port 4178
```

Visit <http://127.0.0.1:4178>. The studio includes the story, an asset gallery, and a foundation view for exploring the 3D layout without product copy. Nothing here calls a model, submits a form, or publishes a website.

## Resources

| Folder | Use |
| --- | --- |
| `assets/` | Generated raster illustrations, including an edited exploded-view variant |
| `prompts/` | Exact image prompts and generation provenance |
| `content/` | Six-beat story, plain/technical explanations, claim sources, and three editable SVG infographics |
| `exports/` | Self-contained SVG overview poster and a PNG export, combining the generated illustration with editable explanatory text and a six-stage flow |
| `studio/` | Standalone React / TypeScript / R3F source with its own dependency lock |

## Visual idea

**A small, friendly machine with an inspectable process.** Paper cards, chunky ceramic parts, little trays, and generous negative space make the idea approachable. Technical typography, registration marks, numbered stages, and visible system boundaries give developers a second reading.

The orange identifies the fox. Blue identifies controls. Warm paper and graphite distinguish the creative study from the existing dashboard while preserving the product's orange/blue relationship. Decorative colors are never proof of trust, accuracy, or success.

The story progresses from **bring the information → show the fields → propose a fill → check the writes → review the facts → choose a home**. Human review is a visible destination, not a footnote. Unknown facts remain visibly unknown.

## What the diagrams mean

- FieldFox fills supported fields in an existing form; the application owns submission.
- Supplied sources and included form context are processed by the configured server and model provider.
- A valid plan and a successful field readback are different from a factually correct extraction.
- Hosted service is the intended default. Cloud onboarding is pre-launch; self-hosting uses the same MIT widget.
- Security-style annotations explain real boundaries. They are not certifications or promises that all sensitive content is automatically removed.

`content/claims-and-sources.md` ties the explanation to the product source. Backplane remains the authority for project status, decisions, and session handoffs.

## Reuse

Keep text and arrows editable rather than baking product claims into the raster art. Treat the generated exploded view as a compositional variant, not a pixel-aligned animation frame. The live R3F scene supplies actual spatial motion; raster art supplies texture, atmosphere, and exportable explanation.

Use the installed [EnzeD R3F skills](https://github.com/EnzeD/r3f-skills) when extending the scene. [React Three Fiber](https://r3f.docs.pmnd.rs/) is the foundation; GSAP, shadcn, and vgpu are optional future tools, not required dependencies of this study.

Review the metaphor, the amount of technical detail, and the scene's sense of depth before promoting components into the product website.
