import { readVisibleTotpCode } from "./totp-lab-page.js";
import { cancelSmsOnPage, probeSmsOnPage, registerSmsOnPage, requestSmsOnPage, submitSmsCodeOnPage } from "./sms-lab-page.js";
import { SMS_LAB_SELECTORS, requireSmsLabSelectors } from "./sms-lab-selectors.js";

const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_ACTION_TIMEOUT_MS = 30_000;
const CANCEL_PAGE_TIMEOUT_MS = 1_000;
const REFRESH_INTERVAL_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;
const HELPER_READ_TIMEOUT_MS = 5_000;
const HELPER_LOAD_POLL_MS = 100;
const SMS_LAB_ORIGIN = "http://sms-lab.local";
const SMS_LAB_HOST = "sms-lab.local";

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function publicState(run) {
  return run
    ? { state: run.state, runId: run.runId, error: run.error }
    : { state: "IDLE", runId: null, error: "" };
}

function safeError(error, fallback = "sms_lab_failed") {
  const value = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

function isMissingTabError(error) {
  const message = error instanceof Error ? error.message : "";
  return /(?:no tab with id|tab not found|invalid tab id)/i.test(message);
}

async function getTabOrNull(api, tabId) {
  try {
    return await api.tabs.get(tabId);
  } catch (error) {
    if (isMissingTabError(error)) return null;
    throw error;
  }
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

function validateChallengeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error("sms_url_invalid");
  }
  if (!/^http:\/\/sms-lab\.local(?:[/?]|$)/.test(value)) {
    throw new Error("sms_url_invalid");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("sms_url_invalid");
  }

  if (
    url.protocol !== "http:" ||
    url.origin !== SMS_LAB_ORIGIN ||
    url.hostname !== SMS_LAB_HOST ||
    url.host !== SMS_LAB_HOST ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("sms_url_invalid");
  }

  return value;
}

function validateRequest({ motherTabId, incognitoTabId, excelRow }) {
  if (
    !Number.isInteger(motherTabId) ||
    !Number.isInteger(incognitoTabId) ||
    !Number.isInteger(excelRow) ||
    typeof motherTabId === "boolean" ||
    typeof incognitoTabId === "boolean" ||
    typeof excelRow === "boolean" ||
    motherTabId < 1 ||
    incognitoTabId < 1 ||
    excelRow < 2 ||
    motherTabId === incognitoTabId
  ) {
    throw new Error("request_invalid");
  }
}

function validatePhone(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("sms_phone_invalid");
  return value;
}

function validateSmsCode(result) {
  if (!result?.ok) {
    if (result?.error === "totp_code_ambiguous") throw new Error("sms_code_ambiguous");
    if (result?.error === "code_not_present") throw new Error("sms_code_not_found");
    throw new Error(result?.error || "helper_page_not_stable");
  }
  if (typeof result.code !== "string" || !/^\d{6}$/.test(result.code)) throw new Error("sms_code_invalid");
  return result.code;
}

