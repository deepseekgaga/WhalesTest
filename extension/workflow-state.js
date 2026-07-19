const terminalStages = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export const WORKFLOW_ERROR_CODES = new Set([
  "accept_button_missing",
  "another_workflow_running",
  "authorization_origin_mismatch",
  "authorization_url_ambiguous",
  "authorization_url_invalid",
  "authorization_url_missing",
  "code_ambiguous",
  "code_invalid",
  "code_not_present",
  "credentials_invalid",
  "cleanup_failed",
  "download_interrupted",
  "download_item_missing",
  "download_timeout",
  "element_ambiguous",
  "element_missing",
  "element_not_found",
  "excel_exhausted",
  "final_url_invalid",
  "final_page_not_ready",
  "group_options_missing",
  "helper_page_not_stable",
  "helper_tab_closed",
  "incognito_access_required",
  "incognito_window_ambiguous",
  "login_input_rejected",
  "login_failed",
  "login_rejected",
  "mother_backfill_failed",
  "mother_tab_incognito",
  "mother_tab_missing",
  "mother_url_invalid",
  "native_host_timeout",
  "native_host_unavailable",
  "otp_page_action_failed",
  "otp_code_invalid",
  "otp_input_not_found",
  "otp_submit_disabled",
  "otp_submit_failed",
  "otp_submit_not_found",
  "otp_submit_unavailable",
  "page_action_failed",
  "page_not_stable",
  "platform_option_missing",
  "request_invalid",
  "selector_not_configured",
  "sms_lab_challenge_failed",
  "sms_lab_failed",
  "sms_page_action_failed",
  "tab_load_timeout",
  "target_host_permission_required",
  "totp_lab_challenge_failed",
  "totp_lab_failed",
  "totp_stage_not_reached",
  "workflow_cancelled",
  "workflow_failed",
  "workflow_page_context_reset",
  "workflow_running",
]);

const retryableWorkflowErrors = new Set([
  "page_not_stable",
  "element_not_found",
  "native_host_timeout",
  "native_host_unavailable",
  "tab_load_timeout",
  "page_action_failed",
]);

export const TERMINAL_STAGES = Object.freeze({
  has(stage) {
    return terminalStages.has(stage);
  },
});

export function createWorkflowState({
  batchId,
  motherTabId,
  motherWindowId,
  now = Date.now(),
} = {}) {
  return {
    batchId,
    stage: "ROW_PREFLIGHT",
    sequence: 1,
    excelRow: 2,
    motherTabId,
    motherWindowId,
    incognitoTabId: null,
    incognitoWindowId: null,
    attempt: 0,
    loginSubmittedAt: null,
    error: "",
    startedAt: now,
    updatedAt: now,
  };
}

export function nextRowState({ sequence, excelRow } = {}) {
  if (
    !Number.isInteger(sequence) ||
    !Number.isInteger(excelRow) ||
    sequence < 1 ||
    excelRow < 2 ||
    excelRow !== sequence + 1
  ) {
    throw new Error("workflow_state_invalid");
  }

  return { sequence: sequence + 1, excelRow: excelRow + 1 };
}

export function formatAccountName(date, sequence) {
  if (!(date instanceof Date) || !Number.isInteger(sequence) || sequence < 1 || Number.isNaN(date.getTime())) {
    throw new Error("account_name_invalid");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute} SHARKPIX PLUS ${sequence}`;
}

export function isRetryableWorkflowError(code) {
  return typeof code === "string" && retryableWorkflowErrors.has(code);
}

export function safeWorkflowError(error, fallback = "workflow_failed") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^[a-z_]+/);
  const code = match?.[0] ?? "";
  return WORKFLOW_ERROR_CODES.has(code) ? code : fallback;
}

export function publicWorkflowState(state) {
  if (!state || typeof state !== "object") {
    return {
      running: false,
      state: "IDLE",
      batchId: null,
      sequence: 0,
      excelRow: 0,
      error: "",
      updatedAt: null,
    };
  }

  return {
    running: !TERMINAL_STAGES.has(state.stage),
    state: state.stage,
    batchId: state.batchId,
    sequence: state.sequence,
    excelRow: state.excelRow,
    error: state.error ?? "",
    updatedAt: state.updatedAt ?? null,
  };
}
