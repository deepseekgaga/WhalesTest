export async function readVisibleTotpCode({ timeoutMs = 15_000, quietMs = 800, sampleGapMs = 250 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const now = env.now ?? Date.now;
  const signal = env.signal;
  const sleep = env.sleep ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }));
  const waitForQuiet = env.waitForQuiet ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
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
    const done = () => { cleanup(); resolve(); };
    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(done, ms);
  }));

  const started = now();
  const withinDeadline = () => now() - started < timeoutMs;
  const readSample = () => {
    const bodyText = documentObject?.body?.innerText;
    return {
      readyState: documentObject?.readyState,
      text: typeof bodyText === "string" ? bodyText : "",
    };
  };
  const findCode = (text) => {
    const matches = text.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
    const unique = [...new Set(matches)];
    if (unique.length === 0) return { ok: false, error: "code_not_present" };
    if (unique.length > 1) return { ok: false, error: "totp_code_ambiguous" };
    return { ok: true, code: unique[0] };
  };

  try {
    while (withinDeadline()) {
      if (signal?.aborted) return { ok: false, error: "cancelled" };
      await waitForQuiet(quietMs, signal);
      if (!withinDeadline()) break;
      const first = readSample();
      if (first.readyState !== "complete") continue;
      await sleep(sampleGapMs, signal);
      if (!withinDeadline()) break;
      const second = readSample();
      if (second.readyState === "complete" && first.text === second.text) {
        return findCode(second.text);
      }
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { ok: false, error: "cancelled" };
    throw error;
  }

  return { ok: false, error: "helper_page_not_stable" };
}
