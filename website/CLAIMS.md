# Website claim sources

Copy reference for the product website, checked against public source commit `d80c595904f77d64ad89e2ad9be456201b4fe76a`. This file maps claims to product evidence; project decisions and status remain in Backplane.

The website follows Sebastian’s explicit September 18 direction: enquiries and MIT self-host adoption. Older hosted-first prose in the product documentation and recovered creative kit is not used as evidence of an available service or a promised launch. The website makes no Cloud signup, hosted free-fill, paid-plan, or future Cloud commitment.

| Website claim | Evidence | Scope |
| --- | --- | --- |
| Source information can become reviewable form values. | [Request construction](../packages/widget/src/element.ts), [provider prompt](../packages/server/src/prompt.ts) | Text and images; PDF and text attachments require `accept-documents`. Image/PDF extraction depends on provider/model capabilities. |
| Works beside an existing supported form. | [Custom element](../packages/widget/src/element.ts), [introspection](../packages/widget/src/introspect.ts), [drivers](../packages/widget/src/drivers.ts) | Supported controls only. No universal form/framework compatibility claim. |
| Server validates the model’s proposed fill plan. | [Model response parsing](../packages/server/src/llm.ts), [plan cleaning](../packages/server/src/fill.ts), [wire schema](../packages/shared/src/contract.ts) | Structural validation does not verify real-world facts. |
| Supported writes are applied and read back. | [Fill executor](../packages/widget/src/fill.ts) | Readback checks the write, not extraction accuracy. Failed confirmation triggers a restore attempt; cancellation can leave earlier confirmed writes applied. |
| Users review in their existing form; FieldFox never submits it. | [Fill executor](../packages/widget/src/fill.ts), [result event](../packages/widget/src/result.ts), [product example](../examples/plain-html/products.html) | Values are applied before human review. The host application retains validation and final submission. |
| Source, schema and included field context go to the configured server/provider. | [Widget request](../packages/widget/src/client.ts), [provider request](../packages/server/src/llm.ts), [prompt](../packages/server/src/prompt.ts) | Self-hosting does not imply browser-local processing or a local model. |
| Provider credentials belong on the server; the site key is public. | [Provider authorization](../packages/server/src/llm.ts), [widget request headers](../packages/widget/src/client.ts) | No authentication, privacy certification or absolute security promise. |
| `data-ff-ignore` excludes a field/subtree. | [Introspection](../packages/widget/src/introspect.ts), [embedding reference](../docs/EMBEDDING.md) | Integrators must deliberately select exclusions and inspect their outgoing context. |
| MIT self-hosting with a compatible provider. | [License](../LICENSE), [self-host setup](../docs/SELF-HOSTING.md), [server package](../packages/server/README.md) | Model and infrastructure costs remain. Configuration and integration evaluation are required. |
| Exact small embed attributes. | [Attribute handling](../packages/widget/src/element.ts), [embedding reference](../docs/EMBEDDING.md) | Explicit `endpoint` is required for this adoption example. Widget must be loaded first; target/server/site key are deployment-specific. |

The website’s Arc desk lamp and its field values are invented illustration data. They demonstrate intended review and unknown-value handling, not a measured model run. A missing fact should remain unknown; this is not a guarantee that a model will always omit it.

Public links target the repository, current embedding/self-hosting/coverage guides, source modules, MIT license and security policy. Historical Cloud/roadmap pages are deliberately absent. The snippet does not recommend a particular published package version or CDN artifact; release selection belongs to the installation documentation and must be checked at adoption time.

Excluded claims: accuracy percentages, universal compatibility, named customers, fabricated integrations, compliance badges, zero hallucinations, automatic detection of all sensitive information, guaranteed rollback, local-only processing, free infrastructure/model usage, a current or future Cloud offering.
