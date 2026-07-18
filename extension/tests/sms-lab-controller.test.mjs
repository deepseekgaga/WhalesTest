import test from "node:test";
import assert from "node:assert/strict";
import { createSmsLabController } from "../sms-lab-controller.js";

const configuredSelectors = Object.freeze({
  phoneInput: "#phone",
  sendButton: "#send",
  codeInput: "#code",
  submitButton: "#submit",
});

function makeClock({ pause = false } = {}) {
  let elapsed = 0;
  const pending = [];
  const abortError = () => new DOMException("Aborted", "AbortError");
  return {
    now: () => elapsed,
    sleep: (ms, signal) => {
      if (!pause) {
        elapsed += ms;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? abortError());
          return;
        }
        const entry = { ms, resolve, reject };
        const onAbort = () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          signal?.removeEventListener("abort", onAbort);
          reject(signal.reason ?? abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        entry.finish = () => {
          signal?.removeEventListener("abort", onAbort);
          elapsed += ms;
          resolve();
        };
        pending.push(entry);
      });
    },
    advance: (ms) => {
      elapsed += ms;
    },
    get elapsed() {
      return elapsed;
    },
    pending,
  };
}

async function waitUntil(predicate) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

function makeChrome({
  motherTab = { id: 10, windowId: 1, index: 3, active: true, incognito: false },
  incognitoTab = { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: true },
  nativeResponse = { ok: true, phone: " +1 555-0100 ", challenge_url: "http://sms-lab.local/challenge?token=abc" },
  helperResults = [{ ok: true, code: "123456" }],
  helperReadPromise = null,
  helperReadFn = null,
  helperStatuses = ["complete"],
  helperUrlChanges = [],
  requestResult = { ok: true },
  requestPromise = null,
  requestReject = null,
  submitResult = { ok: true },
  submitPromise = null,
  registerResult = { ok: true },
  cancelResult = { ok: true },
  cancelPromise = null,
  removeFailures = [],
  delayNative = false,
  delayCreate = false,
  helperClosedAfterStatusChecks = null,
} = {}) {
  const nativeMessages = [];
  const createdTabs = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const helperExecutions = [];
  const targetExecutions = [];
  const motherMutations = [];
  const helperStatusChecks = [];
  const tabsById = new Map();
  let nativeListener;
  let nativeMessageForRelease;
  let releaseCreate;
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
      const respond = () => nativeListener?.({
        request_id: message.request_id,
        ...nativeResponse,
      });
      if (delayNative) nativeMessageForRelease = respond;
      else queueMicrotask(respond);
    },
  };

  return {
    nativeMessages,
    createdTabs,
    removedTabs,
    reloadedTabs,
    helperExecutions,
    targetExecutions,
    motherMutations,
    helperStatusChecks,
    releaseNative() {
      nativeMessageForRelease?.();
      nativeMessageForRelease = null;
    },
    releaseCreate() {
      releaseCreate?.();
      releaseCreate = null;
    },
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
          if (helperClosedAfterStatusChecks != null && helperStatusChecks.length >= helperClosedAfterStatusChecks) {
            tabsById.delete(tabId);
            return null;
          }
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
        if (!delayCreate) {
          tabsById.set(helperTab.id, helperTab);
          return { ...helperTab };
        }
        return new Promise((resolve) => {
          releaseCreate = () => {
            tabsById.set(helperTab.id, helperTab);
            resolve({ ...helperTab });
          };
        });
      },
      async remove(tabId) {
        removedTabs.push(tabId);
        const failure = removeFailures.shift();
        if (failure) throw new Error(failure);
        tabsById.delete(tabId);
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
      async update(tabId, details) {
        motherMutations.push(["update", tabId, details]);
      },
    },
    scripting: {
      async executeScript(details) {
        if (details.target.tabId === incognitoTab?.id) {
          targetExecutions.push(details);
          if (details.func.name === "probeSmsOnPage") {
            if (!incognitoTab.activeTabGranted) throw new Error("active_tab_missing");
            return [{ result: { ok: true } }];
          }
          if (details.func.name === "registerSmsOnPage") {
            if (!incognitoTab.activeTabGranted) throw new Error("active_tab_missing");
            return [{ result: registerResult }];
          }
          if (details.func.name === "requestSmsOnPage") {
            if (requestReject) throw new Error(requestReject);
            return requestPromise ?? [{ result: requestResult }];
          }
          if (details.func.name === "submitSmsCodeOnPage") return submitPromise ?? [{ result: submitResult }];
          if (details.func.name === "cancelSmsOnPage") return cancelPromise ?? [{ result: cancelResult }];
        }
        if (details.target.tabId === motherTab?.id) {
          motherMutations.push(["executeScript", details]);
          return [{ result: { ok: true } }];
        }
        helperExecutions.push(details);
        if (helperReadFn) {
          const result = helperReadFn(details, helperReadIndex);
          helperReadIndex += 1;
          return [{ result }];
        }
        if (helperReadPromise) return helperReadPromise;
        const result = helperResults[Math.min(helperReadIndex, helperResults.length - 1)] ?? { ok: false, error: "helper_page_not_stable" };
        helperReadIndex += 1;
        return [{ result }];
      },
    },
  };
}

