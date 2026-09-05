# Consume local Fieldfox artifacts

This integration candidate is unpublished. Use the server, widget and shared
tarballs together. Their versions, source commit and SHA-256 checksums are
recorded in the cloud repository's `vendor/integration-manifest.json`.
All three packages and the read-only documentation snapshot come from that
same clean public source checkout. They are not npm or CDN releases.

## Clean self-hosted consumer

Prerequisites: Node 20 or newer, pnpm, the three supplied tarballs, and an
OpenAI-compatible provider's base URL, model ID and your own API credential.
No private Fieldfox package, database, console or account is needed.

Copy the tarballs into an empty directory and compare their checksums with
the manifest before installing:

```sh
shasum -a 256 fieldfox-*.tgz
npm init -y
pnpm add ./fieldfox-shared-0.2.0.tgz ./fieldfox-server-0.5.0-rc.20260905.1.tgz ./fieldfox-widget-0.3.0-rc.20260905.1.tgz
mkdir -p public
node -e "require('node:fs').copyFileSync(require.resolve('@fieldfox/widget/fieldfox.js'), 'public/fieldfox.js')"
node -e "console.log('sha384-' + require('node:crypto').createHash('sha384').update(require('node:fs').readFileSync('public/fieldfox.js')).digest('base64'))"
```

Run the packaged listener directly from the installed artifact:

```sh
export FIELDFOX_SITE_KEYS='{"ffx_pk_local_example":{"origins":["http://localhost:5173"],"dailyTokenBudget":50000}}'
export FIELDFOX_LLM_BASE_URL='https://your-provider.example/v1'
export FIELDFOX_LLM_MODEL='your-model-id'
# Set FIELDFOX_LLM_API_KEY securely in this server shell.
export PORT=8787
node --input-type=module -e "await import(new URL('./serve.js', import.meta.resolve('@fieldfox/server')))"
```

Replace the example provider URL and model. The provider credential stays on
the server. The browser site key is an origin-scoped public identifier.

Create public/index.html, replacing LOCAL_SHA384 with the hash printed earlier:

```html
<!doctype html>
<meta charset="utf-8">
<title>Fieldfox self-hosted consumer</title>
<form id="checkout-form">
  <label>Full name <input name="fullName" autocomplete="name"></label>
  <button type="submit">Submit</button>
</form>
<script src="/fieldfox.js" integrity="LOCAL_SHA384" crossorigin="anonymous"></script>
<field-fox target="#checkout-form"
  endpoint="http://localhost:8787/api/fill"
  site-key="ffx_pk_local_example"></field-fox>
```

Serve public with your static server on http://localhost:5173. Open it in
Chrome and fill. Review before submitting; Fieldfox never submits for you.
The script, endpoint and allowed page origin must match. An HTTPS host page
requires HTTPS script and endpoint URLs.

## Laboratory and release boundaries

Codex and simulation scripts live outside the published package file lists.
They require explicit invocation and are not a public service provider.
The optional Codex lab resolves `codex`, `pdfinfo` and `pdftoppm` on PATH;
use FIELDFOX_CODEX_BIN, FIELDFOX_PDFINFO and FIELDFOX_PDFTOPPM for other
installed locations. It uses your Codex quota, not free computation.

The integration branches do not publish, deploy or change main. Seba owns
that decision. After a public release, generate CDN/SRI snippets from the
actual published version using [Embedding](EMBEDDING.md#install).
A locally produced SRI must never accompany an older CDN artifact.
