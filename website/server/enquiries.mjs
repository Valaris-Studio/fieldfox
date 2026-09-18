import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_BODY_BYTES = 8192;
const KEY_PATTERN = /^[a-zA-Z0-9-]{16,80}$/;
class EnquiryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const unavailable = () =>
  new EnquiryError(
    503,
    "delivery_unconfirmed",
    "Delivery could not be confirmed. Please retry with the same enquiry.",
  );

function validateDetails(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new EnquiryError(
      400,
      "invalid_details",
      "Check your enquiry details.",
    );
  const details = Object.fromEntries(
    ["intent", "useCase", "name", "email"].map((field) => [
      field,
      typeof input[field] === "string" ? input[field].trim() : "",
    ]),
  );
  if (
    !["project", "start"].includes(details.intent) ||
    details.useCase.length < 3 ||
    details.useCase.length > 2000 ||
    !details.name ||
    details.name.length > 120 ||
    details.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)
  ) {
    throw new EnquiryError(
      400,
      "invalid_details",
      "Check your name, email and project description.",
    );
  }
  return details;
}

export function createEnquiryService({
  mode = "unconfigured",
  directory,
  webhookUrl,
  webhookToken,
  fetch: transportFetch = globalThis.fetch,
} = {}) {
  const inFlight = new Map();
  async function deliver(details, key, fingerprint) {
    if (mode === "local-test" && directory) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${key}.json`);
      try {
        const previous = JSON.parse(await readFile(path, "utf8"));
        if (previous.fingerprint !== fingerprint)
          throw new EnquiryError(
            409,
            "key_reused",
            "This receipt belongs to different details. Start a new enquiry.",
          );
        return previous.receipt;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const receipt = { id: randomUUID(), status: "accepted", testMode: true };
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            receipt,
            fingerprint,
            details,
            receivedAt: new Date().toISOString(),
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      return receipt;
    }
    if (mode === "webhook" && webhookUrl) {
      if (new URL(webhookUrl).protocol !== "https:") throw unavailable();
      const response = await transportFetch(webhookUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
        },
        body: JSON.stringify({ ...details, idempotencyKey: key }),
      });
      if (!response.ok) throw unavailable();
      const receipt = await response.json();
      if (
        receipt.status !== "accepted" ||
        typeof receipt.id !== "string" ||
        !receipt.id.trim() ||
        receipt.id.length > 200
      )
        throw unavailable();
      return { id: receipt.id, status: "accepted" };
    }
    throw new EnquiryError(
      503,
      "not_configured",
      "Enquiry delivery is not connected yet. Your details have not been sent.",
    );
  }
  return {
    async submit(input, key) {
      const details = validateDetails(input);
      if (typeof key !== "string" || !KEY_PATTERN.test(key))
        throw new EnquiryError(
          400,
          "invalid_key",
          "A valid enquiry identifier is required.",
        );
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(details))
        .digest("hex");
      const existing = inFlight.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new EnquiryError(
            409,
            "key_reused",
            "This receipt belongs to different details. Start a new enquiry.",
          );
        return existing.promise;
      }
      const promise = deliver(details, key, fingerprint)
        .catch((error) => {
          if (error instanceof EnquiryError) throw error;
          throw unavailable();
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, { fingerprint, promise });
      return promise;
    },
  };
}

export function createEnquiryServer({
  publicOrigin = "http://127.0.0.1:4188",
  ...options
} = {}) {
  const service = createEnquiryService(options);
  return createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(data));
    };
    if (request.url !== "/api/enquiries")
      return reply(404, { error: "not_found" });
    if (request.method !== "POST")
      return reply(405, { error: "method_not_allowed" });
    if (request.headers.origin && request.headers.origin !== publicOrigin)
      return reply(403, { error: "origin_not_allowed" });
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return reply(415, { error: "json_required" });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reply(413, { error: "too_large" });
          return;
        }
        chunks.push(chunk);
      }
      let details;
      try {
        details = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { error: "invalid_json" });
      }
      const receipt = await service.submit(
        details,
        request.headers["idempotency-key"],
      );
      reply(200, receipt);
    } catch (error) {
      reply(error.status || 503, {
        error: error.code || "delivery_unconfirmed",
        message: error.status
          ? error.message
          : "Delivery could not be confirmed.",
      });
    }
  });
}
