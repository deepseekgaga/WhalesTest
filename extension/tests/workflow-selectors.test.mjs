import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_SELECTORS, requireWorkflowSelectors } from "../workflow-selectors.js";

const configuredFinalSelectors = Object.freeze({
  motherFinalUrlInput: "#final-url",
  motherFinalConfirmButton: "#confirm-final-url",
  motherFinalSuccess: ".final-success",
});

test("workflow selector defaults pin login and fail-closed final mother selectors", () => {
  for (const key of [
    "accountManagement",
    "addAccount",
    "accountDialog",
    "accountNameInput",
    "platformControl",
    "platformOptions",
    "groupContainer",
    "nextButton",
    "generateLinkSection",
    "generateLinkButton",
    "authorizationUrl",
    "copyUrlButton",
    "loginSubmitButton",
    "loginError",
    "acceptButton",
    "finalPageReady",
  ]) {
    assert.equal(WORKFLOW_SELECTORS[key], "");
  }

  assert.equal(WORKFLOW_SELECTORS.loginUsername, "#username");
  assert.equal(WORKFLOW_SELECTORS.loginPassword, "#password");
  assert.equal(WORKFLOW_SELECTORS.totpStage, "input[autocomplete='one-time-code'][name='code']");
  assert.equal(WORKFLOW_SELECTORS.motherFinalUrlInput, "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__");
  assert.equal(WORKFLOW_SELECTORS.motherFinalConfirmButton, "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__");
  assert.equal(WORKFLOW_SELECTORS.motherFinalSuccess, "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__");
  assert.ok(Object.isFrozen(WORKFLOW_SELECTORS));
});

test("requireWorkflowSelectors rejects missing empty or placeholder final mother selectors", () => {
  for (const candidate of [
    undefined,
    {},
    { ...configuredFinalSelectors, motherFinalUrlInput: "" },
    { ...configuredFinalSelectors, motherFinalConfirmButton: null },
    { ...configuredFinalSelectors, motherFinalSuccess: "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__" },
  ]) {
    assert.throws(
      () => requireWorkflowSelectors(candidate),
      (error) => error?.message === "selector_not_configured",
    );
  }
});

test("requireWorkflowSelectors returns a frozen copy without mutating defaults", () => {
  const candidate = {
    accountNameInput: "#account-name",
    ...configuredFinalSelectors,
  };
  const configured = requireWorkflowSelectors(candidate);

  assert.equal(configured.accountNameInput, "#account-name");
  assert.equal(configured.loginUsername, "#username");
  assert.equal(configured.loginPassword, "#password");
  assert.deepEqual(
    {
      motherFinalUrlInput: configured.motherFinalUrlInput,
      motherFinalConfirmButton: configured.motherFinalConfirmButton,
      motherFinalSuccess: configured.motherFinalSuccess,
    },
    configuredFinalSelectors,
  );
  assert.ok(Object.isFrozen(configured));
  assert.notEqual(configured, candidate);
  assert.equal(WORKFLOW_SELECTORS.accountNameInput, "");

  candidate.accountNameInput = "#changed";
  assert.equal(configured.accountNameInput, "#account-name");
});

test("requireWorkflowSelectors allows semantic fallbacks when only final selectors are configured", () => {
  const configured = requireWorkflowSelectors(configuredFinalSelectors);

  assert.equal(configured.accountManagement, "");
  assert.equal(configured.addAccount, "");
  assert.equal(configured.accountNameInput, "");
  assert.equal(configured.loginUsername, "#username");
  assert.deepEqual(
    {
      motherFinalUrlInput: configured.motherFinalUrlInput,
      motherFinalConfirmButton: configured.motherFinalConfirmButton,
      motherFinalSuccess: configured.motherFinalSuccess,
    },
    configuredFinalSelectors,
  );
  assert.ok(Object.isFrozen(configured));
});
