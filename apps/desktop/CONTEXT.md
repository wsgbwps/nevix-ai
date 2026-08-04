# Desktop

Electron 桌面客户端，采用 Feature-Sliced Design 组织渲染进程，IPC 层按 domain 拆分。

## Language

**Organization**:
企业租户，也是业务数据、文件、额度和订阅的归属边界；即使只有一名 User，业务资源也归 Organization 而非个人所有。
_Avoid_: Team, Workspace, Account

**User**:
使用产品的自然人，可以通过 Membership 加入多个 Organization；其业务身份独立于登录凭据，即使凭据删除，必要的历史归属仍指向不具备登录能力的身份记录。
_Avoid_: Account

**Profile**:
User 在所有 Organization 中共享的公开资料，V1 仅包含必填显示名称和可选头像；登录邮箱不属于 Profile。
_Avoid_: Organization Profile, Account

**Membership**:
User 与 Organization 之间的关系，承载该用户在该组织中的角色和成员状态。
_Avoid_: Team Member, User Role

**Organization Invitation**:
由 Owner 或 Admin 向指定邮箱发出的一次性 Organization 加入凭证，有效期七天，且只能由已验证同一邮箱的 User 接受并成为 Member；待处理期间重发会保留同一 Invitation、重置七日期限并使旧凭证失效。
_Avoid_: Shareable Invite Link, Team Invitation

**Owner**:
Organization 唯一的最终控制者角色；创建者默认成为首任 Owner，且 Owner 只能通过 Ownership Transfer 更换。
_Avoid_: Super Admin, Primary Admin

**Admin**:
可管理邀请、普通 Member 和组织设置的 Organization 角色，但不能提升、降级或移除其他 Admin，也不能操作 Owner、转移所有权或删除 Organization。
_Avoid_: Administrator, Manager

**Member**:
仅使用 Organization 业务功能、不管理成员或组织设置的基础角色。
_Avoid_: User, Regular User

**Former Member**:
Membership 已结束、因此不再拥有 Organization 访问权限的 User；其历史操作和所创建资源仍保留原始归属记录。
_Avoid_: Deactivated User, Deleted Member

**User Deletion**:
User 在重新认证且不再拥有任何 Organization 后发起的账号终止过程；它会结束全部 Membership、撤销待处理邀请，并在七天撤销期后删除登录凭证和个人资料。撤销删除只恢复账号使用资格，不恢复已结束的 Membership 或已撤销的 Invitation。
_Avoid_: Immediate Account Delete, Member Removal

**Pending User Deletion**:
User Deletion 发起后的七天可恢复状态，User 不能正常登录，只能通过已验证邮箱撤销删除；它与 Email Change 和 Security Lock 互斥。
_Avoid_: Deleted User, Suspended User

**Email Change**:
正常状态的 User 在重新认证后更换登录邮箱的过程，新邮箱必须在 24 小时内完成验证；变更不改变 User、Membership、角色或 Ownership。
_Avoid_: New User, Profile Email

**Security Lock**:
旧邮箱接收者明确确认 Email Change 并非本人操作后触发的保护状态；它结束全部 Session，并阻止账号使用，直到旧邮箱完成验证、密码重设且邮箱变更被撤销。
_Avoid_: Membership Suspension, User Deletion

**Ownership Transfer**:
当前 Owner 在重新认证后向一名 Admin 发起的唯一 Owner 身份移交；目标 Admin 必须在 24 小时内接受，完成后原 Owner 成为 Admin。
_Avoid_: Owner Downgrade, Ownership Assignment

**Pending Ownership Transfer**:
Ownership Transfer 发起后、目标 Admin 接受前的状态；当前 Owner 仍是唯一 Owner，可以撤销转移，且同一 Organization 只能存在一个待处理转移。
_Avoid_: Transferred Ownership, Co-Owner

**Organization Deletion**:
由 Owner 在重新认证后发起的组织终止过程；所有成员都会收到通知，并在七天撤销期结束后才永久生效。
_Avoid_: Immediate Delete, Organization Disable

