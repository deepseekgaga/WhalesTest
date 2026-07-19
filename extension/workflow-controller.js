import { clickAcceptOnPage, detectFinalPageOnPage } from "./final-page.js";
import { detectTotpStageOnPage, submitLoginOnPage } from "./login-page.js";
import { backfillFinalUrlOnPage, generateAuthorizationUrlOnPage, prepareMotherAccountOnPage } from "./mother-page.js";
import { cancelWorkflowOnPage, registerWorkflowOnPage } from "./workflow-page-context.js";
import { requireWorkflowSelectors, WORKFLOW_SELECTORS } from "./workflow-selectors.js";
import { TERMINAL_STAGES, createWorkflowState, formatAccountName, publicWorkflowState } from "./workflow-state.js";
import { makeHandoffUrl, validateAuthorizationUrl } from "./workflow-urls.js";

export const STATE_KEY = "workflowState";
export const ALARM_PREFIX = "whalestest-workflow:";
export const MOTHER_URL = "http://127.0.0.1:9527/";
export const DEFAULT_TARGET_ORIGIN = "http://auth-target.local";

const HOST_NAME = "com.whalestest.cc_batch";
const NATIVE_TIMEOUT_MS = 15_000;

function makeRequestId(now) {
  return `${now()}-${Math.random().toString(16).slice(2)}`;
}

function safeError(error, fallback = "workflow_failed") {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(message) ? message : fallback;
}

function clonePublicFailure(error) {
  return { ...publicWorkflowState(null), state: "FAILED", error };
}

export function createNativeRequest(api, options = {}) {
  const timeoutMs = options.timeoutMs ?? NATIVE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return function requestNative(command, payload = {}) {
    let port;
    try {
      port = api.runtime.connectNative(HOST_NAME);
    } catch {
      return Promise.reject(new Error("native_host_unavailable"));
    }

    const requestId = makeRequestId(now);
    let timer;
    let settled = false;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port?.onMessage?.removeListener?.(onMessage);
        port?.onDisconnect?.removeListener?.(onDisconnect);
        try {
          port?.disconnect?.();
        } catch {
          // Port may already be disconnected by Chrome.
        }
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onMessage = (message) => {
        if (message?.request_id !== requestId) return;
        finish(resolve, message);
      };
      const onDisconnect = () => {
        finish(reject, new Error("native_host_unavailable"));
      };

      timer = setTimeout(() => finish(reject, new Error("native_host_unavailable")), timeoutMs);
      port?.onMessage?.addListener?.(onMessage);
      port?.onDisconnect?.addListener?.(onDisconnect);
      try {
        port.postMessage({ request_id: requestId, command, ...payload });
      } catch {
        finish(reject, new Error("native_host_unavailable"));
      }
    });
  };
}

