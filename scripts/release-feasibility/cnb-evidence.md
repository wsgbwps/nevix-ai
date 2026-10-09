# CNB 分发可行性证据（#340）

调查日期：2026-10-09。范围：[规格 #339](https://github.com/wsgbwps/nevix-ai/issues/339)、[发行可行性验证 #340](https://github.com/wsgbwps/nevix-ai/issues/340) 的 CNB 三项验收。原规格要求大陆三网；**用户本次明确授权以当前大陆网络实测代替三网，不再将缺少三网作为本次阻断条件。** 结论：公共样例匿名协议可用；Nevix 实际制品、目标组织额度及永久保留配置尚未验收，CNB 可行性门不能标记通过。

本次仅匿名读取公开资料和官方公开附件；未创建 CNB 仓库、上传制品、使用写 token、绑定预算或修改任何外部资源。没有接触生产密钥及客户数据。此文档不接受 ADR-0026，也不启用生产更新。

## 当前规则及一方来源

| 项目           | 2026-10-09 核对结果                                                                                                                                                                                            | 一方证据                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 免费额度       | 每个顶级组织 Git 存储和对象存储各 100 GiB；附件与制品、LFS、图片共用对象额度。未绑定预算时能力可能受限。未读取目标组织实际剩余额度。                                                                           | [当前定价](https://docs.cnb.cool/zh/pricing.html)；旧 `/zh/saas/pricing.html` 为 HTML meta/JS 跳转，`curl -L` 不会解析该跳转                                                             |
| 超额及保留风险 | 服务协议 3.1.1 允许调整/取消免费额度；3.1.3 说明未绑定付费资源且超额达 15 天可能回收资源；6.6 要求用户自行备份。永久附件配置不能消除组织回收风险。                                                             | [服务协议](https://docs.cnb.cool/zh/saas/terms.html)                                                                                                                                     |
| 附件大小       | 插件 README 声明暂支持 64GB 以内文件；这是文档限制，没有通过本次 9.6 MB 样例证明大包上限。                                                                                                                     | [附件插件 README](https://cnb.cool/wmde/attachments/-/blob/main/README.md)                                                                                                               |
| 附件保留和覆盖 | OpenAPI 上传表单提供 `ttl`（天）及 `overwrite`；文档未明确 `ttl` 永久哨兵值或默认保留期。查阅的插件源码只提交 `asset_name` 和 `size`，不设置这两个字段，因此不能直接声称插件上传永久且不可覆盖。               | [OpenAPI Swagger](https://api.cnb.cool/swagger.json)，`openapi.PostReleaseAssetUploadURLForm`；[插件源码 utils.ts](https://cnb.cool/wmde/attachments/-/blob/main/src/utils.ts)，上传函数 |
| 失败重试       | 插件请求捕获错误后抛出，没有可见自动重试。CNB 流水线 `retry` 默认为 0，配置后以 1、2、4、8 秒间隔重试；这与 GitHub Actions 发布、匿名下载重试是不同责任。未做真实 CNB 上传中断、过期下载 URL 或 429 重试实验。 | [插件请求代码](https://cnb.cool/wmde/attachments/-/blob/main/src/utils.ts)；[流水线 retry](https://docs.cnb.cool/zh/build/grammar.html#retry)                                            |

需在真正上传前确认目标组织剩余额度、不绑定预算，并通过受控实验/有效平台说明确定永久保留值；上传时明确禁止覆盖，厂商保留本地包与签名清单。当前没有足够证据为永久保留填入一个数值。OpenAPI 记录 GET 会重定向至临时下载地址，客户端应重试稳定版本入口，不长期保存临时 URL。

## 已执行的匿名协议实验

环境：macOS 26.6.2（25G83）、arm64、curl 8.7.1，2026-10-09 07:05–07:07 UTC。用户将当前网络确认为大陆环境；检测到环境 HTTP/HTTPS/ALL_PROXY（大小写）均设置，系统 HTTP/HTTPS/SOCKS 代理启用、PAC 关闭；默认接口 `en0`，存在隧道接口。所有协议/下载实验独立加 `--noproxy '*'`，绕过 curl 环境代理，未改动系统代理/VPN。出口运营商及 WAN 地区未独立确认（无代理 HTTPS 地理查询 curl exit 56）；未输出准确 IP、代理地址、用户名或密码。存在隧道接口不证明实际走 VPN，`--noproxy` 也不能排除系统级隧道路由；本次记录是当前连接的结果，不声称已证明三网或排除所有 VPN。curl 使用系统信任并验证 HTTPS，未使用 `-k`；限制初始和重定向协议为 HTTPS，没有 Authorization、Cookie 或业务 Session。

两个对象均为第三方公共样例，未执行下载包，未将其作为 Nevix 签名清单或实际安装包：

- raw：`https://cnb.cool/wmde/attachments/-/git/raw/main/README.md`，响应 commit `dc11f5de702f68780e819aa2f4e3bd3ac7f0b641`。
- Release：`https://cnb.cool/cnb/cool/orange-runner-doc/-/releases/download/v1.0.1/orange-runner-1.0.1-linux-amd64.tar.gz`，来自 [CNB 官方成品仓库](https://cnb.cool/cnb/cool/orange-runner-doc)。

| 对象/请求                      | 实际结果                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| raw HEAD                       | 200，Content-Length 7511；无重定向                                                                                         |
| raw GET                        | 200，text/plain，完整 7511 bytes；无重定向                                                                                 |
| raw GET Range `bytes=0-31`     | 200，完整 7511 bytes，忽略 Range；小清单采用全量 GET                                                                       |
| Release HEAD                   | 200，Content-Length 9617737；主站直接响应，无重定向                                                                        |
| Release GET                    | 主站 302 → `https://asset.cnb.cool/assets/t/…` → 200，完整 9617737 bytes；一次跨主机重定向；单次观测 2.29 秒，不作速度承诺 |
| Release GET Range `bytes=0-31` | 主站 302 → asset 主机 206，32 bytes，`Content-Range: bytes 0-31/9617737`、`Accept-Ranges: bytes`                           |
| TLS                            | 上述 curl 请求 `ssl_verify_result=0`，没有降级 HTTP；不代表 updater/Go 的实际跨主机链路已验收                              |
| 匿名 latest API                | `https://api.cnb.cool/cnb/cool/orange-runner-doc/-/releases/latest` 返回 401/errcode 16，要求登录；客户端不应依赖它        |

完整 GET 在内存计算 SHA-256（未写入或运行附件）：raw `0ac5dee38c3e7708b1f39df0e4711e4eaf737fd63cd4235a333a442df98629be`；Release `e9a77038aefff979fcd9124ef88e0ff5b462ce6c688ca9e4a38807c7e3faeef7`。这只是当前收到的样例字节指纹，未对照厂商受信签名，不能充当来源认证或 Nevix 摘要验收。

可复查命令（先将 `probe_url` 设置为上面的 raw 或 Release URL）：

```sh
curl -q --noproxy '*' --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 45 -sS -IL "$probe_url"
curl -q --noproxy '*' --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 45 -sS -L -D - -o /dev/null \
  -w 'status=%{http_code} bytes=%{size_download} tls=%{ssl_verify_result} redirects=%{num_redirects}\n' \
  "$probe_url"
# 对上一条 GET 增加 --range 0-31，验证最终 206 与 Content-Range。
curl -q --noproxy '*' --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 45 --fail -sS -L "$probe_url" | shasum -a 256
# 哈希步骤还需确认 curl 退出成功，避免把截断字节的哈希当作完整文件。
```

已使用 Context7 `library` 解析 CNB，再 `docs /websites/cnb_cool_zh` 查询额度/附件规则；其摘要只提供概述，数值及协议行为以随后核对的官方原文、Swagger 和 curl 实验为准。

## 当前网络大附件及一次失败重试

2026-10-09 07:10–07:12 UTC，使用同一 `en0` 连接与明确无 curl 代理的 HTTPS 请求，完整读取 [CNB 公开 Kasm Release V01](https://cnb.cool/gem/kasmweb/-/releases/tag/V01) 的 Linux amd64 镜像归档：

`https://cnb.cool/gem/kasmweb/-/releases/download/V01/kasm_release_network_plugin_images_amd64_1.18.1.tar.gz`

这是第三方 Kasm 网络插件镜像归档，**不是 Nevix 后端归档、不是官方 Nevix 制品，也不是桌面 Electron 包**；没有解压、运行或导入镜像。网页附件元数据与 HEAD 都记录 160,043,141 bytes（约 152.6 MiB）。结果仅证明当前连接可以匿名完整读取一个超过 100 MB 的 CNB Release 附件，不能代替 ticket 的实际 Nevix 制品验收。

| 操作            | 实测结果                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD            | 200，Content-Length 160043141                                                                                                                                                                         |
| 单段 Range 0-31 | cnb.cool 302 → asset.cnb.cool 206，32 bytes，Content-Range `bytes 0-31/160043141`                                                                                                                     |
| 首次完整 GET    | curl exit 0，160043141 bytes，30.588 秒，无错误输出；SHA-256 `2eca9c97875a7227f9f116ba0374189f8b0cb2e932a75acfe7cb9b5befd4fce6`                                                                       |
| 有限失败重试    | 同一稳定 URL 使用 `--max-time 0.001` 注入超时：exit 28、0 bytes；只重试一次，从稳定 URL 重取临时跳转，`--max-time 120` 全量 GET 成功：exit 0、160043141 bytes、两次合计 30.236 秒，SHA-256 与首次相同 |
| TLS/授权        | 所有请求限制 `--proto '=https' --proto-redir '=https'`，使用系统证书验证，无 `-k`、凭据或 Cookie；不转发业务身份                                                                                      |

首次完整 GET 参数为 `--max-time 240 --retry 1 --retry-max-time 260`，此次没有触发 curl 自带重试；强制超时后的重试另行执行，总预算 121 秒、最多一次。哈希通过 Python `hashlib.sha256` 对 curl stdout 分块累计，并单独检查进程退出码和完整字节数；两次完整 GET 的哈希相同，只证明该样例重复读取一致，没有发行方受信签名校验。此次没有验证 CNB 上传失败、429、过期链接或安装器自身重试。

可复查全量命令（在 bash/zsh 中执行，避免管道隐藏 curl 失败；仍需核对字节数）：

```sh
set -o pipefail
probe_url='https://cnb.cool/gem/kasmweb/-/releases/download/V01/kasm_release_network_plugin_images_amd64_1.18.1.tar.gz'
curl -q --noproxy '*' --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 --fail -sS -L "$probe_url" | shasum -a 256
# 超时注入：同一 GET 改为 --max-time 0.001；确认 exit 28 后仅重试一次上面的完整 GET。
```

## 真正外部实验的材料与验收记录

在请求外部写入批准前备齐：仅成品的独立 CNB 实验仓库拟定 slug 与公开文件清单；明确实验 Release/tag；Windows x64 NSIS、macOS arm64 DMG/ZIP 的真实 Nevix 构建；明确标注试验的 Linux x64 后端大归档（说明包含什么、实际大小、尚非最终正式包）；全部包的受信测试公钥、确切签名负载、SHA-256/字节数、本地备份；目标组织用量/无付费预算记录；永久保留及禁止覆盖配置的有效证据；仅受控上传端使用的最小权限凭据来源，不能记录凭据值。不得上传源码、源映射、私钥、token、`.env` 或客户资料。

创建真实仓库、写入凭据或上传的动作须按 [delivery.md](../../docs/agents/delivery.md) 授权门逐项判断；当前只准备材料，尚未请求或执行这些动作。先确认所有附件匿名可读并校验，再推进实验 raw 清单；正式后端包必须在最终发行上线验收另行验证。

本次按用户调整仅要求当前大陆网络，对签名 raw 清单、Windows 包、Mac 安装/更新包及后端实验归档分别记录。原规格的三网范围保留为历史要求，不作为此次必须完成的环境矩阵。实际大包记录足够的总超时和有限重试策略，每次实验限制在 5 分钟以内。中断后从稳定版本入口重新获取跳转，按签名大小/摘要验证完整文件；Range 0-31 只是协议探测，不能替代完整下载。

| 日期/地区/运营商                                       | 设备/系统、无代理/VPN证明                                | 对象/版本/稳定 URL             | 签名验证/预期 bytes/SHA-256 | GET/HEAD/每跳主机/TLS                      | Range 内容与状态  | 完整 bytes/SHA-256/耗时    | 故障/重试/结果                  |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------ | ----------------- | -------------------------- | ------------------------------- |
| 2026-10-09；用户确认当前大陆网络，运营商/WAN地区未确认 | macOS 26.6.2/en0；curl --noproxy，系统代理/VPN状态见上文 | 第三方 Kasm V01 样例，非 Nevix | 无受信签名；160043141 bytes | HEAD 200、GET 302→asset 200、HTTPS验证开启 | 0-31→206/32 bytes | SHA-256/两次全量结果见上文 | 超时 exit 28 后一次完整重试成功 |
| 当前大陆网络：真实 Nevix 清单/Windows/Mac/后端实验包   | 同上，测试前复核                                         | 逐对象记录，待备齐             | 待测                        | 待测                                       | 待测              | 待测                       | 待测                            |

## 对应 #340 的 QA 状态

- [ ] **公开 raw 清单及版本附件协议**：官方样例 GET/HEAD/TLS/跨主机/单段 Range 已实测；尚没有实际实验签名清单及 Nevix 附件，原验收项保留未勾选。
- [ ] **当前大陆网络实际制品（用户授权替代原三网要求）**：当前连接的 160 MB 公开样例完整下载及一次超时重试已通过；真实 Nevix 制品完整下载和受信摘要记录仍待测，样例不是该条通过证据。
- [ ] **免费额度、保留、大小和重试**：当前公开额度和大小规则已核对；目标组织额度、永久保留值及真实失败重试待补证。未绑定预算或公开敏感资料，原复合验收项保留未勾选。

三网不在本次用户调整后的验收范围；未完成真实 Nevix 制品、上传失败或永久保留实验。当前公开大附件成功不能证明 Nevix 安装更新或后端交付，免费平台限制仍可变化。
