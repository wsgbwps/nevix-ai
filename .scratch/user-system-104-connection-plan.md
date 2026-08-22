# Issue #104 — 桌面端连接基座：运行时 server URL 与 TOFU：实施计划

高风险变更（安全边界：TLS 信任决策 + CSP 运行时化 + 凭据接触面），按 AGENTS.md
要求先写计划。父 spec #99（用户故事 31–36、TLS 与桌面连接决策）；依据
ADR-0014（运行时配置、RFC1918 http 放行、TOFU 指纹钉扎、不做全局跳过验证）。
Fixed point：`main` @ 1b5fa30。阻塞票 #103 已 CLOSED。

## 已实证的机制基线（本工作tree内探针验证）

- 渲染层以 `file://` 文档直接 `fetch` Go server 可行：请求不带 Origin 头，
  server `cors.go` 视为非浏览器流量放行（现有 E2E 即此形态）。
- `meta` CSP 与响应头 CSP 交集生效：任一策略不含某源即被阻断。
- `session.webRequest.onHeadersReceived` 对 `file://` 主文档请求触发且
  可改写响应头 → 运行时注入 `connect-src` 可行。
- Electron 证书验证 API（已对官方文档核对）：`setCertificateVerifyProc`
  的 `proc(request, callback)`；`request` 只含 `hostname`（无端口）；
  `callback(0)` 放行、`-3` 用 Chromium 默认结果；`Certificate.data` 为 PEM。

## 范围边界

只做 #104 五条 AC：首启连接屏（输入 URL → 测试连通 → 保存 → 进登录）、
URL 经 IPC 持久化于 userData 且设置页可查看/修改、RFC1918（含 loopback）
http 放行 + 公网强制 https、自签证书 TOFU（首连确认、持久化、变更告警、
不做全局跳过验证）、E2E 覆盖内网 http 成功流与指纹变更告警流。

不做：SSE 通道、Admin 用户管理 UI（#105）、README 技术栈表与
auth-policy/Supabase 残余拆除（#106）、server 侧任何改动、
部署手册/nginx 样例。

## 关键决策

1. **Domain 命名**：新 Desktop Domain `connection`，出现在
   `shared/ipc/connection/`、`main/connection/ipc/`、
   `renderer/src/features/connection/` 与 `connection:<action>` Channel 前缀。
   词典新增 Server URL / Connection Screen / Certificate Fingerprint Pin。
2. **URL 策略单一化**：`shared/config/server-url.ts` 取代
   `server-public-config.ts`；不再区分构建 mode（production https-only 旧规
   废除）。单一运行时策略：https 任意主机；http 仅 RFC1918 + loopback
   主机；origin 必须无 userinfo/path/query/hash。构建期
   `VITE_SERVER_URL` / `__NEVIX_SERVER_URL__` / policy define 全部摘除。
3. **持久化**：`userData/server-connection.json`
   `{ version, url, certificatePins: { [hostname]: sha256hex } }`，原子写
   （pending+rename）。读取时 URL 过策略校验，非法即视为未配置（fail-safe）。
   Pin 以 **hostname** 为键：Chromium verify-proc 只暴露 hostname，主进程
   probe 与渲染层验证必须同键才是一致语义（信任对象是「该主机的这张证书」）。
4. **TOFU 双侧强制**：
   - 主进程 probe（`node:https`，`GET /health`，10s 超时）：先
     `rejectUnauthorized:true`；仅「不受信链」类错误
     （UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT_IN_CHAIN /
     DEPTH_ZERO_SELF_SIGNED_CERT / UNABLE_TO_GET_ISSUER_CERT_LOCALLY）进入
     TOFU 分支：抓 `getPeerCertificate()`，`tls.checkServerIdentity` 复验
     主机名，比对 pin：无 pin → `certificate-confirmation-required`（携带
     sha256 指纹 + subject/issuer/有效期）；匹配 → reachable；不匹配 →
     `certificate-changed`。过期/主机机不匹配等其他 TLS 错误一律
     `unreachable`，不做全局跳过验证。
   - 渲染层 fetch：`session.defaultSession.setCertificateVerifyProc`：
     有 pin 且 sha256(PEM→DER) 匹配 → `callback(0)`；否则 `callback(-3)`
     （CA 有效证书照常通过；pin 不匹配维持 Chromium 拒绝）。
   - 信任确认 IPC `connection:trust-certificate { url, fingerprint }`：
     校验 URL 策略后写 pin；确认后立即 re-probe 验证一致性。
