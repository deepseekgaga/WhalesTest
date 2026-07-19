import test from "node:test";
import assert from "node:assert/strict";
import { makeHandoffUrl, validateAuthorizationUrl, validateFinalUrl } from "../workflow-urls.js";

test("validateAuthorizationUrl accepts only normalized http or https URLs with exact expected origin", () => {
  assert.equal(
    validateAuthorizationUrl("https://auth.example.com/oauth?client=abc", "https://auth.example.com"),
    "https://auth.example.com/oauth?client=abc",
  );
  assert.equal(
    validateAuthorizationUrl("http://auth.example.com/oauth", "http://auth.example.com"),
    "http://auth.example.com/oauth",
  );

  for (const value of [
    "http://auth.example.com/oauth",
    "https://evil.example.com/oauth",
    "https://auth.example.com.evil.test/oauth",
  ]) {
    assert.throws(
      () => validateAuthorizationUrl(value, "https://auth.example.com"),
      (error) => error?.message === "authorization_origin_mismatch",
    );
  }

  for (const value of [
    "ftp://auth.example.com/oauth",
    "https://user@auth.example.com/oauth",
    "https://auth.example.com/oauth#token",
    " https://auth.example.com/oauth",
    "https://auth.example.com/oauth ",
    "https://auth.example.com/oauth\n",
    42,
    "not a url",
  ]) {
    assert.throws(
      () => validateAuthorizationUrl(value, "https://auth.example.com"),
      (error) => error?.message === "authorization_url_invalid",
    );
  }
});

test("validateFinalUrl accepts only http or https URLs without credentials", () => {
  assert.equal(validateFinalUrl("https://mother.example/final?ok=1#done"), "https://mother.example/final?ok=1#done");
  assert.equal(validateFinalUrl("http://mother.example/final"), "http://mother.example/final");

  for (const value of [
    "ftp://mother.example/final",
    "https://user:pass@mother.example/final",
    " https://mother.example/final",
    "https://mother.example/final\t",
    "not a url",
    null,
  ]) {
    assert.throws(
      () => validateFinalUrl(value),
      (error) => error?.message === "final_url_invalid",
    );
  }
});

test("makeHandoffUrl accepts constrained batch ids and generates exact about blank handoff URLs", () => {
  assert.equal(makeHandoffUrl("Abc-1234"), "about:blank#whalestest-handoff-Abc-1234");
  assert.equal(makeHandoffUrl("A".repeat(128)), `about:blank#whalestest-handoff-${"A".repeat(128)}`);

  for (const batchId of [
    "short-1",
    "a".repeat(129),
    "abc_1234",
    "abc.1234",
    "abc 1234",
    "",
    12345678,
  ]) {
    assert.throws(
      () => makeHandoffUrl(batchId),
      (error) => error?.message === "batch_id_invalid",
    );
  }
});
