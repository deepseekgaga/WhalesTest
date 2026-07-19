const WORKFLOW_TERMINAL_LABELS = {
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

const WORKFLOW_STATE_LABELS = {
  IDLE: "待机",
  ROW_PREFLIGHT: "准备中",
  LOGIN: "登录中",
  LOGIN_WAIT: "等待验证",
  MOTHER_ACCOUNT: "填写母页",
  AUTH_LINK: "生成授权链接",
  OPEN_INCOGNITO: "打开无痕窗口",
  FINAL_URL: "回填最终链接",
  COMMIT: "提交结果",
  CLEANUP: "清理中",
  FAILED: "失败",
  CANCELLED: "已取消",
  COMPLETED: "已完成",
};

function text(element, value) {
  if (element) element.textContent = value;
}

function disabled(element, value) {
  if (element) element.disabled = Boolean(value);
}

function asNumber(value) {
  return Number.isInteger(value) ? value : 0;
}

function normalizeWorkflow(workflow = {}) {
  return {
    running: Boolean(workflow.running),
    state: typeof workflow.state === "string" && workflow.state.length > 0 ? workflow.state : "IDLE",
    sequence: asNumber(workflow.sequence),
    excelRow: asNumber(workflow.excelRow),
    error: typeof workflow.error === "string" ? workflow.error : "",
  };
}

function normalizeCc(cc = {}) {
  return {
    running: Boolean(cc.running),
    current: asNumber(cc.current),
    total: asNumber(cc.total),
    success: asNumber(cc.success),
    failure: asNumber(cc.failure),
    currentUrl: typeof cc.currentUrl === "string" ? cc.currentUrl : "",
    lastError: typeof cc.lastError === "string" ? cc.lastError : "",
  };
}

function workflowStatusText(workflow) {
  if (workflow.state in WORKFLOW_TERMINAL_LABELS) {
    return `状态：${workflow.state}（${WORKFLOW_TERMINAL_LABELS[workflow.state]}）`;
  }
  return workflow.running ? "状态：运行中" : `状态：${WORKFLOW_STATE_LABELS[workflow.state] ?? "待机"}`;
}

function workflowStageText(workflow) {
  return `阶段：${workflow.state}`;
}

function workflowErrorText(workflow) {
  return `错误：${workflow.error || "无"}`;
}

function ccStatusText(cc) {
  if (cc.running) return "状态：执行中";
  if (cc.lastError) return "状态：已停止";
  return "状态：空闲";
}

export function renderPopup(elements = {}, model = {}) {
  const workflow = normalizeWorkflow(model.workflow);
  const cc = normalizeCc(model.cc);

  disabled(elements.workflowStart, workflow.running || cc.running);
  disabled(elements.workflowStop, !workflow.running || workflow.state === "IDLE");
  disabled(elements.ccStart, workflow.running || cc.running);

  text(elements.workflowStatus, workflowStatusText(workflow));
  text(elements.workflowSequence, `序号：${workflow.sequence}`);
  text(elements.workflowExcelRow, `Excel行：${workflow.excelRow}`);
  text(elements.workflowStage, workflowStageText(workflow));
  text(elements.workflowError, workflowErrorText(workflow));

  text(elements.ccStatus, ccStatusText(cc));
  text(elements.ccProgress, `进度：${cc.current}/${cc.total}`);
  text(elements.ccSuccess, `成功：${cc.success}`);
  text(elements.ccFailure, `失败：${cc.failure}`);
  text(elements.ccUrl, cc.currentUrl ? `当前网址：${cc.currentUrl}` : "当前网址：无");
  text(elements.ccError, `最近错误：${cc.lastError || "无"}`);
}
