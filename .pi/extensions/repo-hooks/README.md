# Repo hooks policy

`../repo-hooks.ts` 是仓库开发流程的 **guardrail**：它降低误改敏感文件、在 `main` 直接提交 CI 把关路径、以及无确认执行危险命令的概率。

它**不是 sandbox、安全边界或授权系统**。`bash`、其他 Extension/MCP 工具、符号链接或别名路径仍可能绕过基于路径和命令字符串的判断；Extension 本身也拥有启动 Pi 的用户权限。无人值守或不可信任务必须使用 OS 权限、VM 或容器提供真正隔离。

## Policy behavior

- `edit`/`write` 的绝对和相对路径先规范为仓库相对路径,再拦截 `pnpm-lock.yaml` 与 `.env*`。
- `main` 上的 `git commit`(包括 `cd ... && git -C ... commit`)逐行检查 changed paths。`--no-renames` 让 rename 的旧、新端点都参与检查;`--all`/`-a` 和 direct pathspec commit 还会检查 tracked worktree changes。
- `rm -r`、`sudo`、`chmod/chown ... 777` 在 TUI 中需要确认,在 RPC/JSON/print 模式默认拒绝。
- Prettier 通过仓库本地的 `pnpm exec prettier` 运行;Prettier、`go env` 或 `goimports` 失败时,错误会追加到原 tool result,模型和用户都能看到。

这些规则的 deterministic 部分位于 `policy.mts`,不依赖 Pi runtime。

## CodeGraph prompt-hook 注入(P0.4 降低无关上下文)

**默认关闭。** `input` 事件不再无条件运行 `codegraph prompt-hook`;代码问题默认走 on-demand 的 `codegraph_explore` MCP tool(`.mcp.json` 已配置)。

显式开启(重启 Pi 或 `/reload` 前设置环境变量):

```bash
CODEGRAPH_PROMPT_INJECT=1 pi        # 可选:CODEGRAPH_PROMPT_INJECT_MAX_BYTES=8000
```

开启时仍套用全部护栏(纯逻辑在 `prompt-inject.mts`,有单测):

1. **只处理 idle 初始 prompt**:会话中已存在任何 message 条目(含 resume/fork)即跳过;
2. **跳过 steer/follow-up**:`streamingBehavior` 非空时不运行,不延迟用户纠偏;
3. **无高置信 relevance 不注入**:只接受返回真实源码的 `Structural context` 结果;
   弱关键字符号列表(medium)、子项目提示(nudge)、空结果一律跳过;
4. **字节上限**:默认 8000 字节,超出按 UTF-8 边界截断并标记;
5. **可观测**:每次调用追加 JSONL 日志到 `.pi/logs/codegraph-inject.jsonl`(gitignored),
   记录命中/空结果/跳过原因/字节/耗时/错误。

## 上下文与 cache 可观测性

测量/对比直接使用已安装的全局扩展命令(不要重复实现):

- `/context details` — `pi-context-usage` 包:system prompt、工具、消息的分项占用与点阵图。
- `/cache graph` — `pi-cache-graph` 包:逐轮 cache hit % 时间线(per-turn / cumulative 视图)。

本扩展额外提供的 CodeGraph 注入观测是 JSONL 日志 `.pi/logs/codegraph-inject.jsonl`(gitignored),每行一个条目:

```json
{"ts":"…","sessionId":"…","gate":"ran","outcome":"high","bytes":16255,"injectedBytes":8074,"truncated":true,"elapsedMs":212}
{"ts":"…","sessionId":"…","gate":"skipped","skipReasons":["not-initial-prompt"]}
```

字段:`gate`(ran/skipped)、`outcome`(high/medium/nudge/empty/error)、`bytes`/`injectedBytes`、`truncated`、`elapsedMs`、`skipReasons`。汇总示例:

```bash
jq -s '{ran: map(select(.gate=="ran"))|length, injected: map(select(.outcome=="high"))|length, empty: map(select(.outcome=="empty"))|length, avgMs: (map(.elapsedMs // 0)|add/length)}' .pi/logs/codegraph-inject.jsonl
```

## Test

```bash
node --test .pi/extensions/repo-hooks/policy.test.mts \
          .pi/extensions/repo-hooks/prompt-inject.test.mts
```
