# Enquiry transport

Run `node server/index.mjs` from `website/` beside the Vite preview. The service listens on `127.0.0.1:4189`. Vite must proxy `/api` to that address, preserving browser Origin. The default mode accepts no enquiries: it returns HTTP 503 with `not_configured`. No real contact destination is included.

The website POSTs only when a visitor confirms the final review. Fields: `intent` (`project` or `start`), `useCase` (3–2000 characters), `name` (1–120), and `email` (up to 254). No draft is sent. The browser sends an `Idempotency-Key`; a retry of unchanged details retains it for the lifetime of the mounted website. A reload clears the in-memory draft and key. The server returns `{ "id": "receipt-id", "status": "accepted" }` only after acceptance is confirmed. Do not treat an HTTP 200 without that receipt as success.

## Controlled local testing

Use fake data only. This mode writes the enquiry to disk and clearly reports a **local test receipt**, never personal delivery.

```sh
FIELDFOX_ENQUIRY_MODE=local-test FIELDFOX_ENQUIRY_TEST_DIR=/tmp/fieldfox-enquiry-tests node server/index.mjs
```

Use one service process per test directory. Test records are written with mode 0600, fsynced before acceptance, and keyed by the idempotency identifier. Retries survive a service restart. The directory contains test contact details; remove it after testing. Startup rejects this mode when `NODE_ENV=production`.

Run the transport suite with `node --test tests/enquiry-server.test.mjs`. With the website preview running on 4188, run `FIELDFOX_BROWSER_TESTS=1 node --test tests/enquiry-browser.test.mjs` for the real browser journey. These browser tests start a temporary local service, persist only fictional example.com details, and remove their records afterward.

## Connect an approved destination

```sh
FIELDFOX_ENQUIRY_MODE=webhook \
FIELDFOX_PUBLIC_ORIGIN=https://your-approved-website.example \
FIELDFOX_ENQUIRY_WEBHOOK_URL=https://your-approved-receiver.example/enquiries \
FIELDFOX_ENQUIRY_WEBHOOK_TOKEN=your-server-only-secret \
node server/index.mjs
```

The receiver URL must use HTTPS. Token is optional and remains server-side. The receiver must persist/transport the enquiry before responding with the accepted receipt contract. It must durably deduplicate `Idempotency-Key` (also supplied as `idempotencyKey` in the body), return the same receipt for retries, and reject the same key with different content. A timeout can occur after the receiver accepted an enquiry: durable receiver idempotency is required to make retries safe. The adapter does not turn generic CRM success formats into verified receipts; adapt the chosen destination explicitly and test its persistence, failure and retry semantics before declaring production delivery ready.

The process binds to loopback, for deployment behind a same-origin reverse proxy that serves the built site and forwards `/api/enquiries` to the service. Set `FIELDFOX_PUBLIC_ORIGIN` to the exact HTTPS website origin. Browser requests from another origin are refused; JSON content type and an 8 KiB body cap are enforced. The proxy should supply deployment-specific abuse limits and TLS. Enquiry contents and secrets are not logged by this service. Retention, deletion contact and privacy notice must be chosen for the actual receiver before public launch; no retention guarantee is supplied here.

Optional `VITE_FIELDFOX_MEETING_URL` is a build-time HTTPS booking URL. It is shown only after a real accepted receipt, never after local test persistence. No booking URL is invented or preconfigured. The website does not send data to the booking site automatically.

Production delivery remains unconfigured until an approved receiver is connected and verified. Never enable local test storage as a substitute for contact delivery.
