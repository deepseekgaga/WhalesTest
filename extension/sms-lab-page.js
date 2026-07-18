export async function requestSmsOnPage({ phone, selectors, timeoutMs = 30_000, quietMs = 800, sampleGapMs = 250 } = {}, env = {}) {
  const placeholders = {
    phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
    sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
    codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
    submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
  };
  const requireSelectors = (candidate) => {
    const configured = {};
    for (const key of Object.keys(placeholders)) {
      const value = candidate?.[key];
      if (typeof value !== "string" || value.length === 0 || value === placeholders[key]) {
        throw new Error("sms_selectors_not_configured");
      }
      configured[key] = value;
    }
    return configured;
  };
  const abortError = () => new DOMException("Aborted", "AbortError");
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const signal = env.signal;
  const sleep = env.sleep ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? abortError());
      return;
    }
    let timer;
    const cleanup = () => abortSignal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }));
  const waitForQuiet = env.waitForQuiet ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? abortError());
      return;
    }
    const MutationObserverCtor = env.MutationObserver ?? globalThis.MutationObserver;
    if (!MutationObserverCtor || !documentObject?.documentElement) {
      sleep(ms, abortSignal).then(resolve, reject);
      return;
    }
    let timer;
    const observer = new MutationObserverCtor(() => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    const cleanup = () => {
      clearTimeout(timer);
      observer.disconnect();
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(done, ms);
  }));

  if (typeof phone !== "string" || phone.length === 0) return { ok: false, error: "sms_phone_invalid" };
  let configuredSelectors;
  try {
    configuredSelectors = requireSelectors(selectors);
  } catch (error) {
    if (error?.message === "sms_selectors_not_configured") return { ok: false, error: "sms_selectors_not_configured" };
    throw error;
  }

  const started = now();
  const remainingMs = () => timeoutMs - (now() - started);
  const withinDeadline = () => remainingMs() > 0;
  const waitWithDeadline = async (operation) => {
    const remaining = remainingMs();
    if (signal?.aborted) return "aborted";
    if (remaining <= 0) return false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? abortError());
    let timer;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const operationPromise = operation(controller.signal);
      operationPromise.catch(() => {});
      return await Promise.race([
        operationPromise.then(() => true, (error) => {
          if (controller.signal.aborted || signal?.aborted || error?.name === "AbortError") return "aborted";
          throw error;
        }),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort(abortError());
            resolve(false);
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const styleFor = (element) => {
    const getStyle = documentObject?.defaultView?.getComputedStyle ?? globalThis.getComputedStyle;
    return getStyle ? getStyle(element) : { display: "block", visibility: "visible" };
  };
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const style = styleFor(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };
  const readSample = () => {
    const input = documentObject?.querySelector?.(configuredSelectors.phoneInput) ?? null;
    const button = documentObject?.querySelector?.(configuredSelectors.sendButton) ?? null;
    const inputRect = input?.getBoundingClientRect?.() ?? null;
    const buttonRect = button?.getBoundingClientRect?.() ?? null;
    return {
      readyState: documentObject?.readyState,
      input,
      button,
      inputVisible: visible(input),
      buttonVisible: visible(button),
      inputDisabled: Boolean(input?.disabled) || input?.getAttribute?.("aria-disabled") === "true",
      buttonDisabled: Boolean(button?.disabled) || button?.getAttribute?.("aria-disabled") === "true",
      inputValue: typeof input?.value === "string" ? input.value : null,
      inputRect: inputRect ? { width: inputRect.width, height: inputRect.height, top: inputRect.top, left: inputRect.left } : null,
      buttonRect: buttonRect ? { width: buttonRect.width, height: buttonRect.height, top: buttonRect.top, left: buttonRect.left } : null,
    };
  };
  const actionable = (sample) => Boolean(
    sample.readyState === "complete" &&
    sample.inputVisible && !sample.inputDisabled &&
    sample.buttonVisible && !sample.buttonDisabled
  );
  const comparable = (sample) => JSON.stringify({
    readyState: sample.readyState,
    inputVisible: sample.inputVisible,
    buttonVisible: sample.buttonVisible,
    inputDisabled: sample.inputDisabled,
    buttonDisabled: sample.buttonDisabled,
    inputValue: sample.inputValue,
    inputRect: sample.inputRect,
    buttonRect: sample.buttonRect,
  });
  const setNativeValue = (input, value) => {
    let prototype = Object.getPrototypeOf(input);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(input, value);
        return;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    input.value = value;
  };

  let stable = null;
  try {
    while (withinDeadline()) {
      const quiet = await waitWithDeadline((deadlineSignal) => waitForQuiet(quietMs, deadlineSignal));
      if (quiet === "aborted") return { ok: false, error: "cancelled" };
      if (!quiet) break;
      if (!withinDeadline()) break;
      const first = readSample();
      if (first.readyState === "complete" && !first.input) return { ok: false, error: "sms_phone_input_not_found" };
      if (first.readyState === "complete" && !first.button) return { ok: false, error: "sms_send_button_not_found" };
      if (first.readyState === "complete" && first.buttonVisible && first.buttonDisabled) return { ok: false, error: "sms_send_button_disabled" };
      if (!actionable(first)) continue;
      const slept = await waitWithDeadline((deadlineSignal) => sleep(sampleGapMs, deadlineSignal));
      if (slept === "aborted") return { ok: false, error: "cancelled" };
      if (!slept) break;
      if (!withinDeadline()) break;
      const second = readSample();
      if (actionable(second) && comparable(first) === comparable(second)) {
        stable = second;
        break;
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, error: "cancelled" };
    throw error;
  }

  if (signal?.aborted) return { ok: false, error: "cancelled" };
  if (!stable) return { ok: false, error: "page_not_stable" };

  setNativeValue(stable.input, phone);
  stable.input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  stable.input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  try {
    if (typeof stable.button.click === "function") stable.button.click();
    else if (typeof stable.button.form?.requestSubmit === "function") stable.button.form.requestSubmit(stable.button);
  } catch {
    return { ok: false, error: "sms_send_failed" };
  }
  return { ok: true };
}

export async function submitSmsCodeOnPage({ code, selectors, timeoutMs = 30_000, quietMs = 800, sampleGapMs = 250 } = {}, env = {}) {
  const placeholders = {
    phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
    sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
    codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
    submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
  };
  const requireSelectors = (candidate) => {
    const configured = {};
    for (const key of Object.keys(placeholders)) {
      const value = candidate?.[key];
      if (typeof value !== "string" || value.length === 0 || value === placeholders[key]) {
        throw new Error("sms_selectors_not_configured");
      }
      configured[key] = value;
    }
    return configured;
  };
  const abortError = () => new DOMException("Aborted", "AbortError");
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const now = env.now ?? Date.now;
  const signal = env.signal;
  const sleep = env.sleep ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? abortError());
      return;
    }
    let timer;
    const cleanup = () => abortSignal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }));
  const waitForQuiet = env.waitForQuiet ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? abortError());
      return;
    }
    const MutationObserverCtor = env.MutationObserver ?? globalThis.MutationObserver;
    if (!MutationObserverCtor || !documentObject?.documentElement) {
      sleep(ms, abortSignal).then(resolve, reject);
      return;
    }
    let timer;
    const observer = new MutationObserverCtor(() => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    });
    const cleanup = () => {
      clearTimeout(timer);
      observer.disconnect();
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(done, ms);
  }));

  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return { ok: false, error: "sms_code_invalid" };
  let configuredSelectors;
  try {
    configuredSelectors = requireSelectors(selectors);
  } catch (error) {
    if (error?.message === "sms_selectors_not_configured") return { ok: false, error: "sms_selectors_not_configured" };
    throw error;
  }

  const started = now();
  const remainingMs = () => timeoutMs - (now() - started);
  const withinDeadline = () => remainingMs() > 0;
  const waitWithDeadline = async (operation) => {
    const remaining = remainingMs();
    if (signal?.aborted) return "aborted";
    if (remaining <= 0) return false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? abortError());
    let timer;
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const operationPromise = operation(controller.signal);
      operationPromise.catch(() => {});
      return await Promise.race([
        operationPromise.then(() => true, (error) => {
          if (controller.signal.aborted || signal?.aborted || error?.name === "AbortError") return "aborted";
          throw error;
        }),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort(abortError());
            resolve(false);
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const styleFor = (element) => {
    const getStyle = documentObject?.defaultView?.getComputedStyle ?? globalThis.getComputedStyle;
    return getStyle ? getStyle(element) : { display: "block", visibility: "visible" };
  };
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const style = styleFor(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };
  const readSample = () => {
    const input = documentObject?.querySelector?.(configuredSelectors.codeInput) ?? null;
    const button = documentObject?.querySelector?.(configuredSelectors.submitButton) ?? null;
    const inputRect = input?.getBoundingClientRect?.() ?? null;
    const buttonRect = button?.getBoundingClientRect?.() ?? null;
    return {
      readyState: documentObject?.readyState,
      input,
      button,
      inputVisible: visible(input),
      buttonVisible: visible(button),
      inputDisabled: Boolean(input?.disabled) || input?.getAttribute?.("aria-disabled") === "true",
      buttonDisabled: Boolean(button?.disabled) || button?.getAttribute?.("aria-disabled") === "true",
      inputValue: typeof input?.value === "string" ? input.value : null,
      inputRect: inputRect ? { width: inputRect.width, height: inputRect.height, top: inputRect.top, left: inputRect.left } : null,
      buttonRect: buttonRect ? { width: buttonRect.width, height: buttonRect.height, top: buttonRect.top, left: buttonRect.left } : null,
    };
  };
  const actionable = (sample) => Boolean(
    sample.readyState === "complete" &&
    sample.inputVisible && !sample.inputDisabled &&
    sample.buttonVisible && !sample.buttonDisabled
  );
  const comparable = (sample) => JSON.stringify({
    readyState: sample.readyState,
    inputVisible: sample.inputVisible,
    buttonVisible: sample.buttonVisible,
    inputDisabled: sample.inputDisabled,
    buttonDisabled: sample.buttonDisabled,
    inputValue: sample.inputValue,
    inputRect: sample.inputRect,
    buttonRect: sample.buttonRect,
  });
  const setNativeValue = (input, value) => {
    let prototype = Object.getPrototypeOf(input);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (typeof descriptor?.set === "function") {
        descriptor.set.call(input, value);
        return;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    input.value = value;
  };

  let stable = null;
  try {
    while (withinDeadline()) {
      const quiet = await waitWithDeadline((deadlineSignal) => waitForQuiet(quietMs, deadlineSignal));
      if (quiet === "aborted") return { ok: false, error: "cancelled" };
      if (!quiet) break;
      if (!withinDeadline()) break;
      const first = readSample();
      if (first.readyState === "complete" && !first.input) return { ok: false, error: "sms_code_input_not_found" };
      if (first.readyState === "complete" && !first.button) return { ok: false, error: "sms_submit_button_not_found" };
      if (first.readyState === "complete" && first.buttonVisible && first.buttonDisabled) return { ok: false, error: "sms_submit_button_disabled" };
      if (!actionable(first)) continue;
      const slept = await waitWithDeadline((deadlineSignal) => sleep(sampleGapMs, deadlineSignal));
      if (slept === "aborted") return { ok: false, error: "cancelled" };
      if (!slept) break;
      if (!withinDeadline()) break;
      const second = readSample();
      if (actionable(second) && comparable(first) === comparable(second)) {
        stable = second;
        break;
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, error: "cancelled" };
    throw error;
  }

  if (signal?.aborted) return { ok: false, error: "cancelled" };
  if (!stable) return { ok: false, error: "page_not_stable" };

  setNativeValue(stable.input, code);
  stable.input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  stable.input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  try {
    if (typeof stable.button.click === "function") stable.button.click();
    else if (typeof stable.button.form?.requestSubmit === "function") stable.button.form.requestSubmit(stable.button);
  } catch {
    return { ok: false, error: "sms_submit_failed" };
  }
  return { ok: true };
}
