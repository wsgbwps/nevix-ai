# #343 完整 Mac 客户端安装与更新验收

状态：2026-10-10，完整签名候选静态验收、CNB 公网分发和真实首次安装已通过；完整已安装更新验收通过。本记录仅证明 #343 的隔离集成验收，不代表正式 stable 发布或 PR 合并。

## 候选与隔离范围

候选来自 `365869e04e476caa97c7f49745b0002da5caeb29`，旧/新版为
`0.1.343` / `0.1.344`，App ID `com.nevix.ai`，包含实际 Main、Preload、Renderer。
构建验签修正 `a3b1c8f0` 将 codesign requirement 写成单个 `-R=...` 参数；
旧的分离参数调用会被系统误解析，不能用其失败推断候选签名失效。

本次明确的候选差异为版本号、临时测试 Ed25519 公钥、隔离 CNB HTTPS feed、
独立 package name/updater cache、userData/sessionData bootstrap、公开 boot receipt，
以及使用现有 pnpm 的依赖发现配置。其余客户端业务和更新实现来自上述源码。
固定验收 profile 名为 `Nevix-343-365869e0`，cache 名为
`nevix-343-365869e0-updater`；测试明确核对实际 Electron userData/sessionData，
不能只依赖 Chromium 的 `--user-data-dir` 参数声称隔离。

两版使用已有固定 Mac 叶证书 SHA1
`3AFD38605AD783F0AF4FCA20AD8654EF6005EB12`，未创建新身份，未读取正式
Ed25519 私钥或 `.p12`。Mac 证书签名与实验 Ed25519 清单签名须区别：后者仅使用
临时测试密钥，不是正式更新信任锚。已验证 strict/deep、固定 identifier/叶证书和
hardened runtime；DMG、ZIP 内嵌 app 均通过验签。每版 ASAR 实际扫描 13,724 个
文件，内容扫描禁止完整 PEM 私钥块及私钥、真实 env、token 等禁用路径。
上游 dotenv/jose 文档和源码内的 PEM 格式字符串不是实际私钥，不据此误报。

| 本地制品             |     bytes | SHA256                                                             |
| -------------------- | --------: | ------------------------------------------------------------------ |
| Nevix-AI-0.1.343.dmg | 129598270 | `4896484e8e61f1945c62e5e9d9570c759a0dbe66ab9a14e0e8d7a0c345f7ff97` |
| Nevix-AI-0.1.343.zip | 129646937 | `2fd0c1b3ce8eb2e81cffe0bfde9933e15ab6d351a61ea4cf8e7e5d7fb76cbc8a` |
| Nevix-AI-0.1.344.dmg | 129596215 | `34eb483d3a4d5f310423c208684321998373a3dcf37a06cfcd1c1755e21d108a` |
| Nevix-AI-0.1.344.zip | 129646921 | `ee8aa8985a87b07897ab2b0900a4f29aba98de8bfc549bf106b3f06b760f1cb8` |

旧/新版 ASAR SHA256 分别为
`21a90ec45e708ea4aa2c7d027efc124f59ecdffae855040169e14cd1cb0e6507` /
`b28e0133995438b99bf2578de969e756a438fc96fa62f036600fc41c89f26227`。

## CNB 与首次真实打开

