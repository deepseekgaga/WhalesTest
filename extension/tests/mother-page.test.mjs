import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { backfillFinalUrlOnPage, generateAuthorizationUrlOnPage, prepareMotherAccountOnPage } from "../mother-page.js";

const registryKey = "__whalestestWorkflowRunControllers__";
const accountName = "20260719-1438 SHARKPIX PLUS 1";
const baseSelectors = {
  accountManagement: "#manager",
  addAccount: "#add",
  accountNameInput: "#name",
  platformControl: "#platform",
  platformOptions: ".platform-option",
  groupContainer: "#groups",
  nextButton: "#next",
  generateLinkSection: "#generate-section",
  generateLinkButton: "#generate-link",
};

test("fills the approved account name, selects platform two, and checks every group", async () => {
  const accountManagement = element();
  const addAccount = element();
  const accountNameInput = element();
  const platform = element();
  const firstOption = element({ text: "平台一" });
  const secondOption = element({ text: "平台二" });
  const groups = [element(), element({ checked: true }), element()];
  const next = element();
  const generate = element();
  const env = environment({
    one: {
      "#account-management": accountManagement,
      "#add-account": addAccount,
      "#account-name": accountNameInput,
      "#platform": platform,
      "#groups": element({ children: groups }),
      "#next": next,
      "#generate": generate,
    },
    many: { ".platform-option": [firstOption, secondOption] },
  });

  const result = await prepareMotherAccountOnPage({
    accountName,
    selectors: {
      accountManagement: "#account-management",
      addAccount: "#add-account",
      accountNameInput: "#account-name",
      platformControl: "#platform",
      platformOptions: ".platform-option",
      groupContainer: "#groups",
      nextButton: "#next",
      generateLinkButton: "#generate",
    },
  }, env);

  assert.deepEqual(result, { ok: true });
  assert.equal(accountManagement.clicked, 1);
  assert.equal(addAccount.clicked, 1);
  assert.equal(accountNameInput.value, accountName);
  assert.deepEqual(accountNameInput.events, ["input", "change"]);
  assert.equal(platform.clicked, 1);
  assert.deepEqual(secondOption.events, ["pointerover", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup"]);
  assert.equal(secondOption.clicked, 1);
  assert.ok(groups.every((item) => item.checked));
  assert.equal(next.clicked, 1);
});

test("rejects ambiguous Add Account text fallback", async () => {
  const result = await prepareMotherAccountOnPage({
    accountName,
    selectors: { ...baseSelectors, addAccount: "" },
    timeoutMs: 1,
  }, environment({
    one: { "#manager": element() },
    many: { "button,[role='button'],a": [element({ text: "\u6dfb\u52a0\u8d26\u53f7" }), element({ text: "\u6dfb\u52a0\u8d26\u53f7" })] },
  }));

  assert.equal(result.error, "element_ambiguous");
});

test("requires a second enabled platform option", async () => {
  const result = await prepareMotherAccountOnPage({ accountName, selectors: baseSelectors }, environment({
    one: { "#manager": element(), "#add": element(), "#name": element(), "#platform": element() },
    many: { ".platform-option": [element()] },
  }));

  assert.equal(result.error, "platform_option_missing");
});

test("requires at least one group checkbox", async () => {
  const result = await prepareMotherAccountOnPage({ accountName, selectors: baseSelectors }, environment({
    one: { "#manager": element(), "#add": element(), "#name": element(), "#platform": element(), "#groups": element({ children: [] }) },
    many: { ".platform-option": [element(), element()] },
  }));

  assert.equal(result.error, "group_options_missing");
});

test("does not click next after the generate section is already visible", async () => {
  const next = element();
  const result = await prepareMotherAccountOnPage({
    accountName,
    selectors: { ...baseSelectors, nextButton: "#next", generateLinkSection: "#generate-section" },
  }, environment({ one: { "#next": next, "#generate-section": element() } }));

  assert.deepEqual(result, { ok: true });
  assert.equal(next.clicked, 0);
});

test("stops before DOM side effects when the page token is aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  const manager = element();
  const env = environment({ one: { "#manager": manager } });
  env.signal = abort.signal;

  const result = await prepareMotherAccountOnPage({ accountName, selectors: baseSelectors }, env);

  assert.equal(result.error, "workflow_cancelled");
  assert.equal(manager.clicked, 0);
});

test("uses one existing DOM URL without regenerating and then clicks COPY URL", async () => {
  const generate = element();
  const copy = element();
  const url = element({ value: "http://auth-target.local/start?id=7" });
  const env = environment({ one: { "#generate": generate, "#auth-url": url, "#copy": copy } });

  const result = await generateAuthorizationUrlOnPage({
    selectors: { generateLinkButton: "#generate", authorizationUrl: "#auth-url", copyUrlButton: "#copy" },
  }, env);

  assert.deepEqual(result, { ok: true, authorizationUrl: "http://auth-target.local/start?id=7" });
  assert.equal(generate.clicked, 0);
  assert.equal(copy.clicked, 1);
});

test("generates when the visible URL container is an empty placeholder", async () => {
  const generate = element();
  const copy = element();
  const url = element({ value: "" });
  generate.click = () => {
    generate.clicked += 1;
    url.value = "https://auth-target.local/generated";
  };
  const env = environment({
    one: { "#generate": generate, "#copy": copy },
    many: { ".url": [url] },
  });

  const result = await generateAuthorizationUrlOnPage({
    selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" },
  }, env);

  assert.deepEqual(result, { ok: true, authorizationUrl: "https://auth-target.local/generated" });
  assert.equal(generate.clicked, 1);
  assert.equal(copy.clicked, 1);
});

test("rejects missing and ambiguous authorization URLs", async () => {
  const missing = await generateAuthorizationUrlOnPage({
    selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" },
    timeoutMs: 1,
  }, environment({ one: { "#generate": element(), "#copy": element() } }));
  assert.equal(missing.error, "authorization_url_missing");

  const ambiguous = await generateAuthorizationUrlOnPage({
    selectors: { authorizationUrl: ".url", copyUrlButton: "#copy" },
  }, environment({
    one: { "#copy": element() },
    many: { ".url": [element({ value: "http://auth-target.local/a" }), element({ value: "http://auth-target.local/b" })] },
  }));
  assert.equal(ambiguous.error, "authorization_url_ambiguous");
});

test("collects only complete http URL values from value href or textContent", async () => {
  const fromHref = await generateAuthorizationUrlOnPage({
    selectors: { authorizationUrl: ".url", copyUrlButton: "#copy" },
  }, environment({
    one: { "#copy": element() },
    many: { ".url": [
      element({ value: "not a url", href: " https://auth-target.local/from-href " }),
      element({ text: "ftp://ignored.test" }),
    ] },
  }));
  assert.deepEqual(fromHref, { ok: true, authorizationUrl: "https://auth-target.local/from-href" });

  const fromText = await generateAuthorizationUrlOnPage({
    selectors: { authorizationUrl: ".url", copyUrlButton: "#copy" },
  }, environment({
    one: { "#copy": element() },
    many: { ".url": [element({ text: " http://auth-target.local/from-text " })] },
  }));
  assert.deepEqual(fromText, { ok: true, authorizationUrl: "http://auth-target.local/from-text" });
});

test("backfills only exact configured selectors and waits for success", async () => {
  const input = element();
  const confirm = element();
  const success = element();
  const one = { "#result-url": input, "#save": confirm };
  confirm.click = () => { confirm.clicked += 1; one[".saved"] = success; };
  const env = environment({ one });

  const result = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: {
      motherFinalUrlInput: "#result-url",
      motherFinalConfirmButton: "#save",
      motherFinalSuccess: ".saved",
    },
  }, env);

  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, "https://final.test/home");
  assert.deepEqual(input.events, ["input", "change"]);
  assert.equal(confirm.clicked, 1);
});

