# 媒体墙 SLO 实测证据（issue #292）

> 日期：2026-09-23
> 状态：实测记录。目标值来自 [#287](https://github.com/wsgbwps/nevix-ai/issues/287)
> 的实施规格与 [#292](https://github.com/wsgbwps/nevix-ai/issues/292) 的验收标准。
> 本文件只记录测量与结论，不改变任何产品行为。

## 结论

60 次路由进入（30 cold + 30 warm）× 2 个阶段 = 120 次测量，全部达标，样本中
零媒体加载失败。

| 阶段 | 目标 | n | p75 | p95 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 页面框架/卡片 | p75 ≤ 500ms | 60 | 47ms | 48ms | PASS |
| 首个首屏预览 | p75 ≤ 1.0s, p95 ≤ 1.5s | 60 | 77ms | 80ms | PASS |
| 全部首屏预览 | p75 ≤ 1.5s, p95 ≤ 2.5s | 60 | 87ms | 92ms | PASS |
| 悬停到画面运动 | p75 ≤ 1.0s, p95 ≤ 2.5s | 60 | 1ms | 2ms | PASS |

视频观测（无目标值）：`loadedmetadata` p75 84ms / p95 87ms，`loadeddata`
p75 84ms / p95 87ms。两者几乎同时，说明这段视频的索引与首帧在同一次取回里就绪。

**悬停到运动只有 1ms 不是测量失效，而是设计意图的直接结果。** 视频墙的卡片在
`loadeddata` 到达时已经把首帧解码好（上面 84ms），用户悬停时元素 `readyState`
已 ≥ 2，`play()` 在已缓冲的数据上立即兑现 `playing`。两端都是页面自身的时间戳
（卡片 `pointerenter`、元素 `playing`），中间没有 Playwright 往返。这个数字说明的
是"墙稳定后悬停"，见「已知边界」。

## 被测链路

真实的 Electron Renderer → Go → 阿里云 OSS，不是本地替身。这条链路只有一种方式
能真正跑起来：`bash apps/desktop/scripts/run-e2e.sh benchmark` 构建**不带 `e2e`
构建标签**的 Server。E2E 构建的内存 Object Storage 的 `PresignThumbnail` /
`PresignPreview` 是刻意报错的（`server/cmd/server/e2e_server_test.go`），显示
URL 在那条路径上根本不存在，所以 E2E 套件里不可能测量这个 SLO。

基准模式做的是：

1. 抛出一次性 PostgreSQL，构建并启动**生产** Server；
2. 通过既有的 TLS 终止器 + reauth proof 注册 Object Storage Connection，凭据与
   bucket 取自 `server/.env.local` 的 `NEVIX_OSS_SMOKE_*`。生产侧的
   `storage.VerifyConnection` 会跑真实 canary，凭据不对就当场失败；
3. provider 用的是仓库自带的 loopback 假 Kapon（`kapon.ValidateBaseURL` 允许
   loopback http），因此**除供应商本身以外**的一切——准入、队列、结果转存、真实
   OSS adapter、媒体探测、Media Asset——都是出厂的代码路径；
4. 生成 8 张图片与 1 段视频，落在真实 bucket 里；
5. 在真实 Renderer 里跑 60 次路由进入。

## 测量方法

测量完全在测试侧，**没有给产品加任何埋点**（criterion 14）。`tests/perf/media-wall-slo.spec.ts`
注入一个页内观察器，每个阶段只读回一次：

- `route start` 是 `arm()` 的 `performance.now()`，紧接导航点击；
- `cards ready` 取所有卡片 `appearedAt` 的最大值；
- `first / all initially visible previews` 取初始视口内卡片 `decodedAt` 的最小/最大值；
- 图片的完成点是 `load`；视频的完成点是 `loadeddata`，与产品自身的 `pending` 判据
  一致；`loadedmetadata` 单独记录，因为它只证明 `moov` 索引解析成功，不证明有可
  显示帧；
- `pointer-enter to playing` 两端都是页面自身的时间戳（卡片上的 `pointerenter`
  事件与元素的 `playing` 事件），中间没有 Playwright 往返。

**"Initially visible"**（criterion 2）用 `rootMargin: 0` 的 `IntersectionObserver`
观察路由进入时挂载的卡片；基准全程不滚动墙面，因此相交即等于首屏可见，屏外卡片
被排除在首屏 SLO 之外。

**cold / warm**（criterion 3）：cold 是在进入路由前调用
`session.defaultSession.clearCache()`，媒体需重新取回；warm 是同一 Session 内不清
缓存地再次进入。两者都不是重开进程。

**两个阶段。** 两个墙面都默认 `mediaType: 'image'`，且媒体类型是严格的
图片|视频 二选一、没有"全部"（`asset-library-page.tsx:63`、
`inspiration-page.tsx:26`）。所以一次路由进入产生两次测量：图片阶段是路由进入本
身，也就是 criteria 5、6、11 所说的 320px 图片墙；视频阶段是在同一面墙上选择
「视频」，这是唯一会挂载 `<video>` 的状态，也是 criterion 7 唯一能测量的状态。

## 传输证据

字节数取自响应头的 `Content-Length`，而不是 `PerformanceResourceTiming.transferSize`
——后者在这里**结构性为 0**：Renderer 是 `file://` 文档，所有请求都是跨源，而阿
里云 OSS 不发送 `Timing-Allow-Origin`。

关键结论：**视频请求确实使用 HTTP 206 与 Range，而不是从标签推断。**

| 资源类型 | 响应数 | 状态 | 总字节 | 每条均字节 |
| --- | --- | --- | --- | --- |
| `media`（视频墙） | 26 | 206 | 1036594 | 39869 |
| `image`（320px 图片墙） | 208 | 200 | 62400 | 300 |

- 26 条视频响应全部带 `Range: bytes=0-`，全部回 206，`Content-Range` 只有一种取值：
  `bytes 0-39868/39869`。即 Chromium 每次取回的是整段原始 MP4 的**一次**分段
  GET，没有多段、没有先取头部再回头补尾部。
- 每条视频响应恰好 39869 字节，与 `scripts/dev/fixtures/video-with-audio.mp4`
  字节数完全一致，说明墙确实拿到的是未经转码、未加 `x-oss-process` 的原始对象。
- 208 条图片响应全部是 200（不是 206），每条 300 字节，全部来自
  `nevix-dev.oss-cn-guangzhou.aliyuncs.com`，即图片墙走的是 OSS 响应期转换出的
  320px WebP，而不是原件。
- 60 个视频阶段只产生 26 条网络响应：warm 阶段命中 Chromium 缓存，cold 阶段的
  一部分也没有产生新的网络响应。**这里只报告观测计数，不解释成因**；26 条 206
  已经是真实网络取回的证据。

这同时证明 **Range 没有参与预签名的签名**：若签名把 `Range` 固定进签名头，浏览器
自行加上 `Range: bytes=0-` 的请求会因签名不匹配被 OSS 拒签，而 26 条全部被正常
应答 206。这与 `server/internal/creation/infrastructure/storage/oss.go` 对任何已
签名头 fail-closed 的立场互为印证。

## MP4 资产检查

`node apps/desktop/scripts/media-wall-benchmark/inspect-mp4.mjs scripts/dev/fixtures/video-with-audio.mp4`
直接遍历 ISO-BMFF 顶层 box（本机没有 ffmpeg，也不引依赖）。被测资产是仓库自带、
可许可再生的 `scripts/dev/fixtures/video-with-audio.mp4`：

| 项 | 值 |
| --- | --- |
| 字节数 | 39869 |
| 顶层 box 顺序 | `ftyp@0(32)` → `moov@32(3633)` → `free@3665(8)` → `mdat@3673(36196)` |
| `moov` 位置 | **前置**（`moov` 在 `mdat` 之前） |
| 品牌 | `isom` |
| 采样描述 | `avc1`（H.264）+ `mp4a`（AAC） |

因此本基准测到的 `loadedmetadata` p75 84ms **不能归因于尾部 `moov`**：索引就在文件开头，
浏览器不需要额外的尾部读取。criterion 10 要求的归因在这里的结论是"不适用"——而这是
一个被检验过的"不适用"，不是没查。

检查器本身非空转：把同一个文件重排为 `ftyp free mdat moov`（并按位移量 -3633 重写 49 个
`stco` 项）后，`inspect-mp4.mjs` 报 `moovPlacement: "trailing"`、`moovOffset: 36236`，
采样描述仍是 `avc1`/`mp4a`——它读的是真实 box 布局，不是文件名或扩展名。该变体只用于
验证检查器，不是基准资产，因此没有提交。

## 高 DPR 目视检查（criterion 11）

截图由基准在图片墙稳定后以 `page.screenshot({ fullPage: true })` 采集，落在
`apps/desktop/test-results/media-wall-benchmark/wall-dpr2.png`。设备像素比为
**2**（`window.devicePixelRatio`，实测值随报告记录），即墙面是在 2 倍 DPR 下渲染
并采样的，符合"representative high-DPR"。

截图实际是 2560×1536（1280×768 视口 × 2），8 张卡片排在 9月23日 分组下，图片墙
布局、圆角、间距与筛选栏都正常。

**结论：PARTIAL，而不是 PASS。** 采集本身是真实的高 DPR 墙面，但本次种下的图片是
假 Kapon 生成的确定性 64×64 **平滑渐变** PNG（经 OSS 转为 320px WebP 后每条 300
字节）。渐变上没有可供辨认的内容，因此这次截图**无法**证明 320px 对真实照片内容是否
足够辨认——它只能证明 320px 变体在 2 倍 DPR 下被正常渲染、卡片布局与边缘清晰度没有
异常。换句话说，它验证了"转换链路与渲染正确"，没有验证"细节够用"。

criterion 11 的升级路径很小：把种子换成真实生成的图片产物（几十到几百 KB 的有细节
照片）后重跑同一基准即可，无需改动测量代码。在此之前不应把该项记为已确认。

## 失败注入（criterion 8 的后半）

60 次样本里零失败只说明"没发生失败"，不说明失败时界面是否可读。因此失败被单独注入，
且**不混进性能样本**——路由拦截会改变它本想测量的时序，所以它是同一个 spec 文件里的
第二个 test。

**传输失败（本次在真实链路上端到端验证）：** 拦截一次授权 GET 并 `abort('failed')`，
然后重新进入墙面。结果是：

- 卡片进入显式的 `媒体加载失败` 状态并出现 `重试` 按钮；
- 每个资产的授权尝试次数有界（≤ 4），不是无限循环；
- 移除拦截后点击 `重试`，重试确实发起了新的授权，卡片渲染出真实的 OSS 授权图片。

"恰好一次自动重新授权"这一计数没有在这里断言：renderer 会重放 effect，单张卡每次
尝试可能发两次请求，精确计数不稳定。该预算由
`apps/desktop/tests/component/asset-library.spec.tsx` 确定性地覆盖。

**通用不可用状态：** 没有在 E2E 墙面上注入，原因是**注入不出来**。我实测过：对
`/creation/assets/{id}/thumbnail-url` 永久回 403，卡片观测序列是
`正在加载媒体… → 媒体加载失败重试`，`媒体不可用` 从未渲染，同时伴随大量客户端
`net::ERR_ABORTED`（Playwright 侧看到 `<- 0`，且全程没有 OPTIONS，即不存在 CORS 预检）。
机制是产品自身的行为：`unavailable` 会触发列表重读，重读后的列表**仍然列出该资产**
（合成 403 没有改变 Server 事实），于是卡片重新授权、再次被拒——墙面无法收敛，每次
重挂载都取消上一个在途请求。

换句话说，"显示 URL 永远拒绝、但列表永远返回该资产"不是一个可达的 Server 状态。
产品规格假定的收敛前提（被拒即意味着资产已不可见，重读后不再出现）在这里被人为破坏。

因此该状态由确定性测试覆盖：`apps/desktop/tests/component/asset-library.spec.tsx:418`
`'a gone asset shows the generic unavailable state and refreshes the list'`
（fixture `displayMode="gone"` → `request-rejected, not_found`）断言 `Media unavailable`
可见、**没有**重试按钮、且列表被重读。这条测试在 `test:component` 中运行，本分支未改动它。

结论：criterion 8 的两个状态都有证据，但它们的证据面不同——`retryable` 在真实链路上
端到端验证，`unavailable` 由组件层确定性验证。这一点如实记录，不当作两个都在 E2E 里验过。

## 复现步骤

```
# 前置：Docker 运行中；server/.env.local 里有可用的 NEVIX_OSS_SMOKE_*。
# 注意这会向该真实 bucket 写入对象。
cd apps/desktop
bash scripts/run-e2e.sh benchmark
node scripts/media-wall-benchmark/aggregate.mjs test-results/media-wall-benchmark/report.json
node scripts/media-wall-benchmark/inspect-mp4.mjs ../../scripts/dev/fixtures/video-with-audio.mp4
```

`aggregate.mjs` 在任一目标未达标、样本不足 30+30、出现媒体加载失败、或网络证据
里没有出现 OSS 源时以非零退出，所以绿灯不是靠没人看而通过的。

报告写在 `apps/desktop/test-results/media-wall-benchmark/report.json`。该目录属于
Playwright 的 `outputDir`，**下一次 Playwright 运行会清空它**；本文件是持久记录。

样本量可用 `NEVIX_BENCHMARK_COLD=2 NEVIX_BENCHMARK_WARM=2` 缩小以便快速验证管线。

## 本分支验证过的门禁

| 检查 | 结果 |
| --- | --- |
| `bash apps/desktop/scripts/run-e2e.sh benchmark` | 2 passed（性能样本 + 失败注入），exit 0 |
| `node …/aggregate.mjs <report>` | 目标全 PASS，样本 30+30，exit 0 |
| `make test-e2e:smoke` | exit 0 — 本分支改动了共享的 `run-e2e.sh`，这是它的回归检查 |
| `make check` | exit 0（format / lint / verify:architecture / typecheck / test:unit 439 / gofmt / go vet / go test） |
| `make harness-test` | 53 tests，exit 0 |
| `pnpm --filter @nevix/desktop test:component` | 329 passed，其中包含上面引用的 `asset-library.spec.tsx:418` |

`make test-creation-oss-smoke` 也单独跑过并通过（`result=pass cleanup=pass`），用于在基准之前
独立确认 bucket 与凭据可用。

## 已知边界

这些是测得的数字真实成立的范围；越过它们结论不再自动成立。

1. **资产体积不代表真实产物，网络分量被低估。** 视频是真实的 5 秒 320×180
   H.264/AAC MP4（39869 字节，`+faststart`），但图片是假 Kapon 生成的确定性
   64×64 平滑渐变 PNG，经 OSS 转为 320px WebP 后每条只有 **300 字节**。真实生成的
   图片产物会是几十到几百 KB，所以首屏预览的 p75 77ms 主要反映的是往返与解码，
   不是带宽。按 8 张首屏图片、每张约 20KB 估算，网络分量会明显上升——余量仍然
   很大（目标 p75 1.0s / p95 1.5s），但**这个余量是推算的，不是测得的**。
   升级路径：用真实产物替换假 Kapon 的测试图后重跑同一基准。

2. **悬停到运动测的是"墙稳定后悬停"。** 卡片在 `loadeddata`（p75 84ms）时已有
   首帧，因此悬停几乎立即出画（p75 1ms）。一个与首次取回**竞速**的悬停——元素
   尚无数据时指针就进入——没有被这个样本覆盖。这是刻意的：产品在近可见时就预取
   元数据，真实用户先看到墙再悬停，这个测量对应的是后者。视频换成数 MB 的真实
   产物时，"悬停出画"仍会很快，但它的前提（首帧已就绪）会更晚成立。

3. **仅在本机网络与 `cn-guangzhou` bucket 上测量。** SLO 是端到端量，含本机到
   OSS 的 RTT。换 region、换网络、或走真实部署拓扑都会改变绝对值。

4. **两张墙都是"图片墙或视频墙"，没有"全部"。** 媒体类型是严格的二选一，所以
   一次路由进入无法同时测量两类媒体；本基准用两个阶段覆盖，而不是假装墙上有
   混排状态（墙本来就没有）。

5. **样本按 30+30 的下限跑。** criterion 3 要求"至少"30+30，这里正好取该下限；
   每个阶段 60 个样本对 p95 而言偏薄（p95 实际由第 57 个排序样本决定），p95 的
   数字应比 p75 更谨慎地解读。加大 `NEVIX_BENCHMARK_COLD/WARM` 即可加密样本。

6. **报告 JSON 会被下一次 Playwright 运行清空。** 它写在 Playwright 的
   `outputDir` 下；本文件是持久记录，JSON 是当次运行的过程产物。
