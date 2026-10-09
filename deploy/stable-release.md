# Stable 发行：准备、验收、最后发布

实现 #349 / [ADR-0026](../docs/adr/0026-networked-release-and-private-deployment-updates.md)。
发布 seam 是 `publish-stable.mjs`：厂商读本地四份完整制品和已签清单，先构建、签名、
创建 draft、上传、确认永久附件、正式化、匿名验收，最后向独立 CNB 成品 Git 仓库
做一次普通 fast-forward commit。客户只访问公开 raw 和版本附件，不调用认证 API。
这个流程不构成 CNB 多资源事务：正式 Release 已创建后失败会留下版本附件，stable
仍指旧版本；最后 push 的应答或 CDN 校验失败可能已经发布，必须先核对确切 commit。
不自动删除、不覆盖、不把失败理解成数据库或远端回滚。

当前上线状态：**代码与隔离协议演练可审查，正式发行尚未授权/验收**。生产公钥仍为空，
CLI 明确拒绝发行。#340 的临时身份和附件只证明早期可行性，不能填本表的最终证据。

## 固定输入与首次配置

仅正式 `vMAJOR.MINOR.PATCH` 标签触发 `.github/workflows/stable-release.yml`，普通
push 不触发。标签去掉 `v` 必须等于已提交 Desktop package version；所有版本分量
符合 [精确签名合同](../contracts/release-v1.md)。每个构建取同一个标签 source commit。
仅 Windows x64 NSIS、Apple Silicon DMG/ZIP、Linux amd64 完整后端包四份文件；后端
包包含 Go 工具、四份实际镜像、Compose 和配置。公开 CNB 不接收 GitHub source
commit、源码、供应商私钥/token 或客户资料。分发 Git checkout 只允许 README、四份
stable 清单和逐版本清单，独立 clone，没有 product checkout 的 Git 对象或 alternates。

正式标签前完成以下具体配置；这些高风险动作须按
[delivery 授权门](../docs/agents/delivery.md)逐项获得授权后执行：

1. 创建 Ed25519 密钥并加密保存；将同一个公共 PEM 提交、review 后编译进 Desktop
   `RELEASE_PUBLIC_KEY_PEM` 和 Go `release.PublicKeyPEM`（运维工具复用 Go）。CLI 检查
   两侧完全一致，不接受 env/source/实验 key fallback。恢复离线加密备份并在隔离环境
   验证签名，厂商保留每次真实二进制和清单的本地副本。
2. 保留固定 Mac 自签证书和私钥。配置厂商 Apple Silicon `nevix-release` self-hosted
   runner，其专用受保护 keychain 已解锁、已在 user search list；固定证书 SHA1。发行
   脚本不创建证书、不改搜索列表、信任、Gatekeeper 或 SIP。参见
   [Mac 完整客户端方案](../scripts/release-feasibility/mac-integrated-proposal.md)。
   固定 App ID `com.nevix.ai`；自签不是 Developer ID、公证或无提示安装保证。
3. GitHub 源码现为公开；获授权后落实私有策略，检查 Actions 免费分钟/存储和零成本
   停止策略。身份检查拒绝公开 source repository。CNB organization 不绑定付费预算；
   仅用真实 whole-org FREE 额度，不使用含优惠/付费的 `total`。配额读取无法预留额度，
   同 organization 的其他使用者仍可能竞争；超限停止，不自动买、不清历史版本。
