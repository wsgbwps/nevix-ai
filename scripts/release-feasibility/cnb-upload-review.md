# #340 CNB 上传前最终审核

本页保留上传前审核快照；用户后续已批准并完成公开上传和匿名验收，见[最终真实证据](cnb-publication-evidence.md)。

上传前状态：真实制品和公开文件已备齐，独立 QA 已确认各包；未上传。目标 [nevix.ai/nevix-releases](https://cnb.cool/nevix.ai/nevix-releases) 当前私有、未初始化。以下审核包含将这个空成品仓库改为公开、初始化列出的文件和创建一次实验 Release；不迁移应用源码，不发布正式 stable/v\* 版本，不绑定预算。

## 审批目标与配额

- Release/tag：`experiment-340-20261009`，独立实验，不覆盖现有 tag/附件。
- 根代理只读核对 [目标组织用量](https://cnb.cool/nevix.ai/-/settings/charge)：2026-10 显示**尚未绑定预算**；Git 和对象存储均已用 `0.00 / 100.00 GiB`。不依赖 2026-10-31 到期的活动 1 TiB 配额。
- 四附件共 **486703196 bytes（约 464.2 MiB）**；全部本地备份保留。
- [官方 Swagger](https://api.cnb.cool/swagger.json) 的附件确认接口明确 `ttl=0` 为永久。上传正文显式 `ttl:0`、`overwrite:false`，确认 query 显式 `ttl=0`；后台到期字段上传后核对。禁止本次覆盖不等于 WORM，免费额度调整/超额回收仍可能影响留存。

## 四个真实附件：固定白名单

来源目录：[待上传附件](../../.scratch/340-release-feasibility/cnb-upload-review/public/attachments/)。只选这些文件，不上传其父目录或其他 scratch 文件。

| 文件                                                    |     bytes | SHA-256                                                            |
| ------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| `Nevix-AI-EXPERIMENTAL-0.1.0-windows-x64-setup.exe`     | 102371106 | `e972558be8532f92c5c08c0fabb8784cc98cbdf2522fabbc0af3d08fd5470665` |
| `Nevix-AI-EXPERIMENTAL-0.1.0-arm64.dmg`                 | 122355813 | `1aeaea3f072716a80c2951667726d1404f149d37ce47492636907f57e0092615` |
| `Nevix-AI-EXPERIMENTAL-0.1.0-arm64.zip`                 | 122316926 | `b36991e93ea5eb43c3ebe4e805d0982fee8ea65fc96c01e6f5242e516ecb211c` |
| `nevix-backend-EXPERIMENTAL-linux-amd64-6f81e33.tar.gz` | 139659351 | `b60fab884cc862edafe0e48499e1a6f096ae948eaad80b1f58b2bd7fe4c80ab9` |

每件 SHA-512、平台、输入 commit 和精确拟定 HTTPS 版本附件 URL 已写入 [files.json](../../.scratch/340-release-feasibility/cnb-upload-review/public/repository/experiments/340/files.json)。这些 URL 是固定上传目标，尚未声称远程文件存在。

Windows 来自成功的 [run 37911980787](https://github.com/wsgbwps/nevix-ai/actions/runs/37911980787)，输入 `c8a1fba5d88de68908bb0f3a1d8a4430d4bef5f7`；实际 x64 NSIS，5/5 packaged Native Smoke，通过独立内容 QA。原 Actions 文件名仅在候选附件外部改为 EXPERIMENTAL，字节未变。Mac 在同一输入 commit 复用获批临时自签/HRT/单 entitlement 例外，实际 arm64 DMG/ZIP 的严格签名、编译内容和摘要独立 QA 通过，见 [Mac 证据](mac-library-validation-evidence.md)。

两个完整客户端均为当前 `0.1.0`、当前打包 App ID `com.electron.app`，**没有正式 updater**；Main AppUserModelID `com.nevix.ai` 的正式对齐不在本轮实施。Windows 无 Authenticode、可能提示 SmartScreen。Mac 未公证，需人工首次系统放行；新增 library validation 例外真实减少动态库加载保护，不能把最小更新实验通过写成完整客户端已经实现自动更新。完整 Mac 仅静态包装验收，未启动业务 UI。

后端包含四个真实 Linux amd64 runtime 镜像及实验离线 Compose/运行配置，输入 `6f81e33aacbd214be35ea5ce71c51d12baf9f29e`；独立外包/内部摘要/层平台与内容 QA 通过，见 [后端证据](backend-artifact-evidence.md)。明确保留公开占位 `.env.example` 和运行 shell/config，不包含真实部署 env、客户数据库或源码检出；未验收离线 load/部署/迁移/恢复。

首个完整 Windows 包因原始 TS、内部文档和 map 被 QA 禁止上传；后两次重建分别因误选 npm、map 检查器误判失败。最终成功包只在实验配置中收紧白名单及修正检查，不修改正式 builder 或依赖；排除上游 README/CLI PEM 示例/debug map，保留正常 runtime 和 417 份 LICENSE/NOTICE。

## 四个公开 Git 文件：固定白名单

- [README.md](../../.scratch/340-release-feasibility/cnb-upload-review/public/repository/README.md)：实验用途与限制。
- [experiments/340/files.json](../../.scratch/340-release-feasibility/cnb-upload-review/public/repository/experiments/340/files.json)：四件制品的确切描述；实验分发 catalog，非正式发行/升级合同。
- [experiments/340/files.json.sig](../../.scratch/340-release-feasibility/cnb-upload-review/public/repository/experiments/340/files.json.sig)：对 JSON **原始字节**的 Ed25519 签名。
- [experiments/340/release-test-public.pem](../../.scratch/340-release-feasibility/cnb-upload-review/public/repository/experiments/340/release-test-public.pem)：实验公钥，不是生产信任锚。

Catalog SHA-256：`a394772286ec8115d0d982f301fa88f496bb3e0a50414f2a0c222ce6f22e044a`；公钥文件 SHA-256：`2b1cc853c0a5381efa7dc89218ea4e0bbacd53aceb8862ae9125d7c7d9ae05bf`。信任应固定到本地已审核公钥，不能把下载源同时返回的任意公钥当作可信。Ed 私钥仅在签名进程内存中存在；Mac 两个签名身份及磁盘私钥/keychain/密码均已清理并由 QA 核实。

不公开源码检出、原始应用 TS、map、真实 env/token/私钥/PKCS12、客户数据、日志、builder-effective-config、构建 context 或 blockmap。Electron 编译 JS 可提取，公开成品不等于源码无法逆向。

## 获准后的顺序与验收

只按上述八文件执行：初始化实验 README/Release，在当前余额仍足够且未绑定预算时上传四件、禁止覆盖并显式永久 TTL；公开仅含白名单的成品仓库；在用户授权的当前大陆网络匿名全量下载各附件，核对 HTTPS/每跳主机/GET/HEAD/单段 Range、字节摘要及有限超时重试；通过后才发布其余三个 raw 签名文件并匿名验证签名及附件绑定。若已有其他内容、额度不足、需付费预算或无法遵守保留/不覆盖配置，停止对应写入并说明变化。

审核时没有创建上传 token、写入 CNB 或接受额外协议；凭据只在受控端配置，不在聊天发送值。审核时 CNB 三项保持未完成，实际上传及匿名下载通过前不会勾选。后续已经按本页八文件范围执行，最新结果见上述最终证据。
