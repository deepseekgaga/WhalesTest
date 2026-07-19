const FINAL_MOTHER_PLACEHOLDERS = Object.freeze({
  motherFinalUrlInput: "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
  motherFinalConfirmButton: "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
  motherFinalSuccess: "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
});

export const WORKFLOW_SELECTORS = Object.freeze({
  accountManagement: "[data-testid='account-management']",
  addAccount: "[data-testid='add-account']",
  accountDialog: "[role='dialog']",
  accountNameInput: "[name='accountName']",
  platformControl: "[name='platform']",
  platformOptions: "[role='option']",
  groupContainer: "[data-testid='group-container']",
  nextButton: "[data-testid='next-button']",
  generateLinkSection: "[data-testid='generate-link-section']",
  generateLinkButton: "[data-testid='generate-link-button']",
  authorizationUrl: "[data-testid='authorization-url']",
  copyUrlButton: "[data-testid='copy-url-button']",
  loginUsername: "#username",
  loginPassword: "#password",
  loginSubmitButton: "[type='submit']",
  loginError: "[role='alert']",
  totpStage: "input[autocomplete='one-time-code'][name='code']",
  acceptButton: "[data-testid='accept-button']",
  finalPageReady: "[data-testid='final-page-ready']",
  ...FINAL_MOTHER_PLACEHOLDERS,
});

export function requireWorkflowSelectors(selectors) {
  const configured = { ...WORKFLOW_SELECTORS, ...selectors };
  for (const [key, placeholder] of Object.entries(FINAL_MOTHER_PLACEHOLDERS)) {
    const value = configured[key];
    if (typeof value !== "string" || value.length === 0 || value === placeholder) {
      throw new Error("selector_not_configured");
    }
  }
  return Object.freeze(configured);
}