test("treats an existing mother success marker as an idempotent completed backfill", async () => {
  const confirm = element();

  const result = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: { motherFinalUrlInput: "#result-url", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" },
  }, environment({ one: { "#result-url": element(), "#save": confirm, ".saved": element() } }));

  assert.deepEqual(result, { ok: true });
  assert.equal(confirm.clicked, 0);
});

test("fails closed when final selectors or success are missing", async () => {
  const unconfigured = await backfillFinalUrlOnPage({ finalUrl: "https://final.test/home", selectors: {} }, environment());
  assert.equal(unconfigured.error, "selector_not_configured");

  const noSuccess = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: { motherFinalUrlInput: "#url", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" },
    timeoutMs: 1,
  }, environment({ one: { "#url": element(), "#save": element() } }));
  assert.equal(noSuccess.error, "mother_backfill_failed");
});

test("requires an existing un-aborted workflow page token when requested", async () => {
  delete globalThis[registryKey];

  for (const action of [
    () => prepareMotherAccountOnPage({ runId: "run-1", requireExistingToken: true, accountName, selectors: baseSelectors }, environment()),
    () => generateAuthorizationUrlOnPage({ runId: "run-1", requireExistingToken: true, selectors: {} }, environment()),
    () => backfillFinalUrlOnPage({ runId: "run-1", requireExistingToken: true, finalUrl: "https://final.test/home", selectors: {} }, environment()),
  ]) {
    assert.equal((await action()).error, "workflow_page_context_reset");
  }

  const controller = new AbortController();
  controller.abort();
  globalThis[registryKey] = new Map([["run-1", controller]]);
  assert.equal((await prepareMotherAccountOnPage({
    runId: "run-1",
    requireExistingToken: true,
    accountName,
    selectors: baseSelectors,
  }, environment({ one: { "#manager": element() } }))).error, "workflow_cancelled");
});

