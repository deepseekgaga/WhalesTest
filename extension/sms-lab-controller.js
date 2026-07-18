import { readVisibleTotpCode } from "./totp-lab-page.js";
import { requestSmsOnPage, submitSmsCodeOnPage } from "./sms-lab-page.js";
import { SMS_LAB_SELECTORS, requireSmsLabSelectors } from "./sms-lab-selectors.js";

const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_ACTION_TIMEOUT_MS = 30_000;
const HELPER_READ_TIMEOUT_MS = 5_000;
const HELPER_LOAD_TIMEOUT_MS = 5_000;
const HELPER_LOAD_POLL_MS = 100;
const SMS_LAB_ORIGIN = "http://sms-lab.local";
const SMS_LAB_HOST = "sms-lab.local";

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function sleepDefault(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

function registerSmsOnPage() {
  return { ok: true };
}

function validateChallengeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new Error("sms_lab_url_invalid");
  }
  if (!/^http:\/\/sms-lab\.local(?:[/?]|$)/.test(value)) {
    throw new Error("sms_lab_url_invalid");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("sms_lab_url_invalid");
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
    throw new Error("sms_lab_url_invalid");
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
      for (const request of [...pending.values()]) request.reject(new Error("native_host_unavailable"));
      pending.clear();
      port = null;
    });
  }

  function request(command, payload = {}) {
    connect();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        pending.delete(requestId);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("native_host_timeout"));
      }, REQUEST_TIMEOUT_MS);
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

  async function assertTabs(motherTabId, incognitoTabId) {
    const motherTab = await api.tabs.get(motherTabId);
    if (!motherTab) throw new Error("mother_tab_missing");
    if (motherTab.incognito) throw new Error("mother_tab_incognito");
    if (motherTab.active !== true) throw new Error("mother_tab_not_active");

    const targetTab = await api.tabs.get(incognitoTabId);
    if (!targetTab) throw new Error("incognito_tab_missing");
    if (targetTab.incognito !== true) throw new Error("incognito_tab_required");

    return { motherTab, targetTab };
  }

  async function assertTargetActiveTab(incognitoTabId, runId) {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: incognitoTabId },
        world: "ISOLATED",
        func: registerSmsOnPage,
        args: [{ runId }],
      });
      if (!results?.[0]?.result?.ok) throw new Error("incognito_active_tab_required");
    } catch {
      throw new Error("incognito_active_tab_required");
    }
  }

  async function executeTarget(tabId, func, args) {
    const results = await api.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func,
      args: [args],
    });
    const result = results?.[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "sms_page_action_failed");
    return result;
  }

  async function waitForHelperComplete(helperTabId) {
    const deadline = now() + HELPER_LOAD_TIMEOUT_MS;
    while (now() < deadline) {
      const helperTab = await api.tabs.get(helperTabId);
      if (!helperTab) throw new Error("helper_tab_closed");
      if (helperTab.status === "complete") return helperTab;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(HELPER_LOAD_POLL_MS, remaining));
    }
    throw new Error("helper_page_not_stable");
  }

  async function closeHelper(run) {
    if (run.helperTabId == null) return;
    const helperTabId = run.helperTabId;
    await api.tabs.remove(helperTabId);
    run.helperTabId = null;
  }

  async function cleanupHelper(run) {
    if (run.helperTabId == null) return;
    const helperTabId = run.helperTabId;
    try {
      await api.tabs.remove(helperTabId);
      run.helperTabId = null;
    } catch {
      // best-effort cleanup
    }
  }

  async function run({ motherTabId, incognitoTabId, excelRow } = {}) {
    if (active) throw new Error("sms_lab_run_active");
    const run = {
      runId: makeRunId(),
      helperTabId: null,
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

      setState(run, "READING_CHALLENGE");
      const native = await request("get_sms_lab_challenge", { excel_row: excelRow });
      if (native.ok !== true) throw new Error(native.error || "sms_lab_challenge_failed");
      const phone = validatePhone(native.phone);
      const challengeUrl = validateChallengeUrl(native.challenge_url);

      setState(run, "REQUESTING_SMS");
      await executeTarget(incognitoTabId, requestSmsOnPage, {
        phone,
        selectors,
        timeoutMs: PAGE_ACTION_TIMEOUT_MS,
      });

      setState(run, "OPENING_HELPER");
      const helperTab = await api.tabs.create({
        windowId: motherTab.windowId,
        index: motherTab.index + 1,
        active: false,
        url: challengeUrl,
      });
      if (!helperTab?.id) throw new Error("helper_tab_create_failed");
      run.helperTabId = helperTab.id;

      setState(run, "WAITING_FOR_CODE");
      const loadedHelperTab = await waitForHelperComplete(run.helperTabId);
      validateChallengeUrl(loadedHelperTab.url);
      const helperResults = await api.scripting.executeScript({
        target: { tabId: run.helperTabId },
        world: "ISOLATED",
        func: readVisibleTotpCode,
        args: [{ timeoutMs: HELPER_READ_TIMEOUT_MS }],
      });
      const code = validateSmsCode(helperResults?.[0]?.result);
      await closeHelper(run);

      const refreshedMother = await api.tabs.get(motherTabId);
      if (!refreshedMother) throw new Error("mother_tab_missing");
      if (refreshedMother.incognito) throw new Error("mother_tab_incognito");
      if (refreshedMother.active !== true) throw new Error("mother_tab_not_active");

      setState(run, "SUBMITTING_SMS");
      await executeTarget(incognitoTabId, submitSmsCodeOnPage, {
        code,
        selectors,
        timeoutMs: PAGE_ACTION_TIMEOUT_MS,
      });

      run.state = "SUCCEEDED";
      run.error = "";
      last = publicState(run);
    } catch (error) {
      run.state = "FAILED";
      run.error = safeError(error);
      last = publicState(run);
    } finally {
      await cleanupHelper(run);
      if (active === run) active = null;
    }

    return { ...last };
  }

  return { run, getState: () => ({ ...last }) };
}
