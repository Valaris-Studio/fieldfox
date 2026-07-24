// Shared pilot harness: injects the fieldfox IIFE into a live third-party page
// (never touching the host app's source) and runs one real fill, capturing
// before/after field state, screenshots, console errors, and failed requests.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WIDGET_IIFE = resolve(HERE, '../../packages/widget/dist/fieldfox.js');
export const SITE_KEY = 'ffx_pk_dev0000000000000000000000000000';

export async function launchPage() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.request().method()} ${res.url()} -> HTTP ${res.status()}`);
  });
  return { browser, page, consoleErrors, failedRequests };
}

// Snapshot every form control inside the target container (id/name/type/value/
// checked/disabled/label guess) so filled-vs-left can be diffed after the fill.
export async function snapshotFields(page, targetSelector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { error: `target ${sel} not found` };
    const controls = [...root.querySelectorAll('input, textarea, select')];
    return controls.map((el, i) => {
      let label = '';
      if (el.id) label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() ?? '';
      if (!label) label = el.closest('label')?.textContent?.trim() ?? '';
      if (!label) label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '';
      return {
        idx: i,
        tag: el.tagName.toLowerCase(),
        type: el.type ?? '',
        id: el.id || null,
        name: el.name || null,
        label: label.slice(0, 80),
        value: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value).slice(0, 120),
        disabled: el.disabled,
        hidden: el.hidden || getComputedStyle(el).display === 'none',
      };
    });
  }, targetSelector);
}

// The INJECTION: addScriptTag(IIFE) + create <field-fox> as a body sibling.
// This is the exact snippet a site owner would paste, minus the CDN URL.
export async function injectFieldfox(page, { targetSelector, endpoint }) {
  await page.addScriptTag({ path: WIDGET_IIFE });
  await page.evaluate(
    ({ targetSelector, endpoint, siteKey }) => {
      const ff = document.createElement('field-fox');
      ff.setAttribute('target', targetSelector);
      ff.setAttribute('endpoint', endpoint);
      ff.setAttribute('site-key', siteKey);
      document.body.appendChild(ff);
    },
    { targetSelector, endpoint, siteKey: SITE_KEY },
  );
  const shadowInfo = await page.evaluate(() => {
    const ff = document.querySelector('field-fox');
    return {
      hasShadowRoot: !!ff?.shadowRoot,
      hasTrigger: !!ff?.shadowRoot?.querySelector('[part="trigger"]'),
    };
  });
  if (!shadowInfo.hasShadowRoot || !shadowInfo.hasTrigger) {
    throw new Error(`fieldfox mount failed: ${JSON.stringify(shadowInfo)}`);
  }
  return shadowInfo;
}

export async function triggerBox(page) {
  return page.locator('field-fox [part="trigger"]').boundingBox();
}

// Real-user interaction first; on failure (host focus traps / pointer-events
// lockout, e.g. Radix modals) fall back to programmatic shadow-DOM dispatch.
// Every fallback taken is recorded — those ARE pilot findings.
async function clickPart(page, part, interactionLog) {
  try {
    await page.locator(`field-fox [part="${part}"]`).click({ timeout: 4_000 });
    interactionLog.push(`${part}: real pointer click OK`);
  } catch (err) {
    interactionLog.push(`${part}: real click FAILED (${String(err).split('\n')[0]}); used programmatic el.click()`);
    await page.evaluate((p) => {
      document.querySelector('field-fox').shadowRoot.querySelector(`[part="${p}"]`).click();
    }, part);
  }
}

// Open panel, type context, click Fill form, wait for a terminal status.
export async function runFill(page, contextText, { timeoutMs = 45_000 } = {}) {
  const interactionLog = [];
  await clickPart(page, 'trigger', interactionLog);
  const panel = page.locator('field-fox [part="panel"]');
  await panel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    interactionLog.push('panel: did not become visible within 5s after trigger click');
  });
  try {
    await page.locator('field-fox [part="context-input"]').fill(contextText, { timeout: 4_000 });
    interactionLog.push('context-input: real keyboard fill OK');
  } catch (err) {
    interactionLog.push(`context-input: real fill FAILED (${String(err).split('\n')[0]}); used native setter + input event`);
    await page.evaluate((text) => {
      const ta = document.querySelector('field-fox').shadowRoot.querySelector('[part="context-input"]');
      const proto = Object.getPrototypeOf(ta);
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, contextText);
  }
  await clickPart(page, 'fill-button', interactionLog);
  const status = page.locator('field-fox .ff-status');
  const start = Date.now();
  let statusText = '';
  while (Date.now() - start < timeoutMs) {
    statusText = (await status.textContent().catch(() => '')) ?? '';
    // Terminal states: success review prompt ("Filled N, left M"), or any
    // error/refusal surface.
    if (/review|filled|error|failed|update required|refus|could not|unable/i.test(statusText)) break;
    await page.waitForTimeout(500);
  }
  return { statusText: statusText.trim(), interactionLog };
}

// Host-vs-widget clash probes: is the trigger visible, clickable, on-screen?
export async function probeTrigger(page) {
  return page.evaluate(() => {
    const ff = document.querySelector('field-fox');
    const trigger = ff?.shadowRoot?.querySelector('[part="trigger"]');
    if (!trigger) return { present: false };
    const rect = trigger.getBoundingClientRect();
    const style = getComputedStyle(trigger);
    return {
      present: true,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      onScreen: rect.width > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      hostAriaHidden: ff.getAttribute('aria-hidden'),
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    };
  });
}

// Pair by identity, not index — host apps mount controls mid-run (e.g. tiptap's
// hidden file inputs appeared between snapshots and shifted indices).
const fieldKey = (f) => f.id ?? f.name ?? `${f.tag}:${f.type}:${f.label}`;

export function diffFields(before, after) {
  const rows = [];
  for (const b of before) {
    const a = after.find((x) => fieldKey(x) === fieldKey(b));
    if (!a) {
      rows.push({ ...b, before: b.value, changed: false, note: 'gone after fill' });
      continue;
    }
    rows.push({ ...a, before: b.value, changed: a.value !== b.value });
  }
  for (const a of after) {
    if (!before.some((b) => fieldKey(b) === fieldKey(a))) {
      rows.push({ ...a, before: null, changed: false, note: 'appeared after fill' });
    }
  }
  return rows;
}

export async function screenshot(page, name) {
  mkdirSync(HERE, { recursive: true });
  const path = resolve(HERE, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
