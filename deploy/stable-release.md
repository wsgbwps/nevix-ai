# Stable 发行：准备、验收、最后发布

实现 #349 / [ADR-0026](../docs/adr/0026-networked-release-and-private-deployment-updates.md)。
发布 seam 是 `publish-stable.mjs`：厂商读本地四份完整制品和已签清单，先构建、签名、
创建 draft、上传、确认永久附件、正式化、匿名验收，最后向独立 CNB 成品 Git 仓库
做一次普通 fast-forward commit。客户只访问公开 raw 和版本附件，不调用认证 API。
这个流程不构成 CNB 多资源事务：正式 Release 已创建后失败会留下版本附件，stable
仍指旧版本；最后 push 的应答或 CDN 校验失败可能已经发布，必须先核对确切 commit。
不自动删除、不覆盖、不把失败理解成数据库或远端回滚。

当前上线状态：**用户已批准继续实施，正式发行最终验收仍待完成**。首个正式版本选定
`1.0.1`；生产公钥与本地 Mac 签名身份已固定，hosted CI 构建与受控本地签名按下文执行。
原 `v1.0.0` 候选在正式包验收中因 canonical ASAR 含
`@babel/code-frame/lib/index.js.map` 被拒绝，未发布；既有标签保持原提交，不移动或覆盖。
修复后的制品重新使用 `v1.0.1` 构建、签名并验收，不继承旧候选的最终字节验收结论。
本次 hosted 构建另保留 `stable-server-baseline` 测试附件：运行源码固定为
`277b17138af8f6b9ca4dcdfca2cb4a8f32eac654` 的完整 Linux `0.1.0`。本机 Mac 旧测试基线
使用同一旧运行源码和当前 canonical 打包白名单。这些不是已发布的客户历史版本，
也不属于最终四制品；不新增 Windows 旧基线构建。
2026-10-10 用户已确认 GitHub 源码保持公开，
正式成品和签名更新清单仍发布到 CNB；源码私有不再是发行前置条件。#340 的临时身份
和附件只证明早期可行性，不能填本表的最终证据。

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
   两侧完全一致，不接受 env/source/实验 key fallback。记录离线加密备份及隔离恢复
   验证；owner 明确批准跳过恢复时按后文如实记录。厂商保留每次真实二进制和清单
   的本地副本。
2. 保留固定 Mac 自签证书和私钥，仅在厂商本地 Apple Silicon Mac 已准备、解锁且
   已在 user search list 的受保护 keychain 中使用，固定证书 SHA1。脚本不创建证书、
   不改搜索列表、信任、Gatekeeper 或 SIP。不把该身份接入公开仓库 self-hosted runner；
   本地只运行已批准、干净的精确正式标签 checkout。参见
   [Mac 完整客户端方案](../scripts/release-feasibility/mac-integrated-proposal.md)。
   固定 App ID `com.nevix.ai`；自签不是 Developer ID、公证或无提示安装保证。
3. GitHub 源码保持公开；检查实际 hosted Actions runner 的免费额度、存储和零成本
   停止策略，不以源码可见性决定是否允许发行。CNB organization 不绑定付费预算；
   仅用真实 whole-org FREE 额度，不使用含优惠/付费的 `total`。配额读取无法预留额度，
   同 organization 的其他使用者仍可能竞争；超限停止，不自动买、不清历史版本。
4. 正式 tag 创建前人工批准 source commit 和本地签名动作。workflow 只在 GitHub hosted
   runner 执行完整 gates 与 Windows/Linux 构建，**没有 Mac/Ed25519 signing 或 CNB publish
   job**，无需签名 Secrets、私钥路径或厂商 keychain；不依赖 environment 审批配置。
   gates 全部通过后，下载对应 run 的 stable-windows、stable-server；在同标签的干净
   本地 checkout 构建和签名 Mac DMG/ZIP，然后本地 `prepare` 签四份清单。保留全部
   精确字节及来源证据，验收并取得当次人工审批后，受控本地 `publish` 上传 CNB。