仅将旧 DMG、新 ZIP（合计 259,245,191 bytes）发布到独立
[实验 release](https://cnb.cool/nevix.ai/nevix-releases/-/releases/tag/experiment-343-20261010-365869e0)。
新清单位于独立 branch `mac-343-365869e0-20261010` 的
[experiments/343/darwin-arm64.json](https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/mac-343-365869e0-20261010/experiments/343/darwin-arm64.json)，
commit `5501b8f1649257d77e1238ba1f33a38173324b44`，唯一新增 Git 文件为该 envelope。
未写源码、私密材料、日志或测试脚本，未修改 CNB main、stable 路径、latest 或 `v*` tag。
payload 的 `channel: stable` 仅满足客户端签名格式，不代表正式 stable 渠道发布。

当天 `07:30:07 UTC` 免费额度检查读取组织实际 quota/volume：object 免费上限
107,374,182,400 bytes、已用 745,948,387 bytes；git 同上限、已用 49,152 bytes。
检查包含后续需要的对象/Git 字节，无付费资源申请。两件上传的 PUT 与
confirmation 均返回 200，明确请求 `ttl=0`、不覆盖；此回执证明请求执行，不能独立
证明服务端未来不会改变保留策略。匿名完整 GET 实际均为 `cnb.cool` 302 →
`asset.cnb.cool` 200，系统 TLS 1.3 校验通过，大小及 SHA256/SHA512 均与本地一致。
未使用 token/cookie，未记录临时签名 URL；临时下载已清理。

通过 Chrome 从 CNB 实际下载旧 DMG，大小和摘要与上表相同，真实 quarantine 存在，
没有删除 quarantine。用户完成首次 Gatekeeper 放行后，真实安装入口为
`/Applications/Nevix AI.app/Contents/MacOS/Nevix AI`；首次 boot 已验证 packaged
`0.1.343`，安装 ASAR 与已审核候选一致，固定叶证书严格验签通过。
这与 #340 的最小实验和 loopback 下载不同，不能把历史证据混作本次结果。

## 完整已安装测试结果

在 macOS 26.6.2 (25G83)、arm64，使用 Electron 39.8.10、builder 26.15.3、
updater 6.8.9。测试使用真实已安装 binary、Main/Renderer、CNB feed/制品、
Squirrel，以及独立 HTTPS Go/Postgres 后端。自动化只提供原生确认对话框的人类
选择，不替换更新器、原生安装器或网络传输。兼容后端真实 `/release/version`
为 `1.0.0`、最低 Desktop `0.1.0`，各案例先验证该响应。

最终干净串行套件 **5/5 通过，1.8 分钟，无重试**；另一个最低版本不兼容
案例由单独后端运行，当前模式跳过，不计入这 5 项：

| 实际已安装案例                                 | 结果                                     |
| ---------------------------------------------- | ---------------------------------------- |
| 下载真实 ZIP，选择 Later，普通关闭、退出和重开 | 保持 `0.1.343`                           |
| 确认时替换实际 cache ZIP 字节，再批准          | 拒绝安装，保留旧版和窗口；随后恢复原 ZIP |
| 确认后暂停真实 Go 进程，再批准                 | 最新兼容性检查拒绝安装，旧版及窗口保留   |
| 确认前使真实 renderer 进程崩溃，再批准         | 旧版保留，未安装                         |
| 登录、明确批准安装、自然重启，再重开验证       | `0.1.343 → 0.1.344`，状态保留            |

正向案例公开启动回执顺序为旧版 PID `74772`（07:53:06 UTC）、Squirrel 自然
新版 PID `74924`（07:53:34 UTC）、测试随后重开新版 PID `74932`（07:53:36 UTC）。
三次均为 packaged，同一 `/Applications/Nevix AI.app/Contents/MacOS/Nevix AI`
和固定隔离 profile；自然重启回执在测试重开前已完成。重开真实 renderer 已登录，
安全保存邮箱返回 `persistence: secure`；窗口 bounds 与安装前完全相同；Server
配置和 TOFU pins、测试标记文件保留。最终已安装新版再次通过 fixed-leaf/App ID
strict/deep 验签，ASAR 摘要与上表新版候选一致。

另一个真实 Go 最低 Desktop `99.0.0` 预检查在完整签名旧版打包应用上通过
（10.1 秒）；这不是已安装后的 Server 切换证明。旧版完整 packaged Native Smoke
此前 **6/6 通过，49.0 秒，无重试**；升级后的真实已安装 `0.1.344` 在
2026-10-10 补跑相同完整 Native Smoke，**6/6 通过，49.7 秒，无重试**。
该套件使用实际 `/Applications/Nevix AI.app`、独立临时 profile、真实原生菜单、
剪贴板、窗口恢复和 Keychain 加密/恢复/清理。此前凭据用例一次 60 秒超时，原因
未确定，不计为通过；本次先独立补跑通过（15.0 秒），再串行整套全部通过。
补跑后固定叶/App ID strict/deep 验签仍通过，ASAR 与上表新版摘要相同。
补充原始回执位于 `.scratch/349-installed-followup-20261010/` 的
`auth-smoke.log`、`native-smoke.log` 和 `native-smoke-results/`；不包含正式发行验收。

### 失败尝试与验收隔离

首次兼容 harness 后端误保留 `development` 版本，客户端正确拒绝，Later 测试
未收到 offer；修正测试后端 linker 版本并加入真实响应预检查，客户端判断未修改。
其后的补充 reload 实验在 `did-start-loading` 内同步 `webContents.stop()` 导致
Electron Main SIGSEGV，未进入更新判定，不能作为拒绝安装通过证据。移除该补充
实验，加载未就绪的 installed 覆盖仍列为缺口。

同次 suite 继续到正向案例，发现仍有手动首次运行旧进程占用同 bundle/profile，
随后中断，但已发生替换；该正向结果没有计为通过。通过原生 Quit 菜单关闭本次
测试进程、核实退出，归档本次隔离 profile，恢复已验证旧 app 并重新 strict 验签
与 ASAR 比对后，才执行上述最终干净套件。Harness 新增运行中精确目标进程拒绝
预检查及 `maxFailures: 1`，避免再次让负例失败后继续正向安装。没有接触正式
用户 profile、其他应用、普通更新 cache 或钥匙串设置。

## 仍未验证的边界

- 下载后 Server **身份切换或最低版本变为不兼容**没有完整已安装实测；当前测试
  对下载后不可用的覆盖不能替代这两个分支。
- 首次 renderer 初始化、保存/上传中、错误就绪决定等细分矩阵只有共享实现测试；
  当前完整已安装测试不能声称逐项覆盖。
- 不同证书签署的完整候选尚未实际执行 Squirrel 拒绝验证；#340 短期实验叶的
  最小库实验记录不能冒充当前完整客户端负向证据。
- 未做公证、企业管理策略或不同 Mac/系统矩阵；自签 Mac 首次人工 Gatekeeper
  放行仍是限制。`disable-library-validation` 例外及其风险沿用已接受方案。
- 尚无正式 stable 发布、PR 合并或专用 CI runner/Secrets 接入；用户选择跳过的
  签名材料离线恢复验证没有被本次测试补齐。此次网络验证不是大陆三运营商矩阵。

公开摘要来自 `.scratch/343-integrated-mac-20261010/` 中的
`artifact-verification.json`、`browser-download.json`、`first-installed-acceptance.json`、
`installed-update-verification.json`、`installed-acceptance-clean.log`，
及 `cnb-fixture/` 的 quota、upload、feed、anonymous 回执。原始本机日志、profile、
env、密码和私密材料不进入公开文档。