test("reports ambiguous exact selectors but ignores hidden and disabled candidates", async () => {
  const ambiguous = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: { motherFinalUrlInput: "#url", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" },
  }, environment({
    many: {
      "#url": [element(), element()],
      "#save": [element()],
      ".saved": [],
    },
  }));
  assert.equal(ambiguous.error, "element_ambiguous");

  const visibleAdd = element({ text: "\u6dfb\u52a0\u8d26\u53f7" });
  const hiddenAdd = element({ text: "\u6dfb\u52a0\u8d26\u53f7", width: 0 });
  const disabledAdd = element({ text: "\u6dfb\u52a0\u8d26\u53f7", disabled: true });
  const result = await prepareMotherAccountOnPage({
    accountName,
    selectors: { ...baseSelectors, addAccount: "" },
  }, environment({
    one: { "#manager": element(), "#name": element(), "#platform": element(), "#groups": element({ children: [element()] }), "#next": element(), "#generate-link": element() },
    many: {
      "button,[role='button'],a": [hiddenAdd, disabledAdd, visibleAdd],
      ".platform-option": [element(), element()],
    },
  }));
  assert.deepEqual(result, { ok: true });
  assert.equal(visibleAdd.clicked, 1);
  assert.equal(hiddenAdd.clicked, 0);
  assert.equal(disabledAdd.clicked, 0);
});

test("bounded quiet returns page_not_stable and disconnects during continuous mutation", async () => {
  let disconnected = 0;
  class BusyMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.timer = null;
    }
    observe() {
      this.timer = setInterval(() => this.callback(), 1);
      this.timer.unref?.();
      setTimeout(() => clearInterval(this.timer), 80).unref?.();
    }
    disconnect() {
      disconnected += 1;
      clearInterval(this.timer);
    }
  }
  const env = environment({ one: { "#generate": element(), "#copy": element() } });
  delete env.waitForQuiet;
  env.MutationObserver = BusyMutationObserver;

  const result = await Promise.race([
    generateAuthorizationUrlOnPage({
      selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" },
      timeoutMs: 30,
      quietMs: 10,
    }, env),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 120)),
  ]);

  assert.equal(result.error, "page_not_stable");
  assert.ok(disconnected > 0);
});

