# #340 CNB 真实公开分发验收

2026-10-09，用户审核八文件白名单后批准公开仓库并上传。实际目标：[nevix.ai/nevix-releases](https://cnb.cool/nevix.ai/nevix-releases)。专门 QA 子代理独立完成两阶段匿名验收，CNB 三项均 PASS；结合已经记录的 Mac/Windows 实验，#340 九项实验验收满足。此证据不接受 ADR-0026，不启用正式 updater 或部署。

## 实际公开内容

实验 Release/tag：`experiment-340-20261009`，ID `2108531465831223296`。API 回读 `draft:false`、`prerelease:true`、`is_latest:false`；tag 精确指向仅 README 的初始提交 `218c3a4b30d0775fb5d11e47880dd5ffa7917093`。创建响应的附件字段不能直接作为最终列表；随后 GET Release 回读并核验四件闭集及服务端摘要。

先在私有仓库上传四件，逐件成功确认；GUI 将这一个成品仓库改为公开并回读成功。匿名附件验收通过后，才在独立 Git 检出提交三个 catalog 文件。最终公开 main 为 `767935bfaf90ae09b01b18043f1362dd5a8f4e0e`，没有给 Nevix 源码检出添加 CNB remote。

| 附件                                                  |     bytes | SHA-256                                                          |
| ----------------------------------------------------- | --------: | ---------------------------------------------------------------- |
| Nevix-AI-EXPERIMENTAL-0.1.0-windows-x64-setup.exe     | 102371106 | e972558be8532f92c5c08c0fabb8784cc98cbdf2522fabbc0af3d08fd5470665 |
| Nevix-AI-EXPERIMENTAL-0.1.0-arm64.dmg                 | 122355813 | 1aeaea3f072716a80c2951667726d1404f149d37ce47492636907f57e0092615 |
| Nevix-AI-EXPERIMENTAL-0.1.0-arm64.zip                 | 122316926 | b36991e93ea5eb43c3ebe4e805d0982fee8ea65fc96c01e6f5242e516ecb211c |
| nevix-backend-EXPERIMENTAL-linux-amd64-6f81e33.tar.gz | 139659351 | b60fab884cc862edafe0e48499e1a6f096ae948eaad80b1f58b2bd7fe4c80ab9 |

合计 486703196 bytes（约 464.2 MiB）。包平台、构建输入及内容检查沿用[已审核白名单](cnb-upload-review.md)、[Mac 实验证据](mac-library-validation-evidence.md)、[后端实验包证据](backend-artifact-evidence.md)，上传后实际全量字节再由独立 QA 核对。

公开 Git 文件恰四个，QA 匿名浅克隆实际 main，递归核验均为 `100644` blob、名称闭集及逐 blob 原始字节；没有 checkout 或执行下载内容：

| Git 文件                                | bytes | SHA-256                                                          |
| --------------------------------------- | ----: | ---------------------------------------------------------------- |
| README.md                               |  2127 | bb1d5e492658bdaa3070f7f409850ca1cb5f207849aa75085fc0ee33c7e1d294 |
| experiments/340/files.json              |  2600 | a394772286ec8115d0d982f301fa88f496bb3e0a50414f2a0c222ce6f22e044a |
| experiments/340/files.json.sig          |    89 | e4977922f927c3515a1db75f29260b0049b4b81bed6892eb87bb44e823eedf8f |
| experiments/340/release-test-public.pem |   113 | 2b1cc853c0a5381efa7dc89218ea4e0bbacd53aceb8862ae9125d7c7d9ae05bf |

[确切签名 catalog](https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/767935bfaf90ae09b01b18043f1362dd5a8f4e0e/experiments/340/files.json)含四个固定 HTTPS 版本附件 URL、size、SHA-256/SHA-512 与输入 commit。已审核的公钥文件指纹如上，不能信任源同时返回的任意替换公钥。QA 对原始 JSON 字节真实 Ed25519 验证通过，篡改拒绝；未改写此前已签名的 `urlsStatus` 准备阶段字段，实际存在性由后续远程验收证明。实验 catalog 不是正式发布合同或生产信任锚。

## 独立匿名协议与完整下载

设备沿用本机 macOS 26.6.2/arm64、curl 8.7.1。用户明确同意当前大陆环境替代原三网矩阵；测试采用 `curl -q --noproxy '*'`、仅 HTTPS、系统 TLS 校验，不含 Authorization/Cookie，不改变代理或 VPN 配置，也不声称独立证明运营商或排除系统隧道。临时重定向 URL 仅经 stdin 传给 curl，不进入 argv/报告。

- 第一阶段 `assets-only`：12:18:31–12:20:33 UTC，仅四附件及 README，不提前请求尚未发布的三个 raw 文件。
- 第二阶段 `raw-only`：12:21:56–12:21:58 UTC，匿名 Git 四文件闭集及四 raw；不重复下载大包。两阶段组合判定 PASS，单阶段不能冒充整体完成。

| 对象                        | HEAD                                  | 完整 GET                                                                  | TLS                                      | 单段 Range                                                                                  |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| 四个实际附件，各自独立      | 200，Content-Length 等于各自签名 size | cnb.cool 302 → asset.cnb.cool 200；各自完整 size、SHA-256、SHA-512 全匹配 | 每跳 TLSv1.3，证书验证成功，无 HTTP 降级 | cnb.cool 302 → asset.cnb.cool 206；各自 `bytes 0-31/<size>`，确切 32 bytes 匹配本地已审核包 |
| 四个公开 raw 文件，各自独立 | 200                                   | 200，无跨主机跳转；逐文件 exact bytes 匹配                                | TLSv1.3、证书验证成功                    | 小清单使用全量 GET，不依赖 raw Range                                                        |

对实际后端归档注入有限传输超时，得到 curl exit 28；只从稳定版本入口重新取得跳转并完整下载一次，139659351 bytes 及双摘要再次匹配。首次 Windows 请求曾 exit 56，随后从稳定入口一次 fresh 重跑通过；历史失败保留，不因此重上传或隐藏波动。Range 探针允许中间 302 页面上限 64 KiB，最终仍严格要求 206/32 bytes/确切内容；不能用 32-byte 限额错误拒绝入口重定向正文。

临时下载和匿名 Git 克隆目录均清理；没有运行安装包、导入镜像或启动客户环境。完整脱敏记录保留本机 `.scratch/340-release-feasibility/qa-followup-report.md`；上传收据在明确的 `cnb-upload-review/upload-result.redacted.json`，不公开原始响应、临时签名 URL 或凭据文件。

## 保留配置与边界

写入前重新核对组织未绑定预算，Git/对象存储显示各 0.00/基础 100 GiB，不依赖月底到期的活动额度。四个上传 URL 请求均 HTTP 201、正文显式 `ttl:0`、`overwrite:false`；四个 PUT 成功，四个确认请求均显式 query `ttl=0`、HTTP 200。附件名称、size 和服务端摘要回读匹配闭集。恢复预检只接受同仓库/tag/Release/文件的成功永久确认收据，没有证据则停止，不将既有有限 TTL 附件误报永久。

[官方 Swagger](https://api.cnb.cool/swagger.json) 定义确认参数 `ttl=0` 为永久，最大有限期 180 天。实际 API 的附件 metadata 没有独立 expiry 字段，因此结论是按合同成功设置，而非后台到期状态或无限时间留存已独立证明。没有倒计时不是补充证明。禁止本次覆盖不等于 WORM；[免费额度和账户回收条款](https://docs.cnb.cool/zh/saas/terms.html)仍适用，本地副本保留。最大真实文件约 139.7 MB，不把插件声明的更大上限当实测保证。

仅临时、指定此仓库的代码/Release 读写凭据用于上传与独立 Git 推送；本地凭据文件及临时 askpass 已清理，没有生产私钥或客户数据进入公开内容。CNB 上的临时令牌由用户删除或到期，不宣称已代为撤销。全部 helpers 位于忽略的 scratch，未改变正式 CI/运行配置。

Mac 未公证、首次需要人工 Gatekeeper 放行，且实验降低 library validation；完整 Mac 只做静态包验收。后端是真实四镜像实验归档，未验收正式离线部署、迁移、维护或恢复。CNB 下载通过不代替原生安装更新或正式发行上线验收，不改变已有 Mac/Windows 实验结论及限制。
