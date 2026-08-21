# Kapon Cloud / Doubao 图片与视频生成接入资料（Issue #83）

> 研究日期：2026-08-20
> 研究问题：为 GitHub Issue #83 整理首批候选供应商中 **Kapon Cloud 所提供的 Doubao（火山方舟 VolcArk）图片与视频生成**能力、接入资料与仍需由账号所有者确认的合作/凭据事实；不记录任何密钥值。

## 结论

- **图片候选：Kapon Cloud 的 Doubao Seedream。** Kapon 将火山方舟（VolcArk）的多模态能力以 OpenAI 风格接口提供；图片端点是 `POST /v1/images/generations`。已记录的模型包括 `doubao-seedream-4.0`、`doubao-seedream-4.5`、按张计费别名 `doubao-seedream-4.0-n`/`doubao-seedream-4.5-n`、以及 `doubao-seedream-3.0-t2i` 与 `doubao-seededit-3.0-i2i`。[Kapon Doubao 概览](https://docs.kapon.cloud/doubao/overview)；[图片生成](https://docs.kapon.cloud/doubao/image)；[按张计费模型](https://docs.kapon.cloud/doubao/image-seedream-4.0-n)
- **视频候选：Kapon Cloud 的国内 Doubao Seedance 2.5。** 稳定模型名为 `doubao-seedance-2-5`；可走原生 VolcArk 异步任务接口，基础场景也可走 OpenAI 风格的 `POST /v1/videos`。该页面同时记录了海外 Dreamina 变体；本 issue 选择的是国内 Doubao 变体，不能将二者混称为同一供应商或同一价格。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)；[Doubao 概览](https://docs.kapon.cloud/doubao/overview)
- **受信任接入边界（仓库契约）。** Kapon 的模型调用令牌只能在服务端/可信运行环境保存；本仓库要求 AI 供应商密钥与生成任务进入 Go 的可信执行边界，客户端不得得到任何第三方供应商密钥。这支持把 Kapon 调用放在 Server 的供应商 adapter，而不是 Desktop renderer 或打包产物中。[Kapon API 认证](https://docs.kapon.cloud/guide/authentication)；仓库证据：`docs/adr/0004-supabase-go-trusted-execution-seam.md:17–24`。

“Kapon Cloud 是本项目可签约的法律主体、已开通哪些模型、是否具有生产商业使用许可”均**不能**由公开 API 文档证实，须由负责人以合同、控制台模型可见性及账户权限另行确认。

## 可贴入 Issue #83 的资料清单

### 候选图片供应商

| 候选 | 已核实能力 | 推荐的验收入口 | 关键限制/注意事项 |
| --- | --- | --- | --- |
| Kapon Cloud → VolcArk Doubao Seedream | `doubao-seedream-4.0` 支持文生图、单图/多图参考、组图、SSE、提示词优化和水印控制；`Seedream 3.0-t2i` 用于带 `seed`/`guidance_scale` 的文生图，`SeedEdit 3.0-i2i` 用于图生图。[图片生成](https://docs.kapon.cloud/doubao/image) | 先用 `doubao-seedream-4.0` 进行一张 T2I 与一张 I2I 验收；若产品需多候选图和显式按张结算，再验证 `doubao-seedream-4.0-n` 或 `doubao-seedream-4.5-n`。[按张计费模型](https://docs.kapon.cloud/doubao/image-seedream-4.0-n) | 图片返回 URL 通常约 24 小时有效，应在有效期内转存；关闭水印仍受模型和账号配置约束。[图片生成](https://docs.kapon.cloud/doubao/image) |

公开资料把 `Seedream 4.5` 描述为与 `4.0` 基本相同、以控制台为准；因此**不应仅凭文档假设该模型已对本账号可用**。[图片生成](https://docs.kapon.cloud/doubao/image)

### 候选视频供应商

| 候选 | 已核实能力 | 推荐的验收入口 | 关键限制/注意事项 |
| --- | --- | --- | --- |
| Kapon Cloud → VolcArk 国内 Doubao Seedance 2.5 | 文生视频；原生 `content[]` 还支持图像、视频、音频参考、首帧/尾帧和可选生成音频。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5) | 使用 `doubao-seedance-2-5` 创建 5 秒、720p、16:9 的原生任务，随后轮询至终态并转存成片；这是对当前选择的最小验收，未实际调用或产生费用。 | 仅 `480p`/`720p`；时长为 4–30 秒整数或 `-1`；`1080p`/`4k` 不支持。成功视频 URL 通常约 24 小时有效且有下载次数限制，应及时转存。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5) |

## API 接入资料

### 通用

- **模型 API 基址：** `https://models.kapon.cloud`。模型调用使用 `Authorization: Bearer <模型调用令牌>`；JSON 请求再加 `Content-Type: application/json`。这是 Kapon 的模型调用令牌，不是个人资料令牌或查询授权令牌；值不应写入本 issue、仓库、聊天或客户端包体。[API 概览](https://docs.kapon.cloud/guide/api-overview)；[API 认证](https://docs.kapon.cloud/guide/authentication)
- **Kapon 侧无需自行实现 VolcArk 签名。** 文档说明由 Kapon 转发至火山方舟；调用方使用 Kapon 的令牌和模型名。[图片生成](https://docs.kapon.cloud/doubao/image)；[视频（原生）](https://docs.kapon.cloud/doubao/video)
- **追踪与错误：** 每次响应有 `X-Oneapi-Request-Id`（以及 `request-id` 别名）；失败体含结构化 `error`，其中包括 `error.request_id`。记录该 ID、HTTP 状态、`error.code` 和 `error.type`，而不是令牌或原始敏感上游错误。[请求追踪](https://docs.kapon.cloud/guide/request-id)；[错误码与响应说明](https://docs.kapon.cloud/guide/errors)

### 图片生成：同步响应或 SSE

- **端点与必填字段：** `POST /v1/images/generations`，请求体至少为 `model` 和 `prompt`；常用字段为 `size`、`n`、`response_format`（`url` 或 `b64_json`）。参考图使用 `image`（HTTPS URL 或 base64），组图使用 `sequential_image_generation` 和 `max_images`；Seedream 4.0 支持 `stream: true` 的 SSE。[图片生成](https://docs.kapon.cloud/doubao/image)
- **返回模式：** 非流式响应在 `data[]` 给出图片 `url` 或 `b64_json`；SSE 可能发出单张成功/失败和完成事件。图片生成页面没有像视频一样规定“创建后必须轮询任务”的流程。[图片生成](https://docs.kapon.cloud/doubao/image)
- **按张计费资料：** `*-n` 模型仍使用上述端点；官方页面当前标为每张 ¥0.2，建议将该数字作为“2026-08-20 文档快照”，发布前以账号的模型价格页面/合同为准。[按张计费模型](https://docs.kapon.cloud/doubao/image-seedream-4.0-n)

### 视频生成：异步任务

- **完整能力（推荐）：** `POST /volcark/api/v3/contents/generations/tasks` 创建任务；`GET /volcark/api/v3/contents/generations/tasks/{task_id}` 查询；同一路径 `GET` 可列举，`DELETE` 可取消/删除。创建请求使用 `model: "doubao-seedance-2-5"` 与 `content[]`；常用参数为 `resolution`、`ratio`、`duration`、`generate_audio`、`output_format`、`watermark`。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)
- **轮询与结果：** 终态为 `queued`、`running`、`succeeded`、`failed` 或 `expired`；成功响应包含 `content.video_url` 和 `usage.completion_tokens`，失败应读取结构化 `error`。实现应将创建与轮询设计为可重试、可持久化的后端任务，并及时将临时产物转存。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)；仓库证据：`docs/adr/0004-supabase-go-trusted-execution-seam.md:28–35`。
- **OpenAI 风格替代：** `POST /v1/videos` 适合基础文生视频和参考素材；若需要 `content[].role`、`output_format` 或联网搜索等原生能力，官方建议使用原生任务接口。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)

### 错误、限流和计费

- 文档定义 `429` 为平台或上游限流，建议延迟重试并降低并发；参数/内容安全错误不应直接重试，网络/超时/5xx 可短暂重试，长任务需业务侧超时和幂等处理。`503` 可能表示上游渠道、余额、计费、配额或容量暂不可用。[错误码与响应说明](https://docs.kapon.cloud/guide/errors)
- Kapon 公共文档**未找到可据以配置的数值化 RPM/TPM/并发上限**；实施前必须在控制台、合同或支持渠道确认账号实际配额和并发策略。
- Seedance 2.5 页面公开了按 token 的参考价格与“仅成功视频结算”的说明，但也明确具体客户价格以 Kapon 控制台为准；不要把公开价格当作采购承诺。[Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)

## 测试凭据与访问方式

**状态：尚未提供，不能在本研究中确认。** Issue #83 当前正文只提出要由人提供测试 Endpoint、模型、商务限制与凭据位置，未列出任何安全存放位置；仓库中也未发现 Kapon/Doubao 接入资料（仅排除了可能包含密钥的文件内容，未搜索密钥值）。[Issue #83](https://github.com/wsgbwps/nevix-ai/issues/83)

在 issue 中只应补充以下非机密元数据：

- 密钥管理系统中该测试令牌的**记录名或路径**（不含值）；
- 获得访问权限的团队/角色及审批方式；
- 测试环境、Endpoint、已开通模型、到期/轮换负责人；
- 令牌只注入 Server 的运行环境，Desktop/renderer、GitHub issue、源代码、日志与聊天均不得接触其值。

这既符合 Kapon 的服务端保存建议，也符合本仓库第三方供应商密钥的可信执行边界。[Kapon API 认证](https://docs.kapon.cloud/guide/authentication)；仓库证据：`docs/adr/0004-supabase-go-trusted-execution-seam.md:17–24`。

## 待负责人确认的缺口

1. Kapon Cloud 的合同主体、商业条款、数据处理/地域要求、内容政策和生产许可；公开 API 文档不足以证明这些事实。
2. 测试令牌的安全存放位置、访问方式、当前 Endpoint、可用模型、余额/额度、IP 白名单和实际限流；不得以公开文档或模型名推断已开通。
3. 是否选择 `Seedream 4.0`、`4.5` 还是按张的 `*-n` SKU；以及图片 URL/视频文件要落入哪个受访问控制的存储桶与保留策略。
4. Kapon 是否提供适用于本项目的 webhook 回调契约；本次官方资料中未找到 Doubao 视频完成 webhook 的公开说明，因此当前接入资料只验证了创建后查询/轮询。

## Sources

- [Kapon：Doubao 概览](https://docs.kapon.cloud/doubao/overview)（官方产品文档，2026-08-20 查阅）
- [Kapon：图片生成](https://docs.kapon.cloud/doubao/image)（官方 API 文档，2026-08-20 查阅）
- [Kapon：Seedream 4.x-N 按张计费](https://docs.kapon.cloud/doubao/image-seedream-4.0-n)（官方 API/计费文档，2026-08-20 查阅）
- [Kapon：Seedance 2.5](https://docs.kapon.cloud/doubao/seedance-2-5)（官方 API/模型文档，2026-08-20 查阅）
- [Kapon：视频（原生）](https://docs.kapon.cloud/doubao/video)（官方 API 文档，2026-08-20 查阅）
- [Kapon：视频（OpenAI）](https://docs.kapon.cloud/doubao/video-openai)（官方 API 文档，2026-08-20 查阅）
- [Kapon：API 概览](https://docs.kapon.cloud/guide/api-overview)、[API 认证](https://docs.kapon.cloud/guide/authentication)、[错误码与响应说明](https://docs.kapon.cloud/guide/errors)、[请求追踪](https://docs.kapon.cloud/guide/request-id)（官方平台文档，2026-08-20 查阅）
- [火山方舟：图片生成 API](https://docs.volcengine.com/docs/82379/1666945?lang=zh)（上游官方文档入口，2026-08-20 查阅；该站点需要 JavaScript，未以其替代 Kapon 的网关接入契约）
- 仓库证据：`docs/adr/0004-supabase-go-trusted-execution-seam.md:17–35`、`docs/agents/issue-tracker.md:1–28`（2026-08-20 工作树）。
