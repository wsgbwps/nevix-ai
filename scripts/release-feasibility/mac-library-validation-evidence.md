# #340 获批免费 Mac 隔离实验

状态：最小真实更新路径通过，完整客户端分发候选已构建并通过独立静态 QA；不是正式发行方案的接受。保留 [原基线失败](mac-evidence.md)，审批范围见 [具体方案](mac-free-proposal.md)，开源项目发行方式见 [研究](mac-free-research.md)。

2026-10-09，当前本机 macOS 26.6.2/arm64，Electron 39.8.10、builder 26.15.3、实验 updater 6.8.9。新的 scratch 根是 `mac-library-validation/`，旧/新版为 `0.1.342/0.1.343`，App ID `com.nevix.ai`。正式应用配置和原失败包不变。

## 保护和签名

用户批准的唯一新增运行权限为 `com.apple.security.cs.disable-library-validation=true`，仅写 scratch entitlement 副本。构建断言正式三项 JIT/DYLD 权限未变；主程序及 Helper 保留 hardened runtime。此例外允许其他团队或未签名的动态库，确实减少 library validation 的保护，不能用发行验签抵消。[Apple entitlement 说明](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)

两版本使用同一新的两天实验叶证书，SHA1 `9A1F41D21DA5B116522B9DED3D911BBD67C2D887`，SHA256 `1E539645252805DD3E0DB03031594614D45D6008512B331D257EEB14E799A237`。实际 designated requirement 连续，旧/新 12 个签名对象严格验证通过；不使用 Developer ID、ad-hoc、生产证书或新增证书信任。keychain 只临时加入搜索列表，finally 恢复。

## 真实首次打开与安装

通过 Chrome 下载实际旧 DMG：109306590 bytes，SHA256 `acf5a4fec46a3ceab3dd48ec00f8d0e440f6143bfb169fdc6680554da8bc31b0`。下载 URL 为 loopback HTTP，不能据此声称 CNB/公网 HTTPS 链路通过；Chrome 实际标记 quarantine。用户首次尝试明确反馈“拦截了，提示不可信任”，并在系统安全设置放行。

再次下载后，将只读挂载 DMG 中的 app 用 ditto 复制到 scratch，并把该次真实 DMG quarantine 原值传播到 app（没有制造来源，也没有删除属性）：`0281;6ac8aee8;Chrome;26718816-63C8-488C-A646-13642A414083`。系统实际拦截，`spctl --assess --type execute` 返回 3/rejected；系统设置显示“已阻止 Nevix Release Experiment.app”。根代理取得针对该 app 的行动审批；自动点击无响应，由用户本人完成“仍要打开”及系统验证，回复“已打开”。

放行后 app 在 App Translocation 中启动，日志已有 packaged/arm64/Electron 39.8.10 的真实 boot。通过 Finder 的 Edit → Move Item Here 正常移动至 `mac-library-validation/installed-via-finder/Nevix Release Experiment.app`，不删除 quarantine；此时实际属性为 `03c1;6ac8aee8;Chrome;26718816-63C8-488C-A646-13642A414083`，之后进程从该 scratch 真实路径运行。未安装或替换 Applications 中的产品。

## 逐项实际结果

| 验证             | 实际结果                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通退出         | 09:13:36 `before-quit installing:false`；从原安装入口重开仍为 0.1.342。                                                                                                                                                                       |
| 稍后并正常退出   | 09:14:30 `later` / `before-quit installing:false`；重开仍为 0.1.342。                                                                                                                                                                         |
| 确认对话框不批准 | 真实原生对话框选择“稍后”，`confirmation approved:false`，保持旧版。                                                                                                                                                                           |
| 不连续签名       | 第二实验叶 SHA1 `20F4E0A147B74CB4CEB49218073F9E801436FB99` 的 ZIP 通过 Ed25519、metadata 绑定和实际字节校验；明确触发安装后，09:22:31 真实 Squirrel 报 `code failed to satisfy specified code requirement(s)`。安装路径仍为 0.1.342，未替换。 |
| 同身份明确批准   | 恢复原身份的确切 ZIP/清单后，09:23:31 `confirmation approved:true` / `install-approved`；09:23:32 真实 `native-update-downloaded` 和 `before-quit installing:true`；09:23:35 0.1.343 packaged boot。                                          |
| 实际替换/重启    | 同一 `installed-via-finder` 路径的 Info.plist 为 0.1.343，真实运行进程也来自该路径；UI 显示新版。更新后 `codesign --verify --deep --strict` 返回 0。                                                                                          |