test("starts with an idle public state before any run", () => {
  const chrome = makeChrome();
  const controller = createSmsLabController(chrome, { selectors: configuredSelectors });

  assert.deepEqual(controller.getState(), { state: "IDLE", runId: null, error: "" });
});

test("requests SMS, reads the helper once, and submits the code to the same incognito tab", async () => {
  const clock = makeClock();
  const chrome = makeChrome();
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

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
    "probeSmsOnPage",
    "registerSmsOnPage",
    "requestSmsOnPage",
    "probeSmsOnPage",
    "registerSmsOnPage",
    "submitSmsCodeOnPage",
  ]);
  assert.deepEqual(chrome.helperExecutions.map((entry) => entry.func.name), ["readVisibleTotpCode"]);
  assert.equal(chrome.targetExecutions.every((entry) => entry.target.tabId === 20), true);
  assert.deepEqual(chrome.targetExecutions[2].args[0], {
    runId: "run-1",
    requireExistingToken: true,
    phone: " +1 555-0100 ",
    selectors: configuredSelectors,
    timeoutMs: 30_000,
  });
  assert.deepEqual(chrome.helperExecutions[0].args[0], { timeoutMs: 5_000 });
  assert.deepEqual(chrome.targetExecutions[5].args[0], {
    runId: "run-1",
    requireExistingToken: true,
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

test("maps known Chrome tabs.get rejections to missing initial tabs", async () => {
  for (const [tabId, rejectionMessage, expectedError] of [
    [10, "No tab with id: 10.", "mother_tab_missing"],
    [20, "Invalid tab ID: 20.", "incognito_tab_missing"],
  ]) {
    const chrome = makeChrome();
    const originalGet = chrome.tabs.get;
    chrome.tabs.get = async (requestedTabId) => {
      if (requestedTabId === tabId) throw new Error(rejectionMessage);
      return originalGet(requestedTabId);
    };
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: expectedError });
    assert.equal(chrome.createdTabs.length, 0);
  }
});

test("sanitizes unexpected tabs.get rejections instead of treating them as missing tabs", async () => {
  const chrome = makeChrome();
  chrome.tabs.get = async () => {
    throw new Error("Unexpected tab service failure at https://sms-lab.local/private?token=secret");
  };
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_lab_failed" });
});

test("rejects invalid native responses before requesting SMS on the target", async () => {
  for (const [expectedError, nativeResponse] of [
    ["sms_lab_challenge_failed", { ok: false }],
    ["sms_phone_invalid", { ok: true, phone: "", challenge_url: "http://sms-lab.local/challenge" }],
    ["sms_phone_invalid", { ok: true, phone: 555, challenge_url: "http://sms-lab.local/challenge" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: " https://sms-lab.local/challenge" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: "http://SMS-LAB.LOCAL/challenge" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local:80/challenge" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: "http://user@sms-lab.local/challenge" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local/challenge#frag" }],
    ["sms_url_invalid", { ok: true, phone: "555", challenge_url: "http://sms-lab.local/challenge\n" }],
  ]) {
    const chrome = makeChrome({ nativeResponse });
    const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.equal(result.state, "FAILED");
    assert.equal(result.error, expectedError);
    assert.equal(chrome.createdTabs.length, 0);
    assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["probeSmsOnPage"]);
  }
});

test("native challenge failure after activeTab probe does not leave a page registry token", async () => {
  const chrome = makeChrome({ nativeResponse: { ok: false, error: "sms_lab_challenge_failed" } });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_lab_challenge_failed" });
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["probeSmsOnPage"]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "registerSmsOnPage"), false);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "cancelSmsOnPage"), false);
});

