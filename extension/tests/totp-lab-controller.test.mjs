import test from "node:test";
import assert from "node:assert/strict";
import { createTotpLabController } from "../totp-lab-controller.js";

function makeChrome({
  motherTab = { id: 10, windowId: 1, index: 3, active: true, incognito: false },
  incognitoTab = { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: true },
  helperResult = { ok: true, code: "123456" },
  fillResult = { ok: true },
  registerResult = { ok: true },
  challengeUrl = "http://totp-lab.local/encoded?test_hook=lab-hook",
} = {}) {
  const nativeMessages = [];
  const createdTabs = [];
  const removedTabs = [];
  const helperExecutions = [];
  const targetExecutions = [];
  const motherMutations = [];
  let nativeListener;

  const tabsById = new Map();
  if (motherTab) tabsById.set(motherTab.id, motherTab);
  if (incognitoTab) tabsById.set(incognitoTab.id, incognitoTab);

  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
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

  return {
    nativeMessages,
    createdTabs,
    removedTabs,
    helperExecutions,
    targetExecutions,
    motherMutations,
    runtime: {
      id: "ext",
      connectNative() {
        return port;
      },
    },
    tabs: {
      async get(tabId) {
        return tabsById.get(tabId) || null;
      },
      async create(details) {
        createdTabs.push(details);
        const helperTab = { id: 30, windowId: details.windowId, index: details.index, active: details.active, incognito: false, url: details.url };
        tabsById.set(helperTab.id, helperTab);
        return helperTab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        tabsById.delete(tabId);
      },
    },
    scripting: {
      async executeScript(details) {
        if (details.target.tabId === incognitoTab.id) {
          targetExecutions.push(details);
          if (!incognitoTab.activeTabGranted) throw new Error("incognito_active_tab_required");
          if (details.func.name === "registerTotpOnPage") return [{ result: registerResult }];
          return [{ result: fillResult }];
        }
        if (details.target.tabId === motherTab.id) return [{ result: { ok: true } }];
        helperExecutions.push(details);
        return [{ result: helperResult }];
      },
    },
  };
}

test("creates a background helper beside the active mother tab and fills the same incognito tab", async () => {
  const chrome = makeChrome();
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "SUCCEEDED", runId: "run-1", error: "" });
  assert.equal(chrome.nativeMessages[0].command, "get_totp_lab_challenge");
  assert.deepEqual(chrome.nativeMessages[0], {
    request_id: chrome.nativeMessages[0].request_id,
    command: "get_totp_lab_challenge",
    excel_row: 2,
  });
  assert.deepEqual(chrome.createdTabs[0], {
    windowId: 1,
    index: 4,
    active: false,
    url: "http://totp-lab.local/encoded?test_hook=lab-hook",
  });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["registerTotpOnPage", "fillTotpOnPage"]);
  assert.equal(chrome.helperExecutions[0].func.name, "readVisibleTotpCode");
  assert.equal(chrome.targetExecutions[1].target.tabId, 20);
  assert.deepEqual(chrome.targetExecutions[1].args[0], {
    code: "123456",
    runId: "run-1",
    requireExistingToken: true,
    timeoutMs: 30_000,
  });
  assert.deepEqual(chrome.motherMutations, []);
});

for (const [name, motherTab] of [
  ["returns mother_tab_missing when the mother tab is absent", null],
  ["returns mother_tab_not_active when the mother tab is not active", { id: 10, windowId: 1, index: 3, active: false, incognito: false }],
  ["returns mother_tab_incognito when the mother tab is incognito", { id: 10, windowId: 1, index: 3, active: true, incognito: true }],
]) {
  test(name, async () => {
    const chrome = makeChrome({ motherTab });
    const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });
    assert.equal(result.state, "FAILED");
    assert.equal(result.runId, "run-1");
    assert.ok(result.error.length > 0);
    assert.equal(chrome.createdTabs.length, 0);
    assert.equal(chrome.removedTabs.length, 0);
  });
}

test("returns incognito_tab_required when the target tab is not incognito", async () => {
  const chrome = makeChrome({
    incognitoTab: { id: 20, windowId: 2, index: 1, active: true, incognito: false, activeTabGranted: true },
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.equal(result.error, "incognito_tab_required");
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.removedTabs.length, 0);
});

test("returns request_invalid for identical mother and target tab ids without creating a helper", async () => {
  const chrome = makeChrome({
    motherTab: { id: 10, windowId: 1, index: 3, active: true, incognito: false },
    incognitoTab: { id: 10, windowId: 1, index: 3, active: true, incognito: false, activeTabGranted: true },
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 10, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "request_invalid" });
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.removedTabs.length, 0);
});

test("returns incognito_active_tab_required when the target incognito tab has no activeTab grant", async () => {
  const chrome = makeChrome({
    incognitoTab: { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: false },
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.equal(result.error, "incognito_active_tab_required");
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.removedTabs.length, 0);
});
