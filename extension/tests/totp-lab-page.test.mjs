import test from "node:test";
import assert from "node:assert/strict";
import { readVisibleTotpCode } from "../totp-lab-page.js";

function stableEnvironment({
  text = "",
  readyState = "complete",
  now = () => 1_000,
  sleep = async () => {},
  waitForQuiet = async () => {},
  signal,
} = {}) {
  const body = {
    get innerText() {
      return typeof text === "function" ? text() : text;
    },
  };
  return {
    document: { readyState, body },
    now,
    sleep,
    waitForQuiet,
    signal,
  };
}

test("returns the only independent visible six digit code", async () => {
  const env = stableEnvironment({ text: "Your verification code is 123456." });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: true, code: "123456" });
});

test("does not truncate five, seven, or longer digit sequences", async () => {
  const env = stableEnvironment({ text: "Short 12345, long 1234567, longer 12345678." });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: false, error: "code_not_present" });
});

test("deduplicates repeated instances of the same visible code", async () => {
  const env = stableEnvironment({ text: "123456\nConfirm with 123456" });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: true, code: "123456" });
});

test("rejects different visible candidate codes as ambiguous", async () => {
  const env = stableEnvironment({ text: "Primary 123456 backup 654321" });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: false, error: "totp_code_ambiguous" });
});

test("returns code_not_present when no independent six digit sequence is visible", async () => {
  const env = stableEnvironment({ text: "No lab code is ready yet." });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: false, error: "code_not_present" });
});

test("returns helper_page_not_stable when the page never reaches a stable complete sample", async () => {
  let clock = 0;
  let sample = 0;
  const env = stableEnvironment({
    readyState: "complete",
    text: () => `Code ${sample++ % 2 === 0 ? "123456" : "654321"}`,
    now: () => clock,
    waitForQuiet: async () => { clock += 60; },
    sleep: async () => { clock += 60; },
  });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 250, quietMs: 50, sampleGapMs: 50 }, env), { ok: false, error: "helper_page_not_stable" });
});

test("returns helper_page_not_stable when mutations never allow the quiet window to complete", async () => {
  const observers = [];
  class BusyMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {
      this.timer = setInterval(() => this.callback(), 5);
    }
    disconnect() {
      this.disconnected = true;
      clearInterval(this.timer);
    }
  }
  const env = stableEnvironment({ text: "Lab code 123456" });
  env.document.documentElement = {};
  env.MutationObserver = BusyMutationObserver;
  delete env.waitForQuiet;
  delete env.sleep;

  try {
    const result = await Promise.race([
      readVisibleTotpCode({ timeoutMs: 50, quietMs: 30, sampleGapMs: 5 }, env),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "hung" }), 250)),
    ]);
    assert.deepEqual(result, { ok: false, error: "helper_page_not_stable" });
    assert.ok(observers.every((observer) => observer.disconnected));
  } finally {
    for (const observer of observers) observer.disconnect();
  }
});

test("does not return a visible code while document readiness is still loading", async () => {
  let clock = 0;
  const env = stableEnvironment({
    text: "Lab code 123456",
    readyState: "loading",
    now: () => clock,
    waitForQuiet: async () => { clock += 50; },
    sleep: async () => { clock += 50; },
  });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 120, quietMs: 40, sampleGapMs: 20 }, env), { ok: false, error: "helper_page_not_stable" });
});

test("returns cancelled when abort and timeout happen together at the deadline", async () => {
  const controller = new AbortController();
  let clock = 0;
  const env = stableEnvironment({
    text: "Lab code 123456",
    now: () => clock,
    signal: controller.signal,
    waitForQuiet: async () => {
      clock = 100;
      controller.abort(new DOMException("Aborted", "AbortError"));
    },
  });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: false, error: "cancelled" });
});

test("returns cancelled when aborted while waiting", async () => {
  const abortError = new DOMException("Aborted", "AbortError");
  const env = stableEnvironment({
    waitForQuiet: async () => { throw abortError; },
  });
  assert.deepEqual(await readVisibleTotpCode({ timeoutMs: 100 }, env), { ok: false, error: "cancelled" });
});

test("is self-contained so it can be serialized through executeScript", async () => {
  const serialized = Function(`"use strict"; return (${readVisibleTotpCode.toString()});`)();
  const env = stableEnvironment({ text: "Lab token: 246810" });
  assert.deepEqual(await serialized({ timeoutMs: 100 }, env), { ok: true, code: "246810" });
});
