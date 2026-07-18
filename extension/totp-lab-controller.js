import { readVisibleTotpCode } from "./totp-lab-page.js";
import { fillTotpOnPage } from "./totp-page.js";

const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;
const FILL_TIMEOUT_MS = 30_000;
const LAB_ORIGIN = "http://totp-lab.local";
const LAB_HOST = "totp-lab.local";

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      pending.delete(message.request_id);
      clearTimeout(request.timer);
      request.resolve(message);
    });
    port.onDisconnect?.addListener?.(() => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("native_host_unavailable"));
      }
      pending.clear();
      port = null;
    });
  }

  function request(command, payload = {}) {
    connect();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("native_host_timeout"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      port.postMessage({ request_id: requestId, command, ...payload });
    });
  }

  async function run({ motherTabId, incognitoTabId, excelRow }) {
    if (active) throw new Error("totp_lab_run_active");
    const run = { runId: makeRunId(), state: "READING_CHALLENGE", error: "" };
    active = run;
    last = publicState(run);
    let helperTabId = null;

    try {
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

      try {
        const registerResults = await api.scripting.executeScript({
          target: { tabId: incognitoTabId },
          world: "ISOLATED",
          func: registerTotpOnPage,
          args: [{ runId: run.runId }],
        });
        if (!registerResults?.[0]?.result?.ok) throw new Error("incognito_active_tab_required");
      } catch {
        throw new Error("incognito_active_tab_required");
      }

      run.state = "OPENING_HELPER";
      last = publicState(run);

      const native = await request("get_totp_lab_challenge", { excel_row: excelRow });
      if (native.ok !== true) throw new Error(native.error || "totp_lab_challenge_failed");
      const challengeUrl = validateChallengeUrl(native.challenge_url);

      const helperTab = await api.tabs.create({
        windowId: motherTab.windowId,
        index: motherTab.index + 1,
        active: false,
        url: challengeUrl,
      });
      if (!helperTab?.id) throw new Error("helper_tab_create_failed");
      helperTabId = helperTab.id;

      run.state = "WAITING_FOR_CODE";
      last = publicState(run);

      const helperResults = await api.scripting.executeScript({
        target: { tabId: helperTabId },
        world: "ISOLATED",
        func: readVisibleTotpCode,
        args: [{ timeoutMs: REQUEST_TIMEOUT_MS }],
      });
      const helperResult = helperResults?.[0]?.result;
      if (!helperResult?.ok) throw new Error(helperResult?.error || "helper_page_not_stable");

      await api.tabs.remove(helperTabId);
      helperTabId = null;

      const refreshedMother = await api.tabs.get(motherTabId);
      if (!refreshedMother) throw new Error("mother_tab_missing");
      if (refreshedMother.incognito) throw new Error("mother_tab_incognito");
      if (refreshedMother.active !== true) throw new Error("mother_tab_not_active");

      run.state = "FILLING_TOTP";
      last = publicState(run);

      const fillResults = await api.scripting.executeScript({
        target: { tabId: incognitoTabId },
        world: "ISOLATED",
        func: fillTotpOnPage,
        args: [{
          code: helperResult.code,
          runId: run.runId,
          requireExistingToken: true,
          timeoutMs: FILL_TIMEOUT_MS,
        }],
      });
      const fillResult = fillResults?.[0]?.result;
      if (!fillResult?.ok) throw new Error(fillResult?.error || "otp_page_action_failed");

      run.state = "SUCCEEDED";
      run.error = "";
      last = publicState(run);
    } catch (error) {
      run.state = "FAILED";
      run.error = safeError(error);
      last = publicState(run);
    } finally {
      if (helperTabId != null) {
        try {
          await api.tabs.remove(helperTabId);
        } catch {
          // best-effort cleanup
        }
      }
      active = null;
    }

    return { ...last };
  }

  return { run };
}
