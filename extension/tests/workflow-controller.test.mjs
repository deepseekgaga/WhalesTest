import test from "node:test";
import assert from "node:assert/strict";
import { createNativeRequest, createWorkflowController } from "../workflow-controller.js";
import { WORKFLOW_SELECTORS } from "../workflow-selectors.js";
import { createWorkflowState } from "../workflow-state.js";

const configuredSelectors = Object.freeze({
  ...WORKFLOW_SELECTORS,
  motherFinalUrlInput: "#result-url",
  motherFinalConfirmButton: "#save-result",
  motherFinalSuccess: ".save-success",
});

function minimalOptions(overrides = {}) {
  return {
    now: () => 1_000,
    makeBatchId: () => "batch-0000",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async () => ({ ok: false, error: "excel_exhausted" }),
    pageActions: {},
    totpLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => {} },
    smsLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => {} },
    ...overrides,
  };
}

function makeChrome({ motherUrl = "http://127.0.0.1:9527/", noActiveTab = false, rejectAlarmCreate = false, rejectTabsQuery = false, rejectTabsUpdate = false } = {}) {
  const session = {};
  const alarms = new Map();
  const tabs = noActiveTab
    ? new Map()
    : new Map([[10, { id: 10, windowId: 1, index: 0, active: true, incognito: false, url: motherUrl, status: "complete" }]]);
  const windows = new Map([[1, { id: 1, incognito: false, focused: true }]]);
  let nextTabId = 20;
  let nextWindowId = 2;
  const calls = [];
  return {
    calls,
    session,
    alarmsByName: alarms,
    tabsById: tabs,
    windowsById: windows,
    runtime: {
      id: "extension-id",
      connectNative() {
        throw new Error("connectNative not stubbed");
      },
    },
    storage: {
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, structuredClone(values)); calls.push(["session.set", structuredClone(values)]); },
        async remove(key) { delete session[key]; calls.push(["session.remove", key]); },
      },
    },
    alarms: {
      async create(name, info) {
        calls.push(["alarm.create", name, info]);
        if (rejectAlarmCreate === true || rejectAlarmCreate === name) throw new Error("secret123");
        alarms.set(name, { name, ...info });
      },
      async clear(name) { calls.push(["alarm.clear", name]); return alarms.delete(name); },
    },
    tabs: {
      async query(query) {
        if (rejectTabsQuery) throw new Error("active tab raw secret");
        if (query.active && query.currentWindow) return [...tabs.values()].filter((tab) => tab.active && tab.windowId === 1);
        return [...tabs.values()].filter((tab) => query.incognito == null || tab.incognito === query.incognito);
      },
      async get(id) { const tab = tabs.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return { ...tab }; },
      async update(id, changes) {
        calls.push(["tabs.update", id, changes]);
        if (rejectTabsUpdate) throw new Error("secret123");
        Object.assign(tabs.get(id), changes, { status: "complete" });
        return { ...tabs.get(id) };
      },
      async remove(id) { tabs.delete(id); calls.push(["tabs.remove", id]); },
    },
    windows: {
      async create(details) {
        const windowId = nextWindowId++;
        const tabId = nextTabId++;
        windows.set(windowId, { id: windowId, incognito: Boolean(details.incognito), focused: Boolean(details.focused) });
        tabs.set(tabId, { id: tabId, windowId, index: 0, active: true, incognito: Boolean(details.incognito), url: details.url, status: "complete" });
        calls.push(["windows.create", details]);
        return { ...windows.get(windowId), tabs: [{ ...tabs.get(tabId) }] };
      },
      async update(id, changes) { Object.assign(windows.get(id), changes); return { ...windows.get(id) }; },
      async remove(id) { windows.delete(id); for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId); calls.push(["windows.remove", id]); },
    },
    scripting: {
      async executeScript(details) { calls.push(["executeScript", details.func?.name]); return [{ result: { ok: true } }]; },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireNextAlarm(controller, chrome, nowRef) {
  const alarm = [...chrome.alarmsByName.values()][0];
  assert.ok(alarm, "expected one scheduled workflow alarm");
  chrome.alarmsByName.delete(alarm.name);
  if (typeof alarm.when === "number") nowRef.value = Math.max(nowRef.value, alarm.when);
  await controller.onAlarm(alarm);
}

async function reachLogin({ chrome = makeChrome(), now = { value: 1_000 }, options = {} } = {}) {
  const controller = createWorkflowController(chrome, minimalOptions({
    now: () => now.value,
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: {
      prepareMother: async () => ({ ok: true }),
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    },
    ...options,
  }));
  await controller.start();
  while (controller.getState().state !== "LOGIN" && controller.getState().state !== "FAILED") {
    await fireNextAlarm(controller, chrome, now);
  }
  return controller;
}

test("binds sequence one to row two and reaches LOGIN through one owned incognito window", async () => {
  const chrome = makeChrome();
  const now = { value: new Date(2026, 6, 19, 14, 38).getTime() };
  const nativeCalls = [];
  const pageCalls = [];
  const controller = createWorkflowController(chrome, {
    now: () => now.value,
    makeBatchId: () => "batch-0001",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async (command, payload) => {
      nativeCalls.push([command, payload]);
      return { ok: true, username: "alice", password: "secret" };
    },
    pageActions: {
      prepareMother: async (args) => { pageCalls.push(["prepare", args]); return { ok: true }; },
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    },
  });
  await controller.start();
  while (controller.getState().state !== "LOGIN") await fireNextAlarm(controller, chrome, now);
  assert.deepEqual(nativeCalls[0], ["get_workflow_credentials", { excel_row: 2 }]);
  assert.equal(pageCalls[0][1].accountName, "20260719-1438 SHARKPIX PLUS 1");
  assert.equal([...chrome.windowsById.values()].filter((item) => item.incognito).length, 1);
  assert.equal(controller.getState().excelRow, 2);
  assert.equal(chrome.session.workflowState.incognitoTabId, 20);
  assert.equal(Object.hasOwn(chrome.session.workflowState, "password"), false);
});

test("fails before side effects when the active tab is not the exact mother URL", async () => {
  const chrome = makeChrome({ motherUrl: "http://127.0.0.1:9527/other" });
  const controller = createWorkflowController(chrome, minimalOptions());
  const result = await controller.start();
  assert.equal(result.error, "mother_url_invalid");
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
  assert.equal(chrome.calls.some(([name]) => name === "session.set"), false);
  assert.equal(chrome.calls.some(([name]) => name === "alarm.create"), false);
});

test("rejects an incognito mother and unconfigured final selectors", async () => {
  const incognitoMother = makeChrome();
  incognitoMother.tabsById.get(10).incognito = true;
  assert.equal((await createWorkflowController(incognitoMother, minimalOptions()).start()).error, "mother_tab_incognito");
  const missingSelectors = makeChrome();
  assert.equal((await createWorkflowController(missingSelectors, minimalOptions({ selectors: WORKFLOW_SELECTORS })).start()).error, "selector_not_configured");
});

test("rejects missing mother tabs before side effects", async () => {
  const chrome = makeChrome({ noActiveTab: true });
  const result = await createWorkflowController(chrome, minimalOptions()).start();
  assert.equal(result.error, "mother_tab_missing");
  assert.equal(chrome.calls.length, 0);
});

test("completes on row exhaustion before touching the mother page", async () => {
  const chrome = makeChrome();
  let motherCalls = 0;
  const controller = createWorkflowController(chrome, minimalOptions({ pageActions: { prepareMother: async () => { motherCalls += 1; return { ok: true }; } } }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  assert.equal(controller.getState().state, "COMPLETED");
  assert.equal(motherCalls, 0);
});

test("rejects a mismatched authorization origin before creating incognito", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: { prepareMother: async () => ({ ok: true }), generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://evil.local/start" }) },
  }));
  await controller.start();
  for (let index = 0; index < 3; index += 1) await fireNextAlarm(controller, chrome, { value: 1_000 + index });
  assert.equal(controller.getState().error, "authorization_origin_mismatch");
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
});

