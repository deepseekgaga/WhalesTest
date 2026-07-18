import test from "node:test";
import assert from "node:assert/strict";
import { createSmsLabController } from "../sms-lab-controller.js";

const configuredSelectors = Object.freeze({
  phoneInput: "#phone",
  sendButton: "#send",
  codeInput: "#code",
  submitButton: "#submit",
});

function makeClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: (ms) => {
      elapsed += ms;
      return Promise.resolve();
    },
    get elapsed() {
      return elapsed;
    },
  };
}

function makeChrome({
  motherTab = { id: 10, windowId: 1, index: 3, active: true, incognito: false },
  incognitoTab = { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: true },
  nativeResponse = { ok: true, phone: " +1 555-0100 ", challenge_url: "http://sms-lab.local/challenge?token=abc" },
  helperResults = [{ ok: true, code: "123456" }],
  helperStatuses = ["complete"],
  helperUrlChanges = [],
  requestResult = { ok: true },
  submitResult = { ok: true },
  registerResult = { ok: true },
} = {}) {
  const nativeMessages = [];
  const createdTabs = [];
  const removedTabs = [];
  const helperExecutions = [];
  const targetExecutions = [];
  const motherMutations = [];
  const helperStatusChecks = [];
  const tabsById = new Map();
  let nativeListener;
  let helperStatusIndex = 0;
  let helperReadIndex = 0;
  let helperUrlIndex = 0;

  if (motherTab) tabsById.set(motherTab.id, { ...motherTab });
  if (incognitoTab) tabsById.set(incognitoTab.id, { ...incognitoTab });

  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
    postMessage(message) {
      nativeMessages.push(message);
      if (message.command !== "get_sms_lab_challenge") return;
      queueMicrotask(() => nativeListener?.({
        request_id: message.request_id,
        ...nativeResponse,
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
    helperStatusChecks,
    runtime: {
      id: "ext",
      connectNative() {
        return port;
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabsById.get(tabId);
        if (!tab) return null;
        if (tab.id === 30) {
          const status = helperStatuses[Math.min(helperStatusIndex, helperStatuses.length - 1)] ?? "complete";
          helperStatusIndex += 1;
          helperStatusChecks.push(status);
          const changedUrl = helperUrlChanges[helperUrlIndex++];
          if (changedUrl) tab.url = changedUrl;
          return { ...tab, status };
        }
        return { ...tab };
      },
      async create(details) {
        createdTabs.push(details);
        const helperTab = {
          id: 30,
          windowId: details.windowId,
          index: details.index,
          active: details.active,
          incognito: false,
          status: "loading",
          url: details.url,
        };
        tabsById.set(helperTab.id, helperTab);
        return { ...helperTab };
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        tabsById.delete(tabId);
      },
      async reload(tabId) {
        motherMutations.push(["reload", tabId]);
      },
      async update(tabId, details) {
        motherMutations.push(["update", tabId, details]);
      },
    },
    scripting: {
      async executeScript(details) {
        if (details.target.tabId === incognitoTab?.id) {
          targetExecutions.push(details);
          if (details.func.name === "registerSmsOnPage") {
            if (!incognitoTab.activeTabGranted) throw new Error("active_tab_missing");
            return [{ result: registerResult }];
          }
          if (details.func.name === "requestSmsOnPage") return [{ result: requestResult }];
          if (details.func.name === "submitSmsCodeOnPage") return [{ result: submitResult }];
        }
        if (details.target.tabId === motherTab?.id) {
          motherMutations.push(["executeScript", details]);
          return [{ result: { ok: true } }];
        }
        helperExecutions.push(details);
        const result = helperResults[Math.min(helperReadIndex, helperResults.length - 1)] ?? { ok: false, error: "helper_page_not_stable" };
        helperReadIndex += 1;
        return [{ result }];
      },
    },
  };
}

test("requests SMS, reads the helper once, and submits the code to the same incognito tab", async () => {
  const chrome = makeChrome();
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "SUCCEEDED", runId: "run-1", error: "" });
  assert.deepEqual(controller.getState(), { state: "SUCCEEDED", runId: "run-1", error: "" });
  assert.deepEqual(chrome.nativeMessages[0], {
    request_id: chrome.nativeMessages[0].request_id,
    command: "get_sms_lab_challenge",
    excel_row: 2,
  });
  assert.deepEqual(chrome.createdTabs[0], {
    windowId: 1,
    index: 4,
    active: false,
    url: "http://sms-lab.local/challenge?token=abc",
  });
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), [
    "registerSmsOnPage",
    "requestSmsOnPage",
    "submitSmsCodeOnPage",
  ]);
  assert.deepEqual(chrome.helperExecutions.map((entry) => entry.func.name), ["readVisibleTotpCode"]);
  assert.equal(chrome.targetExecutions.every((entry) => entry.target.tabId === 20), true);
  assert.deepEqual(chrome.targetExecutions[1].args[0], {
    phone: " +1 555-0100 ",
    selectors: configuredSelectors,
    timeoutMs: 30_000,
  });
  assert.deepEqual(chrome.helperExecutions[0].args[0], { timeoutMs: 5_000 });
  assert.deepEqual(chrome.targetExecutions[2].args[0], {
    code: "123456",
    selectors: configuredSelectors,
    timeoutMs: 30_000,
  });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.motherMutations, []);
});

