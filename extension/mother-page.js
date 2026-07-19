export async function prepareMotherAccountOnPage({ runId, requireExistingToken = false, accountName, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const PointerEventCtor = env.PointerEvent ?? globalThis.PointerEvent ?? EventCtor;
  const now = env.now ?? Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject || typeof accountName !== "string" || accountName.length === 0) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitForQuiet = env.waitForQuiet ?? ((ms) => new Promise((resolve) => {
    const Observer = env.MutationObserver ?? globalThis.MutationObserver;
    if (!Observer || !documentObject?.documentElement) return setTimeout(resolve, ms);
    let timer;
    const observer = new Observer(() => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    const done = () => { observer.disconnect(); resolve(); };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, ms);
  }));
  const checkAbort = () => signal?.aborted;
  const styleFor = (node) => documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = styleFor(node);
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const allBySelector = (selector) => {
    if (typeof selector !== "string" || selector.length === 0) return [];
    const all = Array.from(documentObject.querySelectorAll?.(selector) ?? []);
    if (all.length > 0) return all;
    const one = documentObject.querySelector?.(selector);
    return one ? [one] : [];
  };
  const uniqueBySelector = (selector) => {
    const matches = allBySelector(selector).filter(visible);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const uniqueByText = (text, root = documentObject) => {
    const matches = Array.from(root.querySelectorAll?.("button,[role='button'],a") ?? [])
      .filter((node) => visible(node) && String(node.textContent ?? "").trim() === text);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const findAction = (selector, text) => {
    const exact = uniqueBySelector(selector);
    if (exact.error || exact.element) return exact;
    return uniqueByText(text);
  };
  const quiet = async () => {
    if (checkAbort()) return false;
    await waitForQuiet(quietMs);
    if (checkAbort()) return false;
    return true;
  };
  const clickAction = async (node, pointer = false) => {
    if (checkAbort()) return false;
    node.scrollIntoView?.({ block: "center" });
    if (pointer) {
      for (const type of ["pointerover", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
        if (checkAbort()) return false;
        node.dispatchEvent?.(new (type.startsWith("pointer") ? PointerEventCtor : EventCtor)(type, { bubbles: true }));
      }
    }
    if (checkAbort()) return false;
    node.click?.();
    return quiet();
  };
  const setValue = async (node, value) => {
    if (checkAbort()) return false;
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
    return quiet();
  };
  const waitFor = async (read, missingError) => {
    const started = now();
    let stagnant = 0;
    while (now() - started <= timeoutMs) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const value = read();
      if (value?.error) return value;
      if (value?.element) return value;
      if (await quiet() === false) return { error: "workflow_cancelled" };
      if (checkAbort()) return { error: "workflow_cancelled" };
      await sleep(50);
      if (checkAbort()) return { error: "workflow_cancelled" };
      if (now() === started && ++stagnant > 0) break;
    }
    return { error: missingError };
  };
  const configured = selectors ?? {};

  const existingSection = uniqueBySelector(configured.generateLinkSection);
  if (existingSection.error) return { ok: false, error: existingSection.error };
  if (existingSection.element) return { ok: true };

  for (const [selector, text] of [[configured.accountManagement, "账号管理"], [configured.addAccount, "添加账号"]]) {
    const target = await waitFor(() => findAction(selector, text), "element_missing");
    if (target.error) return { ok: false, error: target.error };
    if (await clickAction(target.element) === false) return { ok: false, error: "workflow_cancelled" };
  }

  let input = uniqueBySelector(configured.accountNameInput);
  if (input.error) return { ok: false, error: input.error };
  if (!input.element) {
    const labels = Array.from(documentObject.querySelectorAll?.("label") ?? [])
      .filter((node) => visible(node) && String(node.textContent ?? "").trim() === "账号名称");
    if (labels.length > 1) return { ok: false, error: "element_ambiguous" };
    const label = labels[0];
    const forId = label?.getAttribute?.("for");
    input = { element: label?.control ?? (forId ? documentObject.querySelector?.(`#${forId}`) : label?.querySelector?.("input")) ?? null };
  }
  if (!input.element || !visible(input.element)) return { ok: false, error: "element_missing" };
  if (await setValue(input.element, accountName) === false) return { ok: false, error: "workflow_cancelled" };

  const platform = await waitFor(() => uniqueBySelector(configured.platformControl), "element_missing");
  if (platform.error) return { ok: false, error: platform.error };
  if (await clickAction(platform.element) === false) return { ok: false, error: "workflow_cancelled" };

  let options = allBySelector(configured.platformOptions).filter(visible);
  if (options.length === 0) {
    options = Array.from(documentObject.querySelectorAll?.("[role='listbox'] [role='option'],[role='option']") ?? []).filter(visible);
  }
  const enabledOptions = options.filter((node) => !node.disabled && node.getAttribute?.("aria-disabled") !== "true");
  if (enabledOptions.length < 2) return { ok: false, error: "platform_option_missing" };
  if (await clickAction(enabledOptions[1], true) === false) return { ok: false, error: "workflow_cancelled" };

  const groupContainer = await waitFor(() => uniqueBySelector(configured.groupContainer), "element_missing");
  if (groupContainer.error) return { ok: false, error: groupContainer.error };
  const checkboxes = Array.from(groupContainer.element.querySelectorAll?.("input[type='checkbox']") ?? []).filter(visible);
  if (checkboxes.length === 0) return { ok: false, error: "group_options_missing" };
  for (const checkbox of checkboxes) {
    if (!checkbox.checked && await clickAction(checkbox) === false) return { ok: false, error: "workflow_cancelled" };
  }

  const next = await waitFor(() => {
    const exact = uniqueBySelector(configured.nextButton);
    if (exact.error || exact.element) return exact;
    const dialogs = Array.from(documentObject.querySelectorAll?.("[role='dialog'],dialog") ?? []).filter(visible);
    for (const dialog of dialogs) {
      const found = uniqueByText("下一步", dialog);
      if (found.error || found.element) return found;
    }
    return uniqueByText("下一步");
  }, "element_missing");
  if (next.error) return { ok: false, error: next.error };
  if (await clickAction(next.element) === false) return { ok: false, error: "workflow_cancelled" };

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
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitForQuiet = env.waitForQuiet ?? ((ms) => new Promise((resolve) => {
    const Observer = env.MutationObserver ?? globalThis.MutationObserver;
    if (!Observer || !documentObject?.documentElement) return setTimeout(resolve, ms);
    let timer;
    const observer = new Observer(() => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    const done = () => { observer.disconnect(); resolve(); };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, ms);
  }));
  const checkAbort = () => signal?.aborted;
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const allBySelector = (selector) => {
    if (typeof selector !== "string" || selector.length === 0) return [];
    const all = Array.from(documentObject.querySelectorAll?.(selector) ?? []);
    if (all.length > 0) return all;
    const one = documentObject.querySelector?.(selector);
    return one ? [one] : [];
  };
  const uniqueBySelector = (selector) => {
    const matches = allBySelector(selector).filter(visible);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const uniqueByText = (text) => {
    const matches = Array.from(documentObject.querySelectorAll?.("button,[role='button'],a") ?? [])
      .filter((node) => visible(node) && String(node.textContent ?? "").trim() === text);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const readUrl = (node) => {
    for (const value of [node?.value, node?.href, node?.textContent]) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
    }
    return "";
  };
  const readUniqueUrl = () => {
    const urls = allBySelector(selectors?.authorizationUrl).filter(visible).map(readUrl).filter(Boolean);
    if (urls.length > 1) return { error: "authorization_url_ambiguous" };
    return { url: urls[0] ?? "" };
  };
  const quiet = async () => {
    if (checkAbort()) return false;
    await waitForQuiet(quietMs);
    if (checkAbort()) return false;
    return true;
  };
  const clickAction = async (node) => {
    if (checkAbort()) return false;
    node.scrollIntoView?.({ block: "center" });
    node.click?.();
    return quiet();
  };
  const waitForUrl = async () => {
    const started = now();
    let stagnant = 0;
    while (now() - started <= timeoutMs) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const current = readUniqueUrl();
      if (current.error || current.url) return current;
      if (await quiet() === false) return { error: "workflow_cancelled" };
      await sleep(50);
      if (checkAbort()) return { error: "workflow_cancelled" };
      if (now() === started && ++stagnant > 0) break;
    }
    return { error: "authorization_url_missing" };
  };

  let current = readUniqueUrl();
  if (current.error) return { ok: false, error: current.error };
  if (!current.url) {
    const generator = uniqueBySelector(selectors?.generateLinkButton);
    const target = generator.error || generator.element ? generator : uniqueByText("生成授权链接");
    if (target.error) return { ok: false, error: target.error };
    if (!target.element) return { ok: false, error: "element_missing" };
    if (await clickAction(target.element) === false) return { ok: false, error: "workflow_cancelled" };
    current = await waitForUrl();
    if (current.error) return { ok: false, error: current.error };
  }

  const copy = uniqueBySelector(selectors?.copyUrlButton);
  const copyTarget = copy.error || copy.element ? copy : uniqueByText("COPY URL");
  if (copyTarget.error) return { ok: false, error: copyTarget.error };
  if (!copyTarget.element) return { ok: false, error: "element_missing" };
  copyTarget.element.dispatchEvent?.(new EventCtor("mouseover", { bubbles: true }));
  if (await clickAction(copyTarget.element) === false) return { ok: false, error: "workflow_cancelled" };
  return { ok: true, authorizationUrl: current.url };
}

export async function backfillFinalUrlOnPage({ runId, requireExistingToken = false, finalUrl, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const registry = globalThis.__whalestestWorkflowRunControllers__;
  const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
  if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
  if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
  if (!documentObject || typeof finalUrl !== "string" || finalUrl.length === 0) return { ok: false, error: "request_invalid" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitForQuiet = env.waitForQuiet ?? ((ms) => new Promise((resolve) => {
    const Observer = env.MutationObserver ?? globalThis.MutationObserver;
    if (!Observer || !documentObject?.documentElement) return setTimeout(resolve, ms);
    let timer;
    const observer = new Observer(() => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    const done = () => { observer.disconnect(); resolve(); };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, ms);
  }));
  const placeholders = new Set([
    "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
    "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
    "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
  ]);
  const configured = selectors ?? {};
  for (const key of ["motherFinalUrlInput", "motherFinalConfirmButton", "motherFinalSuccess"]) {
    const value = configured[key];
    if (typeof value !== "string" || value.length === 0 || placeholders.has(value)) {
      return { ok: false, error: "selector_not_configured" };
    }
  }
  const checkAbort = () => signal?.aborted;
  const visible = (node) => {
    if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
    const rect = node.getBoundingClientRect?.();
    const style = documentObject.defaultView?.getComputedStyle?.(node) ?? globalThis.getComputedStyle?.(node) ?? { display: "block", visibility: "visible" };
    return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  const allBySelector = (selector) => {
    const all = Array.from(documentObject.querySelectorAll?.(selector) ?? []);
    if (all.length > 0) return all;
    const one = documentObject.querySelector?.(selector);
    return one ? [one] : [];
  };
  const uniqueBySelector = (selector) => {
    const matches = allBySelector(selector).filter(visible);
    if (matches.length > 1) return { error: "element_ambiguous" };
    return { element: matches[0] ?? null };
  };
  const quiet = async () => {
    if (checkAbort()) return false;
    await waitForQuiet(quietMs);
    if (checkAbort()) return false;
    return true;
  };
  const setValue = async (node, value) => {
    if (checkAbort()) return false;
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
    return quiet();
  };
  const clickAction = async (node) => {
    if (checkAbort()) return false;
    node.scrollIntoView?.({ block: "center" });
    node.click?.();
    return quiet();
  };
  const waitForSuccess = async () => {
    const started = now();
    let stagnant = 0;
    while (now() - started <= timeoutMs) {
      if (checkAbort()) return { error: "workflow_cancelled" };
      const success = uniqueBySelector(configured.motherFinalSuccess);
      if (success.error || success.element) return success;
      if (await quiet() === false) return { error: "workflow_cancelled" };
      await sleep(50);
      if (checkAbort()) return { error: "workflow_cancelled" };
      if (now() === started && ++stagnant > 0) break;
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
  if (await setValue(input.element, finalUrl) === false) return { ok: false, error: "workflow_cancelled" };
  if (await clickAction(confirm.element) === false) return { ok: false, error: "workflow_cancelled" };
  const success = await waitForSuccess();
  if (success.error) return { ok: false, error: success.error };
  return { ok: true };
}
