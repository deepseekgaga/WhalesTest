import test from "node:test";
import assert from "node:assert/strict";
import { renderPopup } from "../popup-view.js";

function element() {
  return { textContent: "", disabled: false };
}

function elements() {
  return {
    workflowStart: element(),
    workflowStop: element(),
    ccStart: element(),
    workflowStatus: element(),
    workflowSequence: element(),
    workflowExcelRow: element(),
    workflowStage: element(),
    workflowError: element(),
    ccStatus: element(),
    ccProgress: element(),
    ccSuccess: element(),
    ccFailure: element(),
    ccUrl: element(),
    ccError: element(),
  };
}

function popupDom() {
  const map = elements();
  map.workflowStart = clickableButton();
  map.workflowStop = clickableButton();
  map.ccStart = clickableButton();
  const queries = new Map([
    ["#workflow-start", map.workflowStart],
    ["#workflow-stop", map.workflowStop],
    ["#workflow-status", map.workflowStatus],
    ["#workflow-sequence", map.workflowSequence],
    ["#workflow-excel-row", map.workflowExcelRow],
    ["#workflow-stage", map.workflowStage],
    ["#workflow-error", map.workflowError],
    ["#start", map.ccStart],
    ["#status", map.ccStatus],
    ["#progress", map.ccProgress],
    ["#success", map.ccSuccess],
    ["#failure", map.ccFailure],
    ["#url", map.ccUrl],
    ["#error", map.ccError],
  ]);

  return {
    map,
    document: {
      querySelector(selector) {
        return queries.get(selector) ?? null;
      },
    },
  };
}

function clickableButton() {
  return {
    textContent: "",
    disabled: false,
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
  };
}

async function loadPopupModule(sendMessage) {
  const savedDocument = globalThis.document;
  const savedChrome = globalThis.chrome;
  const { map, document } = popupDom();
  const chrome = {
    runtime: {
      id: "ext",
      sendMessage,
    },
    storage: {
      onChanged: {
        addListener() {},
      },
    },
  };

  globalThis.document = document;
  globalThis.chrome = chrome;
  const module = await import(new URL(`../popup.js?case=${Date.now()}-${Math.random()}`, import.meta.url));

  return {
    map,
    module,
    restore() {
      globalThis.document = savedDocument;
      globalThis.chrome = savedChrome;
    },
  };
}

test("renders public workflow and CC state without exposing sensitive fields", () => {
  const ui = elements();
  renderPopup(ui, {
    workflow: {
      running: true,
      state: "ROW_PREFLIGHT",
      sequence: 3,
      excelRow: 4,
      error: "page_not_stable",
      tabId: 77,
      windowId: 88,
      username: "alice",
      password: "secret",
      authorizationUrl: "https://auth.example.test/start",
      finalUrl: "https://final.example.test/home",
      rawSession: "session-secret",
    },
    cc: {
      running: false,
      current: 2,
      total: 8,
      success: 1,
      failure: 1,
      currentUrl: "https://batch.example.test/item",
      lastError: "download_timeout",
      session: { tabId: 99 },
    },
  });

  assert.equal(ui.workflowStart.disabled, true);
  assert.equal(ui.workflowStop.disabled, false);
  assert.equal(ui.ccStart.disabled, true);
  assert.equal(ui.workflowStatus.textContent, "状态：运行中");
  assert.equal(ui.workflowSequence.textContent, "序号：3");
  assert.equal(ui.workflowExcelRow.textContent, "Excel行：4");
  assert.equal(ui.workflowStage.textContent, "阶段：ROW_PREFLIGHT");
  assert.equal(ui.workflowError.textContent, "错误：page_not_stable");
  assert.equal(ui.ccStatus.textContent, "状态：已停止");
  assert.equal(ui.ccProgress.textContent, "进度：2/8");
  assert.equal(ui.ccSuccess.textContent, "成功：1");
  assert.equal(ui.ccFailure.textContent, "失败：1");
  assert.equal(ui.ccUrl.textContent, "当前网址：https://batch.example.test/item");
  assert.equal(ui.ccError.textContent, "最近错误：download_timeout");

  const rendered = Object.values(ui).map((node) => node.textContent).join(" ");
  assert.doesNotMatch(rendered, /alice|secret|authorizationUrl|finalUrl|rawSession|tabId|windowId/);
});

