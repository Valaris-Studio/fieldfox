# FieldFox story studio

A local React / React Three Fiber experiment for reviewing the story kit. It is not the published product website.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4178/. The three views are:

- **The story:** six chapters, a scroll-responsive 3D sorting metaphor, an optional technical explanation layer, an invented example and editable diagrams.
- **Resource shelf:** generated illustrations and SVG diagrams, including the shareable overview infographic.
- **Site foundation:** the same interactive scene without product story content, ready for later website composition.

`npm run build` runs TypeScript checks and builds `dist/`. `npm run preview` serves that build on the same port after stopping the development server.

Chapter copy and example data come from `../content/story.json`. Original illustrations, diagrams and exports stay in the parent story-kit folder; Vite includes these in the build. Typography uses local system font stacks with no external font requests.

The 3D scene renders on demand and uses procedural geometry, direct lighting and a single shadow map. It has keyboard-operable rotation, separation and reset controls. Reduced motion disables interpolation and orbit damping. Pausing motion likewise applies changed states immediately. The mobile layout puts the scene before the chapters so the reading area remains usable. If WebGL is unavailable or its context is lost, the story and resource shelf remain readable with a static scene explanation.

The familiar physical machine is an illustration of the whole workflow. It does not imply local inference, guaranteed correctness, automatic submission or a security certification.
