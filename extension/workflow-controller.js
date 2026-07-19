import { clickAcceptOnPage, detectFinalPageOnPage } from "./final-page.js";
import { detectTotpStageOnPage, submitLoginOnPage } from "./login-page.js";
import { backfillFinalUrlOnPage, generateAuthorizationUrlOnPage, prepareMotherAccountOnPage } from "./mother-page.js";
import { cancelWorkflowOnPage, registerWorkflowOnPage } from "./workflow-page-context.js";
import { requireWorkflowSelectors, WORKFLOW_SELECTORS } from "./workflow-selectors.js";
import { TERMINAL_STAGES, createWorkflowState, formatAccountName, nextRowState, publicWorkflowState } from "./workflow-state.js";
import { makeHandoffUrl, validateAuthorizationUrl, validateFinalUrl } from "./workflow-urls.js";

export const STATE_KEY = "workflowState";
export const ALARM_PREFIX = "whalestest-workflow:";
export const MOTHER_URL = "http://127.0.0.1:9527/";
export const DEFAULT_TARGET_ORIGIN = "http://auth-target.local";

const HOST_NAME = "com.whalestest.cc_batch";
const NATIVE_TIMEOUT_MS = 15_000;
const allowedErrors = new Set([
  "accept_button_missing",
  "another_workflow_running",
  "authorization_origin_mismatch",
  "authorization_url_ambiguous",
  "authorization_url_invalid",
  "authorization_url_missing",
  "code_ambiguous",
  "code_invalid",
  "code_not_present",
  "credentials_invalid",
  "cleanup_failed",
  "download_interrupted",
  "download_item_missing",
  "download_timeout",
  "element_ambiguous",
  "element_missing",
  "excel_exhausted",
  "final_url_invalid",
  "final_page_not_ready",
  "group_options_missing",
  "helper_page_not_stable",
  "helper_tab_closed",
  "incognito_access_required",
  "incognito_window_ambiguous",
  "login_input_rejected",
  "login_failed",
  "login_rejected",
  "mother_backfill_failed",
  "mother_tab_incognito",
  "mother_tab_missing",
  "mother_url_invalid",
  "native_host_unavailable",
  "otp_page_action_failed",
  "otp_code_invalid",
  "otp_input_not_found",
  "otp_submit_disabled",
  "otp_submit_failed",
  "otp_submit_not_found",
  "otp_submit_unavailable",
  "page_action_failed",
  "page_not_stable",
  "platform_option_missing",
  "request_invalid",
  "selector_not_configured",
  "sms_lab_challenge_failed",
  "sms_lab_failed",
  "sms_page_action_failed",
  "target_host_permission_required",
  "totp_lab_challenge_failed",
  "totp_lab_failed",
  "totp_stage_not_reached",
  "workflow_cancelled",
  "workflow_failed",
  "workflow_page_context_reset",
  "workflow_running",
]);

function makeRequestId(now) {
  return `${now()}-${Math.random().toString(16).slice(2)}`;
}

function safeError(error, fallback = "workflow_failed") {
  const message = error instanceof Error ? error.message : "";
  return allowedErrors.has(message) ? message : fallback;
}

function clonePublicFailure(error) {
  return { ...publicWorkflowState(null), state: "FAILED", error };
}

function normalizeTargetOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
      throw new Error("authorization_origin_mismatch");
    }
    return { origin: url.origin, error: "" };
  } catch {
    return { origin: DEFAULT_TARGET_ORIGIN, error: "authorization_origin_mismatch" };
  }
}

export function createNativeRequest(api, options = {}) {
  const timeoutMs = options.timeoutMs ?? NATIVE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  return function requestNative(command, payload = {}) {
    if (payload == null || typeof payload !== "object" || Object.hasOwn(payload, "request_id") || Object.hasOwn(payload, "command")) {
      return Promise.reject(new Error("request_invalid"));
    }

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
        port.postMessage({ ...payload, command, request_id: requestId });
      } catch {
        finish(reject, new Error("native_host_unavailable"));
      }
    });
  };
}

