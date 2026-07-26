// Mock OpenAI-compatible provider for the E2E stack (INT-fill-flow). Zero deps.
//
// THE MOCK BOUNDARY IS THE PROVIDER, NOT OUR SERVER: the widget talks to the
// real fieldfox server (guardrails → two-lane prompt → degradation ladder →
// zod re-validate → cleanPlan); only the upstream LLM is replaced. The server's
// llm.ts POSTs to `${FIELDFOX_LLM_BASE_URL}/chat/completions`, so this answers
// any path ending in /chat/completions.
//
// Fills are DERIVED, not hardcoded by field id: the server embeds the
// introspected FormSchema in the user prompt as "- id: ff-N / kind / name /
// labelCandidates / options" blocks (packages/server/src/prompt.ts). The mock
// parses those blocks back out and plans canned values per field kind — so the
// same mock serves both example hosts and keeps working if fields reorder.
//
// Inspection surface for the specs:
//   GET /__mock/requests → { requests: [{ at, model, responseFormat, prompt }] }
// (e.g. to prove the data-ff-ignore'd promo field never reached the provider,
// and that the FORCE_ERROR flow really walked the ladder's three calls).

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CANNED, FORCE_ERROR, SKIP_AND_OMIT } from './canned.mjs';

const MAX_RECORDED = 200;

/** @returns {Promise<import('node:http').Server>} */
export function startMockProvider(port) {
  // Artificial response latency so the specs can observe the in-flight state
  // (fields disabled + shimmer) before the plan lands. Read here, not at module
  // scope: e2e-env.mjs sets the env AFTER its (hoisted) import of this module.
  const DELAY_MS = Number(process.env.FIELDFOX_MOCK_DELAY_MS ?? 600);
  const requests = [];

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && pathname === '/__mock/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ requests }));
    }

    if (req.method === 'POST' && pathname.endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
        }

        const prompt = promptTextOf(body.messages ?? []);
        const responseFormat = body.response_format?.type ?? 'none';
        requests.push({ at: new Date().toISOString(), model: body.model, responseFormat, prompt });
        if (requests.length > MAX_RECORDED) requests.shift();

        const respond = (status, payload) =>
          setTimeout(() => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          }, DELAY_MS);

        if (prompt.includes(FORCE_ERROR)) {
          // Rung 1: pretend strict json_schema is unsupported (HTTP 400 →
          // ResponseFormatUnsupported → the server drops to rung 2)…
          if (responseFormat === 'json_schema') {
            return respond(400, { error: { message: 'response_format json_schema is not supported' } });
          }
          // …then feed rung 2 malformed content on BOTH the initial call and the
          // repair retry, exhausting the ladder → the server answers 502.
          return respond(200, envelope(body.model, 'Sure! Here is your plan: {fills: ['));
        }

        const fields = parseFields(prompt);
        const fills = prompt.includes(SKIP_AND_OMIT) ? skipAndOmitFills(fields) : cannedFills(fields);
        return respond(200, envelope(body.model, JSON.stringify({ fills })));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no mock route for ${req.method} ${pathname}` } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      console.log(`[mock-llm] OpenAI-compatible mock on http://127.0.0.1:${port} (delay ${DELAY_MS}ms)`);
      resolve(server);
    });
  });
}

// A minimal chat-completion envelope: the server only reads
// choices[0].message.content, but usage rides along like a real provider's.
function envelope(model, content) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'fieldfox-e2e-mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 250, completion_tokens: 90, total_tokens: 340 },
  };
}

// Message content is a plain string on text-only turns and a content-part array
// on multimodal / repair turns — flatten both to one searchable string.
function promptTextOf(messages) {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
    )
    .join('\n');
}

