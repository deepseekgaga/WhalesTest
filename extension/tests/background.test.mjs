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

function makeLabChrome({
  motherTab = { id: 10, windowId: 1, index: 3, active: true, incognito: false },
  targetTab = { id: 20, windowId: 2, index: 1, active: true, incognito: true, activeTabGranted: true },
  helperReadResult = { ok: true, code: "123456" },
  challengeUrl = "http://totp-lab.local/encoded?test_hook=lab-hook",
} = {}) {
  const nativeMessages = [];
  const executions = [];
  const createdTabs = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const tabsById = new Map();
  if (motherTab) tabsById.set(motherTab.id, motherTab);
  if (targetTab) tabsById.set(targetTab.id, targetTab);
  let nativeListener;
  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      nativeMessages.push(message);
      if (message.command !== "get_totp_lab_challenge") return;
      queueMicrotask(() => nativeListener?.({
        request_id: message.request_id,
        ok: true,
        challenge_url: challengeUrl,
      }));
    },
  };
  const api = {
    nativeMessages,
    executions,
    createdTabs,
    removedTabs,
    reloadedTabs,
    runtime: {
      id: "ext",
      onMessage: { addListener(listener) { api.messageListener = listener; } },
      connectNative() {
        return port;
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabsById.get(tabId);
        if (!tab) return null;
        return tab.id === 30 ? { ...tab, status: "complete" } : tab;
      },
      async create(details) {
        createdTabs.push(details);
        const helperTab = { id: 30, windowId: details.windowId, index: details.index, active: details.active, incognito: false, url: details.url, status: "complete" };
        tabsById.set(helperTab.id, helperTab);
        return helperTab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        tabsById.delete(tabId);
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
    },
    scripting: {
      async executeScript(details) {
        executions.push(details);
        if (details.target.tabId === targetTab.id) {
          if (details.func.name === "registerTotpOnPage") {
            if (!targetTab.activeTabGranted) throw new Error("incognito_active_tab_required");
            return [{ result: { ok: true } }];
          }
          if (details.func.name === "fillTotpOnPage") return [{ result: { ok: true } }];
          if (details.func.name === "cancelTotpOnPage") return [{ result: { ok: true } }];
        }
        if (details.target.tabId === 30) return [{ result: helperReadResult }];
        return [{ result: { ok: true } }];
      },
    },
    downloads: {
      onCreated: { addListener() {} },
      onChanged: { addListener() {} },
      onDeterminingFilename: { addListener() {} },
      async download() { return 1; },
      async search() { return []; },
    },
    storage: { local: { async set() {}, async get() { return {}; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  };
  return api;
}

const CONFIGURED_SMS_SELECTORS = Object.freeze({
  phoneInput: "#phone",
  sendButton: "#send",
  codeInput: "#code",
  submitButton: "#submit",
});

function makeSmsLabChrome({
  motherTab = { id: 10, windowId: 1, index: 3, active: true, incognito: false },
  targetTab = { id: 20, windowId: 2, index: 1, active: true, incognito: true, activeTabGranted: true },
  helperReadResult = { ok: true, code: "654321" },
  challengeUrl = "http://sms-lab.local/encoded?test_hook=lab-hook",
  phone = "15555550123",
  holdNativeChallenge = false,
} = {}) {
  const nativeMessages = [];
  const pendingNativeChallengeResponses = [];
  const executions = [];
  const createdTabs = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const tabsById = new Map();
  if (motherTab) tabsById.set(motherTab.id, motherTab);
  if (targetTab) tabsById.set(targetTab.id, targetTab);
  let nativeListener;
  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      nativeMessages.push(message);
      if (message.command !== "get_sms_lab_challenge") return;
      const respond = () => nativeListener?.({
        request_id: message.request_id,
        ok: true,
        phone,
        challenge_url: challengeUrl,
      });
      if (holdNativeChallenge) pendingNativeChallengeResponses.push(respond);
      else queueMicrotask(respond);
    },
  };
  const api = {
    nativeMessages,
    executions,
    createdTabs,
    removedTabs,
    reloadedTabs,
    runtime: {
      id: "ext",
      onMessage: { addListener(listener) { api.messageListener = listener; } },
      connectNative() {
        return port;
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabsById.get(tabId);
        if (!tab) return null;
        return tab.id === 30 ? { ...tab, status: "complete" } : tab;
      },
      async create(details) {
        createdTabs.push(details);
        const helperTab = { id: 30, windowId: details.windowId, index: details.index, active: details.active, incognito: false, url: details.url, status: "complete" };
        tabsById.set(helperTab.id, helperTab);
        return helperTab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        tabsById.delete(tabId);
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
    },
    scripting: {
      async executeScript(details) {
        executions.push(details);
        if (details.target.tabId === targetTab.id) {
          if (details.func.name === "probeSmsOnPage") {
            if (!targetTab.activeTabGranted) throw new Error("incognito_active_tab_required");
            return [{ result: { ok: true } }];
          }
          if (details.func.name === "registerSmsOnPage") return [{ result: { ok: true } }];
          if (details.func.name === "requestSmsOnPage") {
            assert.deepEqual(details.args[0].selectors, CONFIGURED_SMS_SELECTORS);
            assert.equal(details.args[0].phone, phone);
            return [{ result: { ok: true } }];
          }
          if (details.func.name === "submitSmsCodeOnPage") {
            assert.deepEqual(details.args[0].selectors, CONFIGURED_SMS_SELECTORS);
            assert.equal(details.args[0].code, helperReadResult.code);
            return [{ result: { ok: true } }];
          }
          if (details.func.name === "cancelSmsOnPage") return [{ result: { ok: true } }];
        }
        if (details.target.tabId === 30) return [{ result: helperReadResult }];
        return [{ result: { ok: true } }];
      },
    },
    downloads: {
      onCreated: { addListener() {} },
      onChanged: { addListener() {} },
      onDeterminingFilename: { addListener() {} },
      async download() { return 1; },
      async search() { return []; },
    },
    storage: { local: { async set() {}, async get() { return {}; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  };
  return api;
}

function createSmsRuntime(chrome) {
  return createExtensionRuntime(chrome, {
    smsLab: {
      selectors: CONFIGURED_SMS_SELECTORS,
      makeRunId: () => "sms-run-1",
      sleep: async () => {},
    },
  });
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

test("declares only the fixed TOTP and SMS Lab hosts plus minimal extension permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "tabs", "downloads", "storage", "activeTab", "scripting"]);
  assert.deepEqual(manifest.host_permissions, ["http://totp-lab.local/*", "http://sms-lab.local/*"]);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("routes run_totp_lab through the native host and injects into the requested tab", async () => {
  const chrome = makeLabChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_totp_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.state, "SUCCEEDED");
  assert.equal(chrome.nativeMessages[0].command, "get_totp_lab_challenge");
  assert.deepEqual(chrome.executions.map((entry) => entry.func.name), ["registerTotpOnPage", "readVisibleTotpCode", "fillTotpOnPage"]);
});

test("rejects caller-supplied challenge URLs or secrets", async () => {
  const chrome = makeLabChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_totp_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, challengeUrl: "secret", code: "123456" },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, false);
  });

  assert.deepEqual(response, { ok: false, error: "request_invalid" });
});

test("exposes non-sensitive TOTP Lab state", async () => {
  const chrome = makeLabChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener({ type: "totp_lab_state" }, { id: "ext" }, resolve);
    assert.equal(keepChannelOpen, false);
  });

  assert.deepEqual(response, { ok: true, result: { state: "IDLE", runId: null, error: "" } });
});

