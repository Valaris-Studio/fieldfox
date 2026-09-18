# FieldFox product website

An independent React 19 / TypeScript / Vite / React Three Fiber website. It explains the actual source → proposed values → human review workflow, offers MIT self-hosting information, and opens a progressive project enquiry. It does not offer a Cloud service. Its dependencies are deliberately outside the pnpm widget workspace and do not enter the widget bundle.

## Run locally

Use Node.js 22.13+.

```sh
cd website
npm ci
npm run dev
```

Open http://127.0.0.1:4188. In a second terminal, run `npm run enquiry:server`. The API listens on loopback 4189 and the Vite dev server forwards `/api` to it. Delivery defaults to an explicit unavailable response; no contact destination is invented.

```sh
npm run build          # TypeScript + production build
npm run preview        # Serve dist on 4188; stop dev first
npm run test:enquiry   # Transport tests, no real messages
npm run test:browser   # Requires dev preview on 4188; synthetic data only
```

Playwright Chromium must be installed for browser checks (`npx playwright install chromium`). The browser suite launches a controlled local test receiver and deletes its temporary records. Default app behavior never fakes delivery.

## Deployment configuration

Serve `dist/` over HTTPS, with a same-origin reverse proxy for `/api/enquiries` to the Node service in `server/index.mjs`. Vite preview is for local inspection, not a production server. Configure the approved receiver and exact public origin as described in [server/README.md](server/README.md). A static-only deployment can show the website but cannot deliver enquiries.

Production contact delivery is **not configured**. The selected email/CRM destination, its receipt/idempotency adapter, optional HTTPS booking URL, and retention/deletion contact must be configured and verified before publication. A generic webhook HTTP200 is not accepted as proof of delivery. The client requires the explicit accepted receipt contract.

For a production reverse proxy, provide TLS, request-rate/concurrency limits, an 8 KiB request-body limit, appropriate timeouts, and a privacy notice matching the actual destination. Keep the webhook secret server-side. No real enquiry or public deployment is performed by the tests. No analytics, advertising, remote fonts, or external model requests are used by this website.

## Presentation and assets

The R3F scene is lazy loaded and renders on demand; it does not spin indefinitely. Scroll selects narrative stages. Stage buttons are keyboard-accessible; mobile buttons change the scene in place. OS reduced-motion and manual still mode remove interpolated scene movement. WebGL capability failure and context loss use an optimized still illustration while all semantic content, the editable example and the enquiry flow remain available. `?webgl=off` forces that fallback for inspection.

The small interactive product example uses invented fixed values. It is not a live FieldFox extraction and does not measure model accuracy. [CLAIMS.md](CLAIMS.md) maps public copy to source evidence. The scene’s hardware is an explanatory metaphor.

Full-resolution generated originals and exact prompt/edit provenance are retained in [artwork/PROVENANCE.md](artwork/PROVENANCE.md) and the recovered creative kit. `npm run assets` reproduces compressed 1200px WebP delivery derivatives. Original files are preserved. The source kit’s older Cloud copy is historical, not website copy.

The Three.js lazy chunk is approximately 190 KB gzip. The app uses local system fonts and a capped device pixel ratio; the large-chunk build warning is expected for that isolated optional renderer. Website code does not modify the widget, server or shared product packages.
