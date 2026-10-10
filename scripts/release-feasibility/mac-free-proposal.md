# #340 免费 Mac 方案：已批准的隔离实验

状态：用户已批准“仅限上述隔离实验”，正在执行和独立验收；以下内容保留为审批范围。依据见 [免费发行研究](mac-free-research.md)，原失败见 [Mac 实验](mac-evidence.md)。不接受 ADR-0026，不修改正式 Desktop 配置。

## 推荐实验

在 `.scratch/340-release-feasibility/` 复制当前 `apps/desktop/build/entitlements.mac.plist`，仅增加：

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

继续使用 Electron 39.8.10、builder 26.15.3、实验 updater 6.8.9、`com.nevix.ai`，保留 hardened runtime 和当前三项 JIT/DYLD entitlement。该例外只用于隔离实验 app 及 Helpers 的签名；正式 entitlement 文件不变。不关闭 Gatekeeper、不移除 quarantine、不使用 `spctl --master-disable`、SIP 修改或 ad-hoc 代替稳定自签身份。

原实验在 Electron Main 前被 dyld 以 `different Team IDs` 拒绝。Apple 的 library validation 默认只允许 Apple 或与主程序相同 Team ID 的库；没有 Apple Team ID 的自签身份需要另行验证这种例外是否能启动及完成更新。[Apple entitlement 文档](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)

**实际保护变化：** 被这样签名的进程可加载其他团队签名甚至未签名的 framework/plugin。它减少防止动态库注入的保护；发行清单签名与 Squirrel 更新包校验不能抵消这一运行时变化。当前已有 `allow-dyld-environment-variables`，因此不能把新增例外描述为没有安全影响。是否用于正式发行需要单独确认和 ADR。

## 获批后执行范围

1. 创建新的短期实验自签身份及隔离 keychain；只临时加入用户 keychain 搜索列表，结束后恢复并删除 keychain/私钥。不给新证书添加用户或系统信任，不使用生产证书。之前的私钥已删除，不能承诺复用之前的叶证书身份。
2. 同一新叶证书签旧版和新版实验 app，记录指纹、designated requirement、entitlement 和严格签名验证。基线失败包保留，不覆盖其证据。
3. 从 DMG 安装至 scratch，使用真实 MacUpdater/Squirrel：普通退出、稍后、重启且未批准时保持旧版；明确批准后真实替换并从同一安装路径启动新版；第三种不连续签名身份必须被拒绝。Ed25519、实际 metadata 绑定、缓存大小/摘要检查仍在安装前执行。
4. 首次 Gatekeeper 放行只使用系统提供的用户明确确认入口；不能以删除 quarantine 充当此项通过证据。企业策略不允许放行时记录阻断。需要真实隔离文件来源及用户系统操作时再记录对应审批。
5. 最小更新实验通过后，使用同一已批准的**实验**签名配置构建当前完整 Desktop 的 arm64 DMG/ZIP，供 CNB 分发下载验收；完整客户端目前没有正式 updater，不能把这个包标记为已实现自动更新。
6. 清理临时身份、恢复 keychain 搜索列表，由独立 QA 回填 #340；失败则停止，不继续放宽其他保护。CNB 上传仍需单独审核公开文件清单。

## 备选与停止条件

关闭 hardened runtime 会减少更多保护，当前不建议，也不执行。ad-hoc/unsigned DMG 可以作为某些项目的人工安装发行方式，但不能据此满足本规格的稳定自签/Squirrel 自动更新门。Sparkle 自有 Ed25519 更新是另一条研究候选，需要新增原生框架及独立架构决定，当前不实现。

此方案只请求一次有限实验，不保证解决 Gatekeeper、公证、企业设备策略或跨版本更新。本次批准仅覆盖上述隔离范围，正式采用或新增例外仍须另行给出具体方案。