test("maps both workflow page injection rejection paths to target_host_permission_required", async () => {
  for (const rejectedFunction of ["registerWorkflowOnPage", "prepareMotherAccountOnPage"]) {
    const chrome = makeChrome();
    chrome.scripting.executeScript = async ({ func }) => {
      if (func?.name === rejectedFunction) throw new Error("Cannot access contents of the page");
      return [{ result: { ok: true } }];
    };
    const controller = createWorkflowController(chrome, minimalOptions({
      pageActions: undefined,
      requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    }));
    await controller.start();
    await fireNextAlarm(controller, chrome, { value: 1_000 });
    await fireNextAlarm(controller, chrome, { value: 1_001 });
    assert.equal(controller.getState().error, "target_host_permission_required", rejectedFunction);
  }
});

test("enforces existing workflow and CC batch mutual exclusion", async () => {
  const chrome = makeChrome();
  chrome.session.workflowState = createWorkflowState({
    batchId: "batch-old1",
    motherTabId: 10,
    motherWindowId: 1,
    now: 500,
  });
  let controller = createWorkflowController(chrome, minimalOptions());
  assert.equal((await controller.start()).error, "workflow_running");

  const ccChrome = makeChrome();
  controller = createWorkflowController(ccChrome, minimalOptions({ isCcBatchRunning: () => true }));
  assert.equal((await controller.start()).error, "another_workflow_running");
  assert.equal(ccChrome.calls.length, 0);
});

