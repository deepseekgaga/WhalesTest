export async function prepareMotherAccountOnPage({ runId, requireExistingToken = false, accountName, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const PointerEventCtor = env.PointerEvent ?? globalThis.PointerEvent ?? EventCtor;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject || typeof accountName !== "string" || accountName.length === 0) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const configured = selectors ?? {};
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
  const uniqueByText = (text, root = documentObject) => {
    let candidates;
    try {
      candidates = Array.from(root.querySelectorAll?.("button,[role='button'],a") ?? []);
    } catch {
      return { error: "selector_not_configured" };
    }
    const matches = candidates.filter((node) => visible(node) && String(node.textContent ?? "").trim() === text);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const findAction = (selector, text) => {
    const exact = uniqueBySelector(selector);
    if (exact.error || exact.element) return exact;
    return uniqueByText(text);
  };
  const clickAction = async (node, pointer = false) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.scrollIntoView?.({ block: "center" });
    if (pointer) {
      for (const type of ["pointerover", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
        if (checkAbort()) return { error: "workflow_cancelled" };
        node.dispatchEvent?.(new (type.startsWith("pointer") ? PointerEventCtor : EventCtor)(type, { bubbles: true }));
      }
    }
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.click?.();
    return boundedQuiet();
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
    return boundedQuiet();
  };
  const waitFor = async (read, missingError) => {
    while (true) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const value = read();
      if (value?.error) return value;
      if (value?.element) return value;
      if (remainingMs() <= 0) break;
      const quiet = await boundedQuiet();
      if (quiet.error) return quiet.error === "page_not_stable" ? quiet : { error: quiet.error };
      const slept = await guardedSleep(50);
      if (slept.error === "workflow_cancelled") return slept;
      if (slept.error === "page_not_stable") break;
    }
    return { error: missingError };
  };

  const existingSection = uniqueBySelector(configured.generateLinkSection);
  if (existingSection.error) return { ok: false, error: existingSection.error };
  if (existingSection.element) return { ok: true };

  for (const [selector, text] of [[configured.accountManagement, "\u8d26\u53f7\u7ba1\u7406"], [configured.addAccount, "\u6dfb\u52a0\u8d26\u53f7"]]) {
    const target = await waitFor(() => findAction(selector, text), "element_missing");
    if (target.error) return { ok: false, error: target.error };
    const clicked = await clickAction(target.element);
    if (clicked.error) return { ok: false, error: clicked.error };
  }

  let input = uniqueBySelector(configured.accountNameInput);
  if (input.error) return { ok: false, error: input.error };
  if (!input.element) {
    let labels;
    try {
      labels = Array.from(documentObject.querySelectorAll?.("label") ?? []);
    } catch {
      return { ok: false, error: "selector_not_configured" };
    }
    labels = labels.filter((node) => visible(node) && String(node.textContent ?? "").trim() === "\u8d26\u53f7\u540d\u79f0");
    if (labels.length > 1) return { ok: false, error: "element_ambiguous" };
    const label = labels[0];
    const forId = label?.getAttribute?.("for");
    try {
      input = { element: label?.control ?? (forId ? documentObject.getElementById?.(forId) : label?.querySelector?.("input")) ?? null };
    } catch {
      return { ok: false, error: "selector_not_configured" };
    }
  }
  if (!input.element || !visible(input.element)) return { ok: false, error: "element_missing" };
  const filled = await setValue(input.element, accountName);
  if (filled.error) return { ok: false, error: filled.error };

  const platform = await waitFor(() => uniqueBySelector(configured.platformControl), "element_missing");
  if (platform.error) return { ok: false, error: platform.error };
  const opened = await clickAction(platform.element);
  if (opened.error) return { ok: false, error: opened.error };

  const optionSelection = allBySelector(configured.platformOptions);
  if (optionSelection.error) return { ok: false, error: optionSelection.error };
  let options = optionSelection.nodes.filter(visible);
  if (options.length === 0) {
    try {
      options = Array.from(documentObject.querySelectorAll?.("[role='listbox'] [role='option'],[role='option']") ?? []).filter(visible);
    } catch {
      return { ok: false, error: "selector_not_configured" };
    }
  }
  const enabledOptions = options.filter((node) => !node.disabled && node.getAttribute?.("aria-disabled") !== "true");
  if (enabledOptions.length < 2) return { ok: false, error: "platform_option_missing" };
  const selected = await clickAction(enabledOptions[1], true);
  if (selected.error) return { ok: false, error: selected.error };

  const groupContainer = await waitFor(() => uniqueBySelector(configured.groupContainer), "element_missing");
  if (groupContainer.error) return { ok: false, error: groupContainer.error };
  let checkboxes;
  try {
    checkboxes = Array.from(groupContainer.element.querySelectorAll?.("input[type='checkbox']") ?? []).filter(visible);
  } catch {
    return { ok: false, error: "selector_not_configured" };
  }
  if (checkboxes.length === 0) return { ok: false, error: "group_options_missing" };
  for (const checkbox of checkboxes) {
    if (!checkbox.checked) {
      const checked = await clickAction(checkbox);
      if (checked.error) return { ok: false, error: checked.error };
    }
  }

  const next = await waitFor(() => {
    const exact = uniqueBySelector(configured.nextButton);
    if (exact.error || exact.element) return exact;
    let dialogs;
    try {
      dialogs = Array.from(documentObject.querySelectorAll?.("[role='dialog'],dialog") ?? []).filter(visible);
    } catch {
      return { error: "selector_not_configured" };
    }
    for (const dialog of dialogs) {
      const found = uniqueByText("\u4e0b\u4e00\u6b65", dialog);
      if (found.error || found.element) return found;
    }
    return uniqueByText("\u4e0b\u4e00\u6b65");
  }, "element_missing");
  if (next.error) return { ok: false, error: next.error };
  const advanced = await clickAction(next.element);
  if (advanced.error) return { ok: false, error: advanced.error };

  const ready = await waitFor(() => {
    const section = uniqueBySelector(configured.generateLinkSection);
    if (section.error || section.element) return section;
    return uniqueBySelector(configured.generateLinkButton);
  }, "element_missing");
  if (ready.error) return { ok: false, error: ready.error };
  return { ok: true };
}