4. GitHub Free 私库没有 required environment reviewer，而且 private environment secrets
   需要付费计划，不能把 environment 名称当成正式审批门。
   [当前 GitHub 官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
   （2026-10-09 核对）要求 Free/Pro/Team 的 required reviewer 仅用于 public repo。
   因此本 workflow 做 tag 构建并在专用厂商 runner 用预配置受保护的加密 Ed25519 key
   签四份清单，**没有 CNB publish job**。正式 tag 创建前人工批准 source commit 和
   签名动作；这项审批靠 delivery 纪律，不声称免费私库提供受保护环境审批。runner
   与生产 key 尚未配置，本次没有安装/改系统。私钥文件不上传 GitHub/CNB；GitHub Free
   支持普通 repository secret，可存解密 passphrase，不需付费 environment secret。
   下载对应 run 的四份文件及 stable-signed、retain 本地副本，验收并取得当次人工审批
   后，使用同一个 publisher 的厂商受控本地 `publish`。不要另加自动 CNB publish job。
5. repo vars：`NEVIX_MAC_SIGNING_SHA1`、`NEVIX_MAC_SIGNING_KEYCHAIN`（厂商 self-hosted
   runner 中已受保护的身份路径，不含密码）；`NEVIX_MIN_SERVER_VERSION`、
   `NEVIX_MIN_DESKTOP_VERSION`、`NEVIX_RELEASE_PRIVATE_KEY_FILE`（专用 runner 的 repo
   外部 0600 加密 PEM 路径）。repository secret：`NEVIX_RELEASE_KEY_PASSPHRASE`。
   创建正式 tag 将触发 Mac 原生签名和 Ed25519 签名，tag 动作本身须审批。
6. Ed25519 加密 PKCS#8 PEM 只在厂商受控 signer（专用 self-hosted runner 或本地）环境。
   `NEVIX_CNB_TOKEN` 只在人工批准后的厂商本地 publisher 环境。CNB token 仅此 release repo 的 repo-release:rw、
   repo-code:rw，加 root organization `group-resource:r` 读取配额，不授支付写权限。
   下述 attestation 写入本地 plan，不把 token/密码放 JSON。

CNB metadata API 仍要求厂商 Bearer；临时 upload/confirmation URL 只在内存中，PUT
不携带 Bearer。显式 `overwrite:false`、upload ttl=0、confirmation ttl=0；只有成功确认
才记录永久回执。CNB 没有 WORM 或永久服务承诺，管理权限仍可能删除附件。
使用当前 [官方 Swagger](https://api.cnb.cool/swagger.json) 的端点，不推测 commit API。

## 受控本地准备与正式动作

需要厂商 Node 22（`--experimental-strip-types`）、Git 和已完成构建的四份文件；客户
实例仅需要 Docker/Compose，不需要 Node。`prepare` 只写本地全新目录、不访问网络：

```sh
umask 077
# 在受控目录创建 0600 signing-input.json；密码只经受保护环境输入。
node --experimental-strip-types deploy/publish-stable.mjs prepare signing-input.json
# review 四份清单、精确二进制 hash、全部证据及下面的 attestation。
chmod 600 signed/plan.json # downloaded Actions artifact permissions are not preserved
# 在正式发布即刻取得授权后，才运行此行：
node --experimental-strip-types deploy/publish-stable.mjs publish signed/plan.json
```

从已审 source commit 的 tag workflow run 下载四个 artifacts（stable-windows、stable-mac、
stable-server、stable-signed），二进制合并到厂商本地 `artifacts/`，signed 文件放 `signed/`，
保留原文件；不要用其它 run 或重打包样例。Actions 已签时无需重新 prepare；若人工本地
重新签名，仍只能用同一个 prepare 命令、同一受信 key 和已审同一字节。
记录 run ID、source SHA 及每份摘要。运行 `prepare` 后，edit 0600 `signed/plan.json` 添加
经 owner 审查的 attestation。确认本地签名制品和最终平台/三网证据完成后才申请当次
publish 授权；审批并非环境布尔配置可以自动替代。

`signing-input.json` 字段：`version`、`min_server_version`、`min_desktop_version`、
`private_key_file`（0600 加密 PEM）、`output_directory`（必须不存在）、`artifacts`
（keys 恰好四个 target：win32-x64、darwin-arm64、darwin-arm64-dmg、linux-amd64，
values 为本地文件路径）。设置保护环境 `NEVIX_RELEASE_KEY_PASSPHRASE`，签完清除。
`publish` 的 `NEVIX_CNB_TOKEN` 只在受控环境中；Git 使用临时 askpass 文件，token 不进
URL/argv/config/log。输入 plan.json 必须是 0600 普通文件；保留在厂商本地归档。

publisher 不支持盲目重试同 tag；tag/Release 已存在即停止，人工检查已有 draft、附件、
永久确认回执和 signed hashes，重新 review 恢复步骤。最后 push 前 fsync 记录预期新 commit/原 parent，网络失联也可核对；每次成功确认 fsync 写私有
`plan.json.journal.jsonl`；成功另存无秘密 receipt。既有 journal 不覆盖。遇到 push
应答不明先 `git ls-remote` 核对：预期新 SHA 表示已发布，原 SHA 表示未发布，其他 SHA
表示另一 job 已改渠道，必须重新完整审查。旧 job 的 ordinary FF push 不可能替换新
sibling commit；equal/older numeric stable version 在 draft 前拒绝。

## 发行前验收记录（全部必填）

plan 的 `attestation` 示例（实际摘要不得使用示例占位）：

```json
{
  "version": "1.2.3",
  "checked_at": "2026-10-09T00:00:00Z",
  "sha512": {
    "win32-x64": "<final NSIS SHA512 base64>",
    "darwin-arm64": "<final ZIP SHA512 base64>",
    "darwin-arm64-dmg": "<final DMG SHA512 base64>",
    "linux-amd64": "<final full bundle SHA512 base64>"
  },
  "source_private": true,
  "no_paid_binding": true,
  "github_zero_cost_stop": true,
  "offline_key_restore_verified": true,
  "local_artifacts_retained": true,
  "final_platform_acceptance": true,
  "three_carriers_verified": true,
  "bridge_verified": true,
  "evidence": "<reviewed issue/checklist with exact source commit, run IDs and approval>"
}
```

时间必须是发布前 24 小时内，version 和每份实际 SHA512 完全匹配；缺项拒绝。
以下证据由 owner review，不把布尔 JSON 当成自动检测的事实：

| 要求                | 最终真实证据                                                                                                              | 当前状态                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 密钥和固定 Mac 证书 | 公钥指纹、证书 SHA1、离线恢复证明；不记录秘密                                                                             | 待配置/授权                                        |
| 私有源码/免费额度   | GitHub privacy、免费 Actions 剩余额度/零成本停止；CNB whole-org quota/volume、未绑定付费的当日 UI owner 记录              | 待落实；不宣称源码已私有                           |
| Windows 完整客户端  | 真实旧 NSIS 到新 NSIS，同路径重启，Settings 状态保存/丢弃/取消、普通退出不安装、错误清单/架构/缓存                        | isolated Main/Window NSIS 已过；最终全客户端待验收 |
| Mac 完整签名客户端  | 旧/新 com.nevix.ai、相同 certificate requirement、首次放行、真实 Squirrel 更新及相同退出门                                | 库/源码门已过；最终签名实机待验收                  |
| Server 实例         | 原生 Linux x64 空库且无网络 pull，真实排队任务排空，业务/角色/客户配置/TLS/key 保留；备份、迁移、健康失败与完整恢复       | 见当前 CI/native receipts；最终发行包需重新核对    |
| 两侧兼容            | 最新不兼容保留 Desktop；Server 先升级，再下载/安装兼容 Desktop；不可达/未知 Server 不安装                                 | 单元/E2E 基础证据；最终跨版本待验收                |
| 大陆三网            | 电信/联通/移动各记录时间、网络、无代理、四清单+四完整文件、size/hash、TLS、redirect、HEAD/GET/Range、失败后从稳定入口重试 | 全部最终制品待三网验收；#340 单网豁免不适用        |
| 桥接迁移            | 两个隔离 source，旧入口保留的受信 bridge、新客户端新入口；未迁移旧客户端仍更新；同 Mac 身份或真实签名桥接                 | 协议隔离验证；真实平台桥接待验收                   |
| 本仓库 gate/review  | 同一 source commit 的 make check/harness、真库/native/E2E 和两轴 review 全绿                                              | 整合 PR 记录；最终标签需对应已审 commit            |

实际三网验证要针对将发布的同一字节。stable 未推进前，可以使用获明确授权的隔离
验收仓库/版本附件；该远端演练本身也要授权，不能先写客户 stable 来取得前置证明。
Publisher 自己的匿名双次 full GET、HEAD、Range 和 raw read 是厂商当前网络补充检查，
不代替三网、签名平台、完整实例的验收。

## 旧/新源迁移演练与恢复限制

先准备两个隔离源及同一受信 Ed25519 公钥；旧入口发布受信 bridge 版本，其实际
客户端编译新的固定 source（不是未经签名的 runtime env URL/key），新 source
承载后续受信制品。保留旧 source 的清单和 bridge，验证尚未迁移的旧客户端仍能检测
和安装 bridge，然后新客户端能检测后续版本。记录两侧真实 hashes、安装路径和连接
客户 Server 的兼容证明，不同步覆写旧入口来模拟迁移成功。Mac 保持签名身份；换为
Developer ID 或新证书时必须单独实测签名桥接，不能跳过 Squirrel requirement。
旧源已失效时无法自动救回没迁移客户端，只能从厂商保留的离线制品人工安装/部署。
当前隔离 publisher 测试验证受信入口保留和异 key 拒绝；真实桥接跨平台安装仍在表中。