test("request registration is cancelled when request executeScript rejects before page cleanup", async () => {
  const chrome = makeChrome({ requestReject: "execute_script_failed" });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_page_action_failed" });
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), [
    "probeSmsOnPage",
    "registerSmsOnPage",
    "requestSmsOnPage",
    "cancelSmsOnPage",
  ]);
});

test("SMS page context reset after registration fails the run without marking cancelled", async () => {
  const chrome = makeChrome({ requestResult: { ok: false, error: "sms_page_context_reset" } });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_page_context_reset" });
  assert.deepEqual(controller.getState(), { state: "FAILED", runId: "run-1", error: "sms_page_context_reset" });
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), [
    "probeSmsOnPage",
    "registerSmsOnPage",
    "requestSmsOnPage",
    "cancelSmsOnPage",
  ]);
});

test("removes the helper and fails when the helper redirects before reading", async () => {
  const chrome = makeChrome({
    helperUrlChanges: ["http://evil.example/challenge"],
  });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_url_invalid" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 0);
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["probeSmsOnPage", "registerSmsOnPage", "requestSmsOnPage"]);
});

test("maps ambiguous helper codes, rejects malformed codes, and cleans up the helper", async () => {
  for (const [expectedError, helperResults] of [
    ["sms_code_ambiguous", [{ ok: false, error: "totp_code_ambiguous" }]],
    ["sms_code_not_found", [{ ok: false, error: "code_not_present" }]],
    ["sms_code_invalid", [{ ok: true, code: "12345" }]],
    ["sms_code_invalid", [{ ok: true, code: "1234567" }]],
  ]) {
    const clock = makeClock();
    const chrome = makeChrome({ helperResults });
    const controller = createSmsLabController(chrome, {
      makeRunId: () => "run-1",
      selectors: configuredSelectors,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: expectedError });
    assert.deepEqual(chrome.removedTabs, [30]);
    assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"), false);
  }
});

