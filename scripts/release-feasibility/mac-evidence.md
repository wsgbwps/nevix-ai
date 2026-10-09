# #340 Mac 免费稳定自签实验

**结果：FAIL / 阻断。不得据此接受 ADR-0026 或开始正式 updater 实现。**

2026-10-09，在 macOS 26.6.2 (25G83)、Darwin 25.6.0、Apple Silicon arm64 上，使用项目锁定 Electron 39.8.10、electron-builder 26.15.3，以及仅在隔离实验中安装的 electron-updater 6.8.9。实验应用 `Nevix Release Experiment` 使用稳定 App ID `com.nevix.ai`，版本 `0.1.340` 与 `0.1.341`，不修改正式产品目前的 `com.electron.app` 打包配置。

两个版本使用同一 RSA-2048 自签身份 `Nevix Release Experiment ONLY`，证书 SHA1 `6DF93BC868293C3E87E488E0B5B4EEFFDAAFD3A5`。私钥与临时 keychain 不进版本控制、不上传；未使用 Developer ID、ad-hoc 身份或生产发布密钥。Ed25519 发行私钥仅在构建进程内生成，用于签署本次 ZIP 的确切描述，不写入磁盘。更新源为本机 `http://127.0.0.1:13400/`，只在实验显式允许 loopback HTTP。

## 实际过程与失败证据

1. OpenSSL 生成仅供实验使用的证书/PKCS12，导入隔离 keychain。PKCS12 需使用 OpenSSL 3 `-legacy` 以兼容本机导入。`security create-keychain` 使用相对路径时实际放在用户 Library/Keychains 下，复查必须使用实际绝对路径。
2. 探针起初报告 `no identity found`。用户批准临时用户级 codeSign 信任后，叶证书虽已有效，`codesign --keychain` 仍找不到它。将隔离 keychain 临时加入搜索列表后，**未受信的原始自签身份也可签名**；由此确认不能把原失败归因为自签身份必需受信。
3. 已撤销临时叶证书信任（SHA256 `1F96BF86476DAB047C7422B5DC24D9E92BC6E8CDFF85F331750E511FD6BAEE9C`），恢复原 keychain 搜索列表。构建只临时添加实验 keychain，`finally` 恢复列表；未改默认 keychain或系统根信任。
4. `mac-build.mjs` 使用 builder 的 `afterPack` 与已安装的 `@electron/osx-sign`，按真实证书签名全部 nested code，保留 `hardenedRuntime:true` 与项目现有 `entitlements.mac.plist`。builder `mac.identity:null` 仅阻止后续自动发现/重新签名；不是未签名发行，严格验证另行执行且成功。构建两个版本各自的 DMG 与 ZIP，`publish:never`。
5. 挂载旧 DMG，`ditto` 安装到 `.scratch/340-release-feasibility/mac/installed/`，卸载 DMG。两个版本及已安装旧版均通过 `codesign --verify --deep --strict --verbose=2`。旧/新 designated requirement 完全一致：

```text
designated => identifier "com.nevix.ai" and certificate leaf = H"6df93bc868293c3e87e488e0b5b4eeffdaafd3a5"
```

6. 启动已安装旧版真实 executable，在进入 Electron Main 前由 dyld 终止：

```text
Library not loaded: @rpath/Electron Framework.framework/Electron Framework
code signature ... not valid for use in process:
mapping process and mapped file (non-platform) have different Team IDs
```

因此没有 `boot` 事件，没有真实 Squirrel 跨版本安装或重启，也没有“普通退出/稍后不安装”与“签名不连续被拒绝”的 Mac 运行证据。DMG 为本地生成，未证明互联网下载后的 quarantine/首次手动放行；签名检查不等于 Gatekeeper 放行或自动更新成功。已停止此方向运行，不添加 `disable-library-validation`、不关闭 hardened runtime、不替换成手工更新。

## 复查

生成一个隔离、非生产的代码签名证书；将实际 keychain 绝对路径和证书 SHA1 传给构建入口。不要传生产证书。构建入口不会添加证书信任。构建需要现有 workspace 依赖与 npm 网络访问。