export async function generateAuthorizationUrlOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const configured = selectors ?? {};
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
    if (remaining <= 0) return { error: "page_not_stable", observedMutation: false };
    return new Promise((resolve, reject) => {
      const Observer = env.MutationObserver ?? globalThis.MutationObserver;
      let quietTimer;
      let deadlineTimer;
      let observer;
      let settled = false;
      let observedMutation = false;
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
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable", observedMutation }), remaining);
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
          observedMutation = true;
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
  const uniqueByText = (text) => {
    let candidates;
    try {
      candidates = Array.from(documentObject.querySelectorAll?.("button,[role='button'],a") ?? []);
    } catch {
      return { error: "selector_not_configured" };
    }
    const matches = candidates.filter((node) => visible(node) && String(node.textContent ?? "").trim() === text);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const readUrl = (node) => {
    let invalidNonEmpty = false;
    for (const value of [node?.value, node?.href, node?.textContent]) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed) continue;
      invalidNonEmpty = true;
      if (/[\u0000-\u001f\u007f]/.test(trimmed)) continue;
      try {
        const parsed = new URL(trimmed);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username === "" && parsed.password === "") {
          return { url: trimmed, invalidNonEmpty: false };
        }
      } catch {
        continue;
      }
    }
    return { url: "", invalidNonEmpty };
  };
  const readUniqueUrl = () => {
    const selected = allBySelector(configured.authorizationUrl);
    if (selected.error) return { error: selected.error };
    const visibleNodes = selected.nodes.filter(visible);
    const reads = visibleNodes.map(readUrl);
    const urls = reads.map((read) => read.url).filter(Boolean);
    if (urls.length > 1) return { error: "authorization_url_ambiguous" };
    return {
      url: urls[0] ?? "",
      hadCandidates: visibleNodes.length > 0,
      invalidNonEmpty: reads.some((read) => read.invalidNonEmpty),
    };
  };
  const clickAction = async (node) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.scrollIntoView?.({ block: "center" });
    node.click?.();
    return boundedQuiet();
  };
  const waitForUrl = async () => {
    while (remainingMs() > 0) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const current = readUniqueUrl();
      if (current.error || current.url) return current;
      const quiet = await boundedQuiet();
      if (quiet.error) {
        if (quiet.error === "page_not_stable" && quiet.observedMutation === false) break;
        return quiet.error === "page_not_stable" ? quiet : { error: quiet.error };
      }
      const slept = await guardedSleep(50);
      if (slept.error === "workflow_cancelled") return slept;
      if (slept.error === "page_not_stable") break;
    }
    return { error: "authorization_url_missing" };
  };

  let current = readUniqueUrl();
  if (current.error) return { ok: false, error: current.error };
  if (!current.url && current.invalidNonEmpty) return { ok: false, error: "authorization_url_missing" };
  if (!current.url) {
    const generator = uniqueBySelector(configured.generateLinkButton);
    const target = generator.error || generator.element ? generator : uniqueByText("\u751f\u6210\u6388\u6743\u94fe\u63a5");
    if (target.error) return { ok: false, error: target.error };
    if (!target.element) return { ok: false, error: "element_missing" };
    const generated = await clickAction(target.element);
    if (generated.error && !(generated.error === "page_not_stable" && env.waitForQuiet)) return { ok: false, error: generated.error };
    current = await waitForUrl();
    if (current.error) return { ok: false, error: current.error };
  }

  const copy = uniqueBySelector(configured.copyUrlButton);
  const copyTarget = copy.error || copy.element ? copy : uniqueByText("COPY URL");
  if (copyTarget.error) return { ok: false, error: copyTarget.error };
  if (!copyTarget.element) return { ok: false, error: "element_missing" };
  copyTarget.element.dispatchEvent?.(new EventCtor("mouseover", { bubbles: true }));
  const copied = await clickAction(copyTarget.element);
  if (copied.error) return { ok: false, error: copied.error };
  return { ok: true, authorizationUrl: current.url };
}

