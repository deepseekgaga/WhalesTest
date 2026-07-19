import test from "node:test";
import assert from "node:assert/strict";
import { cancelWorkflowOnPage, registerWorkflowOnPage } from "../workflow-page-context.js";

const registryKey = "__whalestestWorkflowRunControllers__";

test("registerWorkflowOnPage stores an AbortController for a run id", () => {
  delete globalThis[registryKey];

  assert.deepEqual(registerWorkflowOnPage({ runId: "run-1" }), { ok: true });

  const registry = globalThis[registryKey];
  assert.ok(registry instanceof Map);
  assert.ok(registry.get("run-1") instanceof AbortController);
  assert.equal(registry.get("run-1").signal.aborted, false);
});

test("registerWorkflowOnPage replaces the same run id by aborting the previous controller", () => {
  delete globalThis[registryKey];
  registerWorkflowOnPage({ runId: "run-1" });
  const first = globalThis[registryKey].get("run-1");

  assert.deepEqual(registerWorkflowOnPage({ runId: "run-1" }), { ok: true });

  const second = globalThis[registryKey].get("run-1");
  assert.equal(first.signal.aborted, true);
  assert.notEqual(second, first);
  assert.equal(second.signal.aborted, false);
});

test("cancelWorkflowOnPage aborts and deletes by run id idempotently", () => {
  delete globalThis[registryKey];
  registerWorkflowOnPage({ runId: "run-1" });
  const controller = globalThis[registryKey].get("run-1");

  assert.deepEqual(cancelWorkflowOnPage({ runId: "run-1" }), { ok: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(globalThis[registryKey].has("run-1"), false);
  assert.deepEqual(cancelWorkflowOnPage({ runId: "run-1" }), { ok: true });
});

test("registerWorkflowOnPage rejects empty run ids without creating the registry", () => {
  for (const runId of ["", null, undefined, 123]) {
    delete globalThis[registryKey];

    assert.deepEqual(registerWorkflowOnPage({ runId }), { ok: false, error: "request_invalid" });
    assert.equal(globalThis[registryKey], undefined);
  }
});