test("retries helper cleanup when the first close after code read fails", async () => {
  const chrome = makeChrome({
    removeFailures: ["helper close failed with http://sms-lab.local/challenge?token=abc and 123456"],
  });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_lab_failed" });
  assert.deepEqual(controller.getState(), { state: "FAILED", runId: "run-1", error: "sms_lab_failed" });
  assert.deepEqual(chrome.removedTabs, [30, 30]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"), false);
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

test("maps a known final mother tabs.get rejection to mother_tab_missing", async () => {
  const chrome = makeChrome();
  const originalGet = chrome.tabs.get;
  let motherGets = 0;
  chrome.tabs.get = async (tabId) => {
    if (tabId === 10 && ++motherGets === 2) throw new Error("Tab not found: 10");
    return originalGet(tabId);
  };
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "mother_tab_missing" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"), false);
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

test("reserves the final five seconds for the last helper read with exactly three reloads", async () => {
  const clock = makeClock();
  const readStarts = [];
  const readBudgets = [];
  const chrome = makeChrome({
    helperReadFn(details) {
      readStarts.push(clock.elapsed);
      readBudgets.push(details.args[0].timeoutMs);
      return { ok: false, error: "code_not_present" };
    },
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_code_not_found" });
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
  assert.equal(clock.elapsed, 60_000);
  assert.deepEqual(readStarts, [0, 15_000, 30_000, 45_000, 55_000]);
  assert.deepEqual(readBudgets, [5_000, 5_000, 5_000, 5_000, 5_000]);
  assert.equal(chrome.helperExecutions.every((entry) => entry.target.tabId === 30), true);
});

test("finds a code during the final helper quiet and sample window", async () => {
  const clock = makeClock();
  const readStarts = [];
  const chrome = makeChrome({
    helperReadFn(details, readIndex) {
      readStarts.push(clock.elapsed);
      if (readIndex < 4) return { ok: false, error: "code_not_present" };
      assert.equal(details.args[0].timeoutMs, 5_000);
      clock.advance(800 + 250);
      return { ok: true, code: "654321" };
    },
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "SUCCEEDED", runId: "run-1", error: "" });
  assert.deepEqual(readStarts, [0, 15_000, 30_000, 45_000, 55_000]);
  assert.equal(clock.elapsed, 56_050);
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
});

test("does not extend the total deadline when the helper never completes after a reload", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperResults: [{ ok: false, error: "code_not_present" }],
    helperStatuses: ["complete", ...Array.from({ length: 500 }, () => "loading")],
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "helper_page_not_stable" });
  assert.equal(clock.elapsed, 20_000);
  assert.deepEqual(chrome.reloadedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 1);
});

test("slow helper load and read share one absolute read deadline", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperStatuses: [...Array.from({ length: 49 }, () => "loading"), "complete"],
    helperReadFn(details) {
      clock.advance(details.args[0].timeoutMs);
      return { ok: false, error: "code_not_present" };
    },
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_code_not_found" });
  assert.equal(chrome.helperExecutions[0].args[0].timeoutMs, 100);
  assert.equal(clock.elapsed, 60_000);
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
});

test("a no-code final helper read consumes at most the remaining absolute deadline", async () => {
  const clock = makeClock();
  const readStarts = [];
  const chrome = makeChrome({
    helperReadFn(details, readIndex) {
      readStarts.push(clock.elapsed);
      if (readIndex === 4) clock.advance(details.args[0].timeoutMs);
      return { ok: false, error: "code_not_present" };
    },
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_code_not_found" });
  assert.equal(clock.elapsed <= 60_000, true);
  assert.deepEqual(readStarts, [0, 15_000, 30_000, 45_000, 55_000]);
  assert.equal(chrome.helperExecutions[4].args[0].timeoutMs, 5_000);
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
  assert.equal(chrome.helperExecutions.length, 5);
});

test("maps ambiguous helper codes without retrying or reloading", async () => {
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "totp_code_ambiguous" }] });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_code_ambiguous" });
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.equal(chrome.helperExecutions.length, 1);
});

test("validates the helper tab still exists, is complete, and remains on sms-lab before each read", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperResults: [{ ok: false, error: "code_not_present" }],
    helperUrlChanges: [null, "http://external.example/challenge"],
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "sms_url_invalid" });
  assert.deepEqual(chrome.reloadedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 1);
});

test("returns helper_tab_closed when the helper is manually closed during retry waiting", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperResults: [{ ok: false, error: "code_not_present" }],
    helperClosedAfterStatusChecks: 1,
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "helper_tab_closed" });
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.deepEqual(chrome.removedTabs, [30]);
});

test("maps a known helper tabs.get rejection during retry to helper_tab_closed", async () => {
  const clock = makeClock();
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "code_not_present" }] });
  const originalGet = chrome.tabs.get;
  let helperGets = 0;
  chrome.tabs.get = async (tabId) => {
    if (tabId === 30 && ++helperGets === 2) throw new Error("No tab with id: 30.");
    return originalGet(tabId);
  };
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "helper_tab_closed" });
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.deepEqual(chrome.removedTabs, [30]);
});

test("cancel with the wrong run id has no effect on the active SMS run", async () => {
  const clock = makeClock({ pause: true });
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "code_not_present" }] });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => clock.pending.length === 1);
  assert.deepEqual(await controller.cancel("other-run"), { state: "WAITING_FOR_CODE", runId: "run-1", error: "" });
  assert.equal(controller.getState().state, "WAITING_FOR_CODE");
  clock.pending[0].finish();
  await waitUntil(() => chrome.reloadedTabs.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
});

test("cancel while native challenge is pending aborts the original run without opening a helper", async () => {
  const chrome = makeChrome({ delayNative: true });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.nativeMessages.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  chrome.releaseNative();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(chrome.createdTabs.length, 0);
  assert.deepEqual(chrome.removedTabs, []);
});