export async function backfillFinalUrlOnPage({ runId, requireExistingToken = false, finalUrl, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const realNow = Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject || typeof finalUrl !== "string" || finalUrl.length === 0) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const configured = selectors ?? {};
  const placeholders = new Set([
    "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
    "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
    "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
  ]);
  for (const key of ["motherFinalUrlInput", "motherFinalConfirmButton", "motherFinalSuccess"]) {
    const value = configured[key];
    if (typeof value !== "string" || value.length === 0 || placeholders.has(value)) {
      return { ok: false, error: "selector_not_configured" };
    }
  }
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
    const rect = node.getBoundingClientRect?.();
    const style = documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const guardedSleep = async (ms) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    const remaining = remainingMs();
    if (remaining <= 0) return { error: "page_not_stable" };
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
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable" }), remaining);
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
    if (remaining <= 0) return { error: "page_not_stable" };
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
      deadlineTimer = setTimeout(() => done({ error: "page_not_stable" }), remaining);
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
    return boundedQuiet();
  };
  const clickAction = async (node) => {
    if (checkAbort()) return { error: "workflow_cancelled" };
    node.scrollIntoView?.({ block: "center" });
    node.click?.();
    return boundedQuiet();
  };
  const waitForSuccess = async () => {
    while (remainingMs() > 0) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const success = uniqueBySelector(configured.motherFinalSuccess);
      if (success.error || success.element) return success;
      const quiet = await boundedQuiet();
      if (quiet.error) return quiet.error === "page_not_stable" ? quiet : { error: quiet.error };
      const slept = await guardedSleep(50);
      if (slept.error === "workflow_cancelled") return slept;
      if (slept.error === "page_not_stable") break;
    }
    return { error: "mother_backfill_failed" };
  };

  const existingSuccess = uniqueBySelector(configured.motherFinalSuccess);
  if (existingSuccess.error) return { ok: false, error: existingSuccess.error };
  if (existingSuccess.element) return { ok: true };

  const input = uniqueBySelector(configured.motherFinalUrlInput);
  if (input.error) return { ok: false, error: input.error };
  if (!input.element) return { ok: false, error: "element_missing" };
  const confirm = uniqueBySelector(configured.motherFinalConfirmButton);
  if (confirm.error) return { ok: false, error: confirm.error };
  if (!confirm.element) return { ok: false, error: "element_missing" };
  const filled = await setValue(input.element, finalUrl);
  if (filled.error) return { ok: false, error: filled.error === "page_not_stable" ? "mother_backfill_failed" : filled.error };
  const confirmed = await clickAction(confirm.element);
  if (confirmed.error) return { ok: false, error: confirmed.error === "page_not_stable" ? "mother_backfill_failed" : confirmed.error };
  const success = await waitForSuccess();
  if (success.error) return { ok: false, error: success.error === "page_not_stable" ? "mother_backfill_failed" : success.error };
  return { ok: true };
}