test("allows only one concurrent start to create and schedule a workflow", async () => {
  const chrome = makeChrome();
  let nextBatch = 1;
  const controller = createWorkflowController(chrome, minimalOptions({
    makeBatchId: () => `batch-000${nextBatch++}`,
  }));

  const results = await Promise.all([controller.start(), controller.start()]);
  assert.equal(results.filter((result) => result.error === "workflow_running").length, 1);
  assert.equal(results.filter((result) => result.state === "ROW_PREFLIGHT").length, 1);
  assert.equal(chrome.calls.filter(([name]) => name === "session.set").length, 1);
  assert.equal(chrome.calls.filter(([name]) => name === "alarm.create").length, 1);
  assert.equal(chrome.session.workflowState.batchId, [...chrome.alarmsByName.values()][0].name.replace("whalestest-workflow:", ""));
});

test("ignores unrelated and old alarms", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => { throw new Error("should_not_run"); },
  }));
  await controller.start();
  await controller.onAlarm({ name: "other" });
  await controller.onAlarm({ name: "whalestest-workflow:batch-old1" });
  assert.equal(controller.getState().state, "ROW_PREFLIGHT");
});

test("persists failures from stage exceptions with fixed FAILED state", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => { throw new Error("credentials_invalid"); },
  }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  assert.equal(controller.getState().state, "FAILED");
  assert.equal(controller.getState().error, "credentials_invalid");
  assert.equal(chrome.session.workflowState.stage, "FAILED");
});

test("does not let a cancelled in-flight stage transition or schedule after it resolves", async () => {
  const chrome = makeChrome();
  const heldPrepare = deferred();
  let prepareStarted = false;
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: {
      prepareMother: async () => {
        prepareStarted = true;
        await heldPrepare.promise;
        return { ok: true };
      },
    },
  }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  const alarm = [...chrome.alarmsByName.values()][0];
  chrome.alarmsByName.delete(alarm.name);
  const runningAlarm = controller.onAlarm(alarm);
  await tick();
  assert.equal(prepareStarted, true);
  await controller.cancel("batch-0000");
  heldPrepare.resolve();
  await runningAlarm;
  assert.equal(controller.getState().state, "CANCELLED");
  assert.equal(chrome.session.workflowState.stage, "CANCELLED");
  assert.equal(chrome.alarmsByName.size, 0);
  assert.equal(chrome.session.workflowState.error, "");
});

test("maps unknown page action errors through an explicit allowlist", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: {
      prepareMother: async () => ({ ok: false, error: "secret123" }),
    },
  }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  await fireNextAlarm(controller, chrome, { value: 1_001 });
  assert.equal(controller.getState().error, "workflow_failed");
  assert.equal(chrome.session.workflowState.error, "workflow_failed");
  assert.doesNotMatch(JSON.stringify(controller.getState()), /secret123/);
  assert.doesNotMatch(JSON.stringify(chrome.session.workflowState), /secret123/);
});

test("sanitizes active tab query rejection during start", async () => {
  const chrome = makeChrome({ rejectTabsQuery: true });
  const controller = createWorkflowController(chrome, minimalOptions());
  const result = await controller.start();
  assert.equal(result.error, "mother_tab_missing");
  assert.doesNotMatch(JSON.stringify(result), /active tab raw secret/);
  assert.equal(chrome.calls.some(([name]) => name === "session.set"), false);
});

test("persists a fixed workflow failure when alarm scheduling rejects", async () => {
  const chrome = makeChrome({ rejectAlarmCreate: true });
  const controller = createWorkflowController(chrome, minimalOptions());
  const result = await controller.start();
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "workflow_failed");
  assert.equal(chrome.session.workflowState.stage, "FAILED");
  assert.equal(chrome.session.workflowState.error, "workflow_failed");
});

