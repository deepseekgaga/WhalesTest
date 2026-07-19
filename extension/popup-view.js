const WORKFLOW_STATES = new Set([
  "IDLE",
  "ROW_PREFLIGHT",
  "MOTHER_ACCOUNT",
  "AUTH_LINK",
  "OPEN_INCOGNITO",
  "LOGIN",
  "LOGIN_WAIT",
  "TOTP",
  "SMS",
  "ACCEPT",
  "FINAL_URL",
  "MOTHER_BACKFILL",
  "COMMIT",
  "CLEANUP",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const WORKFLOW_TERMINAL_LABELS = new Map([
  ["COMPLETED", "已完成"],
  ["FAILED", "失败"],
  ["CANCELLED", "已取消"],
]);

const WORKFLOW_STATE_LABELS = new Map([
  ["IDLE", "待机"],
  ["ROW_PREFLIGHT", "准备中"],
  ["MOTHER_ACCOUNT", "填写母页"],
  ["AUTH_LINK", "生成授权链接"],
  ["OPEN_INCOGNITO", "打开无痕窗口"],
  ["LOGIN", "登录中"],
  ["LOGIN_WAIT", "等待验证"],
  ["TOTP", "检测验证码"],
  ["SMS", "提交短信"],
  ["ACCEPT", "确认接受"],
  ["FINAL_URL", "回填最终链接"],
  ["MOTHER_BACKFILL", "回填母页"],
  ["COMMIT", "提交结果"],
  ["CLEANUP", "清理中"],
  ["FAILED", "失败"],
  ["CANCELLED", "已取消"],
  ["COMPLETED", "已完成"],
]);

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
  const state = typeof workflow.state === "string" && WORKFLOW_STATES.has(workflow.state) ? workflow.state : "IDLE";
  return {
    running: Boolean(workflow.running),
    state,
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
  if (WORKFLOW_TERMINAL_LABELS.has(workflow.state)) {
    return `状态：${workflow.state}（${WORKFLOW_TERMINAL_LABELS.get(workflow.state)}）`;
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
