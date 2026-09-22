# 媒体墙视频卡片悬停预览：方案调研

> 调研日期：2026-09-22
>
> 问题：Electron Chromium + 私有 OSS + H.264 MP4 + Go 签发约 10 分钟单对象 URL 的 Nevix 媒体墙，是否应采用库或其他成熟方案来改善视频首屏与悬停预览。本文不改动产品或架构决策。

## 结论摘要

1. **首版不应引入播放器库。** 对普通 MP4，原生 `<video>` 已负责 progressive download、Range、解码和播放；Video.js/Plyr 是播放器 UI，ReactPlayer 对文件 URL 最终仍使用原生媒体元素，hls.js 只处理 HLS + MSE。它们不能产生 poster、移动 MP4 索引、缩短 OSS RTT，或把 `preload` 从提示变成保证。[Video.js README](https://github.com/videojs/video.js/blob/main/README.md)；[Plyr README](https://github.com/sampotts/plyr)；[ReactPlayer README](https://github.com/cookpete/react-player)；[hls.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
2. **候选的原生 MP4 悬停播放可作为最小交付**：仅可见卡片挂原生视频，`preload="metadata"`，进入时 `muted + loop + playsInline` 后调用并处理 `play()` 的 Promise；离开时暂停并回到 `0`；同一时刻最多一张播放；`prefers-reduced-motion: reduce` 时不自动播放。`preload` 只是浏览器提示，`metadata` 只意图拿到元数据，不能承诺首帧或悬停延迟；`play()` 本身也可能拒绝。[MDN：preload](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload)；[MDN：play](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)；[MDN：reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
3. **若墙面需要稳定的“立即可见画面”，成熟且仍很小的升级是动态 poster，而非新库。** OSS 原生 `video/snapshot` 可为私有 H.264/H.265 对象签发带处理参数的短时 URL，实时返回 JPG，且不保存派生文件；`t=0` 是官方指定的 thumbnail 用法，`m_fast` 取此前最近关键帧。它需要一条资源级授权/签名路径并按快照计费，但不需要持久 poster、ffmpeg、表、清理 worker 或 IMM 多帧任务。[OSS：单帧快照](https://www.alibabacloud.com/help/en/oss/user-guide/video-snapshots)
4. **MP4 文件形状决定悬停长尾。** 支持 HTTP byte ranges 只能让浏览器请求需要的区段，不能保证它不取更多字节；若 `moov` 索引在尾部，浏览器可能需要额外尾部读取才可解析 metadata。FFmpeg 将 `moov` 移到开头的 `faststart` 正是为此设计，但 Nevix 当前转存的是供应商产物，是否已经 fast-start 必须在 staging 以实际响应验证，不能假设。[RFC 9110 §14.1](https://datatracker.ietf.org/doc/html/rfc9110#section-14.1)；[FFmpeg MOV/MP4 文档](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)
5. **HLS/DASH、短 preview clip、sprite/GIF/WebP 都不是本轮的更优解。** 它们会新增转码/派生物或 manifest + 分片授权、保留与清理责任；HLS/DASH 的价值是自适应码率和长视频传输，不是短 MP4 的一张卡片悬停。仅当实测原生 MP4 仍未满足 SLO，才按下文触发条件升级。

## 已核对的 Nevix 约束

- Desktop 当前依赖 Electron `^39.2.6`，尚未安装 Video.js、hls.js、ReactPlayer 或 Plyr；新增库不会复用现有依赖。[apps/desktop/package.json](../../apps/desktop/package.json)
- 交接已定位原实现为「Go 流式完整原件 → Renderer `blob()` 完成后才设置 `video.src`」，大文件甚至不加载；它阻断了浏览器的 native progressive/range 路径。仓库外的用户交接材料：`/private/tmp/nevix-ai-media-loading-handoff-2026-09-22.md`（“已定位的请求链路”与“根因排序”段落；不入发布物）。
- 契约已经明确 Reference Material 的视频预览 URL 是原始字节，Range 不参与 GET 签名，因此 seek 可用；成品 Asset/Publication 尚没有相应展示 URL。现有图片缩略图为 OSS 动态 320px WebP。[contracts/creation.yaml:405](../../contracts/creation.yaml#L405)；[contracts/creation.yaml:411](../../contracts/creation.yaml#L411)；[server/internal/creation/domain/value.go:166](../../server/internal/creation/domain/value.go#L166)
- 这次讨论的 URL 只应留在 Renderer 内存，且限制、撤回或删除只阻止之后的授权；已签 URL 仍可用至 TTL。这需要延续当前约 10 分钟的明确接受窗口，而不是误称“即时撤销”。[ADR-0016](../adr/0016-ai-creation-v1-trusted-seams.md)

## 原生 `<video>`：能保证什么，不能保证什么

| 事实 | 对当前方案的含义 |
| --- | --- |
| `preload` 是作者给 UA 的**提示**；`metadata` 表示只取媒体 metadata，`auto` 才是允许完整下载。 | 保留 `preload="metadata"` 以避免可见卡片一齐完整下载；不能把它写成“预载首帧”。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload) |
| `loadedmetadata` 是时长/尺寸等 metadata 已知；无海报的静态画面仍要有 video data。HTML 规范说明在 `HAVE_METADATA` 但尚无 video data 时仍展示 poster（若有）或透明黑。 | 验收须分别记录 `loadedmetadata`、`loadeddata` 和第一次 `playing`/实际画面；不能拿前者代替 poster 或运动。[HTML Standard](https://html.spec.whatwg.org/multipage/media.html#the-video-element) |
| HTTP Range 定义 partial response 语义；资源必须实际支持而浏览器也必须选择使用。 | 在实际私有 OSS + 预签 URL 上用 DevTools 验证：`Accept-Ranges: bytes`、206、初始与 hover 请求的区段/字节数。不要用应用侧 `fetch`/Blob 介入。 [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-14.1) |
| MP4 `faststart` 会在第二遍把 `moov` 索引移到文件开头；可选 `moov_size` 也会在开头预留空间。 | 若 metadata/首帧长尾与尾部 `moov` 相关，优先要求生成/转存端输出 fast-start MP4；这是产物质量问题，不是前端库问题。[FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv) |
| `play()` 返回 Promise，成功启动才 resolve，权限/策略/格式/网络失败会 reject。 | `onPointerEnter` 调 `play().catch(...)`；失败走既定一次重新授权，然后明确失败 + 手动重试，不能假装已经播放。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play) |

`loadeddata` 表示当前播放位置的帧可用，适合计“首帧可见”；`playing` 是播放实际开始的更好悬停运动指标。两者都应只作测量，不设为预加载成功的替代信号。

## 市场常见方案比较

| 方案 | 解决的体验 | 为 Nevix 新增的责任/成本 | 本轮结论 |
| --- | --- | --- | --- |
| 原生 MP4 + `metadata` + hover `play()` | 最少字节启动并可在悬停时运动 | 无新媒体产物；表现受 MP4 和网络影响 | **首选基线** |
| 动态单帧 poster + 原生 MP4 hover | 墙面立即有代表画面，hover 才取视频字节 | 每次 poster 是 OSS 实时处理和计费；一条精确签名 URL；无持久对象 | **首帧 SLO 不达标时的首个升级** |
| 持久 poster | 最稳定、可缓存的海报 | 生成、命名、关联、删除、发布、清理和迁移责任 | 暂不做；只有动态 snapshot 长尾/成本证实不合适时讨论 ADR |
| 短、低码率 preview MP4 | 悬停时更快且可运动 | 另一视频转码与完整生命周期 | 暂不做；原视频 hover p95 失败后才比较 |
| sprite/storyboard | 拖动进度条或多时点静态预览 | 生成/存储 sprite 或 VTT；不提供真正的 hover 运动 | 不适合卡片首版；OSS/IMM 的 `video/sprite` 属多帧处理能力。[OSS 媒体处理](https://www.alibabacloud.com/help/en/oss/user-guide/introduction-2/) |
| GIF/animated WebP | 可动缩略图、无播放器状态 | 仍要转码/派生；通常无音频和较差压缩/控制 | 不做；只是把 preview clip 换格式 |
| HLS/DASH + hls.js/Video.js | 长视频的自适应码率、分段 seek | manifest/分片、每个请求授权、转码、清理、播放器集成 | 不做；现有短 H.264 MP4 不需要 ABR。[hls.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md)；[Video.js](https://github.com/videojs/video.js/blob/main/README.md) |
| Video.js、Plyr、ReactPlayer | controls、皮肤、多来源适配 | 增加依赖、React/播放器状态和 bundle | 不做；墙面无 controls，file URL 不会改善源媒体路径。[Plyr](https://github.com/sampotts/plyr)；[ReactPlayer](https://github.com/cookpete/react-player) |

### 关于 OSS 动态 poster 的事实

OSS 官方将 `video/snapshot` 列为原生数据处理能力：支持 H.264/H.265，实时返回 JPG；私有对象必须由服务端生成包含 `x-oss-process` 的签名 URL，且默认不保存快照。为 thumbnail，文档指定 `t=0`；`m_fast` 则选目标时刻前最近的关键帧。它按图片数收费。[OSS：单帧快照](https://www.alibabacloud.com/help/en/oss/user-guide/video-snapshots)；[OSS 数据处理概览](https://www.alibabacloud.com/help/en/oss/user-guide/overview-50)

这与 IMM 的 `video/snapshots`（多帧、异步、需 IMM Project 和 `imm:CreateMediaConvertTask`）不同；不要为了一个 poster 错接该能力。[OSS：多帧截取](https://www.alibabacloud.com/help/en/oss/user-guide/video-frame-cutting)；[IMM 权限](https://www.alibabacloud.com/help/en/oss/user-guide/permissions)

## 对 Q17 / Q18 的建议答案

### Q17：悬停播放生命周期

**建议接受，并把语义收窄为：**

- 墙面视频没有 controls；卡片 `pointerenter` 时，只让当前卡片静音、循环、inline 播放；`pointerleave` 时 `pause()` 后把 `currentTime` 归零。点击仍只进入详情。
- 进入另一张卡片前先暂停并归零前一张，所以最多一条墙面视频播放。不是全局播放器状态，也不做 hover 预取队列。
- `matchMedia('(prefers-reduced-motion: reduce)')` 为真时，永不自动 `play()`；仍显示 poster/首帧和点击入口。该媒体查询表达用户希望减少非必要运动。[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- 对 `play()` 的 rejected Promise 和 `error` 事件走已定「最多一次重新授权，随后手动重试」；不要假定 hover 是 user activation。虽然 Electron 的 BrowserWindow 默认 `autoplayPolicy` 是 `no-user-gesture-required`，仍应保留 Promise 错误处理，不改全局窗口策略。[Electron BrowserWindow options](https://www.electronjs.org/docs/latest/api/structures/browser-window-options)；[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- 卡片离开可见范围或组件卸载时同样暂停；只有已不再需要且仍挂在 DOM 的视频才清 `src` 后 `load()` 以取消网络工作。不要每次 `pointerleave` 都卸载/重建元素，否则反而丢失 hover 后的缓冲。

### Q18：预加载强度与指标

**建议维持 `preload="metadata"`，但修正其承诺：**它是节省可见列表带宽的默认提示，**不是**“已拿到可显示帧”的保证。首版可在 hover 才 `play()` 拉取需要的 Range；卡片尚未有 video data 时保持 poster（若实施）或类型占位。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload)；[HTML Standard](https://html.spec.whatwg.org/multipage/media.html#the-video-element)

因此验收应同时记录：

- `loadedmetadata`：metadata；
- `loadeddata`：首帧可用；
- `pointerenter → playing`：真正“开始运动”；
- 206/Range、下载字节数和 `moov` 位置：解释长尾。

保留目标 `hover → motion p75 ≤ 1.0s / p95 ≤ 2.5s`，但它是实测 SLO，不是 `preload` 的平台保证。用有 poster 的墙面时，poster 的 `load`/decode 另记，不能掩盖播放启动慢。

## 分阶段推荐与升级触发器

1. **先实现/测量原生基线，不引库。** 成品 URL 直给 `<video>`，可见范围 `metadata`，Q17 生命周期，单一自动重新授权。验证 30–50 次冷/热路径、206/Range、`moov`、`loadeddata` 与 hover `playing`。
2. **只有“无静态画面”本身未达 ≤1s 时，增加动态 OSS poster。** 它是最小的有行业支撑的 enhancement：不持久化、不引库、不引 IMM。先在目标 bucket/region以实际资产测处理 p95、错误率和计费；动态快照不达目标或成本不可接受才讨论持久 poster。
3. **只有原生视频 hover p95 超过 2.5s 时，先按证据选修复：**尾部 `moov` → 供应商/转存输出 fast-start；首字节/解码仍慢 → 比较低码率短 preview clip；长视频/网络差异大且需要 ABR → 才评估 HLS/DASH。每一步都是新的媒体派生/分发责任，先做 ADR，再实现。

不因当前问题引入 Video.js、Plyr、ReactPlayer、hls.js、GIF/WebP 动图、sprite、持久 poster、跨页面缓存或 OSS client 缓存。

## 风险与待验证

- OSS `video/snapshot` 当前仅保证 H.264/H.265、JPG，且 real-time processing 的具体 p95、区域可用性和账单必须用目标实例验证；官方文档不能证明客户 bucket 已启用或配额充足。[OSS：单帧快照](https://www.alibabacloud.com/help/en/oss/user-guide/video-snapshots)
- 当前视频虽被描述为 H.264 MP4，但应在抽样成品上验证 codec、可解码性、`moov` 位置和 byte-range 响应；不可由文件扩展名推断。
- `currentTime = 0` 是所需的“离开回开头”体验，可能触发 seek；应在验收中确认连续悬停不会制造明显额外请求。若它成为已证实瓶颈，再评估只暂停、下次从 0 播放的取舍。
- 10 分钟 URL 的撤销残留窗口和在已加载像素/字节不可收回性仍是安全语义，需在更新 ADR/契约时明示。

## Sources

- [HTML Living Standard：video/media elements](https://html.spec.whatwg.org/multipage/media.html)（WHATWG，2026-09-22 查阅）
- [MDN：`HTMLMediaElement.preload`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload)、[`play()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)、[autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)、[`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)（平台文档，2026-09-22 查阅）
- [Electron：BrowserWindow constructor options](https://www.electronjs.org/docs/latest/api/structures/browser-window-options)（官方文档，2026-09-22 查阅）
- [RFC 9110 §14.1 Range](https://datatracker.ietf.org/doc/html/rfc9110#section-14.1)（IETF，2026-09-22 查阅）
- [FFmpeg Formats：MOV/MP4 `faststart`](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)（官方文档，2026-09-22 查阅）
- [Alibaba Cloud OSS：单帧快照](https://www.alibabacloud.com/help/en/oss/user-guide/video-snapshots)、[多帧截取](https://www.alibabacloud.com/help/en/oss/user-guide/video-frame-cutting)、[数据处理概览](https://www.alibabacloud.com/help/en/oss/user-guide/overview-50)、[IMM 权限](https://www.alibabacloud.com/help/en/oss/user-guide/permissions)（官方文档，2026-09-22 查阅）
- [Video.js](https://github.com/videojs/video.js/blob/main/README.md)、[hls.js](https://github.com/video-dev/hls.js/blob/master/docs/API.md)、[ReactPlayer](https://github.com/cookpete/react-player)、[Plyr](https://github.com/sampotts/plyr)（官方仓库，2026-09-22 查阅）
