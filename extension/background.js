import { createTotpController } from "./totp-controller.js";

const HOST_NAME = "com.whalestest.cc_batch";
const DOWNLOAD_SUBDIRECTORY = "jingshajingsha/txt保存";

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBatchController(api, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const fallbackMs = options.fallbackMs ?? Math.min(1000, Math.max(100, Math.floor(timeoutMs / 4)));
  const state = {
    running: false,
    current: 0,
    total: 0,
    success: 0,
    failure: 0,
    currentUrl: "",
    lastError: "",
    batchId: null,
  };
  let port = null;
  let tasks = [];
  let taskIndex = 0;
  let current = null;
  let timeoutTimer = null;
  let fallbackTimer = null;
  let runPromise = null;
  let resolveRun = null;
  const pending = new Map();

  function publish() {
    void api.storage?.local?.set?.({ ccBatchState: { ...state } });
    void api.action?.setBadgeText?.({ text: state.running ? `${state.current}/${state.total}` : "" });
  }

  function connect() {
    if (port) return;
    port = api.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener((message) => {
      const request = pending.get(message.request_id);
      if (!request) return;
      pending.delete(message.request_id);
      if (message.ok === false) {
        const error = new Error(message.error || "native_host_error");
        error.fatal = Boolean(message.fatal);
        request.reject(error);
      } else request.resolve(message);
    });
    port.onDisconnect?.addListener(() => {
      for (const request of pending.values()) request.reject(new Error("native_host_disconnected"));
      pending.clear();
      if (state.running) {
        state.running = false;
        state.lastError = "native_host_disconnected";
        publish();
        completeRun();
      }
      port = null;
    });
  }

  function request(command, payload = {}) {
    connect();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      port.postMessage({ request_id: requestId, command, ...payload });
    });
  }

  function completeRun() {
    clearTimeout(timeoutTimer);
    clearTimeout(fallbackTimer);
    timeoutTimer = null;
    fallbackTimer = null;
    current = null;
    tasks = [];
    taskIndex = 0;
    const resolve = resolveRun;
    resolveRun = null;
    runPromise = null;
    resolve?.();
  }

  async function persistResult(task, downloadPath, localError) {
    let response;
    try {
      response = await request("process_result", {
        sequence: task.sequence,
        download_path: downloadPath,
      });
    } catch (error) {
      state.lastError = error.message;
      state.failure += 1;
      if (error.fatal) {
        state.running = false;
        publish();
        completeRun();
        return false;
      }
      return true;
    }
    const success = response.status === "success";
    state.success += success ? 1 : 0;
    state.failure += success ? 0 : 1;
    if (!success) state.lastError = localError || response.error || "task_failed";
    return true;
  }

  async function finishCurrent(downloadPath, localError = "") {
    if (!current) return;
    const task = current;
    current = null;
    clearTimeout(timeoutTimer);
    clearTimeout(fallbackTimer);
    timeoutTimer = null;
    fallbackTimer = null;
    const shouldContinue = await persistResult(task, downloadPath, localError);
    if (!shouldContinue) return;
    taskIndex += 1;
    state.current = taskIndex;
    state.currentUrl = tasks[taskIndex]?.url || "";
    publish();
    await advance();
  }

  async function advance() {
    if (!state.running) return;
    if (taskIndex >= tasks.length) {
      state.running = false;
      state.currentUrl = "";
      publish();
      completeRun();
      return;
    }
    const task = tasks[taskIndex];
    current = { ...task, downloadId: null };
    state.currentUrl = task.url;
    publish();
    if (task.validation_error) {
      await finishCurrent(null, task.validation_error);
      return;
    }
    const tab = await api.tabs.create({ url: "about:blank", active: false });
    current.tabId = tab.id;
    await api.tabs.update(tab.id, { url: task.url });
    fallbackTimer = setTimeout(() => {
      if (current?.downloadId == null && api.downloads.download) {
        void api.downloads.download({
          url: task.url,
          filename: `${DOWNLOAD_SUBDIRECTORY}/${String(task.sequence).padStart(4, "0")}.zip`,
          conflictAction: "uniquify",
        });
      }
    }, fallbackMs);
    timeoutTimer = setTimeout(() => { void finishCurrent(null, "download_timeout"); }, timeoutMs);
  }

  async function start() {
    if (runPromise) return runPromise;
    runPromise = new Promise((resolve) => { resolveRun = resolve; });
    const activePromise = runPromise;
    state.running = true;
    state.current = 0;
    state.total = 0;
    state.success = 0;
    state.failure = 0;
    state.currentUrl = "";
    state.lastError = "";
    publish();
    try {
      connect();
      await request("preflight");
      const prepared = await request("prepare_batch");
      tasks = prepared.tasks || [];
      taskIndex = 0;
      state.current = 0;
      state.total = tasks.length;
      state.success = 0;
      state.failure = 0;
      state.lastError = "";
      state.batchId = prepared.batch_id || null;
      publish();
      await advance();
    } catch (error) {
      state.running = false;
      state.lastError = error.message;
      publish();
      completeRun();
    }
    return activePromise;
  }

  async function resolveDownload(downloadId) {
    const items = await api.downloads.search({ id: downloadId });
    const item = items?.[0];
    await finishCurrent(item?.filename || null, item ? "" : "download_item_missing");
  }

  function handleDownloadCreated(item) {
    if (!current || current.downloadId != null) return;
    if (item.url !== current.url && item.finalUrl !== current.url) return;
    current.downloadId = item.id;
    clearTimeout(fallbackTimer);
    if (item.state === "complete") void resolveDownload(item.id);
  }

  function handleDownloadChanged(delta) {
    if (!current || current.downloadId !== delta.id) return;
    if (delta.state?.current === "complete") void resolveDownload(delta.id);
    else if (delta.state?.current === "interrupted") void finishCurrent(null, delta.error?.current || "download_interrupted");
  }

  function handleDeterminingFilename(item, suggest) {
    if (!current || (item.url !== current.url && item.finalUrl !== current.url)) return;
    const original = String(item.filename || "").split(/[\\/]/).pop();
    const filename = original?.toLowerCase().endsWith(".zip")
      ? original
      : `${String(current.sequence).padStart(4, "0")}.zip`;
    suggest({ filename: `${DOWNLOAD_SUBDIRECTORY}/${filename}`, conflictAction: "uniquify" });
  }

  api.downloads?.onCreated?.addListener(handleDownloadCreated);
  api.downloads?.onChanged?.addListener(handleDownloadChanged);
  api.downloads?.onDeterminingFilename?.addListener(handleDeterminingFilename);

  return {
    start,
    getState: () => ({ ...state }),
    handleDownloadCreated,
    handleDownloadChanged,
    handleDeterminingFilename,
  };
}

function safeRouteError(error, fallback = "totp_route_failed") {
  const value = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

export function createExtensionRuntime(api) {
  const batchController = createBatchController(api);
  const totpController = createTotpController(api);
  const listener = (message, sender, sendResponse) => {
    if (message?.type === "run_totp" || message?.type === "cancel_totp") {
      const senderMatchesTarget = message.tabId == null || sender?.tab?.id == null || sender.tab.id === message.tabId;
      if (sender?.id !== api.runtime.id || !senderMatchesTarget) {
        sendResponse({ ok: false, error: "sender_rejected" });
        return false;
      }
      if (message.type === "run_totp") {
        void totpController.run(message)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: safeRouteError(error) }));
        return true;
      }
      void totpController.cancel(message.runId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: safeRouteError(error) }));
      return true;
    }
    if (message?.type === "start") {
      void batchController.start();
      sendResponse(batchController.getState());
      return false;
    }
    if (message?.type === "state") {
      sendResponse(batchController.getState());
      return false;
    }
    return false;
  };
  api.runtime.onMessage.addListener(listener);
  return { batchController, totpController, listener };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  createExtensionRuntime(chrome);
}