test("returns authorization_url_missing when quiet reaches its deadline without mutation", async () => {
  const realDateNow = Date.now;
  Date.now = () => 0;
  try {
    const env = environment({ one: { "#generate": element(), "#copy": element() } });
    delete env.MutationObserver;
    let nowCalls = 0;
    env.now = () => [0, 0, 0, 2][Math.min(nowCalls++, 3)];

    const result = await generateAuthorizationUrlOnPage({
      selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" },
      timeoutMs: 1,
      quietMs: 10,
    }, env);

    assert.equal(result.error, "authorization_url_missing");
  } finally {
    Date.now = realDateNow;
  }
});

test("bounded quiet returns workflow_cancelled when aborted while waiting", async () => {
  const controller = new AbortController();
  const env = environment({ one: { "#generate": element(), "#copy": element() } });
  env.signal = controller.signal;
  env.waitForQuiet = () => new Promise(() => {});
  setTimeout(() => controller.abort(), 10).unref?.();

  const result = await Promise.race([
    generateAuthorizationUrlOnPage({
      selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" },
      timeoutMs: 100,
      quietMs: 10,
    }, env),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test_hung" }), 150)),
  ]);

  assert.equal(result.error, "workflow_cancelled");
});

test("invalid configured selectors fail closed without throwing", async () => {
  const envWithInvalidSelector = () => ({
    ...environment(),
    document: {
      ...environment().document,
      querySelector(selector) {
        if (selector === "[") throw new SyntaxError("invalid selector");
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "[") throw new SyntaxError("invalid selector");
        return [];
      },
    },
  });

  const actions = [
    () => prepareMotherAccountOnPage({ accountName, selectors: { ...baseSelectors, accountManagement: "[" } }, envWithInvalidSelector()),
    () => generateAuthorizationUrlOnPage({ selectors: { generateLinkButton: "#generate", authorizationUrl: "[", copyUrlButton: "#copy" } }, envWithInvalidSelector()),
    () => backfillFinalUrlOnPage({
      finalUrl: "https://final.test/home",
      selectors: { motherFinalUrlInput: "[", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" },
    }, envWithInvalidSelector()),
  ];

  for (const action of actions) {
    await assert.doesNotReject(action);
    assert.equal((await action()).error, "selector_not_configured");
  }
});

test("authorization URL extraction rejects credentials and unsafe URLs", async () => {
  const result = await generateAuthorizationUrlOnPage({
    selectors: { authorizationUrl: ".url", copyUrlButton: "#copy" },
    timeoutMs: 1,
  }, environment({
    one: { "#copy": element() },
    many: { ".url": [
      element({ value: "https://user:pass@auth-target.local/start" }),
      element({ href: "javascript:alert(1)" }),
      element({ text: "/relative/path" }),
    ] },
  }));

  assert.equal(result.error, "authorization_url_missing");
});

test("page action functions survive executeScript-style serialization", async () => {
  const serialize = (fn) => Function(`return (${fn.toString()})`)();

  assert.deepEqual(await serialize(prepareMotherAccountOnPage)({
    accountName,
    selectors: { generateLinkSection: "#generate-section" },
  }, environment({ one: { "#generate-section": element() } })), { ok: true });

  assert.deepEqual(await serialize(generateAuthorizationUrlOnPage)({
    selectors: { authorizationUrl: "#auth-url", copyUrlButton: "#copy" },
  }, environment({ one: { "#auth-url": element({ value: "https://auth-target.local/start" }), "#copy": element() } })), {
    ok: true,
    authorizationUrl: "https://auth-target.local/start",
  });

  assert.equal((await serialize(backfillFinalUrlOnPage)({
    finalUrl: "https://final.test/home",
    selectors: {},
  }, environment())).error, "selector_not_configured");
});
