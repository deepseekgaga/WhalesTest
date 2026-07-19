export async function clickAcceptOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject) return { ok: false, error: "request_invalid" };
  const configured = selectors ?? {};
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const realStarted = realNow();
  const remainingMs = () => {
    const logicalElapsed = Number(now()) - Number(started);
    const logicalRemaining = Number.isFinite(logicalElapsed) && logicalElapsed > 0 ? timeoutMs - logicalElapsed : timeoutMs;
    return Math.max(0, Math.min(logicalRemaining, timeoutMs - (realNow() - realStarted)));
  };
  const checkAbort = () => signal?.aborted;
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    if (node.hidden === true || node.getAttribute?.("hidden") !== null || node.getAttribute?.("aria-hidden") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const boundedQuiet = async () => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    const remaining = remainingMs();
    if (remaining <= 0 && !env.waitForQuiet) return { error: "page_not_stable" };
    return new Promise((resolve, reject) => {
      const Observer = env.MutationObserver ?? globalThis.MutationObserver;
      let quietTimer;
      let deadlineTimer;
      let observer;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        observer?.disconnect?.();
        signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => done({ error: "workflow_cancelled" });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable" }), Math.max(1, remaining));
      try {
        if (env.waitForQuiet) {
          Promise.resolve(env.waitForQuiet(quietMs, signal)).then(() => done({ ok: true }), reject);
          return;
        }
        if (!Observer || !documentObject.documentElement) {
          quietTimer = setTimeout(() => done({ ok: true }), quietMs);
          return;
        }
        observer = new Observer(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => done({ ok: true }), quietMs);
        });
        observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        quietTimer = setTimeout(() => done({ ok: true }), quietMs);
      } catch (error) {
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        observer?.disconnect?.();
        signal?.removeEventListener?.("abort", onAbort);
        reject(error);
      }
    });
  };
  const allBySelector = (selector) => {
    if (typeof selector !== "string" || selector.length === 0) return { nodes: [] };
    try {
      const all = Array.from(documentObject.querySelectorAll?.(selector) ?? []);
      if (all.length > 0) return { nodes: all };
      const one = documentObject.querySelector?.(selector);
      return { nodes: one ? [one] : [] };
    } catch {
      return { error: "selector_not_configured" };
    }
  };
  const uniqueBySelector = (selector) => {
    const selected = allBySelector(selector);
    if (selected.error) return { error: selected.error };
    const matches = selected.nodes.filter(visible);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const uniqueAcceptFallback = () => {
    let candidates;
    try {
      candidates = Array.from(documentObject.querySelectorAll?.("button,[role='button']") ?? []);
    } catch {
      return { error: "selector_not_configured" };
    }
    const matches = candidates.filter((node) => visible(node) && ["Accept", "\u63a5\u53d7"].includes(String(node.textContent ?? "").trim()));
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };

  let accept = uniqueBySelector(configured.acceptButton);
  if (accept.error) return { ok: false, error: accept.error };
  if (!accept.element) accept = uniqueAcceptFallback();
  if (accept.error) return { ok: false, error: accept.error };
  if (!accept.element) return { ok: false, error: "accept_button_missing" };
  if (checkAbort()) return { ok: false, error: "workflow_cancelled" };
  accept.element.scrollIntoView?.({ block: "center" });
  if (checkAbort()) return { ok: false, error: "workflow_cancelled" };
  accept.element.click?.();
  const quiet = await boundedQuiet();
  if (quiet.error) return { ok: false, error: quiet.error };
  return { ok: true };
}

export async function detectFinalPageOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject) return { ok: false, error: "request_invalid" };
  const configured = selectors ?? {};
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const realStarted = realNow();
  const remainingMs = () => {
    const logicalElapsed = Number(now()) - Number(started);
    const logicalRemaining = Number.isFinite(logicalElapsed) && logicalElapsed > 0 ? timeoutMs - logicalElapsed : timeoutMs;
    return Math.max(0, Math.min(logicalRemaining, timeoutMs - (realNow() - realStarted)));
  };
  const checkAbort = () => signal?.aborted;
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    if (node.hidden === true || node.getAttribute?.("hidden") !== null || node.getAttribute?.("aria-hidden") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const guardedSleep = async (ms) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    const remaining = remainingMs();
    if (remaining <= 0 && !env.waitForQuiet) return { error: "page_not_stable" };
    return new Promise((resolve, reject) => {
      let timeoutTimer;
      let deadlineTimer;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(deadlineTimer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => done({ error: "workflow_cancelled" });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable" }), Math.max(1, remaining));
      try {
        const waited = env.sleep ? Promise.resolve(sleep(ms)) : new Promise((sleepResolve) => { timeoutTimer = setTimeout(sleepResolve, ms); });
        waited.then(() => done({ ok: true }), reject);
      } catch (error) {
        reject(error);
      }
    });
  };
  const boundedQuiet = async () => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    const remaining = remainingMs();
    if (remaining <= 0 && !env.waitForQuiet) return { error: "page_not_stable" };
    return new Promise((resolve, reject) => {
      const Observer = env.MutationObserver ?? globalThis.MutationObserver;
      let quietTimer;
      let deadlineTimer;
      let observer;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        observer?.disconnect?.();
        signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => done({ error: "workflow_cancelled" });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable" }), Math.max(1, remaining));
      try {
        if (env.waitForQuiet) {
          Promise.resolve(env.waitForQuiet(quietMs, signal)).then(() => done({ ok: true }), reject);
          return;
        }
        if (!Observer || !documentObject.documentElement) {
          quietTimer = setTimeout(() => done({ ok: true }), quietMs);
          return;
        }
        observer = new Observer(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => done({ ok: true }), quietMs);
        });
        observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        quietTimer = setTimeout(() => done({ ok: true }), quietMs);
      } catch (error) {
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        observer?.disconnect?.();
        signal?.removeEventListener?.("abort", onAbort);
        reject(error);
      }
    });
  };
  const allBySelector = (selector) => {
    if (typeof selector !== "string" || selector.length === 0) return { nodes: [] };
    try {
      const all = Array.from(documentObject.querySelectorAll?.(selector) ?? []);
      if (all.length > 0) return { nodes: all };
      const one = documentObject.querySelector?.(selector);
      return { nodes: one ? [one] : [] };
    } catch {
      return { error: "selector_not_configured" };
    }
  };
  const uniqueBySelector = (selector) => {
    const selected = allBySelector(selector);
    if (selected.error) return { error: selected.error };
    const matches = selected.nodes.filter(visible);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const isReady = () => documentObject.readyState === "complete" || documentObject.readyState === "interactive";

  while (true) {
    if (checkAbort()) return { ok: false, error: "workflow_cancelled" };
    if (typeof configured.finalPageReady === "string" && configured.finalPageReady.length > 0) {
      const marker = uniqueBySelector(configured.finalPageReady);
      if (marker.error) return { ok: false, error: marker.error };
      if (marker.element) {
        const quiet = await boundedQuiet();
        if (quiet.error) return { ok: false, error: quiet.error };
        return { ok: true };
      }
    } else if (isReady()) {
      const quiet = await boundedQuiet();
      if (quiet.error) return { ok: false, error: quiet.error };
      return { ok: true };
    }
    if (remainingMs() <= 0) break;
    const slept = await guardedSleep(50);
    if (slept.error === "workflow_cancelled") return { ok: false, error: slept.error };
    if (slept.error === "page_not_stable") break;
  }
  return { ok: false, error: "page_not_stable" };
}
