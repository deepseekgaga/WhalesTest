const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

function parseHttpUrl(value, errorCode) {
  if (typeof value !== "string" || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(errorCode);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorCode);
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
    throw new Error(errorCode);
  }

  return url;
}

export function validateAuthorizationUrl(value, expectedOrigin) {
  const url = parseHttpUrl(value, "authorization_url_invalid");
  if (url.hash !== "") throw new Error("authorization_url_invalid");
  if (url.origin !== expectedOrigin) throw new Error("authorization_origin_mismatch");
  return url.href;
}

export function validateFinalUrl(value) {
  return parseHttpUrl(value, "final_url_invalid").href;
}

export function makeHandoffUrl(batchId) {
  if (typeof batchId !== "string" || !BATCH_ID_PATTERN.test(batchId)) {
    throw new Error("batch_id_invalid");
  }
  return `about:blank#whalestest-handoff-${batchId}`;
}
