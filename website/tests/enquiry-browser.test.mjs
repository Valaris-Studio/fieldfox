import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnquiryServer } from "../server/enquiries.mjs";

const enabled = process.env.FIELDFOX_BROWSER_TESTS === "1";
const site = process.env.FIELDFOX_TEST_URL || "http://127.0.0.1:4188";
async function complete(page) {
  const modal = page.getByRole("dialog");
  await modal
    .getByLabel("What would you like to use FieldFox for?")
    .fill("A fictional test intake form.");
  await modal.getByRole("button", { name: "Continue", exact: true }).click();
  await modal.getByLabel("Your name", { exact: true }).fill("Test Visitor");
  await modal
    .getByLabel("Email address", { exact: true })
    .fill("visitor@example.com");
  await modal.getByRole("button", { name: "Continue", exact: true }).click();
  return modal;
}

test(
  "enquiry validates, edits, retries, deduplicates and confirms durable test receipt",
  { skip: !enabled, timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "fieldfox-enquiry-browser-"),
    );
    const server = createEnquiryServer({ mode: "local-test", directory });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const attempts = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/enquiries", async (route) => {
      const request = route.request();
      attempts.push(request.headers()["idempotency-key"]);
      if (attempts.length === 1)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"delivery_unconfirmed"}',
        });
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/enquiries`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempts.at(-1),
            Origin: site,
          },
          body: request.postData(),
        },
      );
      const body = await response.text();
      await gate;
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body,
      });
    });
    await page.goto(site, { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", {
      name: "I want to add it to my projects",
    });
    await trigger.click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(
      await modal.getByRole("heading").innerText(),
      "What could we make easier?",
    );
    await complete(page);
    assert.equal(attempts.length, 0);
    await modal.getByRole("button", { name: "Edit project" }).click();
    await modal
      .getByLabel("What would you like to use FieldFox for?")
      .fill("Edited fictional test intake form.");
    await modal.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(
      await modal.getByLabel("Email address", { exact: true }).inputValue(),
      "visitor@example.com",
    );
    await modal.getByLabel("Email address", { exact: true }).fill("invalid");
    await modal.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(
      await modal.getByRole("heading").innerText(),
      "Who shall we talk to?",
    );
    await modal
      .getByLabel("Email address", { exact: true })
      .fill("visitor@example.com");
    await modal.getByRole("button", { name: "Continue", exact: true }).click();
    await modal.getByRole("button", { name: "Send my enquiry" }).click();
    await modal.getByRole("alert").waitFor();
    await modal.getByRole("button", { name: "Retry enquiry" }).click();
    const submitting = modal.getByRole("button", {
      name: "Sending your enquiry",
    });
    await submitting.waitFor();
    assert.equal(await submitting.isDisabled(), true);
    await page.keyboard.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    release();
    await modal.getByRole("heading", { name: "A good test run." }).waitFor();
    assert.equal((await readdir(directory)).length, 1);
    assert.match(await modal.innerText(), /No message was sent to a person/);
    await page.screenshot({ path: "/tmp/fieldfox-enquiry-success.png" });
    await page.keyboard.press("Escape");
    assert.equal(await modal.isVisible(), false);
    assert.equal(
      await trigger.evaluate((element) => element === document.activeElement),
      true,
    );
    await trigger.click();
    assert.equal(
      await modal
        .getByRole("heading", { name: "A good test run." })
        .isVisible(),
      true,
    );
    assert.equal(attempts.length, 2);
  },
);

test(
  "mobile keyboard dialog contains focus and unconfigured delivery stays honest",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    await page.route("**/api/enquiries", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"not_configured"}',
      }),
    );
    await page.goto(site, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Let’s talk" }).click();
    const modal = page.getByRole("dialog");
    assert.ok((await modal.boundingBox()).width <= 390);
    for (let index = 0; index < 9; index++) {
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => !!document.activeElement?.closest("dialog")),
        true,
      );
    }
    await complete(page);
    await modal.getByRole("button", { name: "Send my enquiry" }).click();
    await modal.getByRole("alert").waitFor();
    assert.match(
      await modal.getByRole("alert").innerText(),
      /Your details have not been sent/,
    );
    assert.equal(
      await modal.getByRole("heading", { name: "Hello, possibility." }).count(),
      0,
    );
    await page.screenshot({ path: "/tmp/fieldfox-enquiry-mobile-failure.png" });
  },
);
