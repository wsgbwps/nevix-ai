# Desktop

Electron 桌面客户端，采用 Feature-Sliced Design 组织渲染进程，IPC 层按 domain 拆分。

## Language

> 2026-08-22：用户系统迁移（#99）已落地到桌面端：组织时代词群随 Organization Feature 一并移除，本词典只剩单租户词汇；账号治理词汇（User Management Domain / Audit Log）已随桌面端 Admin 界面（#105）入册，其余账号治理词群（Admin/Member 等）见 [Server 词典](../../server/CONTEXT.md)。
> 2026-08-23：连接基座（#104）落地，新增 Server URL / Connection Screen / Connection Probe / Certificate Fingerprint Pin 词群，取代已消亡的「构建期服务器配置」概念。
> 2026-09-02：任务卡片改由任务自己的冻结 Generation Specification 展示提示词与参数（#186），新增 Draft / Generation Specification 词群以区分「正在编辑」与「提交时冻结」两种生成意图。
> 2026-09-02：Draft 确定为设备本地状态：仅留存于当前设备、多设备互不相通，提交请求携带完整生成意图，服务端不再保存可编辑草稿。

**User**:
使用产品的自然人；由 Admin 建号并持 email + 密码登录，业务身份独立于登录凭据。
_Avoid_: Account

**Profile**:
User 的公开资料，V1 仅包含显示名（display name）；登录邮箱不属于 Profile。
_Avoid_: Account, User Management

**Session**:
User 在单台设备上的已认证使用状态；opaque token 存于本设备加密存储，多设备会话互相独立，退出登录只结束当前设备。
_Avoid_: Organization Session, Login State

**Server URL**:
设备运行时配置的 Go server 基地址（origin），不再构建期烧死；经 IPC 持久化于本机 userData，客户部署只接受 https，显式开发模式才允许 loopback http。
_Avoid_: Build-time Server Config, API Endpoint（指单个端点而非基地址）

**Connection Screen**:
设备尚无 Server URL 时首次启动呈现的预登录界面：输入 Server URL、测试连通、保存后重载进入登录；它是 `/connect` 预认证路由的唯一页面，归 connection Feature 所有。
_Avoid_: Onboarding, Server Setup Wizard, Login Screen

**Connection Probe**:
主进程对候选 Server URL 的连通验证：先按标准证书验证探活 `/health`，仅对不受信链进入 TOFU 决策；每次探测使用一次性连接，不复用旧 TLS 会话。
_Avoid_: Health Check（不承载信任决策）, Ping

**Certificate Fingerprint Pin**:
User 首次与部署管理员核对并确认自签证书时，设备按主机名或 IP 记下的 SHA-256 指纹；渲染层 fetch 与主进程探测共用同一 pin 判定，只有指纹不变、有效期可确认且尚未过期才可由 pin 放行，指纹变更则告警并要求重新确认，有效期不可确认或过期则 fail closed，任何路径都不全局跳过验证。
_Avoid_: Certificate Bypass, Insecure TLS, Trust All Certificates

**Remembered Email**:
User 在登录界面明确选择后、由当前设备在登录成功时保存并用于预填后续登录的权威邮箱；设备只保存最近一个，取消选择会立即删除。它不是凭据，不延长 Session，退出登录也不会清除它。
_Avoid_: Remembered Password, Remembered Account, Profile Email

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

**AI Creation Domain**:
以从灵感复用、图片与视频生成，到媒体资产沉淀与发布复用的完整创作闭环为边界、canonical owner 名为 `creation` 的 Desktop Domain；供应商连接属于该闭环，媒体类型、页面和独立生命周期的聚合均不单独构成 Domain。
_Avoid_: Generation Domain, Image Generation Domain, Video Generation Domain, Media Asset Domain, Inspiration Domain

**Inspiration Page**:
AI Creation Domain 拥有的灵感浏览与复用页面，组合 Official Selection 与当前部署实例的 Discovery；它不是独立 Domain 或 app-owned 跨 Feature 聚合页。
_Avoid_: Inspiration Domain, Discovery Domain

**Official Template**:
由 Nevix 策划、在 Inspiration Page 以真实生成的示例封面呈现的可复用创作起点；V1 包含简体中文名称、说明与提示词骨架，以及具备复用授权的参考素材、媒体类型、推荐模型和生成参数。"做同款"会把参考素材、提示词、推荐模型与参数填入统一的 Creation Workbench，User 可以保留、删除、替换或修改这些内容；供应商连接由部署实例固定，模型只能在该连接内经 Nevix 适配并验证、且支持当前媒体类型的列表中切换。Official Selection 只是这类模板的展示集合，不构成独立作品类型。
_Avoid_: Official Featured Work, Channel Template, Static Example

**Draft**:
创作台中 User 正在编辑、仅留存于当前设备的生成意图；它随写随存于本设备，多设备互不相通，可以任意修改，尚未对任何生成结果负责，提交时才冻结为 Generation Specification。
_Avoid_: Prompt（仅指 Draft 中的提示词字段）, Specification, 快照, 服务端草稿

