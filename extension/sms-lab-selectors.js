const PLACEHOLDERS = Object.freeze({
  phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
  sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
  codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
  submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
});

export const SMS_LAB_SELECTORS = Object.freeze({ ...PLACEHOLDERS });

export function requireSmsLabSelectors(selectors) {
  const configured = {};
  for (const key of Object.keys(PLACEHOLDERS)) {
    const value = selectors?.[key];
    if (typeof value !== "string" || value.length === 0 || value === PLACEHOLDERS[key]) {
      throw new Error("sms_selectors_not_configured");
    }
    configured[key] = value;
  }
  return Object.freeze(configured);
}
