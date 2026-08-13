# Authentication Usability and Settings Information Architecture

Status: finalized — shared understanding confirmed 2026-08-13; implementation not started

本设计记录认证易用性与 Settings Page 信息架构访谈中已经确认的决定。设计树前沿已经为空，User 已确认共同理解；本文封版不授权或开始产品实现。

## Authentication usability

- 现有加密 Session 持久化保持默认；另外提供 Remembered Email，绝不保存原始密码。
- 登录界面的“记住邮箱”默认勾选。仅成功登录后写入 Supabase 响应中的权威 `User.email`；设备只保存一个邮箱，另一 User 成功登录且勾选时替换。取消勾选立即删除；注册与密码恢复不覆盖。使用 Electron `safeStorage` 加密，不降级为明文；安全存储不可用时只在当前进程保留，并显示一次非阻塞说明。加密记录损坏时删除记录、按没有 Remembered Email 继续并记录内部告警。
- 存在 Remembered Email 时预填权威邮箱、保持复选框勾选并聚焦密码字段；不存在时邮箱为空、仍默认勾选并聚焦邮箱字段。User 编辑预填邮箱并成功登录后，以响应中的权威邮箱替换旧记录。
- 若设备记住邮箱 A，User 改填邮箱 B 但登录失败，保存的 A 保持不变；当前登录页继续显示 B 供修正，应用重启后仍预填 A。
- 所有 Desktop 可编辑字段恢复标准剪贴板快捷键与右键编辑菜单；密码和验证码允许粘贴。
- 登录密码、注册密码、确认密码和恢复新密码分别提供显示/隐藏控制，默认隐藏，离开认证步骤后重置为隐藏。
- 认证窗口失焦或最小化时，所有已显示的密码立即恢复为隐藏，但不清空输入值。
- 注册与密码恢复的新密码界面常驻显示“建议使用 12 个以上字符”；登录界面不显示创建密码提示。
- 离线、超时和临时网络错误不清除加密 Session。明确的 refresh token 撤销、密码修改或恢复、退出登录及安全状态失效要求重新认证；只可恢复 Remembered Email，不重放密码。
- 最终密码策略必须在首个真实 User 创建前启用。产品发布前不存在遗留弱密码 User，V1 不建设弱密码迁移流程，也不消费登录成功响应中的 `weakPassword`；邮箱与密码验证成功后按普通登录进入。HIBP 仍在注册与改密时拒绝命中的泄露密码。

## Settings information architecture