test("renders terminal workflow states with explicit Chinese wording", () => {
  for (const [state, phrase] of [
    ["FAILED", "失败"],
    ["CANCELLED", "已取消"],
    ["COMPLETED", "已完成"],
  ]) {
    const ui = elements();
    renderPopup(ui, {
      workflow: { running: false, state, sequence: 0, excelRow: 0, error: "" },
      cc: {},
    });
    assert.match(ui.workflowStatus.textContent, new RegExp(state));
    assert.match(ui.workflowStatus.textContent, new RegExp(phrase));
  }
});

test("collapses unknown workflow states to idle without echoing raw values", () => {
  const ui = elements();
  renderPopup(ui, {
    workflow: { running: false, state: "__proto__", sequence: 1, excelRow: 2, error: "" },
    cc: {},
  });

  assert.equal(ui.workflowStatus.textContent, "状态：待机");
  assert.equal(ui.workflowStage.textContent, "阶段：IDLE");
  assert.doesNotMatch(Object.values(ui).map((node) => node.textContent).join(" "), /__proto__/);
});

test("workflow commands use fixed route errors and keep the UI locked only while in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { map, restore } = await loadPopupModule(async (message) => {
    if (message.type === "workflow_state") return { ok: true, result: { running: false, state: "IDLE", batchId: null, sequence: 0, excelRow: 0, error: "", updatedAt: null } };
    if (message.type === "state") return { running: false, current: 0, total: 0, success: 0, failure: 0, currentUrl: "", lastError: "" };
    if (message.type === "start_workflow") return pending;
    if (message.type === "cancel_workflow") return pending;
    throw new Error(`unexpected ${message.type}`);
  });

  try {
    const start = map.workflowStart.listeners.get("click");
    const started = start();
    assert.equal(map.workflowStart.disabled, true);
    assert.equal(map.workflowStop.disabled, true);
    assert.equal(map.ccStart.disabled, true);

    release({ ok: false, error: "leak_me" });
    await started;
    await Promise.resolve();

    assert.equal(map.workflowError.textContent, "错误：workflow_route_failed");
    assert.equal(map.workflowStart.disabled, false);
    assert.equal(map.workflowStop.disabled, true);
    assert.equal(map.ccStart.disabled, false);

    map.workflowStop.disabled = false;
    map.workflowStart.disabled = false;
    map.ccStart.disabled = false;

    let cancelPayload;
    const cancelPromise = loadPopupModule(async (message) => {
      if (message.type === "workflow_state") return { ok: true, result: { running: true, state: "ROW_PREFLIGHT", batchId: "batch-7", sequence: 3, excelRow: 4, error: "", updatedAt: 1 } };
      if (message.type === "state") return { running: false, current: 0, total: 0, success: 0, failure: 0, currentUrl: "", lastError: "" };
      if (message.type === "cancel_workflow") {
        cancelPayload = message;
        return { ok: false, error: "still_secret" };
      }
      throw new Error(`unexpected ${message.type}`);
    });

    const second = await cancelPromise;
    try {
      const stop = second.map.workflowStop.listeners.get("click");
      const stopping = stop();
      assert.deepEqual(cancelPayload, { type: "cancel_workflow", batchId: "batch-7" });
      assert.equal(second.map.workflowStart.disabled, true);
      assert.equal(second.map.workflowStop.disabled, true);
      assert.equal(second.map.ccStart.disabled, true);
      await stopping;
      await Promise.resolve();
      assert.equal(second.map.workflowError.textContent, "错误：workflow_route_failed");
    } finally {
      second.restore();
    }
  } finally {
    restore();
  }
});

test("cc command failures use fixed route errors and release the shared lock", async () => {
  const { map, restore } = await loadPopupModule(async (message) => {
    if (message.type === "workflow_state") return { ok: true, result: { running: false, state: "IDLE", batchId: null, sequence: 0, excelRow: 0, error: "", updatedAt: null } };
    if (message.type === "state") return { running: false, current: 0, total: 0, success: 0, failure: 0, currentUrl: "", lastError: "" };
    if (message.type === "start") return { ok: false, error: "cc_secret" };
    throw new Error(`unexpected ${message.type}`);
  });

  try {
    const start = map.ccStart.listeners.get("click");
    await start();
    await Promise.resolve();
    assert.equal(map.ccError.textContent, "最近错误：cc_route_failed");
    assert.equal(map.workflowStart.disabled, false);
    assert.equal(map.workflowStop.disabled, true);
    assert.equal(map.ccStart.disabled, false);
  } finally {
    restore();
  }
});
