import test from "node:test";
import assert from "node:assert/strict";
import { fillTotpOnPage } from "../totp-page.js";

function fakeInput(events) {
  return {
    value: "",
    disabled: false,
    dispatchEvent(event) { events.push(event.type); },
    getAttribute(name) { return name === "aria-disabled" ? "false" : null; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 140, height: 32 }; },
  };
}

function fakeButton(onSubmit) {
  return {
    disabled: false,
    form: { requestSubmit: onSubmit },
    getAttribute(name) { return name === "aria-disabled" ? "false" : null; },
    getBoundingClientRect() { return { x: 0, y: 40, width: 100, height: 32 }; },
  };
}

function stableEnvironment({ input, button, now = () => 1_000 }) {
  const elements = new Map([
    ['input[autocomplete="one-time-code"][name="code"][maxlength="6"]', input],
    ['button[type="submit"][name="intent"][value="verify"]', button],
  ]);
  return {
    document: {
      readyState: "complete",
      querySelector(selector) { return elements.get(selector) ?? null; },
      defaultView: { getComputedStyle() { return { display: "block", visibility: "visible" }; } },
    },
    waitForQuiet: async () => {},
    sleep: async () => {},
    now,
    Event: class Event { constructor(type) { this.type = type; } },
  };
}

test("waits for stable one-time-code controls, fills events, and submits once", async () => {
  const events = [];
  let submitted = 0;
  const input = fakeInput(events);
  const button = fakeButton(() => { submitted += 1; });
  const result = await fillTotpOnPage({ code: "123456", timeoutMs: 100 }, stableEnvironment({ input, button }));
  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, "123456");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(submitted, 1);
});

test("rejects invalid codes and disabled submit controls", async () => {
  const input = fakeInput([]);
  const button = fakeButton(() => {});
  button.disabled = true;
  const env = stableEnvironment({ input, button });
  assert.deepEqual(await fillTotpOnPage({ code: "12345", timeoutMs: 100 }, env), { ok: false, error: "otp_code_invalid" });
  assert.deepEqual(await fillTotpOnPage({ code: "123456", timeoutMs: 100 }, env), { ok: false, error: "otp_submit_disabled" });
});

test("returns page_not_stable when required controls never become actionable", async () => {
  const input = fakeInput([]);
  const button = fakeButton(() => {});
  const env = stableEnvironment({ input, button });
  env.document.readyState = "loading";
  let clock = 0;
  env.now = () => clock;
  env.sleep = async () => { clock += 100; };
  env.waitForQuiet = async () => { clock += 100; };
  assert.deepEqual(await fillTotpOnPage({ code: "123456", timeoutMs: 250 }, env), { ok: false, error: "page_not_stable" });
});