// Parses the "FORM FIELDS" section the server's prompt builder emits: blocks of
//   - id: ff-0
//     kind: text
//     labelCandidates: ["Full name"]
//     name: full-name
//     options: [{"value":"m","label":"Medium"}]
function parseFields(prompt) {
  const start = prompt.indexOf('FORM FIELDS');
  const end = prompt.indexOf('===== SITE-AUTHOR');
  if (start < 0) return [];
  const section = prompt.slice(start, end > start ? end : undefined);

  return section
    .split(/^- id: /m)
    .slice(1)
    .map((block) => {
      const line = (key) => block.match(new RegExp(`^\\s*${key}: (.*)$`, 'm'))?.[1];
      const json = (key, fallback) => {
        try {
          const raw = line(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch {
          return fallback;
        }
      };
      return {
        id: block.split('\n', 1)[0].trim(),
        kind: line('kind') ?? 'other',
        fillable: line('fillable') === 'true',
        name: line('name'),
        autocomplete: line('autocomplete'),
        labelCandidates: json('labelCandidates', []),
        options: json('options', []),
      };
    });
}

function set(fieldId, value) {
  return { fieldId, action: 'set', value };
}
function skip(fieldId) {
  return { fieldId, action: 'skip', value: null };
}

function cannedFills(fields) {
  const fills = [];
  for (const f of fields) {
    if (!f.fillable) continue;
    const labels = f.labelCandidates.join(' ');
    const firstOption = f.options.find((o) => o.value)?.value;
    switch (f.kind) {
      case 'email':
        fills.push(set(f.id, CANNED.email));
        break;
      case 'tel':
        fills.push(set(f.id, CANNED.tel));
        break;
      case 'date':
        // US-formatted on purpose: the server must normalize it to CANNED.date
        // before the widget writes it (see canned.mjs).
        fills.push(set(f.id, CANNED.dateAsModelEmitted));
        break;
      case 'number':
        fills.push(set(f.id, CANNED.number));
        break;
      case 'textarea':
        fills.push(set(f.id, CANNED.textarea));
        break;
      case 'select': {
        const value = CANNED.selectByName[f.name] ?? firstOption;
        fills.push(value ? set(f.id, value) : skip(f.id));
        break;
      }
      case 'radio': {
        const value = CANNED.radioByName[f.name] ?? firstOption;
        fills.push(value ? set(f.id, value) : skip(f.id));
        break;
      }
      case 'checkbox':
        fills.push(CANNED.checkboxOnLabels.test(labels) ? set(f.id, 'true') : skip(f.id));
        break;
      // v4 driver kinds. A combobox arrives with no options (no introspection
      // open-probe), so the plan carries a display NAME the driver resolves
      // against the live listbox — including the unmatchable value that must
      // leave its field.
      case 'combobox': {
        const value = CANNED.comboboxByLabel[f.name] ?? CANNED.comboboxUnmatchable;
        fills.push(set(f.id, value));
        break;
      }
      case 'switch':
        fills.push(CANNED.switchOnLabels.test(labels) ? set(f.id, 'true') : skip(f.id));
        break;
      case 'text':
        fills.push(
          f.autocomplete === 'name' || /name/i.test(labels) ? set(f.id, CANNED.fullName) : skip(f.id),
        );
        break;
      default:
        fills.push(skip(f.id));
    }
  }
  return fills;
}

// Leave-semantics plan: set two fields, explicitly skip textareas, omit the rest
// entirely (omission = leave, PLAN §0 fill-or-leave).
function skipAndOmitFills(fields) {
  const fills = [];
  for (const f of fields) {
    if (!f.fillable) continue;
    if (f.kind === 'email') fills.push(set(f.id, CANNED.email));
    else if (f.kind === 'text' && f.autocomplete === 'name') fills.push(set(f.id, CANNED.fullName));
    else if (f.kind === 'textarea') fills.push(skip(f.id));
  }
  return fills;
}

// Standalone mode for manual poking: node e2e/mock-provider.mjs [port]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMockProvider(Number(process.argv[2] ?? 8793));
}
