import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBatchController, createExtensionRuntime } from "../background.js";

function makeChrome(options = {}) {
  const updates = [];
  const processed = [];
  const api = {
    updates,
    processed,
    runtime: {
      id: "ext",
      onMessage: { addListener(listener) { api.messageListener = listener; } },
      connectNative() {
        const port = {
          onMessage: { addListener(listener) { port.listener = listener; } },
          onDisconnect: { addListener(listener) { port.disconnectListener = listener; } },
          postMessage(message) {
            const respond = (payload) => queueMicrotask(() => port.listener?.(payload));
            if (message.command === "preflight") respond({ request_id: message.request_id, ok: true });
            else if (message.command === "get_totp") respond({ request_id: message.request_id, ok: true, code: "123456", expires_at: "2026-07-18T00:00:30Z" });
            else if (message.command === "prepare_batch") respond({ request_id: message.request_id, ok: true, batch_id: "b1", tasks: [
              { source_row: 2, url: "https://example.test/one", sequence: 1, validation_error: null },
              { source_row: 3, url: "https://example.test/two", sequence: 2, validation_error: null },
            ] });
            else if (message.command === "process_result") {
              api.processed.push({ sequence: message.sequence, download_path: message.download_path ?? null });
              if (options.fatalSequence === message.sequence) {
                respond({ request_id: message.request_id, ok: false, fatal: true, error: "history_append_failed" });
              } else {
                respond({ request_id: message.request_id, ok: true, status: message.download_path ? "success" : "failure" });
              }
            }
          },
        };
        return port;
      },
    },
    tabs: {
      async create() { return { id: 7 }; },
      async update(_id, details) { updates.push(details.url); },
    },
    scripting: {
      async executeScript(details) {
        api.executions ??= [];
        api.executions.push(details);
        return [{ result: { ok: true } }];
      },
    },
    downloads: {
      onCreated: { addListener(listener) { api.createdListener = listener; } },
      onChanged: { addListener(listener) { api.changedListener = listener; } },
      onDeterminingFilename: { addListener(listener) { api.determiningListener = listener; } },
      async download(details) { api.fallbackDownload = details; return 99; },
      async search() { return [{ id: 1, url: "https://example.test/one", filename: "C:/Downloads/one.zip", state: "complete" }]; },
    },
    storage: { local: { async set() {}, async get() { return {}; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  };
  return api;
}

async function waitFor(predicate, timeout = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("test_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("downloads tasks in Excel order and processes each completed file", async () => {
  const chrome = makeChrome();
  const controller = createBatchController(chrome, { timeoutMs: 100 });
  const run = controller.start();
  await waitFor(() => chrome.updates.length === 1);
  chrome.createdListener({ id: 1, url: "https://example.test/one", state: "in_progress" });
  chrome.changedListener({ id: 1, state: { current: "complete" } });
  await waitFor(() => chrome.updates.length === 2);
  chrome.createdListener({ id: 2, url: "https://example.test/two", state: "in_progress" });
  chrome.changedListener({ id: 2, state: { current: "complete" } });
  await run;
  assert.deepEqual(chrome.updates, ["https://example.test/one", "https://example.test/two"]);
  assert.deepEqual(chrome.processed.map((item) => item.sequence), [1, 2]);
});

test("times out a task and records a failure before continuing", async () => {
  const chrome = makeChrome();
  const controller = createBatchController(chrome, { timeoutMs: 15 });
  const run = controller.start();
  await waitFor(() => chrome.updates.length === 2, 300);
  await run;
  assert.equal(chrome.processed[0].download_path, null);
});

test("reports running immediately when a batch is started", async () => {
  const chrome = makeChrome();
  const controller = createBatchController(chrome, { timeoutMs: 10 });
  const run = controller.start();
  assert.equal(controller.getState().running, true);
  await run;
});

test("stops the batch when the native host reports a fatal error", async () => {
  const chrome = makeChrome({ fatalSequence: 1 });
  const controller = createBatchController(chrome, { timeoutMs: 100 });
  const run = controller.start();
  await waitFor(() => chrome.updates.length === 1);
  chrome.createdListener({ id: 1, url: "https://example.test/one", state: "in_progress" });
  chrome.changedListener({ id: 1, state: { current: "complete" } });
  await run;
  assert.equal(chrome.updates.length, 1);
  assert.equal(controller.getState().lastError, "history_append_failed");
});

test("a completed controller can start a fresh batch", async () => {
  const chrome = makeChrome();
  const controller = createBatchController(chrome, { timeoutMs: 10 });
  await controller.start();
  await controller.start();
  assert.equal(chrome.processed.length, 4);
});

test("suggests the configured subdirectory for active ZIP downloads", async () => {
  const chrome = makeChrome();
  const controller = createBatchController(chrome, { timeoutMs: 10 });
  const run = controller.start();
  await waitFor(() => chrome.updates.length === 1);
  let suggestion;
  chrome.determiningListener({ id: 1, url: "https://example.test/one", filename: "one.zip" }, (value) => { suggestion = value; });
  assert.equal(suggestion.filename, "jingshajingsha/txt保存/one.zip");
  await run;
});

test("declares only the minimal active-tab and scripting permissions for TOTP", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "tabs", "downloads", "storage", "activeTab", "scripting"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("routes run_totp through the native host and injects into the requested tab", async () => {
  const chrome = makeChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_totp", tabId: 7, username: "alice", password: "pass" },
      { id: "ext", tab: { id: 7 } },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.state, "SUCCEEDED");
  assert.equal(chrome.executions[0].target.tabId, 7);
});

test("rejects a TOTP request when the sender tab does not match the target", async () => {
  const chrome = makeChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_totp", tabId: 7, username: "alice", password: "pass" },
      { id: "ext", tab: { id: 8 } },
      resolve,
    );
    assert.equal(keepChannelOpen, false);
  });
  assert.deepEqual(response, { ok: false, error: "sender_rejected" });
});

test("allows cancelling a TOTP run when only the run id is supplied", async () => {
  const chrome = makeChrome();
  const runtime = createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "cancel_totp", runId: "run-1" },
      { id: "ext", tab: { id: 7 } },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.state, "IDLE");
  assert.equal(runtime.totpController.getState().state, "IDLE");
});