- 保持单一顶层 `/settings` 路由，不增加嵌套路由；一次只挂载并呈现一个 Settings Section。Section 切换替换当前 history entry。
- 账户组包含 Profile、Language；组织组包含 Organization Details、Members、Audit Log。Members / Pending Invitations 保持 Members 内部 Tab。
- Organization Details 当前仅包含组织名称；所有活跃 Member 可查看，只有 Owner 可编辑，Admin 与 Member 只读。trusted command 必须执行同一 Owner-only 授权，不能只依赖界面隐藏编辑能力。
- Profile 与 Organization Details 都采用最后一次成功写入覆盖：同一 User 或同一 Owner 在多设备修改时，不增加版本号、ETag 或冲突合并；每次进入 Section 重新读取权威值，保存失败保留本地草稿。
- 从普通业务视图新进入 Settings Page 时默认打开 Profile。当前 Settings Section 与来源业务视图保存在 `/settings` 的 memory-history entry state 中，不进入 URL、hash 或嵌套路由；Section 点击 replace 当前 entry。Router Back 与“返回应用”执行同一脏表单检查，并在来源 entry 仍匹配时真正返回，否则 replace 到仍可进入的来源；没有有效来源时回首页。Organization 切换后重新验证来源，新 Organization 下不可进入时回首页。
- Profile 或 Organization Details 有未保存变更时，切换 Section、离开 Settings Page 或切换 Organization 前要求确认丢弃；Language 继续即时保存。
- 切换 Organization 后保持同一 Settings Section；若新角色无权查看 Audit Log，则回退到 Members。账户组 Section 不受 Organization 切换影响。
- 本切片不增加 Realtime 或轮询。进入组织 Section、读取 Audit Log 前及成员操作后刷新 Membership；一旦检测到 Audit 权限丢失，清除已挂载内容、隐藏入口并转到 Members；RLS 保持权威。
- 用户主动切换 Section、离开 Settings Page 或切换 Organization 时，脏 Profile / Organization Details 需要丢弃确认。Membership 结束、角色降低或 Session 结束等强制安全变化绕过确认并立即生效：Organization Details 恢复权威值且失去编辑能力；被迫离开 Settings Page 时丢弃两个表单的草稿并显示非阻塞说明。
- 丢弃确认只提供“继续编辑”和“丢弃更改”，不在导航确认中执行异步保存。
- 脏表单保护也覆盖普通窗口关闭与应用退出。表单保存请求进行中时，Section 切换、返回、Router Back 与 Organization 切换暂时不可用；普通窗口关闭等待保存结束后再继续，系统强制终止不承诺拦截。若等待中的保存失败，则取消关闭、保留 Settings Page 与草稿并显示可重试错误；只有保存成功才继续关闭。
- Membership 刷新遇网络、超时或服务错误时保持“状态未知”，不推断失权或执行 Section 回退。保留当前 Section 和此前成功加载的普通只读内容并标记无法验证，禁用依赖新鲜角色的操作；Audit 内容不读取或不继续展示。没有旧内容时显示可重试状态。只有成功刷新确认角色或 Membership 变化后才执行权限回退或离开 Organization。
- Membership 已确认有 Audit 权限、但 Audit Log 数据请求失败时，停留在 Audit Log Section，清除日志内容并显示明确的可重试错误；不得将失败呈现为空日志或权限丢失。
- 从 Settings Page 发起 Organization 选择时保留原 Active Organization，直到新选择成功；picker 提供取消并返回原 Settings Section。等待期间原 Membership 若已失效，则不能返回旧 Organization，改走正常的 Organization 选择或 onboarding。从 Settings 创建新 Organization 或接受 Invitation 成功后也返回原 Section 并应用权限回退；只有启动流程进入 picker 时成功后落到首页。
- 当前 Section 有脏草稿时，在进入 picker 前要求丢弃确认；确认丢弃后即使随后取消 picker，返回时也重新读取权威值，不恢复草稿。
- Members / Pending Invitations 是 Members Section 内的临时 Tab 状态；重新进入 Members 或切换 Organization 时默认回到 Members，不写入 Settings history。新角色无邀请查看能力时只显示 Members。
- 离开 Settings Section 后释放其界面与请求状态；再次进入时重新读取权威数据，不增加跨 Section 缓存。Language 的即时设备状态除外。
- 应用正常关闭、重启或崩溃恢复后，不恢复 Settings Page、当前 Section 或未保存草稿；Session 恢复后走正常启动路径，下次进入 Settings 默认 Profile。只有已成功写入的权威数据保留。
- 邀请创建/重发/撤销、角色变更、成员移除或退出等 trusted command 提交后，Section 切换、返回、Organization 切换和普通窗口关闭暂时不可用，直到请求成功、失败或达到明确超时。超时后的结果视为未知，不自动重试写命令；先重新读取 Membership、Members 与 Invitations，再恢复操作。
- trusted command 超时后若权威重读也失败，保持“结果尚未确认”，禁用同一写操作并只提供“重新检查”；直到重读成功后，才依据实际状态显示已成功或允许重试。
- Audit Log 的本地保存对话框打开或文件正在写出时，暂时阻止 Settings 导航、Organization 切换和普通窗口关闭；User 取消保存对话框后立即恢复，且不产生文件。

## Delivery boundary

拆分为两条互不依赖的交付主线；每条主线再按真实依赖拆成 tickets，每张 ticket 通过自己的 feature-branch PR 独立构建、测试、合并和回滚：

1. 认证易用性：Authentication Domain，以及必要且窄范围的 Electron 平台与 Supabase 配置支持。
2. Settings 信息架构：`app/pages/` 拥有 Settings Page 聚合，各 Feature 只提供各自的 Settings Section；其中一张原子授权 ticket 将 Organization Details 收紧为 Desktop 仅 Owner 显示编辑能力、Go trusted command 仅 Owner 允许更新、Admin 请求返回既有非枚举 403，并在同一 PR 同步契约与集成/E2E 测试。该授权变更实施前须在 `.scratch/` 写短计划。
