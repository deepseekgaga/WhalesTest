import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { clickAcceptOnPage, detectFinalPageOnPage } from "../final-page.js";

const registryKey = "__whalestestWorkflowRunControllers__";

function hiddenElement(kind, options = {}) {
  const node = element(options);
  if (kind === "property") {
    node.hidden = true;
    return node;
  }
  const originalGetAttribute = node.getAttribute.bind(node);
  node.getAttribute = (name) => {
    if (kind === "attribute" && name === "hidden") return "";
    if (kind === "aria" && name === "aria-hidden") return "true";
    return originalGetAttribute(name);
  };
  return node;
}

test("clicks one configured accept button", async () => {
  const accept = element({ text: "Accept" });
  const result = await clickAcceptOnPage({ selectors: { acceptButton: "#accept" } }, environment({ one: { "#accept": accept } }));
  assert.deepEqual(result, { ok: true });
  assert.equal(accept.clicked, 1);
});

test("uses only a unique visible enabled Accept or Chinese accept text fallback", async () => {
  const accept = element({ text: "  Accept  " });
  const ignored = element({ text: "Other" });
  const hidden = element({ text: "接受", width: 0 });

  const result = await clickAcceptOnPage({
    selectors: { acceptButton: "" },
  }, environment({ many: { "button,[role='button']": [hidden, ignored, accept] } }));

  assert.deepEqual(result, { ok: true });
  assert.equal(accept.clicked, 1);
  assert.equal(hidden.clicked, 0);

  const chinese = element({ text: "接受" });
  assert.deepEqual(await clickAcceptOnPage({
    selectors: { acceptButton: "" },
  }, environment({ many: { "button,[role='button']": [element({ text: "Other" }), chinese] } })), { ok: true });
  assert.equal(chinese.clicked, 1);
});

test("Accept fallback ignores hidden and aria-hidden matching buttons", async () => {
  for (const [kind, hiddenAccept] of [
    ["hidden property", hiddenElement("property", { text: "Accept" })],
    ["hidden attribute", hiddenElement("attribute", { text: "Accept" })],
    ["aria hidden", hiddenElement("aria", { text: "Accept" })],
  ]) {
    const visibleAccept = element({ text: "Accept" });
    const result = await clickAcceptOnPage({
      selectors: { acceptButton: "" },
    }, environment({ many: { "button,[role='button']": [hiddenAccept, visibleAccept] } }));

    assert.deepEqual(result, { ok: true }, kind);
    assert.equal(hiddenAccept.clicked, 0, kind);
    assert.equal(visibleAccept.clicked, 1, kind);

    const missing = await clickAcceptOnPage({
      selectors: { acceptButton: "" },
      timeoutMs: 1,
    }, environment({ many: { "button,[role='button']": [hiddenElement(kind === "hidden property" ? "property" : kind === "hidden attribute" ? "attribute" : "aria", { text: "Accept" })] } }));
    assert.equal(missing.error, "accept_button_missing", kind);
  }
});

test("rejects ambiguous or missing Accept buttons", async () => {
  const ambiguous = await clickAcceptOnPage({
    selectors: { acceptButton: "" },
    timeoutMs: 1,
  }, environment({ many: { "button,[role='button']": [element({ text: "Accept" }), element({ text: "接受" })] } }));
  assert.equal(ambiguous.error, "element_ambiguous");

  const missing = await clickAcceptOnPage({
    selectors: { acceptButton: "" },
    timeoutMs: 1,
  }, environment({ many: { "button,[role='button']": [] } }));
  assert.equal(missing.error, "accept_button_missing");
});

test("waits within the deadline for a delayed Accept button", async () => {
  const accept = element({ text: "Accept" });
  const many = { "button,[role='button']": [] };
  let slept = 0;
  const env = environment({ many });
  env.sleep = async () => {
    slept += 1;
    many["button,[role='button']"] = [accept];
  };

  const result = await clickAcceptOnPage({
    selectors: { acceptButton: "" },
    timeoutMs: 50,
    quietMs: 1,
  }, env);

  assert.deepEqual(result, { ok: true });
  assert.equal(accept.clicked, 1);
  assert.ok(slept > 0);
});

test("detects final page readiness by configured marker or document readiness only", async () => {
  const byMarker = await detectFinalPageOnPage({ selectors: { finalPageReady: ".home" } }, environment({ one: { ".home": element() } }));
  assert.deepEqual(byMarker, { ok: true });

  const withoutMarker = await detectFinalPageOnPage({ selectors: { finalPageReady: "" } }, environment());
  assert.deepEqual(withoutMarker, { ok: true });
  assert.doesNotMatch(JSON.stringify(withoutMarker), /cookie|body|url|href/i);
});

