import test from "node:test";
import assert from "node:assert/strict";
import { createTotpController } from "../totp-controller.js";

function makeChrome({ delayedNative = false, pageResult = { ok: true } } = {}) {
  const nativeMessages = [];
  const executions = [];
  let nativeListener;
  let disconnectListener;
  let delayedResponse;
  const port = {
    onMessage: { addListener(listener) { nativeListener = listener; } },
    onDisconnect: { addListener(listener) { disconnectListener = listener; } },
    postMessage(message) {
      nativeMessages.push(message);
      if (message.command !== "get_totp") return;
      const respond = () => nativeListener?.({
        request_id: message.request_id,
        ok: true,
        code: "123456",
        expires_at: "2026-07-18T00:00:30Z",
      });
      if (delayedNative) delayedResponse = respond;
      else queueMicrotask(respond);
    },
    disconnect() { disconnectListener?.(); },
  };
  return {
    nativeMessages,
    executions,
    releaseNative() { delayedResponse?.(); },
    runtime: { id: "ext", connectNative() { return port; } },
    scripting: {
      async executeScript(details) {
        executions.push(details);
        return [{ result: pageResult }];
      },
    },
  };
}

test("requests get_totp for bound credentials then injects only the returned code", async () => {
  const chrome = makeChrome();
  const controller = createTotpController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ tabId: 7, username: "alice", password: "pass" });
  assert.equal(chrome.nativeMessages[0].command, "get_totp");
  assert.equal(chrome.nativeMessages[0].username, "alice");
  assert.equal(chrome.nativeMessages[0].password, "pass");
  assert.equal(chrome.executions[0].target.tabId, 7);
  assert.deepEqual(chrome.executions[0].args, [{ code: "123456" }]);
  assert.equal(result.state, "SUCCEEDED");
});

test("cancel prevents a delayed native response from injecting into the tab", async () => {
  const chrome = makeChrome({ delayedNative: true });
  const controller = createTotpController(chrome, { makeRunId: () => "run-1" });
  const running = controller.run({ tabId: 7, username: "alice", password: "pass" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await controller.cancel("run-1"), { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  chrome.releaseNative();
  assert.deepEqual(await running, { state: "CANCELLED", runId: "run-1", error: "cancelled" });
  assert.equal(chrome.executions.length, 0);
});

test("turns a page action failure into a failed run without exposing credentials", async () => {
  const chrome = makeChrome({ pageResult: { ok: false, error: "otp_submit_disabled" } });
  const controller = createTotpController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ tabId: 7, username: "alice", password: "pass" });
  assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "otp_submit_disabled" });
  assert.equal(JSON.stringify(result).includes("pass"), false);
});
