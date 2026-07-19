import test from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_STAGES,
  createWorkflowState,
  formatAccountName,
  nextRowState,
  publicWorkflowState,
} from "../workflow-state.js";

test("createWorkflowState initializes each batch at the first row preflight state", () => {
  const now = Date.parse("2026-03-21T10:58:00.000Z");
  const state = createWorkflowState({
    batchId: "batch-001",
    motherTabId: 10,
    motherWindowId: 20,
    now,
  });

  assert.deepEqual(state, {
    batchId: "batch-001",
    stage: "ROW_PREFLIGHT",
    sequence: 1,
    excelRow: 2,
    motherTabId: 10,
    motherWindowId: 20,
    incognitoTabId: null,
    incognitoWindowId: null,
    attempt: 0,
    loginSubmittedAt: null,
    error: "",
    startedAt: now,
    updatedAt: now,
  });
  assert.ok(TERMINAL_STAGES.has("COMPLETED"));
  assert.ok(TERMINAL_STAGES.has("FAILED"));
  assert.ok(TERMINAL_STAGES.has("CANCELLED"));
  assert.equal(TERMINAL_STAGES.has("ROW_PREFLIGHT"), false);
  assert.equal(typeof TERMINAL_STAGES.add, "undefined");
  assert.ok(Object.isFrozen(TERMINAL_STAGES));
});

test("nextRowState only advances one row when excelRow matches sequence plus one", () => {
  const second = nextRowState({ sequence: 1, excelRow: 2 });

  assert.deepEqual(second, { sequence: 2, excelRow: 3 });

  for (const state of [
    { sequence: 1, excelRow: 1 },
    { sequence: 1, excelRow: 3 },
    { sequence: 0, excelRow: 1 },
    { sequence: -1, excelRow: 0 },
    { sequence: 1.5, excelRow: 2 },
    { sequence: "1", excelRow: 2 },
    { sequence: true, excelRow: 2 },
    { sequence: 1, excelRow: NaN },
  ]) {
    assert.throws(
      () => nextRowState(state),
      (error) => error?.message === "workflow_state_invalid",
    );
  }
});

test("formatAccountName formats minute precision account names and rejects invalid input", () => {
  assert.equal(formatAccountName(new Date(2026, 6, 19, 14, 38, 52), 3), "20260719-1438 SHARKPIX PLUS 3");

  for (const input of [
    ["2026-07-19T14:38:00Z", 1],
    [new Date("invalid"), 1],
    [new Date(2026, 6, 19, 14, 38), 0],
    [new Date(2026, 6, 19, 14, 38), 1.5],
  ]) {
    assert.throws(
      () => formatAccountName(...input),
      (error) => error?.message === "account_name_invalid",
    );
  }
});

test("publicWorkflowState exposes only safe fields and returns a fixed idle state for null", () => {
  for (const emptyState of [null, undefined, false, 0, ""]) {
    assert.deepEqual(publicWorkflowState(emptyState), {
      running: false,
      state: "IDLE",
      batchId: null,
      sequence: 0,
      excelRow: 0,
      error: "",
      updatedAt: null,
    });
  }

  const publicState = publicWorkflowState({
    stage: "ROW_PREFLIGHT",
    batchId: "batch-001",
    sequence: 1,
    excelRow: 2,
    error: "",
    updatedAt: "2026-03-21T10:58:00.000Z",
    tabId: 77,
    motherTabId: 10,
    motherWindowId: 20,
    incognitoWindowId: 30,
    secret: "do-not-leak",
    password: "do-not-leak",
    otpSecret: "do-not-leak",
  });

  assert.deepEqual(Object.keys(publicState), ["running", "state", "batchId", "sequence", "excelRow", "error", "updatedAt"]);
  assert.deepEqual(publicState, {
    running: true,
    state: "ROW_PREFLIGHT",
    batchId: "batch-001",
    sequence: 1,
    excelRow: 2,
    error: "",
    updatedAt: "2026-03-21T10:58:00.000Z",
  });
  assert.equal(JSON.stringify(publicState).includes("do-not-leak"), false);
  assert.equal(JSON.stringify(publicState).includes("TabId"), false);
  assert.equal(JSON.stringify(publicState).includes("WindowId"), false);
});

test("publicWorkflowState derives not running from terminal stages", () => {
  assert.deepEqual(publicWorkflowState({
    stage: "COMPLETED",
    batchId: "batch-001",
    sequence: 3,
    excelRow: 4,
    error: "",
    updatedAt: 123,
  }), {
    running: false,
    state: "COMPLETED",
    batchId: "batch-001",
    sequence: 3,
    excelRow: 4,
    error: "",
    updatedAt: 123,
  });
});

test("publicWorkflowState defaults optional public fields without changing its shape", () => {
  assert.deepEqual(publicWorkflowState({
    stage: "ROW_PREFLIGHT",
    batchId: "batch-002",
    sequence: 1,
    excelRow: 2,
  }), {
    running: true,
    state: "ROW_PREFLIGHT",
    batchId: "batch-002",
    sequence: 1,
    excelRow: 2,
    error: "",
    updatedAt: null,
  });
});