test("allows cancelling a TOTP Lab run when only the run id is supplied", async () => {
  const chrome = makeLabChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener({ type: "cancel_totp_lab", runId: "run-1" }, { id: "ext" }, resolve);
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.state, "IDLE");
});

test("packages the TOTP Lab controller and page files", async () => {
  const script = await readFile(new URL("../../scripts/package-extension.ps1", import.meta.url), "utf8");
  assert.equal(script.includes("totp-lab-controller.js"), true);
  assert.equal(script.includes("totp-lab-page.js"), true);
});

test("routes run_sms_lab through native, SMS page, helper read, and submit", async () => {
  const chrome = makeSmsLabChrome();
  const runtime = createSmsRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.state, "SUCCEEDED");
  assert.equal(response.result.runId, "sms-run-1");
  assert.equal(runtime.smsLabController.getState().state, "SUCCEEDED");
  assert.equal(chrome.nativeMessages[0].command, "get_sms_lab_challenge");
  assert.equal(chrome.nativeMessages[0].excel_row, 2);
  assert.deepEqual(chrome.createdTabs[0], {
    windowId: 1,
    index: 4,
    active: false,
    url: "http://sms-lab.local/encoded?test_hook=lab-hook",
  });
  assert.deepEqual(
    chrome.executions.map((entry) => entry.func.name),
    ["probeSmsOnPage", "registerSmsOnPage", "requestSmsOnPage", "readVisibleTotpCode", "probeSmsOnPage", "registerSmsOnPage", "submitSmsCodeOnPage"],
  );
  assert.deepEqual(chrome.removedTabs, [30]);
});

