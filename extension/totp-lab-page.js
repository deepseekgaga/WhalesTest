export async function readVisibleTotpCode({ timeoutMs = 15_000, quietMs = 800, sampleGapMs = 250 } = {}, env = {}) {
  const documentObject = env.document ?? globalThis.document;
  const now = env.now ?? Date.now;
  const signal = env.signal;
  const abortError = () => new DOMException("Aborted", "AbortError");
  const sleep = env.sleep ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? abortError());
      return;
    }
    const cleanup = () => abortSignal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
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
    const done = () => { cleanup(); resolve(); };
    const onAbort = () => {
      cleanup();
      reject(abortSignal.reason ?? abortError());
    };
    observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(done, ms);
  }));

  const started = now();
  const remainingMs = () => timeoutMs - (now() - started);
  const withinDeadline = () => remainingMs() > 0;
  const waitWithDeadline = async (operation) => {
    const remaining = remainingMs();
    if (remaining <= 0) return false;
    if (signal?.aborted) return "aborted";
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? abortError());
    let timer;
    signal?.addEventListener("abort", onAbort, { once: true });
    const operationPromise = operation(controller.signal);
    operationPromise.catch(() => {});
    try {
      return await Promise.race([
        operationPromise.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
            controller.abort(abortError());
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
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
      const quiet = await waitWithDeadline((deadlineSignal) => waitForQuiet(quietMs, deadlineSignal));
      if (quiet === "aborted") return { ok: false, error: "cancelled" };
      if (!quiet) break;
      if (!withinDeadline()) break;
      const first = readSample();
      if (first.readyState !== "complete") continue;
      const slept = await waitWithDeadline((deadlineSignal) => sleep(sampleGapMs, deadlineSignal));
      if (slept === "aborted") return { ok: false, error: "cancelled" };
      if (!slept) break;
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
