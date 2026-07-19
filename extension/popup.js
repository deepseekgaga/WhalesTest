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

const routeErrors = {
  workflow: "",
  cc: "",
};

let commandInFlight = false;

function overlayCommandLock() {
  if (!commandInFlight) return;
  for (const button of [elements.workflowStart, elements.workflowStop, elements.ccStart]) {
    if (button) button.disabled = true;
  }
}

function render() {
  renderPopup(elements, model);
  overlayCommandLock();
  if (routeErrors.workflow) elements.workflowError.textContent = routeErrors.workflow;
  if (routeErrors.cc) elements.ccError.textContent = routeErrors.cc;
}

function applyWorkflowState(response) {
  if (response?.ok === false) {
    routeErrors.workflow = "错误：workflow_route_failed";
    render();
    return;
  }
  model.workflow = response?.result ?? response ?? {};
  if (!commandInFlight) routeErrors.workflow = "";
  render();
}

function applyCcState(response) {
  if (response?.ok === false) {
    routeErrors.cc = "最近错误：cc_route_failed";
    render();
    return;
  }
  model.cc = response?.result ?? response ?? {};
  if (!commandInFlight) routeErrors.cc = "";
  render();
}

async function readWorkflowState() {
  try {
    applyWorkflowState(await chrome.runtime.sendMessage({ type: "workflow_state" }));
  } catch {
    routeErrors.workflow = "错误：workflow_route_failed";
    render();
  }
}

async function readCcState() {
  try {
    applyCcState(await chrome.runtime.sendMessage({ type: "state" }));
  } catch {
    routeErrors.cc = "最近错误：cc_route_failed";
    render();
  }
}

async function refreshState() {
  await Promise.all([readWorkflowState(), readCcState()]);
}

async function runWorkflowCommand(message) {
  commandInFlight = true;
  routeErrors.workflow = "";
  render();
  try {
    const response = await chrome.runtime.sendMessage(message);
    await refreshState();
    if (response?.ok === false) routeErrors.workflow = "错误：workflow_route_failed";
    render();
  } catch {
    await refreshState();
    routeErrors.workflow = "错误：workflow_route_failed";
    render();
  } finally {
    commandInFlight = false;
    render();
  }
}

async function runCcCommand(message) {
  commandInFlight = true;
  routeErrors.cc = "";
  render();
  try {
    const response = await chrome.runtime.sendMessage(message);
    await refreshState();
    if (response?.ok === false) routeErrors.cc = "最近错误：cc_route_failed";
    render();
  } catch {
    await refreshState();
    routeErrors.cc = "最近错误：cc_route_failed";
    render();
  } finally {
    commandInFlight = false;
    render();
  }
}

elements.workflowStart?.addEventListener("click", async () => {
  await runWorkflowCommand({ type: "start_workflow" });
});

elements.workflowStop?.addEventListener("click", async () => {
  const batchId = typeof model.workflow?.batchId === "string" ? model.workflow.batchId : undefined;
  await runWorkflowCommand(batchId ? { type: "cancel_workflow", batchId } : { type: "cancel_workflow" });
});

elements.ccStart?.addEventListener("click", async () => {
  await runCcCommand({ type: "start" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.workflowState) void readWorkflowState();
  if (area === "local" && changes.ccBatchState) applyCcState(changes.ccBatchState.newValue);
});

await refreshState();