test("cancel while requesting SMS on the page aborts the page execution and does not open a helper", async () => {
  const chrome = makeChrome({ requestPromise: new Promise(() => {}) });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.targetExecutions.some((entry) => entry.func.name === "requestSmsOnPage"));
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });

  assert.equal(chrome.createdTabs.length, 0);
  assert.deepEqual(chrome.removedTabs, []);
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["probeSmsOnPage", "registerSmsOnPage", "requestSmsOnPage", "cancelSmsOnPage"]);
});

test("cancel while helper creation is pending removes the late helper exactly once", async () => {
  const chrome = makeChrome({ delayCreate: true });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.createdTabs.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  chrome.releaseCreate();
  assert.deepEqual(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });

  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 0);
});

test("cancel while sleeping between helper reads aborts without reloading again", async () => {
  const clock = makeClock({ pause: true });
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "code_not_present" }] });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => clock.pending.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.deepEqual(chrome.removedTabs, [30]);
});

test("cancel while helper read is pending aborts and cleans up the helper", async () => {
  const chrome = makeChrome({ helperReadPromise: new Promise(() => {}) });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.helperExecutions.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });

  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"), false);
});

test("cancel while submitting SMS aborts promptly and keeps mother and target untouched", async () => {
  const chrome = makeChrome({ submitPromise: new Promise(() => {}) });
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.targetExecutions.some((entry) => entry.func.name === "submitSmsCodeOnPage"));
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });

  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.motherMutations, []);
  assert.deepEqual(chrome.reloadedTabs, []);
});

test("new SMS runs are rejected while cancellation is still unwinding", async () => {
  const clock = makeClock({ pause: true });
  let releaseCancel;
  const chrome = makeChrome({
    helperResults: [{ ok: false, error: "code_not_present" }],
    cancelPromise: new Promise((resolve) => {
      releaseCancel = () => resolve([{ result: { ok: true } }]);
    }),
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => clock.pending.length === 1);
  const cancelling = controller.cancel("run-1");
  await waitUntil(() => chrome.targetExecutions.some((entry) => entry.func.name === "cancelSmsOnPage"));
  await assert.rejects(
    () => controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 }),
    (error) => error?.message === "sms_lab_run_active",
  );

  releaseCancel();
  assert.deepEqual(await cancelling, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
});

test("never-settling page cancel injection is bounded before allowing a new run", async () => {
  const clock = makeClock({ pause: true });
  let runSequence = 0;
  const chrome = makeChrome({
    helperResults: [
      { ok: false, error: "code_not_present" },
      { ok: true, code: "654321" },
    ],
    cancelPromise: new Promise(() => {}),
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => `run-${++runSequence}`,
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
    cancelPageTimeoutMs: 10,
  });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => clock.pending.length === 1);
  const cancelling = controller.cancel("run-1");
  await waitUntil(() => chrome.targetExecutions.some((entry) => entry.func.name === "cancelSmsOnPage"));
  await assert.rejects(
    () => controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 }),
    (error) => error?.message === "sms_lab_run_active",
  );

  assert.deepEqual(await Promise.race([
    cancelling,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(
    await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 }),
    { state: "SUCCEEDED", runId: "run-2", error: "" },
  );
});

test("final cleanup retries when helper removal fails during cancel", async () => {
  const clock = makeClock({ pause: true });
  const chrome = makeChrome({
    helperResults: [{ ok: false, error: "code_not_present" }],
    removeFailures: ["transient_remove_failure"],
  });
  const controller = createSmsLabController(chrome, {
    makeRunId: () => "run-1",
    selectors: configuredSelectors,
    now: clock.now,
    sleep: clock.sleep,
  });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => clock.pending.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.removedTabs, [30, 30]);
});

test("public SMS state never exposes phone, URL, or code values", async () => {
  const chrome = makeChrome();
  const controller = createSmsLabController(chrome, { makeRunId: () => "run-1", selectors: configuredSelectors });

  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(Object.keys(result).sort(), ["error", "runId", "state"]);
  assert.deepEqual(Object.keys(controller.getState()).sort(), ["error", "runId", "state"]);
  assert.equal(JSON.stringify(controller.getState()).includes("555"), false);
  assert.equal(JSON.stringify(controller.getState()).includes("sms-lab.local"), false);
  assert.equal(JSON.stringify(controller.getState()).includes("123456"), false);
});
