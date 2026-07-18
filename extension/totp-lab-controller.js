import { readVisibleTotpCode } from "./totp-lab-page.js";
import { fillTotpOnPage } from "./totp-page.js";

const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;
const FILL_TIMEOUT_MS = 30_000;
const REFRESH_INTERVAL_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;
const HELPER_READ_TIMEOUT_MS = 5_000;
const HELPER_LOAD_POLL_MS = 100;
const LAB_ORIGIN = "http://totp-lab.local";
const LAB_HOST = "totp-lab.local";

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function sleepDefault(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

function publicState(run) {
  return run
    ? { state: run.state, runId: run.runId, error: run.error }
    : { state: "IDLE", runId: null, error: "" };
}

function safeError(error, fallback = "totp_lab_failed") {
  const value = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

function registerTotpOnPage() {
  return { ok: true };
}

function cancelTotpOnPage() {
  return { ok: true };
}

function validateChallengeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("totp_lab_url_invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.origin !== LAB_ORIGIN ||
    url.hostname !== LAB_HOST ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("totp_lab_url_invalid");
  }
  if (!url.pathname.startsWith("/")) {
    throw new Error("totp_lab_url_invalid");
  }
  return url.toString();
}

export function createTotpLabController(api, options = {}) {
  const makeRunId = options.makeRunId ?? makeId;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  let port = null;
  let active = null;
  let last = publicState(null);
  const pending = new Map();

  function connect() {
    if (port) return;
    port = api.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((message) => {
      const request = pending.get(message.request_id);
      if (!request) return;
      request.resolve(message);
    });
    port.onDisconnect?.addListener?.(() => {
      for (const request of [...pending.values()]) {
        request.reject(new Error("native_host_unavailable"));
      }
      pending.clear();
      port = null;
    });
  }

  function request(command, payload = {}, signal) {
    connect();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("cancelled"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("native_host_timeout"));
      }, REQUEST_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(requestId, {
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      port.postMessage({ request_id: requestId, command, ...payload });
    });
  }

  function throwIfCancelled(run) {
    if (active !== run || run.abort.signal.aborted) throw new Error("cancelled");
  }

  function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  async function assertTabs(motherTabId, incognitoTabId, excelRow) {
    if (
      !Number.isInteger(motherTabId) ||
      !Number.isInteger(incognitoTabId) ||
      !Number.isInteger(excelRow) ||
      motherTabId < 1 ||
      incognitoTabId < 1 ||
      excelRow < 1 ||
      motherTabId === incognitoTabId
    ) {
      throw new Error("request_invalid");
    }

    const motherTab = await api.tabs.get(motherTabId);
    if (!motherTab) throw new Error("mother_tab_missing");
    if (motherTab.incognito) throw new Error("mother_tab_incognito");
    if (motherTab.active !== true) throw new Error("mother_tab_not_active");

    const targetTab = await api.tabs.get(incognitoTabId);
    if (!targetTab) throw new Error("incognito_tab_missing");
    if (targetTab.incognito !== true) throw new Error("incognito_tab_required");

    return { motherTab, targetTab };
  }

  async function assertTargetActiveTab(run) {
    try {
      const registerResults = await api.scripting.executeScript({
        target: { tabId: run.incognitoTabId },
        world: "ISOLATED",
        func: registerTotpOnPage,
        args: [{ runId: run.runId }],
      });
      if (!registerResults?.[0]?.result?.ok) throw new Error("incognito_active_tab_required");
    } catch {
      throw new Error("incognito_active_tab_required");
    }
  }

  async function waitForHelperComplete(run, timeoutMs) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      throwIfCancelled(run);
      const helperTab = await api.tabs.get(run.helperTabId);
      if (!helperTab) throw new Error("helper_tab_closed");
      if (helperTab.status === "complete") return;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(HELPER_LOAD_POLL_MS, remaining), run.abort.signal);
    }
    throwIfCancelled(run);
    throw new Error("helper_page_not_stable");
  }

  async function executeRead(run, timeoutMs) {
    throwIfCancelled(run);
    if (run.helperTabId == null) throw new Error("helper_tab_closed");
    const helperResults = await abortable(api.scripting.executeScript({
      target: { tabId: run.helperTabId },
      world: "ISOLATED",
      func: readVisibleTotpCode,
      args: [{ timeoutMs }],
    }), run.abort.signal);
    throwIfCancelled(run);
    return helperResults?.[0]?.result ?? { ok: false, error: "helper_page_not_stable" };
  }

  async function finalReadOrFail(run) {
    const final = await executeRead(run, 1);
    if (final?.ok) return final.code;
    if (final?.error === "totp_code_ambiguous") throw new Error("totp_code_ambiguous");
    throw new Error("totp_code_not_found");
  }

  async function waitForCode(run) {
    const deadline = now() + TOTAL_TIMEOUT_MS;
    while (true) {
      await waitForHelperComplete(run, Math.min(HELPER_READ_TIMEOUT_MS, Math.max(1, deadline - now())));
      const result = await executeRead(run, Math.max(1, Math.min(HELPER_READ_TIMEOUT_MS, deadline - now())));
      if (result?.ok) return result.code;
      if (result?.error === "totp_code_ambiguous") throw new Error("totp_code_ambiguous");
      if (result?.error !== "code_not_present") throw new Error(result?.error || "helper_page_not_stable");

      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("totp_code_not_found");
      await sleep(Math.min(REFRESH_INTERVAL_MS, remaining), run.abort.signal);
      throwIfCancelled(run);
      if (now() >= deadline) return finalReadOrFail(run);
      await api.tabs.reload(run.helperTabId);
    }
  }

  async function closeHelper(run) {
    if (run.helperTabId == null) return;
    const helperTabId = run.helperTabId;
    run.helperTabId = null;
    await api.tabs.remove(helperTabId);
  }

  async function cleanupHelper(run) {
    if (run.helperTabId == null) return;
    const helperTabId = run.helperTabId;
    run.helperTabId = null;
    try {
      await api.tabs.remove(helperTabId);
    } catch {
      // best-effort cleanup
    }
  }

  async function bestEffortCancelTarget(run) {
    if (!run.incognitoTabId) return;
    try {
      await api.scripting.executeScript({
        target: { tabId: run.incognitoTabId },
        world: "ISOLATED",
        func: cancelTotpOnPage,
        args: [{ runId: run.runId }],
      });
    } catch {
      // best-effort target page cancellation
    }
  }

  async function run({ motherTabId, incognitoTabId, excelRow }) {
    if (active) throw new Error("totp_lab_run_active");
    const run = {
      runId: makeRunId(),
      motherTabId,
      incognitoTabId,
      helperTabId: null,
      abort: new AbortController(),
      state: "READING_CHALLENGE",
      error: "",
    };
    active = run;
    last = publicState(run);

    try {
      const { motherTab } = await assertTabs(motherTabId, incognitoTabId, excelRow);
      await assertTargetActiveTab(run);

      run.state = "OPENING_HELPER";
      last = publicState(run);

      const native = await request("get_totp_lab_challenge", { excel_row: excelRow }, run.abort.signal);
      throwIfCancelled(run);
      if (native.ok !== true) throw new Error(native.error || "totp_lab_challenge_failed");
      const challengeUrl = validateChallengeUrl(native.challenge_url);

      const helperTab = await api.tabs.create({
        windowId: motherTab.windowId,
        index: motherTab.index + 1,
        active: false,
        url: challengeUrl,
      });
      if (!helperTab?.id) throw new Error("helper_tab_create_failed");
      run.helperTabId = helperTab.id;
      throwIfCancelled(run);

      run.state = "WAITING_FOR_CODE";
      last = publicState(run);
      const code = await waitForCode(run);

      await closeHelper(run);

      const refreshedMother = await api.tabs.get(motherTabId);
      if (!refreshedMother) throw new Error("mother_tab_missing");
      if (refreshedMother.incognito) throw new Error("mother_tab_incognito");
      if (refreshedMother.active !== true) throw new Error("mother_tab_not_active");

      throwIfCancelled(run);
      run.state = "FILLING_TOTP";
      last = publicState(run);

      const fillResults = await abortable(api.scripting.executeScript({
        target: { tabId: incognitoTabId },
        world: "ISOLATED",
        func: fillTotpOnPage,
        args: [{
          code,
          runId: run.runId,
          requireExistingToken: true,
          timeoutMs: FILL_TIMEOUT_MS,
        }],
      }), run.abort.signal);
      throwIfCancelled(run);
      const fillResult = fillResults?.[0]?.result;
      if (!fillResult?.ok) throw new Error(fillResult?.error || "otp_page_action_failed");

      run.state = "SUCCEEDED";
      run.error = "";
      last = publicState(run);
    } catch (error) {
      if (run.abort.signal.aborted || error?.message === "cancelled") {
        run.state = "CANCELLED";
        run.error = "cancelled";
      } else {
        run.state = "FAILED";
        run.error = safeError(error);
      }
      last = publicState(run);
    } finally {
      await cleanupHelper(run);
      if (active === run) active = null;
    }

    return { ...last };
  }

  async function cancel(runId) {
    if (!active || (runId && active.runId !== runId)) return { ...last };
    const run = active;
    run.abort.abort(new Error("cancelled"));
    run.state = "CANCELLED";
    run.error = "cancelled";
    last = publicState(run);
    active = null;
    await bestEffortCancelTarget(run);
    await cleanupHelper(run);
    return { ...last };
  }

  return { run, cancel, getState: () => ({ ...last }) };
}