export function createWorkflowController(api, options = {}) {
  const now = options.now ?? Date.now;
  const makeBatchId = options.makeBatchId ?? (() => globalThis.crypto?.randomUUID?.() ?? makeRequestId(now));
  const targetOrigin = options.targetOrigin ?? DEFAULT_TARGET_ORIGIN;
  const rawSelectors = options.selectors ?? WORKFLOW_SELECTORS;
  const requestNative = options.requestNative ?? createNativeRequest(api, { now });
  const totpLabController = options.totpLabController;
  const smsLabController = options.smsLabController;
  let state = null;
  let loaded = false;
  let processing = false;

  const configuredSelectors = () => requireWorkflowSelectors(rawSelectors);

  async function loadState() {
    if (loaded) return;
    const stored = await api.storage?.session?.get?.(STATE_KEY);
    state = stored?.[STATE_KEY] ?? null;
    loaded = true;
  }

  async function persist(next) {
    state = { ...next, updatedAt: now() };
    await api.storage.session.set({ [STATE_KEY]: state });
  }

  function schedule(delayMs = 0) {
    api.alarms.create(`${ALARM_PREFIX}${state.batchId}`, { when: now() + Math.max(0, delayMs) });
  }

  async function transition(stage, patch = {}) {
    await persist({ ...state, ...patch, stage, attempt: 0, error: "" });
    schedule(0);
  }

  async function executePageAction(tabId, func, args = {}) {
    let registered;
    try {
      registered = await api.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: registerWorkflowOnPage,
        args: [{ runId: state.batchId }],
      });
    } catch {
      throw new Error("target_host_permission_required");
    }
    if (!registered?.[0]?.result?.ok) throw new Error("target_host_permission_required");

    let results;
    try {
      results = await api.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func,
        args: [{ ...args, runId: state.batchId, requireExistingToken: true }],
      });
    } catch {
      throw new Error("target_host_permission_required");
    }
    return results?.[0]?.result ?? { ok: false, error: "page_action_failed" };
  }

  function createInjectedPageActions() {
    return {
      prepareMother: ({ tabId, ...args }) => executePageAction(tabId, prepareMotherAccountOnPage, args),
      generateAuthorization: ({ tabId, ...args }) => executePageAction(tabId, generateAuthorizationUrlOnPage, args),
      submitLogin: ({ tabId, ...args }) => executePageAction(tabId, submitLoginOnPage, args),
      detectTotp: ({ tabId, ...args }) => executePageAction(tabId, detectTotpStageOnPage, args),
      clickAccept: ({ tabId, ...args }) => executePageAction(tabId, clickAcceptOnPage, args),
      detectFinal: ({ tabId, ...args }) => executePageAction(tabId, detectFinalPageOnPage, args),
      backfillMother: ({ tabId, ...args }) => executePageAction(tabId, backfillFinalUrlOnPage, args),
      cancelPage: ({ tabId, ...args }) => executePageAction(tabId, cancelWorkflowOnPage, args),
    };
  }

  const pageActions = options.pageActions ?? createInjectedPageActions();

  async function getTabOrNull(tabId) {
    try {
      return await api.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function openOwnedIncognito(authorizationUrl) {
    const markerUrl = makeHandoffUrl(state.batchId);
    let tab = state.incognitoTabId ? await getTabOrNull(state.incognitoTabId) : null;

    if (!tab) {
      const matches = (await api.tabs.query({})).filter((candidate) => candidate.incognito === true && candidate.url === markerUrl);
      if (matches.length > 1) throw new Error("incognito_window_ambiguous");
      tab = matches[0] ?? null;
    }

    if (!tab) {
      let created;
      try {
        created = await api.windows.create({ incognito: true, focused: true, type: "normal", url: markerUrl });
      } catch {
        throw new Error("incognito_access_required");
      }
      tab = created?.tabs?.[0];
      if (!created?.id || !tab?.id || created.incognito !== true || tab.incognito !== true) {
        throw new Error("incognito_access_required");
      }
      await persist({ ...state, incognitoWindowId: created.id, incognitoTabId: tab.id });
    } else if (!state.incognitoTabId) {
      await persist({ ...state, incognitoWindowId: tab.windowId, incognitoTabId: tab.id });
    }

    if (tab.incognito !== true) throw new Error("incognito_access_required");
    const current = await api.tabs.get(tab.id);
    if (current.url === markerUrl) {
      await api.tabs.update(tab.id, { url: authorizationUrl, active: true });
    } else {
      let currentOrigin;
      try {
        currentOrigin = new URL(current.url).origin;
      } catch {
        throw new Error("authorization_origin_mismatch");
      }
      if (currentOrigin !== targetOrigin) throw new Error("authorization_origin_mismatch");
    }

    await persist({ ...state, stage: "LOGIN", attempt: 0, error: "" });
    schedule(0);
  }

  async function start() {
    await loadState();
    if (state && !TERMINAL_STAGES.has(state.stage)) {
      return { ...publicWorkflowState(state), error: "workflow_running" };
    }
    if (options.isCcBatchRunning?.() === true) {
      return clonePublicFailure("another_workflow_running");
    }
    try {
      configuredSelectors();
    } catch {
      return clonePublicFailure("selector_not_configured");
    }

    const activeTabs = await api.tabs.query({ active: true, currentWindow: true });
    const motherTab = activeTabs?.[0];
    if (!motherTab) return clonePublicFailure("mother_tab_missing");
    if (motherTab.incognito) return clonePublicFailure("mother_tab_incognito");
    if (motherTab.url !== MOTHER_URL) return clonePublicFailure("mother_url_invalid");

    state = createWorkflowState({
      batchId: makeBatchId(),
      motherTabId: motherTab.id,
      motherWindowId: motherTab.windowId,
      now: now(),
    });
    await persist(state);
    schedule(0);
    return publicWorkflowState(state);
  }

  async function runCurrentStage() {
    switch (state.stage) {
      case "ROW_PREFLIGHT": {
        const response = await requestNative("get_workflow_credentials", { excel_row: state.excelRow });
        if (response?.ok !== true) {
          if (response?.error === "excel_exhausted") {
            await persist({ ...state, stage: "COMPLETED", error: "" });
            return;
          }
          throw new Error(response?.error || "credentials_invalid");
        }
        await transition("MOTHER_ACCOUNT");
        return;
      }
      case "MOTHER_ACCOUNT": {
        const result = await pageActions.prepareMother({
          tabId: state.motherTabId,
          accountName: formatAccountName(new Date(now()), state.sequence),
          selectors: configuredSelectors(),
        });
        if (!result?.ok) throw new Error(result?.error || "page_action_failed");
        await transition("AUTH_LINK");
        return;
      }
      case "AUTH_LINK": {
        const result = await pageActions.generateAuthorization({
          tabId: state.motherTabId,
          selectors: configuredSelectors(),
        });
        if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
        validateAuthorizationUrl(result.authorizationUrl, targetOrigin);
        await transition("OPEN_INCOGNITO");
        return;
      }
      case "OPEN_INCOGNITO": {
        const result = await pageActions.generateAuthorization({
          tabId: state.motherTabId,
          selectors: configuredSelectors(),
        });
        if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
        const authorizationUrl = validateAuthorizationUrl(result.authorizationUrl, targetOrigin);
        await openOwnedIncognito(authorizationUrl);
        return;
      }
      case "LOGIN":
        return;
      default:
        return;
    }
  }

  async function onAlarm(alarm) {
    await loadState();
    if (!state || alarm?.name !== `${ALARM_PREFIX}${state.batchId}` || TERMINAL_STAGES.has(state.stage) || processing) return;
    processing = true;
    try {
      await runCurrentStage();
    } catch (error) {
      await persist({ ...state, stage: "FAILED", error: safeError(error) });
    } finally {
      processing = false;
    }
  }

  async function resume() {
    await loadState();
    if (state && !TERMINAL_STAGES.has(state.stage)) schedule(0);
    return publicWorkflowState(state);
  }

  async function cancel(batchId) {
    await loadState();
    if (!state || TERMINAL_STAGES.has(state.stage)) return publicWorkflowState(state);
    if (batchId && batchId !== state.batchId) return publicWorkflowState(state);
    await persist({ ...state, stage: "CANCELLED", error: "" });
    await api.alarms?.clear?.(`${ALARM_PREFIX}${state.batchId}`);
    await totpLabController?.cancel?.();
    await smsLabController?.cancel?.();
    return publicWorkflowState(state);
  }

  return {
    start,
    onAlarm,
    getState: () => publicWorkflowState(state),
    resume,
    cancel,
  };
}
