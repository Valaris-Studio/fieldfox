import type { Context, MiddlewareHandler } from 'hono';
import type { GuardrailConfig } from './config.js';

declare module 'hono' {
  interface ContextVariableMap {
    fieldfoxRequestSignal: AbortSignal | undefined;
    fieldfoxProviderStarted: boolean | undefined;
  }
}

class RequestBodyTooLarge extends Error {}

export function cancellationResponse(c: Context): Response | undefined {
  const signal = c.get('fieldfoxRequestSignal');
  if (!signal?.aborted) return;
  const timeout = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
  return timeout
    ? c.json({ error: 'request_timeout', message: 'the fill request exceeded its deadline' }, 504)
    : c.json({ error: 'request_cancelled', message: 'the fill request was cancelled' }, 408);
}

async function readBoundedBody(request: Request, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  // Cancelling a pending read resolves it even if no new chunk ever arrives.
  // The source's cancellation hook may be async; it must not hold our deadline.
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLarge();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body.buffer;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function requestLimits(config: GuardrailConfig): MiddlewareHandler {
  return async (c, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('client disconnected', 'AbortError'));
    const clientSignal = c.req.raw.signal;
    clientSignal.addEventListener('abort', abort, { once: true });
    if (clientSignal.aborted) abort();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('request deadline exceeded', 'TimeoutError'));
    }, config.requestTimeoutMs);
    c.set('fieldfoxRequestSignal', controller.signal);
    try {
      const bytes = await readBoundedBody(c.req.raw, config.maxBodyBytes, controller.signal);
      // Rebuild only after the bounded read. Hono owns caching from this point,
      // preserving json()/text() for guardrails and composing middleware.
      c.req.raw = new Request(c.req.raw, { body: bytes.byteLength ? bytes : null });
      await next();
    } catch (error) {
      const cancelled = cancellationResponse(c);
      if (cancelled) return cancelled;
      if (error instanceof RequestBodyTooLarge) {
        return c.json({ error: 'request_body_too_large', maxBytes: config.maxBodyBytes,
          message: `request body must be at most ${config.maxBodyBytes} bytes` }, 413);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener('abort', abort);
    }
  };
}