5. CI repo vars 只需公开兼容值：`NEVIX_MIN_DESKTOP_VERSION` 和
   `NEVIX_MIN_SOURCE_SERVER_VERSION`。首版分别为 `0.1.0`、`0.1.0`。后者是 Linux
   升级允许的最低来源 Server，不能以 Desktop 候选的最低运行 Server 替代。
   Desktop 的 `min_server_version` 在本地准备输入中声明，首版为 `1.0.0`；三个 Desktop
   清单须一致。四份清单的 `min_desktop_version` 须一致且等于后端编译声明。
6. Ed25519 加密 PKCS#8 PEM、解密 passphrase 和 Mac 签名身份只在厂商受控本地环境。
   本地 `NEVIX_MAC_SIGNING_SHA1`、`NEVIX_MAC_SIGNING_KEYCHAIN` 是固定证书指纹与
   已准备的 keychain 路径，不配置为 GitHub vars。`NEVIX_CNB_TOKEN` 只在人工批准后的
   厂商本地 publisher 环境。CNB token 仅此 release repo 的 repo-release:rw、repo-code:rw，
   加 root organization `group-resource:r` 读取配额，不授支付写权限。下述 attestation
   写入本地 plan，不把 token/密码放 JSON；签名材料不得进入源码、日志、artifacts 或成品。

