import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { detectTotpStageOnPage, submitLoginOnPage } from "../login-page.js";

const registryKey = "__whalestestWorkflowRunControllers__";
const loginSelectors = {
  loginUsername: "#username",
  loginPassword: "#password",
  loginSubmitButton: "#submit",
  loginError: ".login-error",
  totpStage: "#totp-stage",
};

test("fills exact username and password fields and clicks one configured submit", async () => {
  const username = element();
  const password = element();
  const submit = element({ text: "Sign in" });

  const result = await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: loginSelectors,
  }, environment({ one: { "#username": username, "#password": password, "#submit": submit } }));

  assert.deepEqual(result, { ok: true });
  assert.equal(username.value, "alice");
  assert.equal(password.value, "secret");
  assert.deepEqual(username.events, ["input", "change"]);
  assert.deepEqual(password.events, ["input", "change"]);
  assert.equal(submit.clicked, 1);
  assert.doesNotMatch(JSON.stringify(result), /alice|secret/);
});

test("rejects empty or non-string credentials before touching the page", async () => {
  const username = element();
  for (const credentials of [
    { username: "", password: "secret" },
    { username: "alice", password: "" },
    { username: 7, password: "secret" },
    { username: "alice", password: null },
  ]) {
    const result = await submitLoginOnPage({ ...credentials, selectors: loginSelectors }, environment({ one: { "#username": username } }));
    assert.equal(result.error, "credentials_invalid");
  }
  assert.equal(username.value, "");
});

test("detects rejected input when the page refuses exact credential values", async () => {
  const username = element();
  Object.defineProperty(username, "value", {
    get() { return this.storedValue ?? ""; },
    set(value) { this.storedValue = String(value).toUpperCase(); },
    configurable: true,
  });

  const result = await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: loginSelectors,
  }, environment({ one: { "#username": username, "#password": element(), "#submit": element() } }));

  assert.equal(result.error, "login_input_rejected");
});

test("uses a unique visible enabled submit fallback and rejects ambiguity", async () => {
  const fallback = element({ text: "Login" });
  const hidden = element({ text: "Hidden", width: 0 });
  const disabled = element({ text: "Disabled", disabled: true });

  const result = await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: { loginUsername: "#u", loginPassword: "#p", loginSubmitButton: "" },
  }, environment({
    one: { "#u": element(), "#p": element() },
    many: { "button[type='submit']": [hidden, disabled, fallback] },
  }));

  assert.deepEqual(result, { ok: true });
  assert.equal(fallback.clicked, 1);
  assert.equal(hidden.clicked, 0);
  assert.equal(disabled.clicked, 0);

  const ambiguous = await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: { loginUsername: "#u", loginPassword: "#p", loginSubmitButton: "" },
  }, environment({
    one: { "#u": element(), "#p": element() },
    many: { "button[type='submit']": [element(), element()] },
  }));
  assert.equal(ambiguous.error, "element_ambiguous");
});

test("detects login rejection before TOTP when both markers are visible", async () => {
  const result = await detectTotpStageOnPage({
    selectors: { loginError: ".error", totpStage: "#totp" },
  }, environment({ one: { ".error": element(), "#totp": element() } }));

  assert.equal(result.error, "login_rejected");
});

test("detects a unique TOTP stage and reports timeout when it never appears", async () => {
  assert.deepEqual(await detectTotpStageOnPage({
    selectors: { loginError: ".error", totpStage: "#totp" },
  }, environment({ one: { "#totp": element() } })), { ok: true });

  const missing = await detectTotpStageOnPage({
    selectors: { loginError: ".error", totpStage: "#totp" },
    timeoutMs: 1,
  }, environment());
  assert.equal(missing.error, "totp_stage_not_reached");
});

