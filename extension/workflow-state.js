export const TERMINAL_STAGES = Object.freeze(new Set(["COMPLETED", "FAILED", "CANCELLED"]));

function timestamp(now) {
  return new Date(now()).toISOString();
}

export function createWorkflowState({
  batchId,
  motherTabId = null,
  motherWindowId = null,
  expectedOrigin = "",
  now = Date.now,
} = {}) {
  const createdAt = timestamp(now);
  return {
    running: true,
    state: "RUNNING",
    batchId,
    sequence: 1,
    excelRow: 2,
    stage: "ROW_PREFLIGHT",
    error: "",
    createdAt,
    updatedAt: createdAt,
    motherTabId,
    motherWindowId,
    expectedOrigin,
  };
}

export function nextRowState(state, { excelRow, now = Date.now } = {}) {
  if (
    !state ||
    !Number.isInteger(state.sequence) ||
    !Number.isInteger(excelRow) ||
    excelRow !== state.sequence + 2
  ) {
    throw new Error("sequence_invalid");
  }

  return {
    ...state,
    sequence: state.sequence + 1,
    excelRow,
    stage: "ROW_PREFLIGHT",
    updatedAt: timestamp(now),
  };
}

export function formatAccountName({ at, sequence } = {}) {
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isInteger(sequence) || sequence < 1 || Number.isNaN(date.getTime())) {
    throw new Error("account_name_invalid");
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute} SHARKPIX PLUS ${sequence}`;
}

export function publicWorkflowState(state) {
  if (state === null) {
    return {
      running: false,
      state: "IDLE",
      batchId: null,
      sequence: null,
      excelRow: null,
      error: "",
      updatedAt: null,
    };
  }

  return {
    running: state.running,
    state: state.state,
    batchId: state.batchId,
    sequence: state.sequence,
    excelRow: state.excelRow,
    error: state.error,
    updatedAt: state.updatedAt,
  };
}