CNB metadata API 仍要求厂商 Bearer；临时 upload/confirmation URL 只在内存中，PUT
不携带 Bearer。显式 `overwrite:false`、upload ttl=0、confirmation ttl=0；只有成功确认
才记录永久回执。CNB 没有 WORM 或永久服务承诺，管理权限仍可能删除附件。
使用当前 [官方 Swagger](https://api.cnb.cool/swagger.json) 的端点，不推测 commit API。

## 受控本地准备与正式动作

需要厂商 Node 22（`--experimental-strip-types`）、Git 和已完成构建的四份文件；客户
实例仅需要 Docker/Compose，不需要 Node。`prepare` 只写本地全新目录、不访问网络：

先核对该 tag run 的全部 gates、run ID 和 `headSha`；本地创建干净的精确标签 checkout。
下面在 repo root 执行；`RELEASE_SOURCE_SHA` 必须填该 run 的实际 source SHA：

```sh
umask 077
RELEASE_TAG=v1.0.1
RELEASE_SOURCE_SHA='<reviewed-tag-run-head-sha>'
RELEASE_BUILD_RUN='<successful-stable-workflow-run-id>'
test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$RELEASE_SOURCE_SHA"
git worktree add --detach .scratch/stable-1.0.1 "$RELEASE_TAG"
cd .scratch/stable-1.0.1
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE_SHA"
pnpm install --frozen-lockfile
# NEVIX_MAC_SIGNING_SHA1/KEYCHAIN 只经本地受控环境提供已有身份。
pnpm --filter @nevix/desktop build:mac:release
mkdir artifacts
gh run download "$RELEASE_BUILD_RUN" --name stable-windows --dir artifacts
gh run download "$RELEASE_BUILD_RUN" --name stable-server --dir artifacts
cp apps/desktop/dist/Nevix-AI-1.0.1.dmg artifacts/Nevix-AI-1.0.1.dmg
# 确认构建仅产出一个 arm64 ZIP，按发布名复制精确字节。
node --input-type=module -e 'import fs from "node:fs"; const files=fs.readdirSync("apps/desktop/dist").filter(x=>x.endsWith(".zip")); if(files.length!==1) throw Error("Expected one arm64 ZIP"); fs.copyFileSync("apps/desktop/dist/"+files[0],"artifacts/Nevix-AI-1.0.1-arm64.zip")'
test -z "$(git status --porcelain --untracked-files=no)"
# 在受控目录按下例创建 0600 signing-input.json；密码只经受保护环境输入。
node --experimental-strip-types deploy/publish-stable.mjs prepare signing-input.json
# review 四份清单、精确二进制 hash、全部证据及下面的 attestation。
# 在最终验收完成且正式发布即刻获得授权后，才运行此行：
node --experimental-strip-types deploy/publish-stable.mjs publish signed/plan.json
```

### 完整制品的原生验收

四份清单准备后，在同一 `v1.0.1` ref 手动运行 `Installed Desktop update`，选择
`mode=final`，传入成功的 stable build run ID，以及公开生产签名 Linux、
旧 Linux 基线 envelope JSON。不要传私钥、密码、token 或客户资料。
工作流拒绝不同 source SHA、未成功或非 stable 构建；下载该 run 的原始完整后端包，
使用只读 Actions 权限，不向 CNB 写入。旧 Linux 基线也必须经厂商本机签名，不能替换公钥。

- [Linux driver](scripts/final-offline-runtime.md)在原生 x64 的 classic/containerd
  两种隔离 daemon 中使用正式 CLI 验签、导入、安装与升级同一完整包，保留真实账号、Session、
  客户配置与卷。receipt 的 `missing_cases` 仍须逐项验收，不能把 covered-cases 成功当作全部通过。

按 owner 对 #349 的最新范围要求，后端用现有 Docker 回归与原生 Linux CI 验证部署、运行、
升级和数据保留；Mac 另行完成真实安装升级，不搭建 Linux 虚拟机，也不将两个环境合并声称
同一台实例的端到端证明。本机 Docker 服务端是 arm64，正式 CLI 要求 linux/amd64，
不得为本机测试放宽生产检查。完整 Windows 安装仍如实区分既有 NSIS fixture 证据。

大陆三网移至 [#352](https://github.com/wsgbwps/nevix-ai/issues/352)，真实跨源桥接移至
[#353](https://github.com/wsgbwps/nevix-ai/issues/353)，不阻塞 #349 本次最小范围收尾。
未验证项目保持未验证；关闭 #349 不表示已发布客户 stable 或已满足 publisher 的生产发布门。

保留原始 hosted artifacts、Mac 构建文件和本地 `signed/`；不要用其它 run、源码提交或
重打包样例。记录 run ID、tag/source SHA、Mac 固定证书指纹及每份摘要。`prepare` 后
编辑 0600 `signed/plan.json` 添加经 owner 审查的 attestation，完成本地签名制品、最终
平台/三网证据后才申请当次 publish 授权；审批不是环境布尔配置。

`signing-input.json` 必填字段如下（路径替换为实际受控路径）：

```json
{
  "version": "1.0.1",
  "min_server_version": "1.0.0",
  "min_source_server_version": "0.1.0",
  "min_desktop_version": "0.1.0",
  "private_key_file": "<outside-repo-0600-encrypted-pkcs8-pem>",
  "output_directory": "signed",
  "artifacts": {
    "win32-x64": "artifacts/Nevix-AI-1.0.1-setup.exe",
    "darwin-arm64": "artifacts/Nevix-AI-1.0.1-arm64.zip",
    "darwin-arm64-dmg": "artifacts/Nevix-AI-1.0.1.dmg",
    "linux-amd64": "artifacts/Nevix-server-1.0.1-linux-amd64.tar.gz"
  }
}
```

`output_directory` 必须不存在。`min_server_version` 只用于三个 Desktop 清单；
`min_source_server_version` 独立写入 Linux 清单的 `min_server_version`，含义是允许
升级的最低来源 Server。两者均严格验证稳定版本，缺失即拒绝。设置受保护环境
`NEVIX_RELEASE_KEY_PASSPHRASE`，签完清除。`publish` 的 `NEVIX_CNB_TOKEN` 只在
受控环境中；Git 使用临时 askpass 文件，token 不进 URL/argv/config/log。输入 plan.json
必须是 0600 普通文件；保留在厂商本地归档。

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
  "no_paid_binding": true,
  "github_zero_cost_stop": true,
  "offline_key_restore_verified": false,
  "offline_key_restore_skipped_by_owner": true,
  "local_artifacts_retained": true,
  "final_platform_acceptance": true,
  "three_carriers_verified": true,
  "bridge_verified": true,
  "evidence": "<reviewed issue/checklist with exact source commit, run IDs and approval>"
}
```

时间必须是发布前 24 小时内，version 和每份实际 SHA512 完全匹配；缺项拒绝。
离线恢复须如实记录：已验证时 `offline_key_restore_verified: true`，skip 字段省略或为
false；owner 明确批准跳过时，须同时填写 verified 为 false、
`offline_key_restore_skipped_by_owner: true`，并在 evidence 中引用其决定及已确认的备份。
缺失、非布尔值或两项同时为 true 均拒绝。skip 不表示已验证恢复，也不代替其他验收
或当次发行授权；密钥丢失后的备份可恢复性仍未经验证。
以下证据由 owner review，不把布尔 JSON 当成自动检测的事实：

| 要求                | 最终真实证据                                                                                                                   | 当前状态                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 密钥和固定 Mac 证书 | 公钥指纹、证书 SHA1、离线恢复证明；不记录秘密                                                                                  | 本机材料已验证，公钥已固定；备份由 owner 确认，恢复验证按 owner 要求跳过；仅本地签名                       |
| 公开源码/免费额度   | GitHub 源码保持公开；实际 Actions runner 免费额度、存储/零成本停止；CNB whole-org quota/volume、未绑定付费的当日 UI owner 记录 | owner 已接受公开 GitHub + CNB 成品方案；最终发行仍需当日额度证据                                           |
| Windows 完整客户端  | 真实旧 NSIS 到新 NSIS，同路径重启，Settings 状态保存/丢弃/取消、普通退出不安装、错误清单/架构/缓存                             | isolated Main/Window NSIS 已过；最终全客户端待验收                                                         |
| Mac 完整签名客户端  | 旧/新 com.nevix.ai、相同 certificate requirement、首次放行、真实 Squirrel 更新及相同退出门                                     | [完整隔离签名安装/升级已过](../scripts/release-feasibility/mac-integrated-evidence.md)；最终发行字节待验收 |
| Server 实例         | 原生 Linux x64 空库且无网络 pull，真实排队任务排空，业务/角色/客户配置/TLS/key 保留；备份、迁移、健康失败与完整恢复            | 见当前 CI/native receipts；最终发行包需重新核对                                                            |
| 两侧兼容            | 最新不兼容保留 Desktop；Server 先升级，再下载/安装兼容 Desktop；不可达/未知 Server 不安装                                      | 单元/E2E 基础证据；最终跨版本待验收                                                                        |
| 大陆三网            | 电信/联通/移动各记录时间、网络、无代理、四清单+四完整文件、size/hash、TLS、redirect、HEAD/GET/Range、失败后从稳定入口重试      | 全部最终制品待三网验收；#340 单网豁免不适用                                                                |
| 桥接迁移            | 两个隔离 source，旧入口保留的受信 bridge、新客户端新入口；未迁移旧客户端仍更新；同 Mac 身份或真实签名桥接                      | 协议隔离验证；真实平台桥接待验收                                                                           |
| 本仓库 gate/review  | 同一 source commit 的 make check/harness、真库/native/E2E 和两轴 review 全绿                                                   | 整合 PR 记录；最终标签需对应已审 commit                                                                    |

实际三网验证要针对将发布的同一字节。stable 未推进前，可以使用获明确授权的隔离
验收仓库/版本附件；该远端演练本身也要授权，不能先写客户 stable 来取得前置证明。
Publisher 自己的匿名双次 full GET、HEAD、Range 和 raw read 是厂商当前网络补充检查，
不代替三网、签名平台、完整实例的验收。

2026-10-10 #349 本地续验：真实已安装 Mac `0.1.343 → 0.1.344` 的更新及状态保留
见上表证据，升级后完整 Native Smoke 6/6 通过；这两版来自 `365869e0`，使用正式
Mac 证书和隔离测试 Ed25519/feed/profile，不能替代最终 stable 字节。
本地候选四份 DMG/ZIP 保留在
`.scratch/343-integrated-mac-20261010/{old,new}/apps/desktop/dist/`，对应摘要已记录；
尚无同一最终版号的 NSIS、DMG、ZIP、完整 Linux x64 包与生产签名清单发行副本。
只读核对时本地 HEAD 为 `a3b1c8f0`，远端草稿 PR #351 为 `365869e0`，没有 `v*`
标签、GitHub Release 或已注册 self-hosted runner。当前 owner 只能使用一种网络，
尚无最终相同字节的大陆三网证明。
本次本地续验 `make check` 通过（463 Desktop 单元、36 架构检查及 Go vet/test），
发行/交付 harness 89/89、Mac 签名输入检查 3/3 通过；owner skip 的正向和拒绝用例
先复现旧门冲突，再通过修正后的真实 publisher seam。以上是本地准备验证，
不能作为尚未固定的最终发行 source commit 的 CI/平台验收回执。

上述记录反映 2026-10-10 本地安装续验时的旧 source 状态。最新授权已允许继续实施
正式 tag 构建与受控本地签名，首版选定 `1.0.1`；不再接入专用 runner/Secrets。
#349 下一步是固定已审 source commit，完成同源 hosted Windows/Linux 构建、本地
Mac 签名与四制品清单，保留本地发行副本；再完成现有 Docker/原生 Linux CI 的后端
部署、运行、升级及数据保留与 Mac 真实安装升级，核对该 source 的 gate/review。
三网和跨源桥接分别跟踪 #352、#353，不阻塞本次 #349 收尾。
正式发行当日仍须核实免费额度、未绑定付费和零成本停止，并取得即时 publish 批准。
安装续验和恢复验证 skip 不替代最终验收；上述历史续验未发布或合并。

2026-10-10 签名材料：Ed25519 SPKI DER SHA256 `b4ef59eec33aca90f220418df0ee8922e424d0bac82730ddcb89b2b934dcfe6d`；固定 Mac 证书 SHA1 `3AFD38605AD783F0AF4FCA20AD8654EF6005EB12`，有效期至 2027-10-10 03:23:05 UTC。Desktop、Go Server 与运维工具使用相同内置公钥；测试身份不作为生产信任根。离线恢复未验证，不得填写 `offline_key_restore_verified: true`。

## 旧/新源迁移演练与恢复限制

先准备两个隔离源及同一受信 Ed25519 公钥；旧入口发布受信 bridge 版本，其实际
客户端编译新的固定 source（不是未经签名的 runtime env URL/key），新 source
承载后续受信制品。保留旧 source 的清单和 bridge，验证尚未迁移的旧客户端仍能检测
和安装 bridge，然后新客户端能检测后续版本。记录两侧真实 hashes、安装路径和连接
客户 Server 的兼容证明，不同步覆写旧入口来模拟迁移成功。Mac 保持签名身份；换为
Developer ID 或新证书时必须单独实测签名桥接，不能跳过 Squirrel requirement。
旧源已失效时无法自动救回没迁移客户端，只能从厂商保留的离线制品人工安装/部署。
当前隔离 publisher 测试验证受信入口保留和异 key 拒绝；真实桥接跨平台安装仍在表中。

2026-10-10 后续授权：owner 已批准继续实施并委托选择正式版号，首版使用 `1.0.1`。
公开个人仓库采用 hosted CI 完整 gates 与同源 Windows/Linux 构建、厂商本地干净 tag
checkout 的 Mac 固定身份构建，以及本地四制品 Ed25519 `prepare`，替代上面历史记录中的
专用 runner/Secrets 接入前置条件。这避免把现有厂商 keychain 与签名密钥接入公开 CI。
最终相同字节的四制品、跨版本升级、真实跨源桥接和三网证据仍须实际完成，不将此授权
记录当作验收证明。

The stable tag workflow checks out the exact tag commit for the delivery harness, complete Desktop CI (including both native smoke platforms) and complete Server CI (including both isolated Linux image stores). Hosted Windows and Linux artifact builds await all gates; the vendor waits for those gates before local Mac and envelope signing at the same tag. Linux bundle export uses the pinned Docker 29.4 OCI image store and the independent minimum source Server version. The stable workflow is the sole tag entry and has no signing keys, self-hosted jobs or automatic publishing; Desktop CI remains callable by PR checks and manual dispatch.
