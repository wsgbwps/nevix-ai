# #340 Mac 免费发行方案调研

**结论（2026-10-09）：** GitHub 上的开源项目可以免费发布 DMG，但这不等于它们免费获得了 Gatekeeper 信任。受检的正式发行流水线分成两类：Apple Developer Program 的 Developer ID + 公证，或未获 Apple 信任的 unsigned/ad-hoc DMG，并要求用户绕过 quarantine。后者可作为 Nevix 的“首次由 User 在系统设置明确放行”方向的旁证，却不能证明现有 Electron 39 稳定自签 + Hardened Runtime 能启动或自动更新。

本报告只提出实验候选；没有改动签名、entitlement、Gatekeeper、系统信任或正式发行配置。

## 已有 Nevix 事实

| 事实                                                                                                                                                                                                                                         | 证据与含义                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正式打包配置的 `mac.notarize` 是 `false`，只给 inherited code 指定 entitlement。                                                                                                                                                             | [`apps/desktop/electron-builder.yml:32-41`](../../apps/desktop/electron-builder.yml)；不能把当前包说成 Developer ID 或已公证。                                                   |
| 当前 entitlement 有 `allow-jit`、`allow-unsigned-executable-memory` 和 `allow-dyld-environment-variables`，没有 `disable-library-validation`。                                                                                               | [`apps/desktop/build/entitlements.mac.plist:5-10`](../../apps/desktop/build/entitlements.mac.plist)。                                                                            |
| 隔离实验的旧/新包都由同一个自签叶证书签名，designated requirement 相同，且 `codesign --verify --deep --strict` 成功；启动仍在 Electron Main 之前被 `dyld` 以 `mapping process and mapped file (non-platform) have different Team IDs` 杀死。 | [`mac-evidence.md:14-29`](mac-evidence.md)。本机对实验主可执行文件与 Electron Framework 的 `codesign -dvvv` 都显示 `TeamIdentifier=not set`。                                    |
| ADR 要求的是稳定自签身份的真实旧版到新版 Squirrel 更新；首次安装可由 User 在系统设置放行，不能悄然退化为手工更新。                                                                                                                           | [ADR-0026:24](../../docs/adr/0026-networked-release-and-private-deployment-updates.md)、[ADR-0026:49](../../docs/adr/0026-networked-release-and-private-deployment-updates.md)。 |

