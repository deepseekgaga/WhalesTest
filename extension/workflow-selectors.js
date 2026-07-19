const FINAL_MOTHER_PLACEHOLDERS = Object.freeze({
  motherFinalUrlInput: "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
  motherFinalConfirmButton: "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
  motherFinalSuccess: "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
});

export const WORKFLOW_SELECTORS = Object.freeze({
  accountManagement: "",
  addAccount: "",
  accountDialog: "",
  accountNameInput: "",
  platformControl: "",
  platformOptions: "",
  groupContainer: "",
  nextButton: "",
  generateLinkSection: "",
  generateLinkButton: "",
  authorizationUrl: "",
  copyUrlButton: "",
  loginUsername: "#username",
  loginPassword: "#password",
  loginSubmitButton: "",
  loginError: "",
  totpStage: "input[autocomplete='one-time-code'][name='code']",
  acceptButton: "",
  finalPageReady: "",
  ...FINAL_MOTHER_PLACEHOLDERS,
});

export function requireWorkflowSelectors(selectors = WORKFLOW_SELECTORS) {
  const configured = { ...WORKFLOW_SELECTORS, ...selectors };
  for (const [key, placeholder] of Object.entries(FINAL_MOTHER_PLACEHOLDERS)) {
    const value = configured[key];
    if (typeof value !== "string" || value.length === 0 || value === placeholder) {
      throw new Error("selector_not_configured");
    }
  }
  return Object.freeze(configured);
}
