---
trigger: model_decision
description: 生成 git 提交信息或执行 git commit 时必须遵循的提交信息格式规范
---

# 提交信息格式

生成提交信息（或执行 `git commit`）时，第一行必须符合：

```
<emoji> <type>(<scope>): <description>
```

- `type` 只能是：feat fix docs style refactor perf test build ci chore revert
- `scope` 可选，如 `ipc`、`auth`、`i18n`
- `description` 用中文简述本次变更
- emoji 与 type 对应关系：

| type     | emoji | type  | emoji |
| -------- | ----- | ----- | ----- |
| feat     | ✨    | perf  | ⚡️    |
| fix      | 🐛    | test  | ✅    |
| docs     | 📝    | build | 📦    |
| style    | 🎨    | ci    | 👷    |
| refactor | ♻️    | chore | 🔧    |
| revert   | ⏪    |       |       |

示例：

```
✨ feat(ipc): 添加新的 IPC 通道
🐛 fix(auth): 修复启动崩溃问题
```
