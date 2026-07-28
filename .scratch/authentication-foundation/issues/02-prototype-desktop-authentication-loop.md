# Prototype the Desktop Authentication Loop

Type: prototype
Status: resolved
Blocked by: 01

## Question

用一次低保真、可交互的 Desktop prototype 校准注册、六位验证码、登录、忘记密码、Session 恢复失败和退出登录的最小状态流；哪些状态必须在 Authentication Foundation 中清晰呈现，才能直接进入实施而不继续讨论视觉细节？

## Answer

采用单一低保真 Desktop 状态流，不继续比较视觉变体。Authentication Foundation handoff 必须明确呈现以下状态，实施时可以重写界面，但不得合并掉这些行为差异。

### 未认证边界与 Session 恢复

- Desktop 启动后先进入阻塞式 `restoring` 状态；确认 Session 前既不显示 app shell，也不短暂闪现登录页。
- Session 恢复成功后直接进入 app shell。
- refresh token 已失效、损坏或明确被撤销属于终止性失败：清除本地认证材料，回到登录，并显示“登录状态已失效，请重新登录”。
- 网络或服务暂时不可用属于可重试失败：保留本地 Session，停留在独立的恢复失败状态，不显示 app shell，也不误报为已退出。
- 未认证状态只有登录、创建账号和忘记密码三个入口；app shell 是已认证状态的明确边界。

### 注册与邮箱验证

- 注册只收集邮箱和密码；密码按原始输入显示 12–72 UTF-8 字节反馈，不 trim、不规范化，也不增加字符组合规则。
- 注册提交后的界面必须保持邮箱存在性中立：只说明“如果该邮箱可以用于注册，我们已发送验证码”，并同时保留登录和忘记密码入口。
- 邮箱验证使用六位 code，标明 1 小时有效期；不足六位不能提交。
- code 不匹配、过期、已使用统一显示“验证码无效或已过期”，失败后仍停留在同一输入状态。
- 重新发送期间显示 60 秒冷却；成功重发明确说明新 code 已发送、旧 code 已失效。429 与网络异常分别显示可操作的通用错误。
- 注册 code 验证成功后建立正常 Session 并进入 app shell。

### 登录与密码恢复

- 登录失败只显示“邮箱或密码错误”，不区分未知邮箱、未验证邮箱或错误密码；提交中禁止重复操作。
- 忘记密码提交后同样使用存在性中立提示，再进入六位恢复 code 状态。
- 恢复 code 验证成功只授予设置新密码这一步所需的恢复资格，不把中间状态暴露为正常 app Session。
- 新密码沿用 12–72 UTF-8 字节规则；`same_password` 可以显示“新密码不能与当前密码相同”，其余异常安全回退为通用服务错误。
- 密码重设成功后清除恢复状态并返回登录，提示使用新密码重新登录，不直接进入 app shell。

### 当前设备退出

- app shell 中提供“退出当前设备”，无需确认弹窗；提交期间禁止重复操作。
- 无论远端撤销是否暂时因网络失败而需要重试，都先移除当前设备的本地认证材料并返回登录，保证本机不能继续进入 app shell。
- 文案只承诺当前设备已退出；远端撤销延迟时可以给出不夸大安全边界的提示。

### Prototype primary source

- Branch: `codex/prototype-authentication-foundation-loop`
- Commit: `5df2a2a`
- Path: `.scratch/authentication-foundation/prototype/`
- Run from that branch: `node .scratch/authentication-foundation/prototype/server.mjs`

Prototype 使用纯 reducer 暴露完整相关状态，并通过独立评审控制注入成功、安全错误、429 和网络异常。Playwright 人工走查覆盖了 Session 恢复三分支、注册和验证码错误/成功、登录通用错误、完整密码恢复，以及网络异常下退出当前设备。没有连接 Supabase、写入持久化或修改生产代码。