**Reference Material**:
User 在创作台向当前会话上传、供生成引用的原始媒体（图片/视频/音频）；它属于会话、可独立删除，身份是素材 id。提交时冻结进 Generation Specification 的是对它的引用（素材 id、role、kind、claims 版本）而非素材本体；素材删除后任务里的冻结引用悬空，界面按素材缺失回退展示，不影响已生成结果。它与 Asset Library 的媒体资产分属两个生命阶段，V1 互不连通。
_Avoid_: 素材库, Attachment, 上传文件

**Reference Mention**:
Draft 提示词内、随本地 Draft 持久化的结构化指代，稳定绑定当前已添加 Reference Material 的身份；界面将其呈现为不可拆分的行内 chip，并按当前参考素材顺序在各媒体类型内动态编号和本地化类型名称，不按素材 role 命名。它不决定素材是否参与生成，提交时按当前 Interface Language 展开为同一类型名称与编号的普通文本且不把身份冻结进 Generation Specification；V1 也不从主体库或 Asset Library 引入候选。
_Avoid_: @文本, 素材名称, Reference Binding

**Generation Specification**:
生成提交时冻结的完整生成意图；它承载提交时刻的真实意图，冻结后永不变更，与会话当前仍可编辑的 Draft 相对。
_Avoid_: Draft, 任务参数（指 Specification 中的个别字段）

**Creation Workbench**:
AI Creation Domain 拥有的会话式创作页面，承载创作上下文、生成操作、任务状态和结果；它是界面而非 Domain 或新的租户边界。
_Avoid_: Generation Workspace, Creation Workspace

**Composer 完整态**:
Creation Workbench 底部 Composer 的完整形态：参考素材堆、多行提示词输入、能力控制行与提交按钮齐全；工作区位于滚动底部、或 User 正与 Composer 交互时呈现。
_Avoid_: 编辑态, 默认态

**Composer 紧凑态**:
工作区滚离底部时 Composer 整体收窄收矮成的居中单行形态：素材堆（或收小的添加入口）、单行提示词与提交按钮保留，能力控制行隐藏；点击其内部恢复完整态，直到下一次滚动才收回。
_Avoid_: 折叠态（与素材堆自身的收拢牌堆撞词）, 最小化

**Asset Library**:
AI Creation Domain 拥有的媒体资产浏览与复用页面；媒体资产的独立生命周期不使该页面成为独立 Domain，不与 renderer 静态 assets 混同。
_Avoid_: Media Asset Domain, Asset Workspace

**Authentication Domain**:
以凭据验证和当前设备 Session 生命周期为范围的 Desktop Domain，不包含 User 或账号管理。
_Avoid_: Identity Domain, Account Domain

**User Management Domain**:
以 Admin 治理面为范围的 Desktop Domain：全员账号目录（含已停用账号）、六个治理命令（建号/停用/重置密码/改登录 email/调角色/删号）与 Audit Log 的分页查看与导出；仅 Admin 会话可见，授权真相在 server（guard 拒 403），桌面端门控只是可见性。
_Avoid_: Account Domain, Identity Domain, Admin Domain, Governance Domain

**Audit Log**:
服务端不可变审计记录（ADR-0009）在桌面端的 Admin-only 分页视图；导出把查询结果序列化为 CSV 并经 `user-management:export-audit-log` IPC 的原生保存对话框写入本地文件，动作词表随服务端单一写入方演进。
_Avoid_: Activity Log, Event Log（与 push event 混淆）

**Profile Domain**:
仅拥有全局 Profile 读写与显示名称编辑的窄 Desktop Domain；不承担凭据、Session 或账号安全职责。
_Avoid_: Account Domain, Identity Domain, User Domain

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
承载账户设置的独立全屏聚合页；它在 App Shell 之外一次只呈现一个 Settings Section，正常进入时默认呈现 Profile，只组合各 Feature 的设置贡献，本身不构成 Domain、不拥有任何业务行为。
_Avoid_: Settings Domain, Preferences Center, Settings Dialog

**Settings Section**:
Settings Page 中可独立选择并单独呈现的一级设置范围；一个 Settings Section 可以包含多个下属设置块或内部 Tab，但这些内容不成为同级导航入口。Admin-only Section（用户管理 / 审计日志）仅在 Admin 会话的导航中呈现，非 Admin 的陈旧导航状态回退到 Profile。
_Avoid_: Settings Route, Settings Domain, Anchor Section

**Settings Flow**:
app 拥有的深模块（`app/settings/`），聚合 Settings 页面外壳、Section 注册表、离开确认（discard prompt）、路由 blocker 与窗口关闭编排；public interface 只有页面组件与 Settings entry 构造。Feature 以导航语义（`SettingsLeaveSemantics`：`navigate` / `close` / `discard`）参与，不暴露自身内部状态；`app/pages/` 不再承载 Settings。Settings Page 是它的呈现，不是独立 owner。
_Avoid_: Settings Domain, Settings Feature, Settings Controller, settings 模块（指 Feature 时）
