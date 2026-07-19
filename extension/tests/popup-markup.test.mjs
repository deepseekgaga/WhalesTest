import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("popup exposes the two manual stages with distinct labels", async () => {
  const markup = await readFile(new URL("../popup.html", import.meta.url), "utf8");

  assert.equal((markup.match(/CC 批量下载与 TXT 汇总/g) ?? []).length, 2);
  assert.equal((markup.match(/授权登录与 MFA 测试工作流/g) ?? []).length, 2);
  assert.match(markup, /id="workflow-start"[^>]*>授权登录与 MFA 测试工作流<\/button>/);
  assert.match(markup, /id="start"[^>]*>CC 批量下载与 TXT 汇总<\/button>/);
  assert.doesNotMatch(markup, /自动.*第二阶段|自动.*MFA/);
});