test("rejects unconfigured selectors before touching tabs or the native host", async () => {
  const chrome = makeChrome();
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1" });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_selectors_not_configured" });
  assert.equal(chrome.nativeMessages.length, 0);
  assert.equal(chrome.targetExecutions.length, 0);
  assert.equal(chrome.createdTabs.length, 0);
});

test("validates mother, target, row, and activeTab grant before opening helper work", async () => {
  for (const [expectedError, overrides, request = { motherTabId: 10, incognitoTabId: 20, excelRow: 2 }] of [
    ["request_invalid", {}, { motherTabId: 10, incognitoTabId: 20, excelRow: 1 }],
    ["request_invalid", {}, { motherTabId: 10, incognitoTabId: 20, excelRow: true }],
    ["request_invalid", {}, { motherTabId: 10, incognitoTabId: 10, excelRow: 2 }],
    ["mother_tab_missing", { motherTab: null }],
    ["mother_tab_not_active", { motherTab: { id: 10, windowId: 1, index: 3, active: false, incognito: false } }],
    ["mother_tab_incognito", { motherTab: { id: 10, windowId: 1, index: 3, active: true, incognito: true } }],
    ["incognito_tab_missing", { incognitoTab: null }],
    ["incognito_tab_required", { incognitoTab: { id: 20, windowId: 2, index: 1, active: false, incognito: false, activeTabGranted: true } }],
    ["incognito_active_tab_required", { incognitoTab: { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: false } }],
  ]) {
    const chrome = makeChrome(overrides);
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run(request);

    assert.equal(result.state, "FAILED");
    assert.equal(result.error, expectedError);
    assert.equal(chrome.createdTabs.length, 0);
    assert.equal(chrome.removedTabs.length, 0);
  }
});

test("rejects invalid native responses before requesting SMS on the target", async () => {
  for (const [expectedError, nativeResponse] of [
    ["sms_lab_challenge_failed", { ok: false }],
    ["sms_phone_invalid", { ok: true, phone: "", challenge_url: "http://sms-lab.local/challenge" }],
    ["sms_phone_invalid", { ok: true, phone: 555, challenge_url: "http://sms-lab.local/challenge" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: " https://sms-lab.local/challenge" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: "http://SMS-LAB.LOCAL/challenge" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local:80/challenge" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: "http://user@sms-lab.local/challenge" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local/challenge#frag" }],
    ["sms_lab_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local/challenge\n" }],
  ]) {
    const chrome = makeChrome({ nativeResponse });
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.equal(result.state, "FAILED");
    assert.equal(result.error, expectedError);
    assert.equal(chrome.createdTabs.length, 0);
    assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["registerSmsOnPage"]);
  }
});

test("removes the helper and fails when the helper redirects before reading", async () => {
  const chrome = makeChrome({
    helperUrlChanges: ["http://evil.example/challenge"],
  });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_lab_url_invalid" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 0);
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["registerSmsOnPage", "requestSmsOnPage"]);
});

test("maps ambiguous helper codes, rejects malformed codes, and cleans up the helper", async () => {
  for (const [expectedError, helperResults] of [
    ["sms_code_ambiguous", [{ ok: false, error: "totp_code_ambiguous" }]],
    ["sms_code_invalid", [{ ok: true, code: "12345" }]],
    ["sms_code_invalid", [{ ok: true, code: "1234567" }]],
  ]) {
    const chrome = makeChrome({ helperResults });
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: expectedError });
    assert.deepEqual(chrome.removedTabs, [30]);
    assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"), false);
  }
});

test("rechecks the mother tab before submitting and cleans up the helper on page action errors", async () => {
  for (const [expectedError, overrides] of [
    ["sms_request_failed", { requestResult: { ok: false, error: "sms_request_failed" } }],
    ["mother_tab_not_active", { motherTab: { id: 10, windowId: 1, index: 3, active: true, incognito: false, deactivateAfterCreate: true } }],
    ["sms_submit_failed", { submitResult: { ok: false, error: "sms_submit_failed" } }],
  ]) {
    const motherTab = overrides.motherTab;
    const chrome = makeChrome({
      ...overrides,
      motherTab: motherTab ? { ...motherTab } : undefined,
    });
    if (motherTab?.deactivateAfterCreate) {
      let gets = 0;
      const originalGet = chrome.tabs.get;
      chrome.tabs.get = async (tabId) => {
        const tab = await originalGet(tabId);
        if (tabId === 10) {
          gets += 1;
          if (gets > 1) return { ...tab, active: false };
        }
        return tab;
      };
    }
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: expectedError });
    assert.deepEqual(chrome.removedTabs, expectedError === "sms_request_failed" ? [] : [30]);
  }
});

test("waits at most five seconds for the helper to complete before reading", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperStatuses: Array.from({ length: 100 }, () => "loading"),
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "helper_page_not_stable" });
  assert.equal(clock.elapsed, 5_000);
  assert.equal(chrome.helperExecutions.length, 0);
  assert.deepEqual(chrome.removedTabs, [30]);
});