export function createWorkflowController(api, options = {}) {
  const now = options.now ?? Date.now;
  const makeBatchId = options.makeBatchId ?? (() => globalThis.crypto?.randomUUID?.() ?? makeRequestId(now));
  const targetOriginConfig = normalizeTargetOrigin(options.targetOrigin ?? DEFAULT_TARGET_ORIGIN);
  const targetOrigin = targetOriginConfig.origin;
  const rawSelectors = options.selectors ?? WORKFLOW_SELECTORS;
  const requestNative = options.requestNative ?? createNativeRequest(api, { now });
  const totpLabController = options.totpLabController;
  const smsLabController = options.smsLabController;
  let state = null;
  let stateEpoch = 0;
  let loaded = false;
  let processing = false;
  let startInFlight = false;

  const configuredSelectors = () => requireWorkflowSelectors(rawSelectors);

  async function loadState() {
    if (loaded) return;
    const stored = await api.storage?.session?.get?.(STATE_KEY);
    state = stored?.[STATE_KEY] ?? null;
    stateEpoch += 1;
    loaded = true;
  }

  function setState(next) {
    state = next;
    stateEpoch += 1;
  }

  function snapshot() {
    return state ? { batchId: state.batchId, stage: state.stage, epoch: stateEpoch } : null;
  }

  function isCurrent(activeSnapshot) {
    return Boolean(
      activeSnapshot &&
      state &&
      state.batchId === activeSnapshot.batchId &&
      state.stage === activeSnapshot.stage &&
      stateEpoch === activeSnapshot.epoch &&
      !TERMINAL_STAGES.has(state.stage),
    );
  }

  async function persist(next, activeSnapshot = null) {
    if (activeSnapshot && !isCurrent(activeSnapshot)) return false;
    const nextState = { ...next, updatedAt: now() };
    await api.storage.session.set({ [STATE_KEY]: nextState });
    if (activeSnapshot && !isCurrent(activeSnapshot)) {
      if (state) await api.storage.session.set({ [STATE_KEY]: state });
      return false;
    }
    setState(nextState);
    return true;
  }

  async function schedule(batchId, delayMs = 0) {
    await Promise.resolve(api.alarms.create(`${ALARM_PREFIX}${batchId}`, { when: now() + Math.max(0, delayMs) }));
  }

  async function transition(stage, patch = {}, activeSnapshot) {
    if (!isCurrent(activeSnapshot)) return false;
    if (!await persist({ ...state, ...patch, stage, attempt: 0, error: "" }, activeSnapshot)) return false;
    const scheduledSnapshot = snapshot();
    try {
      await schedule(state.batchId, 0);
    } catch {
      await persist({ ...state, stage: "FAILED", error: "workflow_failed" }, scheduledSnapshot);
      throw new Error("workflow_failed");
    }
    if (!isCurrent(scheduledSnapshot)) await api.alarms?.clear?.(`${ALARM_PREFIX}${scheduledSnapshot.batchId}`);
    return true;
  }

  async function scheduleCurrent(delayMs, activeSnapshot) {
    if (!isCurrent(activeSnapshot)) return false;
    try {
      await schedule(state.batchId, delayMs);
    } catch {
      await persist({ ...state, stage: "FAILED", error: "workflow_failed" }, activeSnapshot);
      throw new Error("workflow_failed");
    }
    if (!isCurrent(activeSnapshot)) {
      await api.alarms?.clear?.(`${ALARM_PREFIX}${activeSnapshot.batchId}`);
      return false;
    }
    return true;
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

  async function removeWindowOrTreatMissingAsSuccess(windowId) {
    try {
      await api.windows.remove(windowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/No window with id|Window not found|Invalid window id/i.test(message)) return;
      throw new Error("cleanup_failed");
    }
  }

  async function openOwnedIncognito(authorizationUrl, activeSnapshot) {
    if (!isCurrent(activeSnapshot)) return;
    const markerUrl = makeHandoffUrl(state.batchId);
    let tab = state.incognitoTabId ? await getTabOrNull(state.incognitoTabId) : null;
    if (!isCurrent(activeSnapshot)) return;

    if (!tab) {
      const matches = (await api.tabs.query({})).filter((candidate) => candidate.incognito === true && candidate.url === markerUrl);
      if (!isCurrent(activeSnapshot)) return;
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
      if (!isCurrent(activeSnapshot)) return;
      tab = created?.tabs?.[0];
      if (!created?.id || !tab?.id || created.incognito !== true || tab.incognito !== true) {
        throw new Error("incognito_access_required");
      }
      if (!await persist({ ...state, incognitoWindowId: created.id, incognitoTabId: tab.id }, activeSnapshot)) return;
      activeSnapshot = snapshot();
    } else if (!state.incognitoTabId) {
      if (!await persist({ ...state, incognitoWindowId: tab.windowId, incognitoTabId: tab.id }, activeSnapshot)) return;
      activeSnapshot = snapshot();
    }

    if (tab.incognito !== true) throw new Error("incognito_access_required");
    try {
      const current = await api.tabs.get(tab.id);
      if (!isCurrent(activeSnapshot)) return;
      if (current.url === markerUrl) {
        await api.tabs.update(tab.id, { url: authorizationUrl, active: true });
        if (!isCurrent(activeSnapshot)) return;
      } else {
        let currentOrigin;
        try {
          currentOrigin = new URL(current.url).origin;
        } catch {
          throw new Error("authorization_origin_mismatch");
        }
        if (currentOrigin !== targetOrigin) throw new Error("authorization_origin_mismatch");
      }
    } catch (error) {
      await persist({ ...state, stage: "FAILED", error: safeError(error) }, activeSnapshot);
      throw error;
    }

    if (!await persist({ ...state, stage: "LOGIN", attempt: 0, error: "" }, activeSnapshot)) return;
    const scheduledSnapshot = snapshot();
    try {
      await schedule(state.batchId, 0);
    } catch {
      await persist({ ...state, stage: "FAILED", error: "workflow_failed" }, scheduledSnapshot);
      throw new Error("workflow_failed");
    }
    if (!isCurrent(scheduledSnapshot)) await api.alarms?.clear?.(`${ALARM_PREFIX}${scheduledSnapshot.batchId}`);
  }

  async function start() {
    if (startInFlight) return clonePublicFailure("workflow_running");
    startInFlight = true;
    try {
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
      if (targetOriginConfig.error) return clonePublicFailure(targetOriginConfig.error);

      let activeTabs;
      try {
        activeTabs = await api.tabs.query({ active: true, currentWindow: true });
      } catch {
        return clonePublicFailure("mother_tab_missing");
      }
      const motherTab = activeTabs?.[0];
      if (!motherTab) return clonePublicFailure("mother_tab_missing");
      if (motherTab.incognito) return clonePublicFailure("mother_tab_incognito");
      if (motherTab.url !== MOTHER_URL) return clonePublicFailure("mother_url_invalid");

      const nextState = createWorkflowState({
        batchId: makeBatchId(),
        motherTabId: motherTab.id,
        motherWindowId: motherTab.windowId,
        now: now(),
      });
      try {
        await persist(nextState);
        await schedule(nextState.batchId, 0);
      } catch {
        try {
          await persist({ ...nextState, stage: "FAILED", error: "workflow_failed" });
        } catch {
          setState({ ...nextState, stage: "FAILED", error: "workflow_failed", updatedAt: now() });
        }
      }
      return publicWorkflowState(state);
    } catch {
      return clonePublicFailure("workflow_failed");
    } finally {
      startInFlight = false;
    }
  }

  async function runCurrentStage(activeSnapshot) {
    switch (state.stage) {
      case "ROW_PREFLIGHT": {
        const response = await requestNative("get_workflow_credentials", { excel_row: state.excelRow });
        if (!isCurrent(activeSnapshot)) return;
        if (response?.ok !== true) {
          if (response?.error === "excel_exhausted") {
            await persist({ ...state, stage: "COMPLETED", error: "" }, activeSnapshot);
            return;
          }
          throw new Error(response?.error || "credentials_invalid");
        }
        await transition("MOTHER_ACCOUNT", {}, activeSnapshot);
        return;
      }
      case "MOTHER_ACCOUNT": {
        const result = await pageActions.prepareMother({
          tabId: state.motherTabId,
          accountName: formatAccountName(new Date(now()), state.sequence),
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "page_action_failed");
        await transition("AUTH_LINK", {}, activeSnapshot);
        return;
      }
      case "AUTH_LINK": {
        const result = await pageActions.generateAuthorization({
          tabId: state.motherTabId,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
        validateAuthorizationUrl(result.authorizationUrl, targetOrigin);
        await transition("OPEN_INCOGNITO", {}, activeSnapshot);
        return;
      }
      case "OPEN_INCOGNITO": {
        const result = await pageActions.generateAuthorization({
          tabId: state.motherTabId,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
        const authorizationUrl = validateAuthorizationUrl(result.authorizationUrl, targetOrigin);
        await openOwnedIncognito(authorizationUrl, activeSnapshot);
        return;
      }
      case "LOGIN": {
        const credentials = await requestNative("get_workflow_credentials", { excel_row: state.excelRow });
        if (!isCurrent(activeSnapshot)) return;
        if (credentials?.ok !== true) throw new Error(credentials?.error || "credentials_invalid");
        const result = await pageActions.submitLogin({
          tabId: state.incognitoTabId,
          username: credentials.username,
          password: credentials.password,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "login_failed");
        const submittedAt = now();
        if (!await persist({ ...state, stage: "LOGIN_WAIT", loginSubmittedAt: submittedAt, attempt: 0, error: "" }, activeSnapshot)) return;
        await scheduleCurrent(30_000, snapshot());
        return;
      }
      case "LOGIN_WAIT": {
        const remaining = (state.loginSubmittedAt ?? 0) + 30_000 - now();
        if (remaining > 0) {
          await scheduleCurrent(remaining, activeSnapshot);
          return;
        }
        const result = await pageActions.detectTotp({
          tabId: state.incognitoTabId,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "totp_stage_not_reached");
        await transition("TOTP", {}, activeSnapshot);
        return;
      }
      case "TOTP": {
        if (typeof totpLabController?.run !== "function") throw new Error("totp_lab_failed");
        const result = await totpLabController.run({
          motherTabId: state.motherTabId,
          incognitoTabId: state.incognitoTabId,
          excelRow: state.excelRow,
        });
        if (!isCurrent(activeSnapshot)) return;
        if (result?.state !== "SUCCEEDED") throw new Error(result?.error || "totp_lab_failed");
        await transition("SMS", {}, activeSnapshot);
        return;
      }
      case "SMS": {
        if (typeof smsLabController?.run !== "function") throw new Error("sms_lab_failed");
        const result = await smsLabController.run({
          motherTabId: state.motherTabId,
          incognitoTabId: state.incognitoTabId,
          excelRow: state.excelRow,
        });
        if (!isCurrent(activeSnapshot)) return;
        if (result?.state !== "SUCCEEDED") throw new Error(result?.error || "sms_lab_failed");
        await transition("ACCEPT", {}, activeSnapshot);
        return;
      }
      case "ACCEPT": {
        const accepted = await pageActions.clickAccept({
          tabId: state.incognitoTabId,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!accepted?.ok) throw new Error(accepted?.error || "accept_button_missing");
        const finalReady = await pageActions.detectFinal({
          tabId: state.incognitoTabId,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!finalReady?.ok) throw new Error(finalReady?.error || "final_page_not_ready");
        await transition("FINAL_URL", {}, activeSnapshot);
        return;
      }
      case "FINAL_URL": {
        const target = await api.tabs.get(state.incognitoTabId);
        if (!isCurrent(activeSnapshot)) return;
        const finalUrl = validateFinalUrl(target.url);
        await api.windows.update(state.motherWindowId, { focused: true });
        if (!isCurrent(activeSnapshot)) return;
        const result = await pageActions.backfillMother({
          tabId: state.motherTabId,
          finalUrl,
          selectors: configuredSelectors(),
        });
        if (!isCurrent(activeSnapshot)) return;
        if (!result?.ok) throw new Error(result?.error || "mother_backfill_failed");
        await transition("MOTHER_BACKFILL", {}, activeSnapshot);
        return;
      }
      case "MOTHER_BACKFILL": {
        await transition("COMMIT", {}, activeSnapshot);
        return;
      }
      case "COMMIT": {
        const next = nextRowState(state);
        if (!await persist({ ...state, ...next, stage: "CLEANUP", attempt: 0, error: "" }, activeSnapshot)) return;
        await scheduleCurrent(0, snapshot());
        return;
      }
      case "CLEANUP": {
        if (state.incognitoWindowId) {
          await removeWindowOrTreatMissingAsSuccess(state.incognitoWindowId);
          if (!isCurrent(activeSnapshot)) return;
        }
        if (!await persist({
          ...state,
          stage: "ROW_PREFLIGHT",
          incognitoTabId: null,
          incognitoWindowId: null,
          loginSubmittedAt: null,
          attempt: 0,
          error: "",
        }, activeSnapshot)) return;
        await scheduleCurrent(0, snapshot());
        return;
      }
      default:
        return;
    }
  }

  async function onAlarm(alarm) {
    await loadState();
    if (!state || alarm?.name !== `${ALARM_PREFIX}${state.batchId}` || TERMINAL_STAGES.has(state.stage) || processing) return;
    processing = true;
    const activeSnapshot = snapshot();
    try {
      await runCurrentStage(activeSnapshot);
    } catch (error) {
      if (!isCurrent(activeSnapshot)) return;
      await persist({ ...state, stage: "FAILED", error: safeError(error) }, activeSnapshot);
    } finally {
      processing = false;
    }
  }

  async function resume() {
    await loadState();
    if (state && !TERMINAL_STAGES.has(state.stage)) {
      try {
        await schedule(state.batchId, 0);
      } catch {
        await persist({ ...state, stage: "FAILED", error: "workflow_failed" });
      }
    }
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