test("reports ambiguous TOTP markers and invalid configured selectors", async () => {
  const ambiguousError = await detectTotpStageOnPage({
    selectors: { loginError: ".error", totpStage: "#totp" },
  }, environment({ many: { ".error": [element(), element()] } }));
  assert.equal(ambiguousError.error, "element_ambiguous");

  const ambiguousTotp = await detectTotpStageOnPage({
    selectors: { loginError: ".error", totpStage: "#totp" },
  }, environment({ many: { "#totp": [element(), element()] } }));
  assert.equal(ambiguousTotp.error, "element_ambiguous");

  const invalidEnv = environment();
  invalidEnv.document.querySelectorAll = (selector) => {
    if (selector === "[") throw new SyntaxError("bad selector");
    return [];
  };
  invalidEnv.document.querySelector = (selector) => {
    if (selector === "[") throw new SyntaxError("bad selector");
    return null;
  };
  assert.equal((await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: { loginUsername: "[", loginPassword: "#p", loginSubmitButton: "#s" },
  }, invalidEnv)).error, "selector_not_configured");
});

test("requires and honors workflow page tokens", async () => {
  delete globalThis[registryKey];
  assert.equal((await submitLoginOnPage({
    runId: "run-1",
    requireExistingToken: true,
    username: "alice",
    password: "secret",
    selectors: loginSelectors,
  }, environment())).error, "workflow_page_context_reset");
  assert.equal((await detectTotpStageOnPage({
    runId: "run-1",
    requireExistingToken: true,
    selectors: loginSelectors,
  }, environment())).error, "workflow_page_context_reset");

  const controller = new AbortController();
  controller.abort();
  globalThis[registryKey] = new Map([["run-1", controller]]);
  assert.equal((await submitLoginOnPage({
    runId: "run-1",
    requireExistingToken: true,
    username: "alice",
    password: "secret",
    selectors: loginSelectors,
  }, environment({ one: { "#username": element(), "#password": element(), "#submit": element() } }))).error, "workflow_cancelled");
});

test("bounded quiet fails on continuous mutation and cancels during quiet wait", async () => {
  let disconnected = 0;
  class BusyMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.timer = null;
    }
    observe() {
      this.timer = setInterval(() => this.callback(), 1);
      this.timer.unref?.();
    }
    disconnect() {
      disconnected += 1;
      clearInterval(this.timer);
    }
  }
  const busyEnv = environment({ one: { "#username": element(), "#password": element(), "#submit": element() } });
  delete busyEnv.waitForQuiet;
  busyEnv.MutationObserver = BusyMutationObserver;
  const unstable = await Promise.race([
    submitLoginOnPage({
      username: "alice",
      password: "secret",
      selectors: loginSelectors,
      timeoutMs: 30,
      quietMs: 10,
    }, busyEnv),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 120)),
  ]);
  assert.equal(unstable.error, "page_not_stable");
  assert.ok(disconnected > 0);

  const controller = new AbortController();
  const cancelEnv = environment({ one: { "#totp": element() } });
  cancelEnv.signal = controller.signal;
  cancelEnv.waitForQuiet = () => new Promise(() => {});
  setTimeout(() => controller.abort(), 10).unref?.();
  const cancelled = await Promise.race([
    detectTotpStageOnPage({ selectors: { loginError: ".error", totpStage: "#totp" }, timeoutMs: 100, quietMs: 10 }, cancelEnv),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 150)),
  ]);
  assert.equal(cancelled.error, "workflow_cancelled");
});

test("page login functions survive executeScript-style serialization", async () => {
  const serialize = (fn) => Function(`return (${fn.toString()})`)();

  assert.deepEqual(await serialize(submitLoginOnPage)({
    username: "alice",
    password: "secret",
    selectors: { loginUsername: "#u", loginPassword: "#p", loginSubmitButton: "#s" },
  }, environment({ one: { "#u": element(), "#p": element(), "#s": element() } })), { ok: true });

  assert.deepEqual(await serialize(detectTotpStageOnPage)({
    selectors: { loginError: ".error", totpStage: "#totp" },
  }, environment({ one: { "#totp": element() } })), { ok: true });
});
