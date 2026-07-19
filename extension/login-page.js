export async function submitLoginOnPage({ runId, requireExistingToken = false, username, password, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (typeof username !== "string" || username.length === 0 || typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "credentials_invalid" };
  }
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
  const styleFor = (node) => documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    if (node.hidden === true || node.getAttribute?.("hidden") !== null || node.getAttribute?.("aria-hidden") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = styleFor(node);
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
  const waitFor = async (read, missingError) => {
    while (true) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const value = read();
      if (value?.error) return value;
      if (value?.element) return value;
      if (remainingMs() <= 0) break;
      const quiet = await boundedQuiet();
      if (quiet.error) return quiet;
      const slept = await guardedSleep(50);
      if (slept.error === "workflow_cancelled") return slept;
      if (slept.error === "page_not_stable") break;
    }
    return { error: missingError };
  };
  const setValue = async (node, value) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    let prototype = Object.getPrototypeOf(node);
    let assigned = false;
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(node, value);
        assigned = true;
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!assigned) node.value = value;
    node.dispatchEvent?.(new EventCtor("input", { bubbles: true }));
    node.dispatchEvent?.(new EventCtor("change", { bubbles: true }));
    if (node.value !== value) return { error: "login_input_rejected" };
    return boundedQuiet();
  };
  const clickAction = async (node) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.scrollIntoView?.({ block: "center" });
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.click?.();
    return boundedQuiet();
  };

  const usernameField = await waitFor(() => uniqueBySelector(configured.loginUsername), "element_missing");
  if (usernameField.error) return { ok: false, error: usernameField.error };
  const passwordField = await waitFor(() => uniqueBySelector(configured.loginPassword), "element_missing");
  if (passwordField.error) return { ok: false, error: passwordField.error };
  const usernameSet = await setValue(usernameField.element, username);
  if (usernameSet.error) return { ok: false, error: usernameSet.error };
  const passwordSet = await setValue(passwordField.element, password);
  if (passwordSet.error) return { ok: false, error: passwordSet.error };

  let submit = uniqueBySelector(configured.loginSubmitButton);
  if (submit.error) return { ok: false, error: submit.error };
  if (!submit.element) {
    submit = uniqueBySelector("button[type='submit']");
  }
  if (submit.error) return { ok: false, error: submit.error };
  if (!submit.element) return { ok: false, error: "element_missing" };
  const clicked = await clickAction(submit.element);
  if (clicked.error) return { ok: false, error: clicked.error };
  return { ok: true };
}

export async function detectTotpStageOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
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

  while (true) {
    if (checkAbort()) return { ok: false, error: "workflow_cancelled" };
    const loginError = uniqueBySelector(configured.loginError);
    if (loginError.error) return { ok: false, error: loginError.error };
    if (loginError.element) {
      const quiet = await boundedQuiet();
      if (quiet.error) return { ok: false, error: quiet.error };
      return { ok: false, error: "login_rejected" };
    }
    const totpStage = uniqueBySelector(configured.totpStage);
    if (totpStage.error) return { ok: false, error: totpStage.error };
    if (totpStage.element) {
      const quiet = await boundedQuiet();
      if (quiet.error) return { ok: false, error: quiet.error };
      return { ok: true };
    }
    if (remainingMs() <= 0) break;
    const quiet = await boundedQuiet();
    if (quiet.error) {
      if (quiet.error === "page_not_stable") break;
      return { ok: false, error: quiet.error };
    }
    const slept = await guardedSleep(50);
    if (slept.error === "workflow_cancelled") return { ok: false, error: slept.error };
    if (slept.error === "page_not_stable") break;
  }
  return { ok: false, error: "totp_stage_not_reached" };
}
