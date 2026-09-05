# Consume local Fieldfox artifacts

This branch is an unpublished local integration experiment. Package versions do
not identify its added behavior on npm or a CDN. Use the exact tarballs supplied
with the experiment and retain their SHA-256 checksums and source commits.

The widget used by the console comes from c86dd23f162581a8f6ad96391de463d3425d8d02.
Its tarball is fieldfox-widget-c86dd23.tgz with SHA-256
ce1286e4e017aeb9d37c3b237b20144139009f8389131cbcb8032bbc934f38a2.
The public server artifact comes from 3c8f4b4a46ad8599063a975d3feb2c1f306bc9cb.
Its tarball is fieldfox-server-3c8f4b4.tgz with SHA-256
ae6570749a57d6d0c77ead2220ee80fffcd97758036d250c87a87b32153a40f1.
These are local file identities, not published release claims.

## Clean self-hosted consumer

Prerequisites: Node 20 or newer, pnpm, the two supplied tarballs, and an
OpenAI-compatible provider's base URL, model ID and your own API credential.
No private Fieldfox package, database, console or account is needed.

Create an empty directory, place the supplied tarballs there, and verify their
checksums before installation:

```sh
shasum -a 256 fieldfox-server-3c8f4b4.tgz fieldfox-widget-c86dd23.tgz
npm init -y
pnpm add ./fieldfox-server-3c8f4b4.tgz ./fieldfox-widget-c86dd23.tgz
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

The example provider URL and model above must be replaced. Keep the API credential
on the server. The browser site key is a public identifier constrained by origin
and budget; it is not the provider credential.

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

Serve public with your existing static server on http://localhost:5173. Open it
in Chrome, click the fox, provide a name and fill. The value is for you to review;
submission remains a separate action. The script, endpoint and allowed page
origin must match exactly. On another machine, replace localhost with URLs it
can reach. HTTPS pages require HTTPS script and endpoint URLs.

Local functional acceptance may use a deterministic loopback provider fixture
with an obvious test credential. That exercises the real public package's HTTP
provider adapter, but it does not validate a commercial model's extraction quality
or imply an authorized paid call.

## Public distribution after release

The canonical public workflow remains the exact-version CDN generator in
[Embedding](EMBEDDING.md#install). It fetches and hashes published bytes and
refuses a mismatch with the local build. Do not use a local hash for an old CDN
URL. Public distribution, a final hosted domain, and zero-config hosted availability
require a separate release and deployment; this experiment does not perform them.
