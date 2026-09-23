# 媒体墙 SLO 实测证据（issue #292）

> 日期：2026-09-23
> 状态：实测记录。目标值来自 [#287](https://github.com/wsgbwps/nevix-ai/issues/287)
> 的实施规格与 [#292](https://github.com/wsgbwps/nevix-ai/issues/292) 的验收标准。
> 本文件只记录测量与结论，不改变任何产品行为。

## 结论

60 次路由进入（30 cold + 30 warm）× 2 个阶段 = 120 次测量，四个目标全部达标，
样本中零媒体加载失败。

**先读这句再读表格：表中的数字是在非代表性图片资产上测到的，而 `unavailable` 与
320px 可辨认性两项没有拿到。** 具体地——图片是假 Kapon 的渐变测试图（每条 300 字节），
真实产物的网络分量会明显更大（见「已知边界 1」），所以这四个"达标"说明的是**链路机制
与量级余量**，不是真实资产下的最终余量。另有 criterion 3、8、11 三项为 PARTIAL，理由
各自记在下面与「已知边界」。

| 阶段 | 目标 | n | p75 | p95 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 页面框架/卡片 | p75 ≤ 500ms | 60 | 46ms | 49ms | PASS |
| 首个首屏预览 | p75 ≤ 1.0s, p95 ≤ 1.5s | 60 | 77ms | 79ms | PASS |
| 全部首屏预览 | p75 ≤ 1.5s, p95 ≤ 2.5s | 60 | 87ms | 94ms | PASS |
| 悬停到画面运动 | p75 ≤ 1.0s, p95 ≤ 2.5s | 60 | 1ms | 2ms | PASS |

视频观测（无目标值）：`loadedmetadata` p75 83ms / p95 85ms，`loadeddata`
p75 83ms / p95 86ms。两者几乎同时，说明这段视频的索引与首帧在同一次取回里就绪。

**悬停到运动只有 1ms 不是测量失效，而是设计意图的直接结果。** 视频墙的卡片在
`loadeddata` 到达时已经把首帧解码好（上面 83ms），用户悬停时元素 `readyState`
已 ≥ 2，`play()` 在已缓冲的数据上立即兑现 `playing`。两端都是页面自身的时间戳
（卡片 `pointerenter`、元素 `playing`），中间没有 Playwright 往返。这个数字说明的
是"墙稳定后悬停"，见「已知边界」。

这个测量不是空转的，报告本身可证：60 个视频阶段全部产生了悬停样本（没有一张视频卡
从未被悬停），**60 个 delta 全部为正**（没有一次 `playing` 先于 `pointerenter`，
即墙面视频没有在悬停前自行播放），实测区间 0.80–1.70ms；并且 60/60 张卡的
`loadeddata` 都严格早于 `hoverEnteredAt`，也就是上面解释的机制在数据里成立。

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
| `media`（视频墙） | 25 | 206 | 996725 | 39869 |
| `image`（320px 图片墙） | 208 | 200 | 62400 | 300 |

- 25 条视频响应全部带 `Range: bytes=0-`，全部回 206，`Content-Range` 只有一种取值：
  `bytes 0-39868/39869`。即 Chromium 每次取回的是整段原始 MP4 的**一次**分段
  GET，没有多段、没有先取头部再回头补尾部。
- 每条视频响应恰好 39869 字节，与 `scripts/dev/fixtures/video-with-audio.mp4`
  字节数完全一致，说明墙确实拿到的是未经转码、未加 `x-oss-process` 的原始对象。
- 208 条图片响应全部是 200（不是 206），每条 300 字节，全部来自
  `nevix-dev.oss-cn-guangzhou.aliyuncs.com`，即图片墙走的是 OSS 响应期转换出的
  320px WebP，而不是原件。
- 60 个视频阶段只产生 25 条网络响应，60 个图片阶段产生 208 条。**这些计数没有按阶段
  标注**（抓包是一个扁平列表），所以下面是算术而不是观测：若 warm 阶段都命中缓存，则
  25 条意味着 30 个 cold 视频阶段里有约 5 个没有产生新响应，208 条意味着 cold 图片入口
  平均约 6.9 张（首屏约 8 张）。也就是说 cold/warm 的区分在图片上看起来是干净的，在视频
  上不是完全的——`clearCache()` 清的是 HTTP 缓存，Chromium 的媒体缓存在其之外，这一点
  没有被消除。因此"每个 cold 视频阶段都必定重新取回原始视频"**不能**由本样本断言；能
  断言的是 25 次 206 真实发生过。

这同时证明 **Range 没有参与预签名的签名**：若签名把 `Range` 固定进签名头，浏览器
自行加上 `Range: bytes=0-` 的请求会因签名不匹配被 OSS 拒签，而 25 条全部被正常
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

因此本基准测到的 `loadedmetadata` p75 83ms **不能归因于尾部 `moov`**：索引就在文件开头，
浏览器不需要额外的尾部读取。criterion 10 要求的归因在这里的结论是"不适用"——而这是
一个被检验过的"不适用"，不是没查。

检查器本身非空转，而且这一步可以复跑：`derive-trailing-moov.mjs` 把同一个文件重排为
`ftyp free mdat moov`（`mdat` 从 3673 移到 40，按位移量 -3633 重写 49 个 `stco` 项，
文件长度不变），再跑检查器得到 `moovPlacement: "trailing"`、`moovOffset: 36236`、
采样描述仍是 `avc1`/`mp4a`。也就是说它读的是真实 box 布局，不是文件名或扩展名——如果它
对任何输入都报"前置"，criterion 10 的检查就没有意义。该变体只用于验证检查器，不是基准
资产，因此派生物本身不提交，派生工具提交。

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
- 每个资产的授权尝试次数落在 2–4 之间：**下界 2** 就是自动重新授权确实发生了，
  上界说明它不是重试循环；
- 移除拦截后点击 `重试`，重试确实发起了新的授权，卡片渲染出真实的 OSS 授权图片。

"恰好一次"这个精确计数没有在这里断言：renderer 会重放 effect，单张卡每次尝试可能发
两次请求，精确计数不稳定——断言一个会随框架行为漂移的数字，比断言区间更容易假装通过。
该预算由 `apps/desktop/tests/component/asset-library.spec.tsx` 确定性地覆盖。

**通用不可用状态：本次没有在真实链路上取得证据，这里如实记录失败的努力。**

尝试过的做法是对 `/creation/assets/{id}/thumbnail-url` 的 GET 用 `route.fulfill`
注入 403。**这次尝试没有成功，而且不能说明产品的行为**：注入的响应没有以 403 到达页面
——Playwright 侧看到的是 `<- GET 0` 与成片的 `net::ERR_ABORTED`，即请求在拿到可读响应
之前就被客户端取消了（全程没有 OPTIONS，所以不是 CORS 预检的问题）。卡片最终停在
`媒体加载失败`（retryable），而按代码 `go-creation-http.ts:205` 的映射，一个**真正被读到**
的 403 应当走 `forbidden → unavailable`（`use-asset-display.ts:124-131`）。

所以准确的说法是：**"永久 403 在墙面上会怎样"这次没有被测到**，abort 与网络失败才是
观测到的东西。先前把结论写成"产品在永久拒绝下无法收敛"是把推断当成了观测，已删除。
重试该实验需要一种能让页面真正读到 403 的注入方式（而不是被取消的那种）。

因此 `unavailable` 的渲染目前只有确定性证据：
`apps/desktop/tests/component/asset-library.spec.tsx:418`
`'a gone asset shows the generic unavailable state and refreshes the list'`
（fixture `displayMode="gone"` → `request-rejected, not_found`）断言 `Media unavailable`
可见、**没有**重试按钮、且列表被重读。该测试在 `test:component` 中运行（本分支未改动它），
已单独复跑通过。它证明的是**组件层**在该 outcome 下渲染正确，不是真实链路会走到那里。

结论：criterion 8 只完成了一半多一点——`retryable` 与手工重试恢复在真实链路上端到端
验证；`unavailable` 只有组件层证据，**真实链路上的可达性未验证**。因此该 criterion 在
验收里标为 PARTIAL，而不是通过。

## 复现步骤

```
# 前置：Docker 运行中；server/.env.local 里有可用的 NEVIX_OSS_SMOKE_*。
# 注意这会向该真实 bucket 写入对象。
cd apps/desktop
bash scripts/run-e2e.sh benchmark
node scripts/media-wall-benchmark/aggregate.mjs test-results/media-wall-benchmark/report.json
node scripts/media-wall-benchmark/inspect-mp4.mjs ../../scripts/dev/fixtures/video-with-audio.mp4
# 复现 criterion 10 的非空转性：派生一个 moov 尾置的同源变体再检查一次
node scripts/media-wall-benchmark/derive-trailing-moov.mjs \
  ../../scripts/dev/fixtures/video-with-audio.mp4 /tmp/trailing-moov.mp4
node scripts/media-wall-benchmark/inspect-mp4.mjs /tmp/trailing-moov.mp4
```

`aggregate.mjs` 在任一目标未达标、样本不足 30+30、出现媒体加载失败、或网络证据
里没有出现 OSS 源时以非零退出，所以绿灯不是靠没人看而通过的。

这四条失败路径不是承诺，是实测过的：把本报告的副本分别构造成「图片阶段慢到 90s」
「只留 8 条测量」「删掉整个视频阶段」「把所有网络来源改成 127.0.0.1」，四次运行各
自 exit 1，并分别打印出失败的阶段名、`sample size: cold 4/30`、
`hoverToPlaying no samples`、`no Aliyun OSS origin observed`。

报告写在 `apps/desktop/test-results/media-wall-benchmark/report.json`。该目录属于
Playwright 的 `outputDir`，**下一次 Playwright 运行会清空它**；本文件是持久记录。

样本量可用 `NEVIX_BENCHMARK_COLD=2 NEVIX_BENCHMARK_WARM=2` 缩小以便快速验证管线。注意
缩小的运行**应当**被 `aggregate.mjs` 判为失败（`sample size: cold 2/30`）：30+30 是
criterion 3 的下限，不随运行配置下调，缩小跑是用来确认管线通不通的，不是用来通过验收的。

## 本分支验证过的门禁

| 检查 | 结果 |
| --- | --- |
| `bash apps/desktop/scripts/run-e2e.sh benchmark` | 2 passed（性能样本 + 失败注入），exit 0 |
| `node …/aggregate.mjs <report>` | 目标全 PASS，样本 30+30，0 失败、0 未决卡片，exit 0 |
| 同一脚本喂四份构造坏的报告 | 慢阶段 / 样本截断 / 缺视频阶段 / 无 OSS 源，四次都 exit 1 并指出原因 |
| `derive-trailing-moov.mjs` + `inspect-mp4.mjs` | 派生物报 `trailing`@36236，原文件报 `front-loaded`@32 |
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

2. **悬停到运动测的是"墙稳定后悬停"。** 卡片在 `loadeddata`（p75 83ms）时已有
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

7. **基准会向真实 bucket 留下对象，而且不做清理。** 每次运行通过真实生成链路创建
   约 10 个 Media Asset，对象键是产品自己的键（不是 `nevix-smoke/...` 那样的隔离
   前缀），运行结束后**不会删除**。这偏离了仓库对 `NEVIX_OSS_SMOKE_*` 这组凭据的既有
   纪律（`Makefile:96-97`：隔离前缀 + 精确 key 清理）。删对象属于 delivery.md 的
   「破坏性持久数据操作」，需要人工批准，所以基准不自行删除——**每次运行都会留下
   残留，运维方需要自行清理**。频繁重跑前请先确认这一点。
