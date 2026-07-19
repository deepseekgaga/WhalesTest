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
  const state = createWorkflowState({
    batchId: "batch-001",
    motherTabId: 10,
    motherWindowId: 20,
    expectedOrigin: "https://mother.example",
    now: () => Date.parse("2026-03-21T10:58:00.000Z"),
  });

  assert.equal(state.batchId, "batch-001");
  assert.equal(state.sequence, 1);
  assert.equal(state.excelRow, 2);
  assert.equal(state.stage, "ROW_PREFLIGHT");
  assert.equal(state.running, true);
  assert.equal(state.error, "");
  assert.equal(state.createdAt, "2026-03-21T10:58:00.000Z");
  assert.equal(state.updatedAt, "2026-03-21T10:58:00.000Z");
  assert.equal(state.motherTabId, 10);
  assert.equal(state.motherWindowId, 20);
  assert.equal(state.expectedOrigin, "https://mother.example");
  assert.ok(TERMINAL_STAGES.has("COMPLETED"));
  assert.ok(TERMINAL_STAGES.has("FAILED"));
  assert.ok(TERMINAL_STAGES.has("CANCELLED"));
  assert.ok(Object.isFrozen(TERMINAL_STAGES));
});

test("nextRowState only advances one row when excelRow matches sequence plus one", () => {
  const first = createWorkflowState({ batchId: "batch-001", now: () => Date.parse("2026-03-21T10:58:00.000Z") });
  const second = nextRowState(first, { excelRow: 3, now: () => Date.parse("2026-03-21T10:59:00.000Z") });

  assert.equal(second.sequence, 2);
  assert.equal(second.excelRow, 3);
  assert.equal(second.stage, "ROW_PREFLIGHT");
  assert.equal(second.updatedAt, "2026-03-21T10:59:00.000Z");
  assert.equal(first.sequence, 1);

  for (const excelRow of [2, 4, 3.5, "3", NaN]) {
    assert.throws(
      () => nextRowState(first, { excelRow }),
      (error) => error?.message === "sequence_invalid",
    );
  }
});

test("formatAccountName formats minute precision account names and rejects invalid input", () => {
  assert.equal(formatAccountName({ at: new Date("2026-07-19T14:38:52Z"), sequence: 3 }), "20260719-1438 SHARKPIX PLUS 3");
  assert.equal(formatAccountName({ at: "2026-07-19T14:38:00Z", sequence: 1 }), "20260719-1438 SHARKPIX PLUS 1");

  for (const input of [
    { at: "invalid", sequence: 1 },
    { at: new Date("invalid"), sequence: 1 },
    { at: new Date("2026-07-19T14:38:00Z"), sequence: 0 },
    { at: new Date("2026-07-19T14:38:00Z"), sequence: 1.5 },
  ]) {
    assert.throws(
      () => formatAccountName(input),
      (error) => error?.message === "account_name_invalid",
    );
  }
});

test("publicWorkflowState exposes only safe fields and returns a fixed idle state for null", () => {
  assert.deepEqual(publicWorkflowState(null), {
    running: false,
    state: "IDLE",
    batchId: null,
    sequence: null,
    excelRow: null,
    error: "",
    updatedAt: null,
  });

  const publicState = publicWorkflowState({
    running: true,
    state: "RUNNING",
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
    state: "RUNNING",
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
