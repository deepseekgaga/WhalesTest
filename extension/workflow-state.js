const terminalStages = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

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