**Pending Deletion**:
Organization Deletion 发起后的七天可撤销状态；成员只能读取或导出数据，不能新建任务、邀请成员、修改角色、转移所有权或变更订阅。进入时会终止全部待处理 Invitation 和 Ownership Transfer，取消删除后不恢复这些流程。
_Avoid_: Deleted, Disabled

**Active Organization**:
User 当前正在使用的唯一 Organization，决定界面中业务数据、文件、任务和额度的范围；设备记住的上次选择不构成访问权限。
_Avoid_: Default Organization, Current Team

**Session**:
User 在单台设备上的已认证使用状态，独立于任何 Organization；V1 只允许 User 登录或退出当前设备，不提供其他设备的查看或撤销。
_Avoid_: Organization Session, Membership Session

**Organization Audit Log**:
Organization 内不可由成员修改或删除、滚动保留 365 天的安全事件记录，覆盖邀请、Membership、角色、Ownership Transfer 和 Organization Deletion；仅 Owner 与 Admin 可查看或导出。
_Avoid_: Activity Feed, Analytics Log

**Feature**:
一个拥有单一 public interface 的完整 Desktop 垂直功能切片；内部责任受控演化，peer Feature 彼此隔离。
_Avoid_: module, component, page

**Channel**:
主进程与渲染进程之间的 IPC 通信通道，以 `<domain>:<action>` 格式命名。类型在 `IpcChannelMap` 中声明。
_Avoid_: event（与 push event 混淆）, message, route

**Handler**:
主进程中处理单个 IPC Channel 请求的函数，每个 handler 独立一个文件。
_Avoid_: controller, listener

**Domain**:
Desktop 中拥有一组内聚业务责任与术语的组织范围；Domain 只出现在实际需要的进程与 interface 中，不由目录对称性定义。
_Avoid_: module（与 Go 侧混淆）, service

**Authentication Domain**:
以凭据验证和当前设备 Session 生命周期为范围的 Desktop Domain，不包含 User、Profile 或 Membership 管理。
_Avoid_: Identity Domain, Account Domain

**Language Domain**:
包含设备 Language Mode 及其解析出的 Interface Language 的 Desktop Domain；各 Feature 的本地化资源仍归所属 Feature。
_Avoid_: Settings Domain, i18n Domain

**Localized Surface**:
Desktop 拥有的全部用户可见文案，包括渲染界面、窗口、原生桌面交互、安装流程和系统权限说明；不包括品牌名、用户内容、服务端日志或第三方原文。
_Avoid_: UI text（范围过窄）, all text（范围过宽）

**Language Mode**:
设备本地保存的语言选择，可取跟随系统（默认）、简体中文或英文，不属于账号数据。
_Avoid_: language setting（未区分选择与结果）, locale

**Interface Language**:
Localized Surface 文案实际采用的语言，不决定时区、日期与数字格式、货币、计量单位或业务数据；跟随系统时在应用启动阶段解析，中文系统采用简体中文，英文系统采用英文，其他系统语言回退到简体中文。
Language Mode 改变后，当前运行中的 Localized Surface 无需重启即可采用新的 Interface Language；正式支持语言的资源意外缺失时回退到简体中文。
_Avoid_: Language Mode, app language

**Supported Language**:
翻译资源已覆盖全部 Localized Surface、由发布检查持续保证完整性、并向正式版用户开放选择的 Interface Language；当前为简体中文和英文。
_Avoid_: available language（未表达完整性承诺）, translation file

**App Shell**:
Session 建立后 Desktop 呈现的整体界面框架，由侧边导航与内容区组成；各业务 Feature 的界面在内容区中渲染，设置页以外的已登录界面都在其中呈现。
_Avoid_: Dashboard, Home Screen, Main Window

**Settings Page**:
承载设备级设置项（当前仅有 Language Mode）的独立全屏界面，在 App Shell 之外呈现；它只是各 Feature 所提供设置项的组合面，本身不构成 Domain、不拥有任何行为。
_Avoid_: Settings Domain, Preferences Center, Settings Dialog