export function createSmsLabController(api, options = {}) {
  const makeRunId = options.makeRunId ?? makeId;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  const cancelPageTimeoutMs = options.cancelPageTimeoutMs ?? CANCEL_PAGE_TIMEOUT_MS;
  let port = null;
  let active = null;
  let last = publicState(null);
  const pending = new Map();

  function makeDeferred() {
    let resolve;
    const promise = new Promise((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  function connect() {
    if (port) return;
    port = api.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((message) => {
      const request = pending.get(message.request_id);
      if (!request) return;
      request.resolve(message);
    });
    port.onDisconnect?.addListener?.(() => {
      for (const request of [...pending.values()]) request.reject(new Error("native_host_unavailable"));
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

  function setState(run, state) {
    run.state = state;
    last = publicState(run);
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

  function bounded(promise, signal, timeoutMs, timeoutError) {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutError));
      }, timeoutMs);
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

  async function assertTabs(motherTabId, incognitoTabId) {
    const motherTab = await getTabOrNull(api, motherTabId);
    if (!motherTab) throw new Error("mother_tab_missing");
    if (motherTab.incognito) throw new Error("mother_tab_incognito");
    if (motherTab.active !== true) throw new Error("mother_tab_not_active");

    const targetTab = await getTabOrNull(api, incognitoTabId);
    if (!targetTab) throw new Error("incognito_tab_missing");
    if (targetTab.incognito !== true) throw new Error("incognito_tab_required");

    return { motherTab, targetTab };
  }

  async function assertTargetActiveTab(incognitoTabId, runId) {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: incognitoTabId },
        world: "ISOLATED",
        func: probeSmsOnPage,
        args: [{ runId }],
      });
      if (!results?.[0]?.result?.ok) throw new Error("incognito_active_tab_required");
    } catch {
      throw new Error("incognito_active_tab_required");
    }
  }

  async function registerTargetToken(run) {
    throwIfCancelled(run);
    const results = await abortable(api.scripting.executeScript({
      target: { tabId: run.incognitoTabId },
      world: "ISOLATED",
      func: registerSmsOnPage,
      args: [{ runId: run.runId }],
    }), run.abort.signal);
    throwIfCancelled(run);
    if (!results?.[0]?.result?.ok) throw new Error("incognito_active_tab_required");
    run.pageTokenRegistered = true;
  }

  async function executeTarget(run, func, args) {
    throwIfCancelled(run);
    let results;
    try {
      results = await abortable(api.scripting.executeScript({
        target: { tabId: run.incognitoTabId },
        world: "ISOLATED",
        func,
        args: [args],
      }), run.abort.signal);
    } catch (error) {
      if (error?.message === "cancelled") throw error;
      throw new Error("sms_page_action_failed");
    }
    throwIfCancelled(run);
    const result = results?.[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "sms_page_action_failed");
    return result;
  }

  async function executeRead(run, deadline) {
    throwIfCancelled(run);
    if (run.helperTabId == null) throw new Error("helper_tab_closed");
    if (deadline - now() <= 0) return { ok: false, error: "code_not_present" };
    const loadedHelperTab = await waitForHelperComplete(run, deadline);
    validateChallengeUrl(loadedHelperTab.url);
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) return { ok: false, error: "code_not_present" };
    const helperResults = await bounded(api.scripting.executeScript({
      target: { tabId: run.helperTabId },
      world: "ISOLATED",
      func: readVisibleTotpCode,
      args: [{ timeoutMs }],
    }), run.abort.signal, timeoutMs, "helper_page_not_stable");
    throwIfCancelled(run);
    return helperResults?.[0]?.result ?? { ok: false, error: "helper_page_not_stable" };
  }

  async function createHelperTab(run, details) {
    const createPromise = api.tabs.create(details);
    createPromise.then(
      (helperTab) => {
        if (helperTab?.id && (run.abort.signal.aborted || active !== run) && run.helperTabId !== helperTab.id) {
          void removeHelperById(run, helperTab.id);
        }
      },
      () => {},
    );
    const helperTab = await abortable(createPromise, run.abort.signal);
    if (!helperTab?.id) throw new Error("helper_tab_create_failed");
    run.helperTabId = helperTab.id;
    return helperTab;
  }

  async function bestEffortCancelTarget(run) {
    if (!run.incognitoTabId) return;
    if (run.targetCancel) return run.targetCancel;
    run.targetCancel = (async () => {
      try {
        const cancelPromise = api.scripting.executeScript({
          target: { tabId: run.incognitoTabId },
          world: "ISOLATED",
          func: cancelSmsOnPage,
          args: [{ runId: run.runId }],
        });
        cancelPromise.catch(() => {});
        await bounded(cancelPromise, new AbortController().signal, cancelPageTimeoutMs, "sms_cancel_timeout");
      } catch {
        // best-effort target page cancellation
      } finally {
        run.pageTokenRegistered = false;
        run.targetCancel = null;
      }
    })();
    return run.targetCancel;
  }

  async function waitForHelperComplete(run, deadline) {
    while (now() < deadline) {
      throwIfCancelled(run);
      const helperTab = await getTabOrNull(api, run.helperTabId);
      if (!helperTab) throw new Error("helper_tab_closed");
      if (helperTab.status === "complete") return helperTab;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(HELPER_LOAD_POLL_MS, remaining), run.abort.signal);
    }
    throwIfCancelled(run);
    throw new Error("helper_page_not_stable");
  }

  async function finalReadOrFail(run, deadline) {
    const final = await executeRead(run, deadline);
    if (final?.ok) return validateSmsCode(final);
    if (final?.error === "totp_code_ambiguous") throw new Error("sms_code_ambiguous");
    const remaining = deadline - now();
    if (remaining > 0) await sleep(remaining, run.abort.signal);
    throwIfCancelled(run);
    throw new Error("sms_code_not_found");
  }

  async function waitForCode(run) {
    const started = now();
    const deadline = started + TOTAL_TIMEOUT_MS;
    let reloads = 0;

    while (true) {
      if (deadline - now() <= 0) throw new Error("sms_code_not_found");
      const readDeadline = Math.min(deadline, now() + HELPER_READ_TIMEOUT_MS);
      const result = await executeRead(run, readDeadline);
      if (result?.ok) return validateSmsCode(result);
      if (result?.error === "totp_code_ambiguous") throw new Error("sms_code_ambiguous");
      if (result?.error !== "code_not_present") throw new Error(result?.error || "helper_page_not_stable");

      const finalReadBudgetMs = HELPER_READ_TIMEOUT_MS;
      const nextBoundary = reloads < 3
        ? started + REFRESH_INTERVAL_MS * (reloads + 1)
        : deadline;
      const sleepLimit = Math.min(deadline - finalReadBudgetMs, nextBoundary);
      const sleepMs = Math.max(0, sleepLimit - now());
      if (sleepMs > 0) await sleep(sleepMs, run.abort.signal);
      throwIfCancelled(run);
      if (deadline - now() <= 0) throw new Error("sms_code_not_found");
      if (reloads >= 3) return finalReadOrFail(run, deadline);
      const helperTab = await getTabOrNull(api, run.helperTabId);
      if (!helperTab) throw new Error("helper_tab_closed");
      await api.tabs.reload(run.helperTabId);
      reloads += 1;
      throwIfCancelled(run);
    }
  }

  async function removeHelperById(run, helperTabId) {
    if (!run.lateHelperRemovals) run.lateHelperRemovals = new Map();
    if (run.lateHelperRemovals.has(helperTabId)) return run.lateHelperRemovals.get(helperTabId);
    const removal = api.tabs.remove(helperTabId)
      .catch(() => {
        // best-effort late helper cleanup
      })
      .finally(() => {
        run.lateHelperRemovals.delete(helperTabId);
      });
    run.lateHelperRemovals.set(helperTabId, removal);
    return removal;
  }

  async function removeRecordedHelper(run) {
    if (run.helperTabId == null) return;
    if (run.helperRemoval) return run.helperRemoval;
    const helperTabId = run.helperTabId;
    run.helperRemoval = api.tabs.remove(helperTabId)
      .then(() => {
        if (run.helperTabId === helperTabId) run.helperTabId = null;
      })
      .finally(() => {
        run.helperRemoval = null;
      });
    return run.helperRemoval;
  }

  async function closeHelper(run) {
    await removeRecordedHelper(run);
  }

  async function cleanupHelper(run) {
    try {
      await removeRecordedHelper(run);
    } catch {
      // best-effort cleanup
    }
  }

  async function run({ motherTabId, incognitoTabId, excelRow } = {}) {
    if (active) throw new Error("sms_lab_run_active");
    const completion = makeDeferred();
    const run = {
      runId: makeRunId(),
      motherTabId,
      incognitoTabId,
      helperTabId: null,
      helperRemoval: null,
      lateHelperRemovals: new Map(),
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      pageTokenRegistered: false,
      targetCancel: null,
      abort: new AbortController(),
      state: "VALIDATING",
      error: "",
    };
    active = run;
    last = publicState(run);

    try {
      const selectors = requireSmsLabSelectors(options.selectors ?? SMS_LAB_SELECTORS);
      validateRequest({ motherTabId, incognitoTabId, excelRow });
      const { motherTab } = await assertTabs(motherTabId, incognitoTabId);
      await assertTargetActiveTab(incognitoTabId, run.runId);
      throwIfCancelled(run);

      setState(run, "READING_CHALLENGE");
      const native = await request("get_sms_lab_challenge", { excel_row: excelRow }, run.abort.signal);
      throwIfCancelled(run);
      if (native.ok !== true) throw new Error(native.error || "sms_lab_challenge_failed");
      const phone = validatePhone(native.phone);
      const challengeUrl = validateChallengeUrl(native.challenge_url);

      setState(run, "REQUESTING_SMS");
      await registerTargetToken(run);
      await executeTarget(run, requestSmsOnPage, {
        runId: run.runId,
        requireExistingToken: true,
        phone,
        selectors,
        timeoutMs: PAGE_ACTION_TIMEOUT_MS,
      });
      run.pageTokenRegistered = false;
      throwIfCancelled(run);

      setState(run, "OPENING_HELPER");
      await createHelperTab(run, {
        windowId: motherTab.windowId,
        index: motherTab.index + 1,
        active: false,
        url: challengeUrl,
      });
      throwIfCancelled(run);

      setState(run, "WAITING_FOR_CODE");
      const code = await waitForCode(run);
      await closeHelper(run);

      const refreshedMother = await getTabOrNull(api, motherTabId);
      if (!refreshedMother) throw new Error("mother_tab_missing");
      if (refreshedMother.incognito) throw new Error("mother_tab_incognito");
      if (refreshedMother.active !== true) throw new Error("mother_tab_not_active");

      throwIfCancelled(run);
      await assertTargetActiveTab(incognitoTabId, run.runId);
      throwIfCancelled(run);
      setState(run, "SUBMITTING_SMS");
      await registerTargetToken(run);
      await executeTarget(run, submitSmsCodeOnPage, {
        runId: run.runId,
        requireExistingToken: true,
        code,
        selectors,
        timeoutMs: PAGE_ACTION_TIMEOUT_MS,
      });
      run.pageTokenRegistered = false;

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
      if (run.pageTokenRegistered) await bestEffortCancelTarget(run);
      await cleanupHelper(run);
      if (active === run) active = null;
      run.resolveCompletion();
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
    await bestEffortCancelTarget(run);
    await cleanupHelper(run);
    await run.completion;
    await cleanupHelper(run);
    return publicState(run);
  }

  return { run, cancel, getState: () => ({ ...last }) };
}