这将问题分成两个独立门：**能否启动**由 Hardened Runtime / library validation 阻断；**能否更新**才由 Squirrel 的签名要求决定。Squirrel 的实现先从正在运行的 app 取得 designated requirement，再用该 requirement 严格验证下载 app 的 nested code；它并没有把“Developer ID”写成唯一接受条件。[Squirrel.Mac 源码（固定提交）](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLCodeSignature.m#L49-L114) 佐证这一点。因此，现有失败还**不能**得出“同一稳定自签身份不能更新”；它在运行 updater 前已经停止。

## Apple 平台事实

- Apple 的 [Developer ID 文档](https://developer.apple.com/help/glossary/developer-id-certificate/) 说明，Developer ID 用于 App Store 外分发，且只发给 Apple Developer Program 或 Enterprise Program 成员；[计划页](https://developer.apple.com/programs/) 列出的通常年费是 99 美元。这不等于每个组织必然实际付费：Apple 的 [fee waiver 规则](https://developer.apple.com/help/account/membership/fee-waivers/) 允许满足条件的非营利组织、认证教育机构或政府实体申请免年费。当前没有 Nevix 符合资格的证据，不能据此假定可用；免费 Apple Account 本身也不能产生这个公开分发身份。
- Apple 说明 [Hardened Runtime 默认启用 Library Validation](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.disable-library-validation)：可执行程序只能加载 Apple 签名或与主程序相同 Team ID 的 framework、plugin、library；`dyld` 会报告不同 Team ID。这个规则与本实验的原始错误一致，但它不是“加一个 entitlement 一定修复”的证明。
- 同一 Apple 文档还说明 `com.apple.security.cs.disable-library-validation=true` 可关闭这条限制，允许未签或任意签名的动态库/插件，并警告 Gatekeeper 会作额外检查。它是安全边界的实质性弱化。
- [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) 区分两件事：自签/自建 CA 可提供稳定 designated requirement，适用于一些更新识别；但 Gatekeeper 默认接受的是 Developer ID 或 Mac App Store 锚定的代码。TN2206 也要求从实际下载、带 quarantine 的 DMG 安装并测试，`codesign --verify` 本身不足以证明 Gatekeeper 放行。

## 开源项目怎样发行 DMG（固定源码快照）

| 项目与固定提交                                                                                                                                                             | 观察到的正式发布做法                                                                                                                                                                                                                                                                                                                                                                                                        | 分类                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [VS Code `a02d65e`](https://github.com/microsoft/vscode/blob/a02d65ec69571a3bda387227df19a88729a0bf85/build/azure-pipelines/darwin/steps/product-build-darwin-package.yml) | 发布管线将未签编译物交给 Sign job；该 job 从 Azure Key Vault 导入 `macos-developer-certificate`，签 Hardened Entitlements，再运行名为 “Codesign & Notarize” 的步骤，并在启动已签 app 后检查 timer 文件。[签名步骤](https://github.com/microsoft/vscode/blob/a02d65ec69571a3bda387227df19a88729a0bf85/build/azure-pipelines/darwin/steps/product-build-darwin-sign-local.yml)                                                | Apple 证书 + 公证的受管发布路径；源码不公开证书类别，不能仅因其开源而称为免费。                                                                             |
| [Joplin `cb2f658`](https://github.com/laurent22/joplin/blob/cb2f658b6c85e4fba8ebf37e1d1ef28779a3c7d4/.github/workflows/build-macos-m1.yml)                                 | tag 发行向构建传入 `APPLE_CSC_LINK` / 密码和 Apple ID 凭据；非 tag 构建明确关掉签名。其 [`afterSign`](https://github.com/laurent22/joplin/blob/cb2f658b6c85e4fba8ebf37e1d1ef28779a3c7d4/packages/app-desktop/tools/notarizeMacApp.ts) 用 `notarytool` 公证并 staple ticket。                                                                                                                                                | Apple Developer ID + 公证路径；“CI 可以不签”只适用于非发行构建，不能当作免费正式发行案例。是否实际付年费取决于其成员资格和可能的 fee waiver，源码没有披露。 |
| [MarkText `ce807d5`](https://github.com/marktext/marktext/blob/ce807d50ac128b2aecca3ef0b5cc0511db1baa3e/.github/workflows/release.yml)                                     | tag 发行在 macOS runner 直接构建并上传 `.dmg` / `.zip`；源码注释明确写 “unsigned (no Developer ID)”。发布说明要求用户拖到 Applications 后执行 `xattr -d com.apple.quarantine`。其 [builder 配置](https://github.com/marktext/marktext/blob/ce807d50ac128b2aecca3ef0b5cc0511db1baa3e/packages/desktop/electron-builder.yml) 设 `notarize: false`，并为 Electron fuse 修改后的 arm64 包设 `resetAdHocDarwinSignature: true`。 | **确切免费案例：unsigned / ad-hoc DMG**。它确实公开发布 DMG，却把用户侧 quarantine 移除作为发行说明；这不符合 Nevix ADR 的自动更新验收，不能照搬。          |

因此，“GitHub 开源软件如何发布 DMG”的直接答案是：常见项目把 Apple 证书和 notary 凭据放在 CI secret 中；不付费的项目则可以发 unsigned/ad-hoc DMG，但系统信任和用户体验由用户自行处理。源码可审计并不会替代 Apple 的分发身份。

## 可审批的免费候选

### 候选 A：只关闭 Library Validation，保留 Hardened Runtime（首选实验）

这是目前**最小、可证伪**的保护变更。只在新的隔离实验 entitlement 副本中加入：

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

其余合同保持：`hardenedRuntime: true`；现有 JIT、unsigned executable memory、DYLD 环境变量 entitlement 原样不动；本次实验以同一个新的短期自签身份签旧/新包，并在实验后清理；Squirrel 仍用当前 app 的 designated requirement 验证新 app；外层 Ed25519 manifest 验签、下载后大小/摘要校验与安装前复查全部保留。它不添加系统根信任、不关闭 Gatekeeper、不改成手工复制安装。若实验通过，正式发行所需的长期签名密钥管理必须另行审批，不能沿用这次实验身份。

代价必须明确接受：Library Validation 不再阻止运行中的 Nevix process 加载任意签名或未签名的 framework/plugin；Apple 还会对带该例外的 app 作额外 Gatekeeper 检查。现有 `allow-dyld-environment-variables` 已是动态加载面的例外，这个键会再扩大该面。该方案只能在用户审核后用于隔离实验，不能直接写入 `build/entitlements.mac.plist`。

批准后的实验判定步骤：

1. 仅在新的 `.scratch/340-release-feasibility/mac-library-validation/` 根目录生成实验 app、DMG、ZIP 和新的临时 keychain；不使用生产身份，也不添加证书信任。用同一身份构建 **`0.1.342` / `0.1.343`**，绝不覆盖现有失败证据 `0.1.340` / `0.1.341` 或其日志、字节记录。
2. 对主 app、helper 和 Electron Framework 记录 `codesign -dvvv`、`codesign -d --entitlements :-` 与 `codesign --verify --deep --strict`；确认唯一新增项就是该键。
3. 通过浏览器实际下载 DMG 以保留 quarantine，再安装到上述 scratch 根目录中的隔离 `installed/` 目录；不替换 `/Applications` 或任何既有 app。User 只走系统设置的单次明确放行。记录 `spctl` 结果，但不把 Developer-ID 通过设为目标。
4. 启动旧版必须产生实验 `boot` 记录；否则失败，停止而不再加其它 entitlement。
5. 只在第 4 步成功后，运行原 #340 的旧版到新版、普通退出、稍后、明确确认、断签名/换身份、篡改清单和替换 ZIP 的全套门。只有这些都通过才可提出 ADR 修订。

### 备选诊断：关闭 Hardened Runtime（不是交付候选）

把 `hardenedRuntime` 设为 `false` 可作为一次性的根因对照实验：同时去掉只对 Hardened Runtime 有意义的 runtime exceptions，再运行同一启动探针。它会移除包括 Library Validation 在内的整个 Hardened Runtime 保护面，范围远大于候选 A；即使启动成功，也只说明诊断方向，不足以授权正式发布。未把它列为可交付免费方案。

Sparkle 的 Ed25519 更新签名不能消除 app 在 Electron Main 之前的 `dyld` 拒绝；切换 updater只会增加原生框架与迁移面，不能替代上面的启动门。

## 研究完成时的证据缺口与后续进展

1. 当时尚未执行候选 A；随后用户批准有限实验，真实 Squirrel 同身份更新和换签拒绝均已完成，见 [后续实验证据](mac-library-validation-evidence.md)。
2. 随后 Chrome 实际下载的 DMG/quarantine 已在系统设置中由用户明确放行；下载源为本机 loopback，并未证明 CNB/公网下载。无 Developer ID 的 `spctl` 接受不是预期结果，实际仍被拒绝。
3. 还没有能够长期保管的免费签名私钥，也没有授权建立它；不得把临时实验身份当成发行身份。

## Sources

- [Apple: Developer ID certificate](https://developer.apple.com/help/glossary/developer-id-certificate/)
- [Apple: Developer Program membership and price](https://developer.apple.com/programs/)
- [Apple: Developer Program fee waiver eligibility](https://developer.apple.com/help/account/membership/fee-waivers/)
- [Apple: Disable Library Validation entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.disable-library-validation)
- [Apple TN2206: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
- [Squirrel.Mac signature verification, fixed source](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLCodeSignature.m#L49-L114)
- [VS Code release signing, fixed source](https://github.com/microsoft/vscode/blob/a02d65ec69571a3bda387227df19a88729a0bf85/build/azure-pipelines/darwin/steps/product-build-darwin-package.yml)
- [Joplin Mac release, fixed source](https://github.com/laurent22/joplin/blob/cb2f658b6c85e4fba8ebf37e1d1ef28779a3c7d4/.github/workflows/build-macos-m1.yml)
- [MarkText unsigned Mac release, fixed source](https://github.com/marktext/marktext/blob/ce807d50ac128b2aecca3ef0b5cc0511db1baa3e/.github/workflows/release.yml)
