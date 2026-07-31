---
trigger: manual
alwaysApply: false
---
Protect the main context window from large, unpredictable output. Choose inline or agent based on whether the output is bounded.

## Must use Agent (subagent_type="Explore" or general-purpose)

- Broad/recursive grep without `--include` or `-l` flags
- `find` over large directories without `-maxdepth` constraint
- `git log` without `-n` / `--oneline` limit
- WebFetch, WebSearch, or any command whose output size is unpredictable
- Any exploratory search where you don't know what you're looking for

## OK to run inline

- Reading a file at a known path (Read tool)
- Build / test / typecheck commands
- Targeted grep: has `--include`, `-l`, `-c`, or a narrow directory scope (e.g. `grep -rl "symbol" src/utils/`)
- `git log` with explicit limit (e.g. `git log --oneline -10`)
- `git diff --stat`, `git show --stat`
- `find` with `-maxdepth` or a narrow directory scope (e.g. `find src/components -name "*.tsx"`)
- Any single command whose output is confidently under ~30 lines
