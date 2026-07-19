import { renderPopup } from "./popup-view.js";

const elements = {
  workflowStart: document.querySelector("#workflow-start"),
  workflowStop: document.querySelector("#workflow-stop"),
  workflowStatus: document.querySelector("#workflow-status"),
  workflowSequence: document.querySelector("#workflow-sequence"),
  workflowExcelRow: document.querySelector("#workflow-excel-row"),
  workflowStage: document.querySelector("#workflow-stage"),
  workflowError: document.querySelector("#workflow-error"),
  ccStart: document.querySelector("#start"),
  ccStatus: document.querySelector("#status"),
  ccProgress: document.querySelector("#progress"),
  ccSuccess: document.querySelector("#success"),
  ccFailure: document.querySelector("#failure"),
  ccUrl: document.querySelector("#url"),
  ccError: document.querySelector("#error"),
};

const model = {
  workflow: {},
  cc: {},
};

const syncErrors = {
  workflow: "",
  cc: "",
};

function render() {
  renderPopup(elements, model);
  if (syncErrors.workflow) elements.workflowError.textContent = syncErrors.workflow;
  if (syncErrors.cc) elements.ccError.textContent = syncErrors.cc;
}

function applyWorkflowState(response) {
  if (response?.ok === false) {
    syncErrors.workflow = "错误：状态读取失败";
    render();
    return;
  }
  syncErrors.workflow = "";
  model.workflow = response?.result ?? response ?? {};
  render();
}

function applyCcState(response) {
  if (response?.ok === false) {
    syncErrors.cc = "最近错误：状态读取失败";
    render();
    return;
  }
  syncErrors.cc = "";
  model.cc = response?.result ?? response ?? {};
  render();
}

async function readWorkflowState() {
  try {
    applyWorkflowState(await chrome.runtime.sendMessage({ type: "workflow_state" }));
  } catch {
    syncErrors.workflow = "错误：状态读取失败";
    render();
  }
}

async function readCcState() {
  try {
    applyCcState(await chrome.runtime.sendMessage({ type: "state" }));
  } catch {
    syncErrors.cc = "最近错误：状态读取失败";
    render();
  }
}

elements.workflowStart?.addEventListener("click", async () => {
  elements.workflowStart.disabled = true;
  elements.workflowStop.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "start_workflow" });
  } catch {
    syncErrors.workflow = "错误：状态读取失败";
    render();
  }
  void readWorkflowState();
  void readCcState();
});

elements.workflowStop?.addEventListener("click", async () => {
  elements.workflowStop.disabled = true;
  const batchId = typeof model.workflow?.batchId === "string" ? model.workflow.batchId : undefined;
  try {
    await chrome.runtime.sendMessage(batchId ? { type: "cancel_workflow", batchId } : { type: "cancel_workflow" });
  } catch {
    syncErrors.workflow = "错误：状态读取失败";
    render();
  }
  void readWorkflowState();
});

elements.ccStart?.addEventListener("click", async () => {
  elements.ccStart.disabled = true;
  elements.ccStatus.textContent = "状态：启动中";
  try {
    await chrome.runtime.sendMessage({ type: "start" });
  } catch {
    syncErrors.cc = "最近错误：状态读取失败";
    render();
  }
  void readCcState();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.workflowState) void readWorkflowState();
  if (area === "local" && changes.ccBatchState) applyCcState(changes.ccBatchState.newValue);
});

await Promise.all([readWorkflowState(), readCcState()]);
