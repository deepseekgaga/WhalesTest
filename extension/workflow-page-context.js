const registryKey = "__whalestestWorkflowRunControllers__";

export function registerWorkflowOnPage({ runId } = {}) {
  if (typeof runId !== "string" || runId.trim().length === 0) return { ok: false, error: "request_invalid" };

  const registry = globalThis[registryKey] instanceof Map ? globalThis[registryKey] : new Map();
  globalThis[registryKey] = registry;
  registry.get(runId)?.abort?.();
  registry.set(runId, new AbortController());
  return { ok: true };
}

export function cancelWorkflowOnPage({ runId } = {}) {
  const registry = globalThis[registryKey] instanceof Map ? globalThis[registryKey] : null;
  const controller = typeof runId === "string" ? registry?.get?.(runId) : null;
  controller?.abort?.();
  registry?.delete?.(runId);
  return { ok: true };
}