正向 343 ZIP SHA256 `d3095e9f47a7a06a8cb83c9998cfa8a4ff3028f4533602095fd1fdb8f1f1b8dc`；负向 ZIP 为 110130666 bytes，SHA256 `3b6cfd2b644c35ef262796e0271fefe8b306ba426ce535aa685cc8f7aacdb8ce`。各自清单都签署真实精确 payload，实验 Ed 私钥只在内存中生成；负测切换时公钥/清单/feed 同组替换，之后完整恢复正向文件。没有关闭 Squirrel 验签或 Ed25519/摘要检查。

原始材料在 scratch 的 `events.jsonl`、`signature-evidence.json`、`installation-source.json`、`actual-result.json` 和 `negative-signature/actual-result.json`。不公开完整本机日志/私钥。更新前 quarantine 保留；Squirrel 正常替换的新本地生成 bundle 只有 provenance 属性，根代理没有执行任何 quarantine 删除操作。

## 范围与未验项

这是最小更新实验，不包含业务草稿/上传就绪门、正式 Desktop updater 或长期发行密钥管理。首次人工放行不可避免的实际结果须保留；没有公证、没有企业策略或不同 Mac 硬件/系统的通过证据。完整当前 Desktop DMG/ZIP 只用于后续 CNB 分发材料验收，不能将它标记为已经实现正式自动更新。

两个新短期签名身份及 PKCS12、磁盘私钥、keychain 密码均已清理，用户搜索列表恢复为原 login.keychain；新实验未添加用户或系统证书信任。loopback feed 已停止，旧 DMG 的两个只读挂载均已卸载，实验 app 已正常退出。实际记录见 scratch `cleanup.json`。正式采用需要独立审批/ADR，#340 由专门 QA 依据原正文条件决定勾选，不由上述运行成功自动接受 ADR-0026。

## 完整当前 Desktop 分发候选

在输入 commit `c8a1fba5d88de68908bb0f3a1d8a4430d4bef5f7` 以当前 Desktop 编译 out 打包，保留正式当前 App ID `com.electron.app`，名称明确 `Nevix AI EXPERIMENTAL`；这是完整 `0.1.0` 客户端，不是上面的最小 updater app。复用获批实验叶及 entitlement/HRT，不修改正式 builder/依赖配置。实验只排除原始 TS/map/内部文档、README 和上游 CLI PEM 帮助示例、source-map.debug.js 调试映射产物；保留正常 runtime 入口及 LICENSE/NOTICE。

| 文件                                  |     bytes | SHA-256                                                            |
| ------------------------------------- | --------: | ------------------------------------------------------------------ |
| Nevix-AI-EXPERIMENTAL-0.1.0-arm64.dmg | 122355813 | `1aeaea3f072716a80c2951667726d1404f149d37ce47492636907f57e0092615` |
| Nevix-AI-EXPERIMENTAL-0.1.0-arm64.zip | 122316926 | `b36991e93ea5eb43c3ebe4e805d0982fee8ea65fc96c01e6f5242e516ecb211c` |

独立 QA 实际解包 ZIP，确认 arm64 Mach-O、编译 main/preload/renderer 完整；ASAR 9816 项（8538 常规文件）公开内容检查通过，无原始应用 TS/map/内部文档/真实 env/私钥或 ASAR 链接，417 份 LICENSE/NOTICE。framework 的标准内部链接均未逃出 bundle。Main/4 Helpers 的实际权限精确为基线三项加获批例外，严格签名和同实验叶通过。worker 另只读挂载 DMG 验签，实际 ASAR 与 ZIP 字节一致并卸载。

完整客户端只做静态包装验收，未启动其业务 UI，没有正式 updater，也没有公证或企业设备策略通过证据；不得把最小实验升级结果当作完整客户端已经实现自动更新。公开候选只含 DMG/ZIP，不上传相邻 builder 配置、日志、scratch 源或 blockmap。