test("requires a unique configured final marker", async () => {
  const ambiguous = await detectFinalPageOnPage({
    selectors: { finalPageReady: ".home" },
    timeoutMs: 1,
  }, environment({ many: { ".home": [element(), element()] } }));
  assert.equal(ambiguous.error, "element_ambiguous");
});

test("final marker ignores hidden and aria-hidden elements", async () => {
  for (const [kind, hiddenMarker] of [
    ["hidden property", hiddenElement("property")],
    ["hidden attribute", hiddenElement("attribute")],
    ["aria hidden", hiddenElement("aria")],
  ]) {
    const result = await detectFinalPageOnPage({
      selectors: { finalPageReady: ".home" },
      timeoutMs: 1,
    }, environment({ one: { ".home": hiddenMarker } }));

    assert.equal(result.error, "page_not_stable", kind);
  }
});

test("waits for document readiness when no final marker is configured", async () => {
  let ready = false;
  const env = environment();
  env.document.readyState = "loading";
  env.sleep = async () => { ready = true; env.document.readyState = "interactive"; };

  const result = await detectFinalPageOnPage({ selectors: { finalPageReady: "" }, timeoutMs: 50 }, env);

  assert.deepEqual(result, { ok: true });
  assert.equal(ready, true);
});

test("invalid selectors fail closed without throwing", async () => {
  const env = environment();
  env.document.querySelectorAll = (selector) => {
    if (selector === "[") throw new SyntaxError("bad selector");
    return [];
  };
  env.document.querySelector = (selector) => {
    if (selector === "[") throw new SyntaxError("bad selector");
    return null;
  };

  assert.equal((await clickAcceptOnPage({ selectors: { acceptButton: "[" } }, env)).error, "selector_not_configured");
  assert.equal((await detectFinalPageOnPage({ selectors: { finalPageReady: "[" } }, env)).error, "selector_not_configured");
});

test("requires and honors workflow page tokens", async () => {
  delete globalThis[registryKey];
  assert.equal((await clickAcceptOnPage({
    runId: "run-1",
    requireExistingToken: true,
    selectors: { acceptButton: "#accept" },
  }, environment())).error, "workflow_page_context_reset");
  assert.equal((await detectFinalPageOnPage({
    runId: "run-1",
    requireExistingToken: true,
    selectors: {},
  }, environment())).error, "workflow_page_context_reset");

  const controller = new AbortController();
  controller.abort();
  globalThis[registryKey] = new Map([["run-1", controller]]);
  assert.equal((await clickAcceptOnPage({
    runId: "run-1",
    requireExistingToken: true,
    selectors: { acceptButton: "#accept" },
  }, environment({ one: { "#accept": element() } }))).error, "workflow_cancelled");
});

test("bounded quiet fails on continuous mutation and cancels during quiet wait", async () => {
  let disconnected = 0;
  class BusyMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.timer = null;
    }
    observe() {
      this.timer = setInterval(() => this.callback(), 1);
      this.timer.unref?.();
    }
    disconnect() {
      disconnected += 1;
      clearInterval(this.timer);
    }
  }
  const busyEnv = environment({ one: { "#accept": element() } });
  delete busyEnv.waitForQuiet;
  busyEnv.MutationObserver = BusyMutationObserver;
  const unstable = await Promise.race([
    clickAcceptOnPage({ selectors: { acceptButton: "#accept" }, timeoutMs: 30, quietMs: 10 }, busyEnv),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 120)),
  ]);
  assert.equal(unstable.error, "page_not_stable");
  assert.ok(disconnected > 0);

  const controller = new AbortController();
  const cancelEnv = environment({ one: { ".home": element() } });
  cancelEnv.signal = controller.signal;
  cancelEnv.waitForQuiet = () => new Promise(() => {});
  setTimeout(() => controller.abort(), 10).unref?.();
  const cancelled = await Promise.race([
    detectFinalPageOnPage({ selectors: { finalPageReady: ".home" }, timeoutMs: 100, quietMs: 10 }, cancelEnv),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 150)),
  ]);
  assert.equal(cancelled.error, "workflow_cancelled");
});

test("final page functions survive executeScript-style serialization", async () => {
  const serialize = (fn) => Function(`return (${fn.toString()})`)();

  assert.deepEqual(await serialize(clickAcceptOnPage)({
    selectors: { acceptButton: "#accept" },
  }, environment({ one: { "#accept": element() } })), { ok: true });

  assert.deepEqual(await serialize(detectFinalPageOnPage)({
    selectors: { finalPageReady: ".home" },
  }, environment({ one: { ".home": element() } })), { ok: true });
});