test("persists a fixed stage failure when transition scheduling rejects", async () => {
  const chrome = makeChrome();
  let alarmCalls = 0;
  chrome.alarms.create = async (name, info) => {
    chrome.calls.push(["alarm.create", name, info]);
    alarmCalls += 1;
    if (alarmCalls > 1) throw new Error("secret123");
    chrome.alarmsByName.set(name, { name, ...info });
  };
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
  }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  assert.equal(controller.getState().state, "FAILED");
  assert.equal(controller.getState().error, "workflow_failed");
  assert.doesNotMatch(JSON.stringify(chrome.session.workflowState), /secret123/);
});

test("resume converts alarm scheduling rejection into a persisted workflow failure", async () => {
  const chrome = makeChrome({ rejectAlarmCreate: true });
  chrome.session.workflowState = createWorkflowState({
    batchId: "batch-old1",
    motherTabId: 10,
    motherWindowId: 1,
    now: 500,
  });
  const controller = createWorkflowController(chrome, minimalOptions());
  const result = await controller.resume();
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "workflow_failed");
  assert.equal(chrome.session.workflowState.stage, "FAILED");
});

test("fails when incognito window creation is denied or malformed", async () => {
  const chrome = makeChrome();
  chrome.windows.create = async () => { throw new Error("Incognito disabled"); };
  const controller = await reachLogin({ chrome });
  assert.equal(controller.getState().state, "FAILED");
  assert.equal(controller.getState().error, "incognito_access_required");
});

test("rejects ambiguous batch markers without creating another window", async () => {
  const chrome = makeChrome();
  chrome.tabsById.set(30, { id: 30, windowId: 3, index: 0, active: true, incognito: true, url: "about:blank#whalestest-handoff-batch-0000" });
  chrome.tabsById.set(31, { id: 31, windowId: 4, index: 0, active: true, incognito: true, url: "about:blank#whalestest-handoff-batch-0000" });
  chrome.windowsById.set(3, { id: 3, incognito: true, focused: true });
  chrome.windowsById.set(4, { id: 4, incognito: true, focused: true });
  const controller = await reachLogin({ chrome });
  assert.equal(controller.getState().error, "incognito_window_ambiguous");
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
});

test("adopts an existing marker after worker-like restart", async () => {
  const chrome = makeChrome();
  chrome.tabsById.set(30, { id: 30, windowId: 3, index: 0, active: true, incognito: true, url: "about:blank#whalestest-handoff-batch-0000" });
  chrome.windowsById.set(3, { id: 3, incognito: true, focused: true });
  const controller = await reachLogin({ chrome });
  assert.equal(controller.getState().state, "LOGIN");
  assert.equal(chrome.session.workflowState.incognitoTabId, 30);
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
  assert.deepEqual(chrome.calls.find(([name]) => name === "tabs.update"), ["tabs.update", 30, { url: "http://auth-target.local/start?id=7", active: true }]);
});

test("retains failed incognito handoff windows and ids for diagnosis without public leakage", async () => {
  const chrome = makeChrome({ rejectTabsUpdate: true });
  const controller = await reachLogin({ chrome });
  assert.equal(controller.getState().state, "FAILED");
  assert.equal(controller.getState().error, "workflow_failed");
  assert.equal(chrome.windowsById.has(2), true);
  assert.equal(chrome.tabsById.has(20), true);
  assert.equal(chrome.session.workflowState.incognitoWindowId, 2);
  assert.equal(chrome.session.workflowState.incognitoTabId, 20);
  assert.equal(Object.hasOwn(controller.getState(), "incognitoWindowId"), false);
  assert.equal(Object.hasOwn(controller.getState(), "incognitoTabId"), false);
  assert.equal(chrome.calls.some(([name]) => name === "windows.remove" || name === "tabs.remove"), false);
});

test("does not create a second window when repeated after LOGIN", async () => {
  const chrome = makeChrome();
  const controller = await reachLogin({ chrome });
  const windowCreates = chrome.calls.filter(([name]) => name === "windows.create").length;
  await controller.onAlarm([...chrome.alarmsByName.values()][0]);
  assert.equal(chrome.calls.filter(([name]) => name === "windows.create").length, windowCreates);
  assert.equal(controller.getState().state, "LOGIN");
});

test("rejects stored non-marker incognito tabs at the wrong origin", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: {
      prepareMother: async () => ({ ok: true }),
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    },
  }));
  await controller.start();
  chrome.session.workflowState.incognitoTabId = 30;
  chrome.session.workflowState.incognitoWindowId = 3;
  chrome.session.workflowState.stage = "OPEN_INCOGNITO";
  chrome.tabsById.set(30, { id: 30, windowId: 3, index: 0, active: true, incognito: true, url: "http://wrong.local/start" });
  chrome.windowsById.set(3, { id: 3, incognito: true, focused: true });
  const restarted = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: {
      prepareMother: async () => ({ ok: true }),
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    },
  }));
  await restarted.onAlarm({ name: "whalestest-workflow:batch-0000" });
  assert.equal(restarted.getState().error, "authorization_origin_mismatch");
});