test("returns the fixed SMS URL validation error through the background route", async () => {
  const chrome = makeSmsLabChrome({ challengeUrl: "https://sms-lab.local/challenge" });
  createSmsRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.deepEqual(response, {
    ok: true,
    result: { state: "FAILED", runId: "sms-run-1", error: "sms_url_invalid" },
  });
  assert.deepEqual(chrome.createdTabs, []);
});

test("reports configured selector failure when SMS Lab runs with production placeholders", async () => {
  const chrome = makeSmsLabChrome();
  createExtensionRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.state, "FAILED");
  assert.equal(response.result.error, "sms_selectors_not_configured");
  assert.deepEqual(chrome.nativeMessages, []);
});

test("rejects extra fields on every SMS Lab route", async () => {
  for (const message of [
    { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, phone: "15555550123" },
    { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, challengeUrl: "http://sms-lab.local/x" },
    { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, code: "654321" },
    { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, selectors: CONFIGURED_SMS_SELECTORS },
    { type: "cancel_sms_lab", runId: "sms-run-1", code: "654321" },
    { type: "sms_lab_state", runId: "sms-run-1" },
  ]) {
    const chrome = makeSmsLabChrome();
    createSmsRuntime(chrome);
    const response = await new Promise((resolve) => {
      const keepChannelOpen = chrome.messageListener(message, { id: "ext" }, resolve);
      assert.equal(keepChannelOpen, false);
    });
    assert.deepEqual(response, { ok: false, error: "request_invalid" });
  }
});

test("rejects invalid SMS Lab run and cancel route identifiers", async () => {
  for (const message of [
    { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 1 },
    { type: "run_sms_lab", motherTabId: true, incognitoTabId: 20, excelRow: 2 },
    { type: "cancel_sms_lab", runId: "" },
    { type: "cancel_sms_lab", runId: 101 },
    { type: "cancel_sms_lab", runId: null },
    { type: "cancel_sms_lab", runId: true },
    { type: "cancel_sms_lab", runId: ["sms-run-1"] },
    { type: "cancel_sms_lab", runId: { value: "sms-run-1" } },
  ]) {
    const chrome = makeSmsLabChrome();
    createSmsRuntime(chrome);
    const response = await new Promise((resolve) => {
      const keepChannelOpen = chrome.messageListener(message, { id: "ext" }, resolve);
      assert.equal(keepChannelOpen, false);
    });
    assert.deepEqual(response, { ok: false, error: "request_invalid" });
  }
});

test("rejects SMS Lab messages from other extensions", async () => {
  const chrome = makeSmsLabChrome();
  createSmsRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "other" },
      resolve,
    );
    assert.equal(keepChannelOpen, false);
  });

  assert.deepEqual(response, { ok: false, error: "sender_rejected" });
});

test("exposes synchronous non-sensitive SMS Lab idle state", async () => {
  const chrome = makeSmsLabChrome();
  createSmsRuntime(chrome);
  const response = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener({ type: "sms_lab_state" }, { id: "ext" }, resolve);
    assert.equal(keepChannelOpen, false);
  });

  assert.deepEqual(response, { ok: true, result: { state: "IDLE", runId: null, error: "" } });
});

test("routes a non-empty string SMS Lab run id to the controller cancellation", async () => {
  const chrome = makeSmsLabChrome({ holdNativeChallenge: true });
  const runtime = createSmsRuntime(chrome);
  const runResponse = new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener(
      { type: "run_sms_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2 },
      { id: "ext" },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });
  await waitFor(() => chrome.nativeMessages.length === 1);

  const cancelResponse = await new Promise((resolve) => {
    const keepChannelOpen = chrome.messageListener({ type: "cancel_sms_lab", runId: "sms-run-1" }, { id: "ext" }, resolve);
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(cancelResponse.ok, true);
  assert.equal(cancelResponse.result.state, "CANCELLED");
  assert.equal(cancelResponse.result.runId, "sms-run-1");
  const completedRun = await runResponse;
  assert.equal(completedRun.ok, true);
  assert.equal(completedRun.result.state, "CANCELLED");
  assert.equal(runtime.smsLabController.getState().state, "CANCELLED");
});

test("packages the SMS Lab selector, page, and controller files", async () => {
  const script = await readFile(new URL("../../scripts/package-extension.ps1", import.meta.url), "utf8");
  assert.equal(script.includes("sms-lab-selectors.js"), true);
  assert.equal(script.includes("sms-lab-page.js"), true);
  assert.equal(script.includes("sms-lab-controller.js"), true);
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
