// CodeGraph prompt-hook 注入策略(P0.4 降低无关上下文)。
// 纯逻辑模块:不依赖 Pi runtime,可用 node --test 单测。
//
// 背景:旧 input hook 对每个非 slash、非 extension 输入无条件运行
// `codegraph prompt-hook` 并把结果拼进 user prompt。实测它会对弱关键字命中输出
// "CodeGraph found indexed symbols" 的中等置信符号列表(常与本问题无关),浪费 token、
// 增加首 token 延迟、给模型错误的注意力锚点,且在 steer/follow-up 时同样运行,并且
// 静默失败无法观测命中率(roadmap P0.4 / docs/research/pi-coding-harness-roadmap.md)。
//
// 新策略:
// 1. 默认关闭:只有显式设置 CODEGRAPH_PROMPT_INJECT=1 才运行 hook;默认路径是
//    on-demand 的 codegraph_explore MCP tool。
// 2. 开启时只处理 idle 的初始 prompt:跳过 steer/follow-up(streamingBehavior),
//    跳过已有会话消息的后续输入。
// 3. 只注入高置信结果:仅 "Structural context" 结果(已返回真实源码)注入;
//    符号列表(medium)、子项目提示(nudge)、未知格式一律跳过。
// 4. 字节上限:超出上限按 UTF-8 边界截断并记录 truncated。
// 5. 可观测:每次调用追加 JSONL 日志(命中/空结果/跳过原因/耗时/字节)。
import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 注入内容字节上限(env CODEGRAPH_PROMPT_INJECT_MAX_BYTES 可覆盖)。 */
export const DEFAULT_MAX_INJECT_BYTES = 8000;

/** prompt-hook 输出分类。 */
export type HookOutcome =
  | "high" // note="Structural context ...":已注入真实源码,唯一允许注入的结果
  | "medium" // note="CodeGraph found indexed symbols ...":弱关键字符号列表,误路由源
  | "nudge" // note="CodeGraph is available ... sub-projects":仅提示存在子项目
  | "empty" // 无输出
  | "unknown" // 无法识别
  | "error"; // 运行失败(仅日志使用)

export interface InjectGateInput {
  source: string;
  text: string;
  /** "steer" | "followUp" | undefined(idle) */
  streamingBehavior: string | undefined;
  /** 会话中尚无任何 message 条目(首条用户输入) */
  isFirstUserMessage: boolean;
}

export interface InjectGateResult {
  run: boolean;
  skipReasons: string[];
}

/** 判断本次输入是否值得运行 prompt-hook。所有条件都必须满足才运行。 */
export function shouldRunHook(input: InjectGateInput): InjectGateResult {
  const skipReasons: string[] = [];
  if (input.source === "extension") skipReasons.push("extension-source");
  if (input.text.startsWith("/")) skipReasons.push("slash-command");
  if (input.streamingBehavior !== undefined)
    skipReasons.push(`streaming:${input.streamingBehavior}`);
  if (!input.isFirstUserMessage) skipReasons.push("not-initial-prompt");
  return { run: skipReasons.length === 0, skipReasons };
}

/** 按 <codegraph_context note="..."> 的 note 前缀分类 hook 输出。 */
export function classifyHookOutput(output: string): HookOutcome {
  if (!output.trim()) return "empty";
  if (output.includes('note="Structural context')) return "high";
  if (output.includes("CodeGraph found indexed symbols")) return "medium";
  if (output.includes("sub-projects")) return "nudge";
  return "unknown";
}

export interface ByteLimitResult {
  text: string;
  truncated: boolean;
}

/** 按 UTF-8 字节上限截断,避免切断多字节字符;截断时追加说明。 */
export function applyByteLimit(
  output: string,
  maxBytes: number,
): ByteLimitResult {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= maxBytes) return { text: output, truncated: false };
  // subarray 到上限再解码,丢弃末尾不完整多字节字符(表现为 U+FFFD)
  const cut = Buffer.from(output, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return {
    text: `${cut}\n…(context truncated at ${maxBytes} bytes; call codegraph_explore for the rest)`,
    truncated: true,
  };
}

// 日志消费方式见 README:jq 汇总命中/空结果/耗时。
export interface InjectLogEntry {
  ts: string;
  sessionId?: string;
  gate: "skipped" | "ran";
  skipReasons?: string[];
  outcome?: HookOutcome;
  /** hook 原始输出字节数 */
  bytes?: number;
  /** 实际拼进 user prompt 的字节数(仅 high 且未超限/截断时写入) */
  injectedBytes?: number;
  truncated?: boolean;
  elapsedMs?: number;
  error?: string;
}

/** 追加一行 JSONL 日志;目录不存在时创建。失败静默(日志不应阻塞输入)。 */
export async function appendInjectLog(
  logPath: string,
  entry: InjectLogEntry,
): Promise<void> {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 静默降级:日志失败不影响注入决策
  }
}
