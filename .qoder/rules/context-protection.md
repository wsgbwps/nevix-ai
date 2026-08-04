---
trigger: always_on
alwaysApply: true
---
Protect the main context window from large, unpredictable output. Choose inline or subagent based on whether the output is bounded. When delegating, invoke the Agent tool with `subagent_type="explorer"` — never run the noisy commands in the primary context yourself.

## Mandatory pre-action gate

Before running ANY search or exploration command — Grep, Glob, find, git log, WebFetch, WebSearch, or any codebase question you cannot answer from known paths — explicitly classify it as delegate vs. inline first, then act. Never skip the gate with "just one quick command" reasoning: the failure mode this rule exists to prevent is a chain of individually small inline searches, not one big one.

## Must delegate to Agent (subagent_type="explorer")

Use the read-only `explorer` subagent for throwaway lookups whose result is only needed to continue the current conversation. It returns a concise summary with file references instead of raw output.

- Broad/recursive grep without `--include` or `-l` flags
- `find` over large directories without `-maxdepth` constraint
- `git log` without `-n` / `--oneline` limit
- One-off WebFetch, WebSearch, or any command whose output size is unpredictable
- Any exploratory codebase search where you don't know what you're looking for
- Understanding an unfamiliar module, feature, or Domain boundary before changing it

## Research documents also go to Agent (subagent_type="explorer")

Delegate to `explorer` as well when findings must be archived as a persistent, citable asset — the dispatch prompt alone decides whether the agent writes a citation-backed Markdown file under `docs/research/`:

- The user explicitly asks to "research" a topic or requests a research report/document
- Deep external investigation with version-sensitive facts worth archiving
- Formal conclusions that need source citations
- When a previous `explorer` report says the question deserves a persistent research document

For these, state explicitly in the dispatch prompt that a research document must be written to `docs/research/`. Without that instruction the agent stays read-only and returns an in-conversation summary.

## OK to run inline

- Reading a file at a known path (Read tool)
- Build / test / typecheck commands
- Targeted grep: has `--include`, `-l`, `-c`, or a narrow directory scope (e.g. `grep -rl "symbol" src/utils/`)
- `git log` with explicit limit (e.g. `git log --oneline -10`)
- `git diff --stat`, `git show --stat`
- `find` with `-maxdepth` or a narrow directory scope (e.g. `find src/components -name "*.tsx"`)
- Any single command whose output is confidently under ~30 lines