5. **CSP 运行时化**：`index.html` meta 保留
   `script-src/style-src/img-src/object-src/base-uri/frame-src`，摘除
   `default-src` 与 `connect-src`（交集语义下二者会冻结运行时源）。主进程
   `onHeadersReceived` 仅对 `resourceType === 'mainFrame'` 注入
   `Content-Security-Policy: connect-src <已存 URL | 'none'>`（dev 追加
   `'self'` 供 HMR）。保存 URL 后渲染层 `location.reload()` 重建文档取新
   CSP；注入失败时 meta 仍独立约束 script/style（纵深防御）。
6. **状态机与路由**：`useServerConnection`：
   `restoring → {unconfigured | configured}`。`useAuthentication(serverUrl?)`
   在 URL 就绪前停在 `restoring`；`configuration-error` 状态删除（概念随
   构建期注入消亡）。启动面扩展为
   `{connectionStatus, authenticationStatus, pathname}`：unconfigured →
   `/connect`；其余走既有认证二分；`/auth` 视图在 connection 未
   configured 时渲染 null（无闪烁）。新 pre-auth 路由 `/connect`
   （修订 desktop ADR-0004 路由清单，一并回收其中过时的组织时代段落）。
7. **设置页**：SETTINGS_SECTIONS 增加 `connection` 段（新「服务器」分组），
   Feature 贡献 `ServerConnectionSettings`：查看当前 URL、编辑 + 测试 +
   保存（保存要求当前编辑值测试通过）；确认指纹/指纹变更告警在同一节。
   已登录改 URL：保存 → `authentication:clear-session`（renderer 组合，
   不做跨 Domain main 侧依赖）→ reload → 按新 URL 重新登录。
8. **profile/api 接线**：`readProfile/saveProfile` 增加 `serverUrl` 参数，
   由 settings 组合根从 connection 状态传入（Feature 间不互相 import）。
9. **E2E 栈**：run-e2e.sh 摘除两个 production 失配构建矩阵与
   `VITE_SERVER_URL` 注入；新增 TLS terminator（node https，
   SNICallback 换证书支持轮换）+ openssl 生成两套自签证书（SAN:
   IP:127.0.0.1）。新 spec：`tests/connection/connection-screen.spec.ts`
   （@smoke：未配置首启 → 连接屏 → 非法/公网 http 拒绝 → 内网 http 测试
   通过 → 保存 → 登录面 → 重启免配置直达登录）与
   `tests/connection/connection-tofu.spec.ts`（@smoke：自签首连指纹确认 →
   持久化 → 登录走 TLS → 证书轮换后测试连接触发变更告警 → 重信新指纹）。
   既有 spec 用 seed 助手（直写 store 文件）或一次性驱动连接屏完成配置；
   专属连接 spec 走完整 UI 流。

## 测试计划

- 单元：server-url 策略（改写 public-config-policy.spec）、
  connect-src CSP 构造器、startup-surface 新三分支、pin map 规范化、
  IPC allowlist drift 自动。
- 组件：authentication-transition story 传 serverUrl。
- E2E：上表两条新 spec + electron-security CSP 断言改行为化
  （放行源可用 + 哨兵源被 connect-src 阻断）+ 既有 spec 全量适配。
- 服务器侧零改动；contracts/ 零改动（/health 既有，无新端点）。

## 已知缺口（PR 记录，不扩 scope）

- 未认证状态下无 server URL 修改入口（保存前置测试通过使错配概率极低）。
- Chromium 与 Node 信任库差异：probe 接受而 Chromium 拒绝的边缘证书
  （弱密钥等）会在渲染层 fetch 失败——按网络错误呈现，可重试。
