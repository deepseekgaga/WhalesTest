export async function fillTotpOnPage({ code, timeoutMs = 15_000, quietMs = 800, sampleGapMs = 250 }, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const EventCtor = env.Event ?? globalThis.Event;
  const MutationObserverCtor = env.MutationObserver ?? globalThis.MutationObserver;
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  }));
  const signal = env.signal;
  const waitForQuiet = env.waitForQuiet ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
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
    const done = () => { cleanup(); resolve(); };
    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(done, ms);
  }));

  const inputSelector = 'input[autocomplete="one-time-code"][name="code"][maxlength="6"]';
  const submitSelector = 'button[type="submit"][name="intent"][value="verify"]';
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return { ok: false, error: "otp_code_invalid" };

  const styleFor = (element) => {
    const getStyle = documentObject.defaultView?.getComputedStyle ?? globalThis.getComputedStyle;
    return getStyle ? getStyle(element) : { display: "block", visibility: "visible" };
  };
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const style = styleFor(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  };
  const readSample = () => {
    const input = documentObject.querySelector(inputSelector);
    const button = documentObject.querySelector(submitSelector);
    return {
      readyState: documentObject.readyState,
      input,
      button,
      inputVisible: visible(input),
      buttonVisible: visible(button),
      inputDisabled: Boolean(input?.disabled),
      buttonDisabled: Boolean(button?.disabled) || button?.getAttribute?.("aria-disabled") === "true",
      inputValue: typeof input?.value === "string" ? input.value : null,
      inputRect: input?.getBoundingClientRect?.() ?? null,
      buttonRect: button?.getBoundingClientRect?.() ?? null,
    };
  };
  const actionable = (sample) => Boolean(
    sample.readyState === "complete" &&
    sample.inputVisible && !sample.inputDisabled &&
    sample.buttonVisible && !sample.buttonDisabled
  );
  const sameSample = (first, second) => JSON.stringify({
    readyState: first.readyState,
    inputVisible: first.inputVisible,
    buttonVisible: first.buttonVisible,
    inputDisabled: first.inputDisabled,
    buttonDisabled: first.buttonDisabled,
    inputValue: first.inputValue,
    inputRect: first.inputRect,
    buttonRect: first.buttonRect,
  }) === JSON.stringify({
    readyState: second.readyState,
    inputVisible: second.inputVisible,
    buttonVisible: second.buttonVisible,
    inputDisabled: second.inputDisabled,
    buttonDisabled: second.buttonDisabled,
    inputValue: second.inputValue,
    inputRect: second.inputRect,
    buttonRect: second.buttonRect,
  });
  const withinDeadline = (started) => now() - started < timeoutMs;
  const started = now();
  let stable = null;
  try {
    while (withinDeadline(started)) {
      await waitForQuiet(quietMs, signal);
      if (!withinDeadline(started)) break;
      const first = readSample();
      if (!first.input) return { ok: false, error: "otp_input_not_found" };
      if (!first.button) return { ok: false, error: "otp_submit_not_found" };
      if (first.readyState === "complete" && first.buttonDisabled) return { ok: false, error: "otp_submit_disabled" };
      if (!actionable(first)) continue;
      await sleep(sampleGapMs, signal);
      if (!withinDeadline(started)) break;
      const second = readSample();
      if (actionable(second) && sameSample(first, second)) {
        stable = second;
        break;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, error: "cancelled" };
    throw error;
  }
  if (!stable) return { ok: false, error: "page_not_stable" };

  const input = stable.input;
  const button = stable.button;
  let prototype = Object.getPrototypeOf(input);
  let setter = null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (typeof descriptor?.set === "function") {
      setter = descriptor.set;
      break;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  if (setter) setter.call(input, code);
  else input.value = code;
  input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  try {
    if (typeof button.form?.requestSubmit === "function") button.form.requestSubmit(button);
    else if (typeof button.click === "function") button.click();
    else return { ok: false, error: "otp_submit_unavailable" };
  } catch {
    return { ok: false, error: "otp_submit_failed" };
  }
  return { ok: true };
}
