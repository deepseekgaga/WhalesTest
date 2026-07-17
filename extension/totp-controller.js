import { fillTotpOnPage } from "./totp-page.js";

const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function publicState(run) {
  return run
    ? { state: run.state, runId: run.runId, ...(run.error ? { error: run.error } : {}) }
    : { state: "IDLE", runId: null, error: "" };
}

function safeError(error, fallback = "totp_failed") {
  const value = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

export function createTotpController(api, options = {}) {
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
    port.onDisconnect?.addListener(() => {
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

  function stillActive(run) {
    return active === run;
  }

  async function run({ tabId, username, password }) {
    if (active) throw new Error("totp_run_active");
    const run = { runId: makeRunId(), tabId, state: "FETCHING_TOTP", error: "" };
    active = run;
    last = publicState(run);
    try {
      if (!Number.isInteger(tabId) || typeof username !== "string" || typeof password !== "string") {
        throw new Error("request_invalid");
      }
      const response = await request("get_totp", { username, password });
      if (!stillActive(run)) return last;
      if (response.ok !== true) throw new Error(response.error || "totp_native_error");
      if (typeof response.code !== "string" || !/^\d{6}$/.test(response.code)) throw new Error("totp_code_invalid");

      run.state = "FILLING_TOTP";
      last = publicState(run);
      const results = await api.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: fillTotpOnPage,
        args: [{ code: response.code }],
      });
      if (!stillActive(run)) return last;
      const result = results?.[0]?.result;
      if (!result?.ok) throw new Error(result?.error || "otp_page_action_failed");
      run.state = "SUCCEEDED";
    } catch (error) {
      if (!stillActive(run)) return last;
      run.state = "FAILED";
      run.error = safeError(error);
    }
    active = null;
    last = publicState(run);
    return last;
  }

  async function cancel(runId) {
    if (!active || (runId && active.runId !== runId)) return last;
    const cancelled = active;
    cancelled.state = "CANCELLED";
    cancelled.error = "cancelled";
    active = null;
    last = publicState(cancelled);
    return last;
  }

  return { run, cancel, getState: () => ({ ...last }) };
}
