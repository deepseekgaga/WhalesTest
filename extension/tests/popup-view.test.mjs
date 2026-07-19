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
