import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyByteLimit,
  appendInjectLog,
  classifyHookOutput,
  shouldRunHook,
} from "./prompt-inject.mts";

const baseInput = {
  source: "interactive",
  text: "how does AuthService work",
  streamingBehavior: undefined,
  isFirstUserMessage: true,
};

test("shouldRunHook 默认对初始 idle 输入放行", () => {
  const result = shouldRunHook(baseInput);
  assert.equal(result.run, true);
  assert.deepEqual(result.skipReasons, []);
});

test("shouldRunHook 跳过 extension 来源、slash 命令、steer/followUp、非初始输入", () => {
  const cases = [
    {
      name: "extension source",
      input: { ...baseInput, source: "extension" },
      want: "extension-source",
    },
    {
      name: "slash command",
      input: { ...baseInput, text: "/model gpt-5.6" },
      want: "slash-command",
    },
    {
      name: "steer",
      input: { ...baseInput, streamingBehavior: "steer" },
      want: "streaming:steer",
    },
    {
      name: "followUp",
      input: { ...baseInput, streamingBehavior: "followUp" },
      want: "streaming:followUp",
    },
    {
      name: "非初始输入(已有会话消息)",
      input: { ...baseInput, isFirstUserMessage: false },
      want: "not-initial-prompt",
    },
  ];
  for (const { name, input, want } of cases) {
    const result = shouldRunHook(input);
    assert.equal(result.run, false, name);
    assert.ok(result.skipReasons.includes(want), name);
  }
});

test("classifyHookOutput 区分 high/medium/nudge/empty/unknown", () => {
  assert.equal(
    classifyHookOutput(
      '<codegraph_context note="Structural context from CodeGraph for this prompt — treat returned source as already read; call codegraph_explore for more.">\n**Exploration**\n</codegraph_context>',
    ),
    "high",
  );
  assert.equal(
    classifyHookOutput(
      '<codegraph_context note="CodeGraph found indexed symbols matching this prompt — query the graph before searching files.">\n  - SidebarInput (function)\n</codegraph_context>',
    ),
    "medium",
  );
  assert.equal(
    classifyHookOutput(
      '<codegraph_context note="CodeGraph is available for this workspace\'s indexed sub-projects — query one by passing projectPath to codegraph_explore.">\n</codegraph_context>',
    ),
    "nudge",
  );
  assert.equal(classifyHookOutput("   \n  "), "empty");
  assert.equal(classifyHookOutput("<random>garbage</random>"), "unknown");
});

test("applyByteLimit 未超限时原样返回", () => {
  const result = applyByteLimit("short context", 8000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "short context");
});

test("applyByteLimit 超限时按字节截断并带说明", () => {
  const input = "a".repeat(5000) + "中".repeat(2000); // 5000 + 6000 bytes
  const result = applyByteLimit(input, 8000);
  assert.equal(result.truncated, true);
  // 上限约束的是原始内容部分;附加的截断说明不算入内容字节
  const marker = "…(context truncated at 8000 bytes;";
  const content = result.text.slice(0, result.text.indexOf(marker)).replace(/\n$/, "");
  assert.ok(Buffer.byteLength(content, "utf8") <= 8000, `content ${Buffer.byteLength(content, "utf8")} <= 8000`);
  assert.ok(result.text.includes(marker));
  // 截断后的说明本身附加在尾部,超出的部分一定是被裁掉而不是切断
  assert.ok(!result.text.includes("\uFFFD"), "no replacement char in tail");
});

test("appendInjectLog 创建目录并写入可回读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-inject-"));
  const logPath = join(dir, "nested", "logs", "inject.jsonl");
  await appendInjectLog(logPath, { ts: "t1", gate: "skipped", skipReasons: ["disabled"] });
  const content = readFileSync(logPath, "utf8");
  assert.ok(content.includes('"gate":"skipped"'));
});