```sh
NEVIX_LAB_KEYCHAIN=/absolute/path/to/test.keychain-db \
NEVIX_LAB_IDENTITY=<40-character-test-certificate-SHA1> \
node scripts/release-feasibility/mac-build.mjs build

mkdir -p .scratch/340-release-feasibility/mac/old-dmg \
  .scratch/340-release-feasibility/mac/installed
hdiutil attach -nobrowse -readonly \
  -mountpoint .scratch/340-release-feasibility/mac/old-dmg \
  .scratch/340-release-feasibility/mac/0.1.340/dist/Nevix-Experiment-0.1.340-arm64.dmg
ditto '.scratch/340-release-feasibility/mac/old-dmg/Nevix Release Experiment.app' \
  '.scratch/340-release-feasibility/mac/installed/Nevix Release Experiment.app'
hdiutil detach .scratch/340-release-feasibility/mac/old-dmg
codesign --verify --deep --strict --verbose=2 \
  '.scratch/340-release-feasibility/mac/installed/Nevix Release Experiment.app'
node scripts/release-feasibility/mac-build.mjs serve
# 另一个终端启动已安装的真实旧版（本次在 dyld 处失败）
'.scratch/340-release-feasibility/mac/installed/Nevix Release Experiment.app/Contents/MacOS/Nevix Release Experiment'
```

本次原始构建输出与失败输出留在 `.scratch/340-release-feasibility/mac-build.log`、`mac/app-output.log`；已签名包留在 `mac/0.1.340/dist/` 与 `mac/0.1.341/dist/`。这些本机材料不进入公开成品仓库；上述关键错误与身份已固化在本报告。

本次包的独立字节记录（实验包，不是可交付客户的完整 Nevix 应用）：

| 文件                                 |     bytes | SHA-256                                                            |
| ------------------------------------ | --------: | ------------------------------------------------------------------ |
| `Nevix-Experiment-0.1.340-arm64.dmg` | 109305952 | `ff6baf12edad3f803e3a39a9c17d0e4dc005cecbe4b8f49283a7acf2b5fced57` |
| `Nevix-Experiment-0.1.340-arm64.zip` | 109364102 | `13c63d8be66492850ad6fa3aaca4f9a0380397559dbbd7a8fed7e37229b39076` |
| `Nevix-Experiment-0.1.341-arm64.dmg` | 109308924 | `c05c94dd9b9fc9ddc482d231166f15c557437173e5d2dfd62436438af452e0de` |
| `Nevix-Experiment-0.1.341-arm64.zip` | 109364128 | `e0040e0afda480457d4ad7a43bc1035c52b317e65019bec6a3d79cfea9b47df7` |

实验完成后已删除临时 keychain 与磁盘上的测试私钥/PKCS12；没有保留或新增生产签名身份。

上述失败包保留构建时字节。审查随后修正了实验 Main 的提前读取未验签版本与 updater 缓存隔离：新版启动只依据实际 `app.getVersion()` 和固定实验目标；后续构建在签名前将 updater 的真实缓存路径绑定至 scratch，并在运行入口断言。原失败发生于进入 Main 之前，未写入 updater 缓存；未重新签名或把修正后的 Main 运行宣称为已通过。

## 决策门与限制

需要重新选择/确认免费 Mac 打包与更新方案。当前证据只证明“保持项目现有运行保护与 entitlements 的这次稳定自签构建不能启动”，不证明所有免费方案均不可行，也不证明 Squirrel 自签连续性本身失败。

下一步可以单独调查 Apple 对免费证书、hardened runtime 与 library validation 的可支持组合，并以新实验重新过门；如需改变运行保护合同，须先明确安全取舍与架构决定。Spec 提到的 Sparkle 可作为更新信任机制候选，但更换更新器本身不能消除本次 dyld 启动问题。购买 Developer ID 不在本次预算内，手工更新也不满足规格；本分支不擅自采用任何替代。

依据：[匹配版本 MacUpdater](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/electron-updater/src/MacUpdater.ts)、[Squirrel 代码签名检查](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLCodeSignature.m)、[Apple TN2206 自签身份与 designated requirement](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)。这些说明真实验证机制，不能替代本次旧版到新版实测。
