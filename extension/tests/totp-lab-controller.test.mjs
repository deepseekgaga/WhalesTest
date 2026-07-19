import test from "node:test";
import assert from "node:assert/strict";
import { createTotpLabController } from "../totp-lab-controller.js";

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
  helperResults = [{ ok: true, code: "123456" }],
  helperReadPromise = null,
  helperStatuses = ["complete"],
  fillResult = { ok: true },
  fillPromise = null,
  registerResult = { ok: true },
  cancelResult = { ok: true },
  challengeUrl = "http://totp-lab.local/encoded?test_hook=lab-hook",
  delayNative = false,
  delayCreate = false,
} = {}) {
  const nativeMessages = [];
  const createdTabs = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const helperExecutions = [];
  const targetExecutions = [];
  const motherMutations = [];
  const helperStatusChecks = [];
  let nativeListener;
  let nativeMessageForRelease;
  let releaseCreate;
  let helperStatusIndex = 0;
  let helperReadIndex = 0;

  const tabsById = new Map();
  if (motherTab) tabsById.set(motherTab.id, motherTab);
  if (incognitoTab) tabsById.set(incognitoTab.id, incognitoTab);

  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
    postMessage(message) {
      nativeMessages.push(message);
      if (message.command !== "get_totp_lab_challenge") return;
      const respond = () => nativeListener?.({
        request_id: message.request_id,
        ok: true,
        challenge_url: challengeUrl,
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
          const status = helperStatuses[Math.min(helperStatusIndex, helperStatuses.length - 1)] ?? "complete";
          helperStatusIndex += 1;
          helperStatusChecks.push(status);
          return { ...tab, status };
        }
        return tab;
      },
      async create(details) {
        createdTabs.push(details);
        const helperTab = { id: 30, windowId: details.windowId, index: details.index, active: details.active, incognito: false, url: details.url };
        if (!delayCreate) {
          tabsById.set(helperTab.id, helperTab);
          return helperTab;
        }
        return new Promise((resolve) => {
          releaseCreate = () => {
            tabsById.set(helperTab.id, helperTab);
            resolve(helperTab);
          };
        });
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
        if (details.target.tabId === incognitoTab.id) {
          targetExecutions.push(details);
          if (details.func.name === "registerTotpOnPage") {
            if (!incognitoTab.activeTabGranted) throw new Error("incognito_active_tab_required");
            return [{ result: registerResult }];
          }
          if (details.func.name === "fillTotpOnPage") return fillPromise ?? [{ result: fillResult }];
          if (details.func.name === "cancelTotpOnPage") return [{ result: cancelResult }];
        }
        if (details.target.tabId === motherTab.id) return [{ result: { ok: true } }];
        helperExecutions.push(details);
        if (helperReadPromise) return helperReadPromise;
        const result = helperResults[Math.min(helperReadIndex, helperResults.length - 1)] ?? helperResults[helperResults.length - 1] ?? { ok: false, error: "helper_page_not_stable" };
        helperReadIndex += 1;
        return [{ result }];
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

test("refreshes every 15 seconds and stops at the 60-second deadline", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperResults: [
      { ok: false, error: "code_not_present" },
      { ok: false, error: "code_not_present" },
      { ok: false, error: "code_not_present" },
      { ok: false, error: "code_not_present" },
      { ok: false, error: "code_not_present" },
    ],
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1", now: clock.now, sleep: clock.sleep });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "totp_code_not_found" });
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
  assert.equal(clock.elapsed, 60_000);
  assert.equal(chrome.helperExecutions.length, 5);
});

test("does not reload when the helper returns an ambiguous code", async () => {
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "totp_code_ambiguous" }] });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "totp_code_ambiguous" });
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.equal(chrome.helperExecutions.length, 1);
});

test("waits for the helper page to complete loading before reading", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperStatuses: ["loading", "loading", "complete"],
    helperResults: [{ ok: true, code: "123456" }],
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1", now: clock.now, sleep: clock.sleep });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "SUCCEEDED", runId: "run-1", error: "" });
  assert.ok(chrome.helperStatusChecks.length >= 3);
  assert.equal(chrome.helperExecutions.length, 1);
});

test("returns helper_page_not_stable when the helper never reaches complete", async () => {
  const clock = makeClock();
  const chrome = makeChrome({
    helperStatuses: Array.from({ length: 200 }, () => "loading"),
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1", now: clock.now, sleep: clock.sleep });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "helper_page_not_stable" });
  assert.equal(chrome.helperExecutions.length, 0);
  assert.deepEqual(chrome.reloadedTabs, []);
});

test("cancels only the helper tab and best-effort cancels the target page", async () => {
  const clock = makeClock({ pause: true });
  const chrome = makeChrome({ helperResults: [{ ok: false, error: "code_not_present" }] });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1", now: clock.now, sleep: clock.sleep });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.reloadedTabs, []);
  assert.deepEqual(chrome.targetExecutions.map((entry) => entry.func.name), ["registerTotpOnPage", "cancelTotpOnPage"]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "fillTotpOnPage"), false);
});

test("cancel aborts a pending helper read and cleans up the helper", async () => {
  const chrome = makeChrome({ helperReadPromise: new Promise(() => {}) });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.helperExecutions.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]);

  assert.deepEqual(result, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.targetExecutions.some((entry) => entry.func.name === "fillTotpOnPage"), false);
});

test("cancel while native challenge is pending prevents late helper creation", async () => {
  const chrome = makeChrome({ delayNative: true });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
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
  assert.deepEqual(chrome.reloadedTabs, []);
});

test("cancel while helper creation is pending removes the late helper exactly once", async () => {
  const chrome = makeChrome({ delayCreate: true });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.createdTabs.length === 1);
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  chrome.releaseCreate();
  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]);

  assert.deepEqual(result, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.equal(chrome.helperExecutions.length, 0);
  assert.deepEqual(chrome.reloadedTabs, []);
});

test("cancel while fill is pending settles cancelled promptly", async () => {
  const chrome = makeChrome({ fillPromise: new Promise(() => {}) });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const running = controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  await waitUntil(() => chrome.targetExecutions.some((entry) => entry.func.name === "fillTotpOnPage"));
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ state: "HUNG" }), 100)),
  ]);

  assert.deepEqual(result, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.reloadedTabs, []);
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

test("returns request_invalid for the physical header row without opening a helper", async () => {
  const chrome = makeChrome();
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 1 });

  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "request_invalid" });
  assert.equal(chrome.nativeMessages.length, 0);
  assert.equal(chrome.targetExecutions.length, 0);
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.removedTabs.length, 0);
});

test("returns target_host_permission_required when the target incognito tab injection is denied", async () => {
  const chrome = makeChrome({
    incognitoTab: { id: 20, windowId: 2, index: 1, active: false, incognito: true, activeTabGranted: false },
  });
  const controller = createTotpLabController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

  assert.equal(result.error, "target_host_permission_required");
  assert.equal(chrome.createdTabs.length, 0);
  assert.equal(chrome.removedTabs.length, 0);
});