test("public state and session never include credentials or authorization URL", async () => {
  const chrome = makeChrome();
  const controller = await reachLogin({ chrome });
  const publicState = controller.getState();
  assert.equal(Object.hasOwn(publicState, "motherTabId"), false);
  assert.equal(Object.hasOwn(publicState, "incognitoTabId"), false);
  assert.equal(Object.hasOwn(publicState, "username"), false);
  assert.equal(Object.hasOwn(publicState, "password"), false);
  assert.equal(Object.hasOwn(publicState, "authorizationUrl"), false);
  assert.doesNotMatch(JSON.stringify(chrome.session.workflowState), /alice|secret|authorizationUrl/);
});

test("normalizes target origin configuration before authorization validation", async () => {
  const chrome = makeChrome();
  const controller = await reachLogin({
    chrome,
    options: { targetOrigin: "http://auth-target.local/" },
  });
  assert.equal(controller.getState().state, "LOGIN");
});

test("invalid target origin configuration fails closed without throwing from the factory", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({ targetOrigin: "not a url" }));
  const result = await controller.start();
  assert.equal(result.state, "FAILED");
  assert.equal(result.error, "authorization_origin_mismatch");
  assert.equal(chrome.calls.some(([name]) => name === "session.set"), false);
});

function makeNativePort() {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  const posted = [];
  let disconnected = false;
  return {
    posted,
    get disconnected() { return disconnected; },
    get listenerCount() { return messageListeners.size + disconnectListeners.size; },
    port: {
      onMessage: {
        addListener(listener) { messageListeners.add(listener); },
        removeListener(listener) { messageListeners.delete(listener); },
      },
      onDisconnect: {
        addListener(listener) { disconnectListeners.add(listener); },
        removeListener(listener) { disconnectListeners.delete(listener); },
      },
      postMessage(message) { posted.push(message); },
      disconnect() { disconnected = true; },
    },
    emitMessage(message) {
      for (const listener of [...messageListeners]) listener(message);
    },
    emitDisconnect() {
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

test("default native request resolves only matching request ids and cleans up the port", async () => {
  const native = makeNativePort();
  const requestNative = createNativeRequest({
    runtime: { connectNative: () => native.port },
  }, { now: () => 7, timeoutMs: 100 });

  const pending = requestNative("get_workflow_credentials", { excel_row: 2 });
  assert.deepEqual(Object.keys(native.posted[0]).sort(), ["command", "excel_row", "request_id"]);
  native.emitMessage({ request_id: "wrong", ok: true, username: "ignored", password: "ignored" });
  native.emitMessage({ request_id: native.posted[0].request_id, ok: true, username: "alice", password: "secret" });

  assert.deepEqual(await pending, { request_id: native.posted[0].request_id, ok: true, username: "alice", password: "secret" });
  assert.equal(native.disconnected, true);
  assert.equal(native.listenerCount, 0);
});

test("default native request maps disconnect and timeout to native_host_unavailable", async () => {
  const disconnected = makeNativePort();
  const disconnectedRequest = createNativeRequest({
    runtime: { connectNative: () => disconnected.port },
  }, { now: () => 8, timeoutMs: 100 });
  const disconnectedPending = disconnectedRequest("get_workflow_credentials", { excel_row: 2 });
  disconnected.emitDisconnect();
  await assert.rejects(disconnectedPending, /native_host_unavailable/);
  assert.equal(disconnected.listenerCount, 0);

  const timedOut = makeNativePort();
  const timedOutRequest = createNativeRequest({
    runtime: { connectNative: () => timedOut.port },
  }, { now: () => 9, timeoutMs: 1 });
  await assert.rejects(timedOutRequest("get_workflow_credentials", { excel_row: 2 }), /native_host_unavailable/);
  assert.equal(timedOut.listenerCount, 0);
});

test("default native request rejects reserved payload keys before connecting", async () => {
  let connectCalls = 0;
  const requestNative = createNativeRequest({
    runtime: {
      connectNative() {
        connectCalls += 1;
        throw new Error("should not connect");
      },
    },
  });

  await assert.rejects(requestNative("get_workflow_credentials", { request_id: "evil" }), /request_invalid/);
  await assert.rejects(requestNative("get_workflow_credentials", { command: "evil" }), /request_invalid/);
  assert.equal(connectCalls, 0);
});
