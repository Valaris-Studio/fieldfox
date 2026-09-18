import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const enabled = process.env.FIELDFOX_BROWSER_TESTS === "1";
const site = process.env.FIELDFOX_TEST_URL || "http://127.0.0.1:4188";
const webgl = [
  "--enable-webgl",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
];

test(
  "mobile fallback fits; stage buttons stay visible; sample stays editable without network",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST") posts++;
    });
    await page.goto(`${site}/?webgl=off`);
    await page.locator(".field-lab-fallback img").waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "03 Review it" }).click();
    const scene = await page.locator(".scene-frame").boundingBox();
    assert.ok(scene.y + scene.height > 0 && scene.y < 844);
    assert.equal(
      await page.locator(".field-lab").getAttribute("data-stage"),
      "2",
    );
    await page.getByRole("button", { name: "Place the sample values" }).click();
    assert.equal(
      await page.getByLabel("Product name", { exact: true }).inputValue(),
      "Arc desk lamp",
    );
    assert.equal(
      await page.getByLabel("Weight not in the source").inputValue(),
      "",
    );
    await page
      .getByLabel("Product name", { exact: true })
      .fill("My corrected lamp");
    assert.equal(
      await page.getByLabel("Product name", { exact: true }).inputValue(),
      "My corrected lamp",
    );
    assert.equal(posts, 0);
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "Reset the example" }).click();
    assert.equal(
      await page.getByLabel("Product name", { exact: true }).inputValue(),
      "",
    );
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/mobile-fallback.png",
      fullPage: true,
    });
  },
);

test(
  "desktop WebGL story changes, still mode works, and context loss falls back",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch({ args: webgl });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(site);
    await page.locator(".field-lab canvas").waitFor();
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/desktop-hero.png" });
    await page.getByRole("button", { name: "02 Shape it" }).click();
    assert.equal(
      await page.locator(".field-lab").getAttribute("data-stage"),
      "1",
    );
    await page.getByRole("button", { name: "Still mode" }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "Motion off" })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.screenshot({ path: "test-results/desktop-exploded.png" });
    await page
      .locator(".field-lab canvas")
      .evaluate((canvas) =>
        canvas
          .getContext("webgl2")
          .getExtension("WEBGL_lose_context")
          .loseContext(),
      );
    await page.locator(".field-lab-fallback").waitFor();
    assert.equal(await page.locator(".field-lab canvas").count(), 0);
    assert.deepEqual(errors, []);
  },
);

test(
  "responsive composition fits small phone, tablet and desktop",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const width of [320, 768, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      await page.goto(`${site}/?webgl=off`);
      await page.locator(".field-lab-fallback img").waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        `overflow at ${width}`,
      );
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollBehavior,
        ),
        "auto",
      );
      await page.close();
    }
  },
);
