import test from "node:test";
import assert from "node:assert/strict";
import { SMS_LAB_SELECTORS, requireSmsLabSelectors } from "../sms-lab-selectors.js";
import { requestSmsOnPage, submitSmsCodeOnPage } from "../sms-lab-page.js";

const configuredSelectors = Object.freeze({
  phoneInput: "#sms-phone",
  sendButton: "#send-sms",
  codeInput: "#sms-code",
  submitButton: "#submit-sms",
});

function createElement({
  tagName = "input",
  value = "",
  disabled = false,
  ariaDisabled = null,
  visible = true,
  form = null,
} = {}) {
  const attributes = new Map();
  if (ariaDisabled !== null) attributes.set("aria-disabled", ariaDisabled);
  const events = [];
  const element = {
    tagName: tagName.toUpperCase(),
    value,
    disabled,
    form,
    events,
    clicked: 0,
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, nextValue) {
      attributes.set(name, String(nextValue));
    },
    getBoundingClientRect() {
      return visible ? { width: 40, height: 20, top: 0, left: 0 } : { width: 0, height: 0, top: 0, left: 0 };
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
    click() {
      this.clicked += 1;
    },
  };
  return element;
}

function createDocument({ readyState = "complete", elements = {}, onQuery = null } = {}) {
  return {
    readyState,
    documentElement: {},
    defaultView: {
      getComputedStyle: (element) => ({
        display: element?.hiddenByDisplay ? "none" : "block",
        visibility: element?.hiddenByVisibility ? "hidden" : "visible",
      }),
    },
    querySelector(selector) {
      onQuery?.(selector);
      return elements[selector] ?? null;
    },
  };
}

function stableEnv({ document, now = () => 0, sleep = async () => {}, waitForQuiet = async () => {}, signal } = {}) {
  return {
    document,
    Event: class TestEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
      }
    },
    now,
    sleep,
    waitForQuiet,
    signal,
  };
}

test("selector defaults are placeholders and validation rejects unconfigured selectors", () => {
  assert.deepEqual(SMS_LAB_SELECTORS, {
    phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
    sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
    codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
    submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
  });
  assert.ok(Object.isFrozen(SMS_LAB_SELECTORS));

  for (const badSelectors of [
    undefined,
    {},
    { ...configuredSelectors, phoneInput: "" },
    { ...configuredSelectors, sendButton: 42 },
    { ...configuredSelectors, codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__" },
    { ...configuredSelectors, submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__" },
  ]) {
    assert.throws(
      () => requireSmsLabSelectors(badSelectors),
      (error) => error?.message === "sms_selectors_not_configured",
    );
  }

  const copy = requireSmsLabSelectors(configuredSelectors);
  assert.deepEqual(copy, configuredSelectors);
  assert.ok(Object.isFrozen(copy));
  assert.notEqual(copy, configuredSelectors);
});

test("requestSmsOnPage preserves the exact phone string and submits once with input events", async () => {
  const form = {
    submittedWith: [],
    requestSubmit(button) {
      this.submittedWith.push(button);
    },
  };
  const phoneInput = createElement();
  const sendButton = createElement({ tagName: "button", form });
  const document = createDocument({
    elements: {
      [configuredSelectors.phoneInput]: phoneInput,
      [configuredSelectors.sendButton]: sendButton,
    },
  });

  const result = await requestSmsOnPage(
    { phone: "  +1 555 0100  ", selectors: configuredSelectors, timeoutMs: 100 },
    stableEnv({ document }),
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(phoneInput.value, "  +1 555 0100  ");
  assert.deepEqual(phoneInput.events, ["input", "change"]);
  assert.deepEqual(form.submittedWith, [sendButton]);
  assert.equal(sendButton.clicked, 0);
});

test("requestSmsOnPage uses the native value setter when one is available", async () => {
  const phoneInput = Object.create({
    set value(nextValue) {
      this.nativeSetterValue = nextValue;
    },
    get value() {
      return this.nativeSetterValue ?? "";
    },
  });
  Object.assign(phoneInput, createElement());
  delete phoneInput.value;
  const sendButton = createElement({ tagName: "button" });
  const document = createDocument({
    elements: {
      [configuredSelectors.phoneInput]: phoneInput,
      [configuredSelectors.sendButton]: sendButton,
    },
  });

  assert.deepEqual(
    await requestSmsOnPage({ phone: " 555 ", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document })),
    { ok: true },
  );
  assert.equal(phoneInput.nativeSetterValue, " 555 ");
});

test("requestSmsOnPage validates phone, missing controls, disabled controls, unstable pages, and cancellation", async () => {
  assert.deepEqual(await requestSmsOnPage({ phone: "", selectors: configuredSelectors }, stableEnv()), { ok: false, error: "sms_phone_invalid" });
  assert.deepEqual(await requestSmsOnPage({ phone: "123", selectors: SMS_LAB_SELECTORS }, stableEnv()), { ok: false, error: "sms_selectors_not_configured" });

  const missingInputDoc = createDocument({ elements: { [configuredSelectors.sendButton]: createElement({ tagName: "button" }) } });
  assert.deepEqual(
    await requestSmsOnPage({ phone: "123", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: missingInputDoc })),
    { ok: false, error: "sms_phone_input_not_found" },
  );

  const missingButtonDoc = createDocument({ elements: { [configuredSelectors.phoneInput]: createElement() } });
  assert.deepEqual(
    await requestSmsOnPage({ phone: "123", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: missingButtonDoc })),
    { ok: false, error: "sms_send_button_not_found" },
  );

  const disabledDoc = createDocument({
    elements: {
      [configuredSelectors.phoneInput]: createElement(),
      [configuredSelectors.sendButton]: createElement({ tagName: "button", disabled: true }),
    },
  });
  assert.deepEqual(
    await requestSmsOnPage({ phone: "123", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: disabledDoc })),
    { ok: false, error: "sms_send_button_disabled" },
  );

  let clock = 0;
  let rectRead = 0;
  const neverStableInput = createElement();
  neverStableInput.getBoundingClientRect = () => {
    const width = Math.floor(rectRead++ / 2) % 2 === 0 ? 40 : 41;
    return { width, height: 20 };
  };
  const neverStableDoc = createDocument({
    elements: {
      [configuredSelectors.phoneInput]: neverStableInput,
      [configuredSelectors.sendButton]: createElement({ tagName: "button" }),
    },
  });
  assert.deepEqual(
    await requestSmsOnPage(
      { phone: "123", selectors: configuredSelectors, timeoutMs: 100, sampleGapMs: 10 },
      stableEnv({ document: neverStableDoc, now: () => clock, waitForQuiet: async () => { clock += 40; }, sleep: async () => { clock += 40; } }),
    ),
    { ok: false, error: "page_not_stable" },
  );

  const abortError = new DOMException("Aborted", "AbortError");
  assert.deepEqual(
    await requestSmsOnPage(
      { phone: "123", selectors: configuredSelectors, timeoutMs: 100 },
      stableEnv({ waitForQuiet: async () => { throw abortError; } }),
    ),
    { ok: false, error: "cancelled" },
  );
});

