import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnquiryService,
  createEnquiryServer,
} from "../server/enquiries.mjs";

const details = {
  intent: "project",
  useCase: "A test intake form",
  name: "Test Visitor",
  email: "visitor@example.com",
};
const key = "cf233f79-83ae-4a79-b7cf-30cbb6cc3bcd";
const temporaryStore = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fieldfox-enquiry-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("unconfigured delivery does not claim acceptance", async () => {
  const service = createEnquiryService();
  await assert.rejects(service.submit(details, key), {
    status: 503,
    code: "not_configured",
  });
});

test("validation rejects malformed and oversized inputs before transport", async () => {
  let called = false;
  const service = createEnquiryService({
    mode: "webhook",
    webhookUrl: "https://example.com/enquiry",
    fetch: async () => {
      called = true;
    },
  });
  for (const payload of [
    { ...details, email: "nope" },
    { ...details, useCase: "x".repeat(2001) },
    { ...details, name: "" },
    { ...details, intent: "cloud" },
  ]) {
    await assert.rejects(service.submit(payload, key), { status: 400 });
  }
  await assert.rejects(service.submit(details, "../outside"), { status: 400 });
  assert.equal(called, false);
});

test("local test acceptance follows durable persistence and survives restart", async (t) => {
  const directory = await temporaryStore(t);
  const first = await createEnquiryService({
    mode: "local-test",
    directory,
  }).submit(details, key);
  assert.equal(first.status, "accepted");
  assert.equal(first.testMode, true);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const stored = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
  assert.equal(stored.details.email, details.email);
  const retried = await createEnquiryService({
    mode: "local-test",
    directory,
  }).submit(details, key);
  assert.deepEqual(retried, first);
});

test("simultaneous duplicate requests persist exactly one receipt", async (t) => {
  const directory = await temporaryStore(t);
  const service = createEnquiryService({ mode: "local-test", directory });
  const receipts = await Promise.all(
    Array.from({ length: 10 }, () => service.submit(details, key)),
  );
  assert.ok(receipts.every((receipt) => receipt.id === receipts[0].id));
  assert.equal((await readdir(directory)).length, 1);
  await assert.rejects(service.submit({ ...details, name: "Different" }, key), {
    status: 409,
  });
});

test("storage failure never returns acceptance", async () => {
  const service = createEnquiryService({
    mode: "local-test",
    directory: "/dev/null/no-directory",
  });
  await assert.rejects(service.submit(details, key), { status: 503 });
});

test("webhook requires confirmed receipt and retains idempotency on retry", async () => {
  const keys = [];
  let attempt = 0;
  const service = createEnquiryService({
    mode: "webhook",
    webhookUrl: "https://example.com/enquiry",
    fetch: async (_url, options) => {
      keys.push(options.headers["Idempotency-Key"]);
      attempt++;
      return attempt === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ id: "receipt-test", status: "accepted" });
    },
  });
  await assert.rejects(service.submit(details, key), { status: 503 });
  assert.deepEqual(await service.submit(details, key), {
    id: "receipt-test",
    status: "accepted",
  });
  assert.deepEqual(keys, [key, key]);
  const lyingTransport = createEnquiryService({
    mode: "webhook",
    webhookUrl: "https://example.com/enquiry",
    fetch: async () => Response.json({ ok: true }),
  });
  await assert.rejects(lyingTransport.submit(details, key), { status: 503 });
});

test("HTTP enforces origin, content type, body cap and rejects malformed JSON", async (t) => {
  const server = createEnquiryServer({ publicOrigin: "http://127.0.0.1:4188" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/enquiries`;
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...headers,
      },
    });
  assert.equal(
    (await post(JSON.stringify(details), { Origin: "https://other.example" }))
      .status,
    403,
  );
  assert.equal(
    (await post(JSON.stringify(details), { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("x".repeat(9000))).status, 413);
  assert.equal((await post(JSON.stringify(details))).status, 503);
});
