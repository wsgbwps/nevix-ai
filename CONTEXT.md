# Nevix AI

跨 Desktop 与 Server 两个 context 的仓库级术语。各 context 自己的语言见
[CONTEXT-MAP.md](./CONTEXT-MAP.md)。

## Language

**Gate 强制**:
合并前 PR 必须通过的检查集合及其实际执行方式——由 CI gate 认定范围，经本地
watch 兑现。GitHub 免费私库没有服务端 required checks，这套本地纪律就是仓库
唯一的门禁。
_Avoid_: required checks、required status checks、分支保护

## 交付

**License**:
年订阅的离线授权凭证，界定客户、到期日与席位上限；仅由 Server 校验，Desktop 不感知。
_Avoid_: entitlement, activation, license key（指实现时）

## AI 创作

**Deployment Instance**:
一套单租户私有化 Nevix 部署，是 AI Creation 数据与配置的最外层业务边界；它不是可切换或嵌套的租户聚合。
_Avoid_: Organization, Tenant

**Team**:
界面中对 Deployment Instance 内全体 active User 的统称；它不是实体、成员关系聚合或独立授权边界。
_Avoid_: Organization, Workspace

**AI Creation**:
在 Deployment Instance 内从灵感复用、图片与视频生成，到媒体资产沉淀与发布复用的端到端业务能力；图片与视频共享该边界，不按媒体类型或页面拆分。
_Avoid_: Generation Domain, Image Generation Domain, Video Generation Domain, Media Asset Domain

**Creation Session**:
记录创建者的一条会话式创作上下文，仅创建者可读取其 prompt、参考素材和未发布结果；Admin 只能执行生命周期与安全治理。它是独立聚合，与认证 Session 无关。
_Avoid_: Session, Generation Session, Workspace

**Reference Material**:
User 上传或导入、供 Generation Specification 引用的私有媒体记录；创建动作本身即确认上传者拥有必要权利，并固定当时适用的声明版本。
_Avoid_: Upload, Attachment, Reference Asset

**Generation Specification**:
用户提交生成时由 Generation Task 拥有的不可变生成意图，包含提示词、参考素材、生成模式和已选参数；提交动作与 HTTP request 不产生独立的领域对象。
_Avoid_: Generation Request, Request, Request Payload

**Generation Task**:
用户提交生成后由 Nevix 追踪的逻辑生成操作，是引用所属 Creation Session 的独立聚合根；它拥有一份 Generation Specification、其 Generation Result 及 AI Provider Jobs，不是供应商的外部作业。
_Avoid_: Generation Request, Provider Job, Outbox Job

**Generation Result**:
Generation Task 拥有的结果值或结果视图，表达成功、部分成功或失败事实，并关联成功产生的 Media Asset；它没有独立身份或生命周期。
_Avoid_: Result Entity, Generated Asset

**Media Asset**:
每个成功生成输出形成的持久图片或视频；它是对 Deployment Instance 内全体 active User 可见的独立聚合，生命周期独立于 Creation Session 和 Generation Task。
_Avoid_: Static Asset, Generation Result, Output File

**AI Provider Connection**:
Deployment Instance 为 AI Creation 配置并启用的已审核 AI 供应商接入聚合，指向固定 Endpoint、可用能力与模型以及仅 Server 可解密的凭据；V1 每个 Deployment Instance 最多一个，同时服务图片与视频，不建立按媒体选择的默认连接。其管理状态为启用或暂停，凭据状态为检查中、有效、无效或不可解密；删除是终止事件，“需要处理”是派生提示，都不是可恢复状态。它不是密钥本身或 infrastructure adapter。
_Avoid_: Provider, Provider Adapter, Provider Credential, Default Provider Connection, Integration Domain

**AI Provider Connection Check**:
Admin 创建或替换 AI Provider Connection 凭据时执行的低副作用检查；V1 只通过 Kapon Cloud `/v1/models` 确认 Token 有效性和固定图片、视频模型的可见性，不生成真实媒体，不以第一笔用户任务作为连接激活门槛。
_Avoid_: Connection Smoke Test, First-Generation Activation

**AI Provider Media Capability**:
AI Provider Connection 对图片或视频一种媒体及其固定模型的独立检查结果，为检查中、可用或不可用；固定模型不可见只使对应媒体不可用，不否定另一种媒体已检查的能力。
_Avoid_: Default Connection, Provider Health, Media Provider

**AI Provider Capability Manifest**:
随 Nevix 代码发布的版本化能力合同，限定模型支持的生成选项、组合及参考素材数量；Desktop 只展示其允许值，Server 执行权威校验。
_Avoid_: Provider Documentation, Runtime Capability Guess, Client Capability Config

**AI Provider Release Smoke**:
Nevix 首次正式发布、固定模型变化或供应商合同变化时，由开发者按发布 checklist 人工执行的真实生成检查；结果只记录在 release checklist 或 issue，不是运行时状态、部署资产或 Capability Manifest 激活门槛。
_Avoid_: AI Provider Production Readiness, Runtime Readiness Evidence, AI Provider Connection Check

**AI Provider Job**:
Generation Task 内记录的一次外部 AI 供应商执行实体，以所用 AI Provider Connection 和供应商作业标识区分；它由 Generation Task 拥有，不是独立聚合或 Module。
_Avoid_: Generation Task, Provider Task, Outbox Job, Job

**Official Selection**:
由 Nevix 策展、在 Inspiration Page 中提供创作灵感和复用入口的官方模板集合；它与 Team Publication 的所有者和生命周期不同，不共享领域实体。
_Avoid_: Official Feed, Inspiration Item

**Discovery**:
Inspiration Page 中展示当前 Team Publications、供同事获取灵感的 deployment-scoped feed；它是页面栏目而非实体、聚合或 Domain。
_Avoid_: Team Discovery, Team Works, Discovery Domain, Public Gallery

**Team Publication**:
User 向 Team 发布一次媒体作品形成的独立聚合，保存发布时媒体与可复用创作信息的不可变快照；来源 Media Asset 只用于追溯，其生命周期不改变仍有效的发布。它是 Discovery 展示的对象，不是 Media Asset 本身。
_Avoid_: Organization Publication, Team Work, Published Asset, Discovery Item, Work

**Create Similar**:
从 Official Selection 或 Team Publication 取得可复用创作信息并进入新创作上下文的动作；Team Publication 来源只在发布有效时按值复制可编辑生成意图到新的私有 Creation Session，且来源关系仅表示“从这里开始创作”、不授予权限或绑定生命周期。它不是实体。
_Avoid_: Remix Entity, Clone Work