test("submitSmsCodeOnPage accepts exactly six digits and submits once", async () => {
  const form = {
    submittedWith: [],
    requestSubmit(button) {
      this.submittedWith.push(button);
    },
  };
  const codeInput = createElement();
  const submitButton = createElement({ tagName: "button", form });
  const document = createDocument({
    elements: {
      [configuredSelectors.codeInput]: codeInput,
      [configuredSelectors.submitButton]: submitButton,
    },
  });

  for (const code of ["", "12345", "1234567", "12345a"]) {
    assert.deepEqual(
      await submitSmsCodeOnPage({ code, selectors: configuredSelectors }, stableEnv({ document })),
      { ok: false, error: "sms_code_invalid" },
    );
  }

  const result = await submitSmsCodeOnPage(
    { code: "012345", selectors: configuredSelectors, timeoutMs: 100 },
    stableEnv({ document }),
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(codeInput.value, "012345");
  assert.deepEqual(codeInput.events, ["input", "change"]);
  assert.deepEqual(form.submittedWith, [submitButton]);
});

test("submitSmsCodeOnPage reports missing controls, disabled controls, unstable pages, and cancellation", async () => {
  const missingInputDoc = createDocument({ elements: { [configuredSelectors.submitButton]: createElement({ tagName: "button" }) } });
  assert.deepEqual(
    await submitSmsCodeOnPage({ code: "123456", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: missingInputDoc })),
    { ok: false, error: "sms_code_input_not_found" },
  );

  const missingButtonDoc = createDocument({ elements: { [configuredSelectors.codeInput]: createElement() } });
  assert.deepEqual(
    await submitSmsCodeOnPage({ code: "123456", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: missingButtonDoc })),
    { ok: false, error: "sms_submit_button_not_found" },
  );

  const disabledDoc = createDocument({
    elements: {
      [configuredSelectors.codeInput]: createElement(),
      [configuredSelectors.submitButton]: createElement({ tagName: "button", ariaDisabled: "true" }),
    },
  });
  assert.deepEqual(
    await submitSmsCodeOnPage({ code: "123456", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document: disabledDoc })),
    { ok: false, error: "sms_submit_button_disabled" },
  );

  let clock = 0;
  const loadingDoc = createDocument({
    readyState: "loading",
    elements: {
      [configuredSelectors.codeInput]: createElement(),
      [configuredSelectors.submitButton]: createElement({ tagName: "button" }),
    },
  });
  assert.deepEqual(
    await submitSmsCodeOnPage(
      { code: "123456", selectors: configuredSelectors, timeoutMs: 100, sampleGapMs: 10 },
      stableEnv({ document: loadingDoc, now: () => clock, waitForQuiet: async () => { clock += 40; }, sleep: async () => { clock += 40; } }),
    ),
    { ok: false, error: "page_not_stable" },
  );

  const abortError = new DOMException("Aborted", "AbortError");
  assert.deepEqual(
    await submitSmsCodeOnPage(
      { code: "123456", selectors: configuredSelectors, timeoutMs: 100 },
      stableEnv({ waitForQuiet: async () => { throw abortError; } }),
    ),
    { ok: false, error: "cancelled" },
  );
});

test("page action functions are self-contained for executeScript serialization", async () => {
  const serializedRequest = Function(`"use strict"; return (${requestSmsOnPage.toString()});`)();
  const serializedSubmit = Function(`"use strict"; return (${submitSmsCodeOnPage.toString()});`)();
  const form = {
    submitted: 0,
    requestSubmit() {
      this.submitted += 1;
    },
  };
  const document = createDocument({
    elements: {
      [configuredSelectors.phoneInput]: createElement(),
      [configuredSelectors.sendButton]: createElement({ tagName: "button", form }),
      [configuredSelectors.codeInput]: createElement(),
      [configuredSelectors.submitButton]: createElement({ tagName: "button", form }),
    },
  });

  assert.deepEqual(
    await serializedRequest({ phone: "555", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document })),
    { ok: true },
  );
  assert.deepEqual(
    await serializedSubmit({ code: "654321", selectors: configuredSelectors, timeoutMs: 100 }, stableEnv({ document })),
    { ok: true },
  );
  assert.equal(form.submitted, 2);
});
