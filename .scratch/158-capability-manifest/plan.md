# Plan — #158 Capability Manifest 与 Production Readiness 基座 (AI Creation V1 08/16)

Spec: #150(权威)。上游 seam:ADR-0016(可信 seam)、#157 交付的 Connection 聚合
(PR #178)。高风险切片:公共 contract(contracts/)+ 部署资产与激活语义 —— 本文件
是仓库要求的编码前书面计划。

## 范围(票面 What to build)

- Server 以**版本化** Capability Manifest 权威声明已验收生成能力;Desktop 只镜像可提交值。
- 图片/视频 Production Readiness(Nevix 发布级真实 smoke 门槛)与实例 Connection Check 正交:
  未通过媒体的值不激活进 manifest,但**绝不改写**实例 Connection/Credential/Capability 事实。
- read contract 只发布当前可提交值 + 结构化的版本/可用性/稳定原因/行动建议,
  让下游 Workbench(#177)保留失效草稿原值并阻止提交。
- 固定国内 Endpoint 与 allowlist 不可由 Desktop 配置(延续 #157 的 KAPON_BASE_URL 进程级启动变量)。
- fake/recorded Kapon adapter contract 覆盖模型目录、能力动态消失、独立降级、临时故障不改写。
- 手动 Production Readiness workflow:注入测试凭据 + 记录真实调用证据,不进普通 PR;普通 CI 无生产 Token。
- checklist slot 全枚举(模式/参数/分辨率/异步查询/临时 URL/媒体探测),实际执行归 T16(#166)。
- 不做:Workbench UI、composer、草稿恢复 E2E(#177)、Task 内核(#159)。

## Domain 与归属

Primary Domain: AI Creation;canonical owner `creation`。逐文件最窄归属:

- `server/internal/creation/domain/readiness.go` — evidence 值类型、slot 注册表、验证、激活判定
- `server/internal/creation/domain/readiness-checklist.json` — go:embed 的 checklist 单一事实源
- `server/internal/creation/domain/manifest.go` — 版本化 manifest 内容 + DeriveManifestView 纯函数
- `server/internal/creation/infrastructure/readiness/file.go` — evidence 文件 IO + 结构校验
- `server/internal/creation/application/manifest_service.go` — 读服务(evidence × connection 投影)
- `server/internal/creation/interface/http/manifest.go` — handler
- `module.go`/`routes.go` — wiring 与路由表(组合根不变)
- Desktop:`features/creation/api/capability-manifest-http.ts`(类型化客户端,复用共享 transport)
- `contracts/creation.yaml` + `contracts/openapi.yaml`(0.12.0 → 0.13.0,只增不改)
- `scripts/production-readiness/`(runner + README,scripts/ 是既有操作脚本 owner)
- `.github/workflows/production-readiness.yml`(仅 workflow_dispatch)
- `server/.env.example`、`deploy/docker-compose.yml`(env 默认)、`deploy/README.md`(激活手册)
- 测试:`domain/*_test.go`、`infrastructure/readiness/file_test.go`、
  `integrationtest/capability_manifest_flow_test.go`、`apps/desktop/tests/unit/capability-manifest-client.test.mts`

无 migration(readiness evidence 是文件态部署资产,不是持久业务数据)。

## Checklist 注册表(28 slots,单一事实源)

`domain/readiness-checklist.json` 由 Go `go:embed`;Node runner 按 repo 路径读同一文件。
slot id 词表(media 前缀,dimension.value):

- image:`mode.text-to-image`、`mode.reference-image`、`ratio.1-1|4-3|4-5|16-9|9-16`、
  `resolution.1k|2k|4k`、`quantity.1|2|3|4`、`transfer.temp-url`、`probe.png`
- video:`mode.text-to-video|first-frame|first-last-frame|omni-reference`、
  `resolution.480p|720p|1080p`、`duration.5s|10s`、`async.query`、
  `transfer.temp-url`、`probe.mp4`、`probe.audio-track`、`reference.envelope`

比例候选集 = 五个官方模板所需比例(1:1/4:3/4:5/16:9/9:16),实现自由度,PR 说明;
时长候选 {5,10} 覆盖模板默认 5s;未验收值天然不进 manifest(不承诺、不静默降级)。

## Manifest 内容(schema_version=1, manifest_version=1)

每媒体:prompt 1–2000 字符;image 模式 {text-to-image(0 参考), reference-image(JPEG/PNG/WebP,
1–4 张有序,≤8MiB,256–6000px,≤36MP,1:3–3:1)};video 模式 {text-to-video(无输入),
first-frame(1 图),first-last-frame(1–2 图有序),omni-reference(总数 1–4:图 0–4 ≤10MiB、
视频 0–1 MP4/H.264 ≤200MiB 2–30s、音频 0–1 MP3/WAV/M4A ≤50MiB 2–30s)};输出 PNG / MP4。
每个 capability 值绑定其 slot;**只发布 slot 已通过(evidence passed)的值**;
默认值 = 规格默认在位时用之,否则取激活集合中位序最小者;某维度零激活 → 该媒体不可提交。

## 可用性投影(正交合并,固定优先级)

`DeriveManifestView(evidence, connection)`:
1. readiness 未激活媒体 → `production_readiness_pending` / action `await_release`(新增枚举值)
2. 否则复用 #157 `DeriveMediaCapabilities` 的实例投影
   (not_configured → checking → credential_invalid → credential_unavailable →
   connection_paused → model_unavailable)
3. 两侧均可用才 available 并发布值。纯函数,不改写任何输入事实。

## Evidence 文件契约

`NEVIX_CREATION_READINESS_FILE`(可选)。JSON:
`{schema_version:1, generated_at, entries:[{slot_id, status: passed|failed, checked_at, evidence_ref}]}`。
- env 未设 或 文件不存在 → 空 evidence,合法状态(部署出厂即未激活)
- 存在但非法(schema version 未知 / slot id 未知 / status 非法 / JSON 损坏)→ **启动失败**(权威文档损坏必须响亮)
- 激活 = restart 时重读;不改 compose 语义,secrets volume 内固定路径 + env 默认

## HTTP contract(新增一条)

`GET /creation/capability-manifest`(RequireActiveUser,Admin 与 Member 同 payload):
`{schema_version, manifest_version, image, video}`;每媒体
`{available, reason?, action?, model?, modes[]?, ratios[]?, resolutions[]?, quantities[]?,
durations[]?, defaults?, prompt, reference_material?}` —— 全结构化字段,无自由 JSON。
错误:401 unauthorized / 500 internal_error。既有 `GET /creation/media-capabilities`
(Settings 面)不变。

## 手动 Production Readiness workflow

- `scripts/production-readiness/probe.mjs`(Node 零依赖):
  - 强制 `KAPON_API_KEY` 来自 env(未设即拒绝);普通 CI 永不注入
  - `--slot <id>` 逐槽执行;目录探测(GET /v1/models)本切片真实实现;
    生成类 probe 以明确 "execution lands with #166" 失败,不伪造证据
  - 仅对真实执行且通过的 slot 追加 evidence entry 到输出文件
- `.github/workflows/production-readiness.yml`:仅 `workflow_dispatch`,token 取自
  Actions secret,evidence 作为 artifact 上传;ci-gate 路径分类不受影响(不自动触发)

## 测试策略(按最高 seam)

- domain 单测:checklist 与 manifest 绑定一致性(每个值有已知 slot、每个 slot 恰绑一值);
  **property 测试**(固定种子随机 + 全枚举):published 值 ⇒ slot 已通过、默认 ∈ published、
  原因/建议封闭集一致、图片视频独立、同 connection 不同 evidence ⇒ 实例投影恒等(正交)、
  推导纯函数不改输入
- evidence loader:缺失=空、损坏/未知 slot/坏 schema version=类型化错误
- 集成(harness,零 skip 契约):无 evidence → 全 media `production_readiness_pending` 且
  connection 管理视图逐字节不变;全 evidence + 可用模型 → 值发布;图片/视频独立降级
  (fake Kapon 单模型消失 + recheck);429/临时故障 recheck 后 manifest 状态不变;
  member/admin/未认证授权矩阵;新端点契约 conformance
- Desktop:`capability-manifest-client.test.mts` —— URL/method/Bearer、payload 解析、
  malformed fail-closed、reason/action 枚举映射

## 验证门槛

`go vet ./...`、`go test ./...`(server)、`./scripts/test-creation-integration.sh`
(零 skip + sentinel)、desktop `pnpm test`(unit/component)与 typecheck;
`git diff --name-status` 对照本计划归属表。
