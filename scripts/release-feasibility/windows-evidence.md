# #340 Windows 发行验签实验

结论：Node 标准密码库发行合同及真实 `NsisUpdater` 检测/下载边界通过本地实验。**Windows NSIS 安装验收未完成**，不能据此通过 #340 的整体可行性门或进入正式实现。

本次 host 为 macOS 26.6.2 / Darwin 25.6.0 / arm64。Electron 39.8.10、electron-builder 26.15.3 保持项目基线；electron-updater 6.8.9 仅安装到 `.scratch/340-release-feasibility/lab/`。运行时间 2026-10-09。没有 Windows 真机，没有有效 NSIS 安装包，也没有调用 `install`、`quitAndInstall` 或启动 `.exe`。报告中的 `.exe` 是 39 字节无执行能力的无系统签名文本 fixture。

## 实验合同与公开向量

`vectors.json` 只包含一次性实验公钥（PEM/SPKI）、签名 envelope、解码后的描述和 fixture 字节，不包含私钥。每次运行测试/下载实验时在进程内生成新的实验 Ed25519 密钥；它们不写入磁盘，不是生产密钥。

Envelope 必须只有三个字段：

```json
{
  "format": "nevix-release-v1",
  "payload": "<standard-base64>",
  "signature": "<standard-base64-64-bytes>"
}
```

签名原文是 `base64Decode(payload)` 的**确切字节**，由 Ed25519 标准算法签名，不签外层 JSON，不把清单和签名分开读取，不先解析再重序列化后验签。payload 是 UTF-8、无额外空白、无重复字段的紧凑 JSON：解析后 `JSON.stringify` 的字节必须与原文相同。字段顺序保持原文顺序，不要求读取端排序；Node/Go 读取端都须验证原始字节，而不是各自重新序列化。标准 base64 必须可无损往返且保留 padding；URL-safe base64、换行和模糊编码拒绝。

payload 必须恰好包含：`version`、`channel`、`platform`、`arch`、`min_server_version`、`min_desktop_version`、`url`、`size`、`sha512`。只接受 stable 三段数字版本（无前导零、无预发行标识）、`win32/x64` 或 `darwin/arm64`；候选必须比当前 Desktop 新。文件摘要是 SHA-512 的标准 base64，size 是正的安全整数字节数。正式 URL 必须为无凭据、无 fragment 的 HTTPS；本地实验仅显式开启 `allowLoopbackHttp`，限制到 `127.0.0.1`/`::1`，不降低正式 HTTPS 要求。

Desktop 候选的 `min_server_version` 与当前 Server 比较；候选 Desktop 还必须达到 Server 返回的 `serverMinDesktopVersion`。Server 版本或最低 Desktop 要求未知时拒绝。统一实验 payload 中 `min_desktop_version` 是最低 Desktop 声明，此 Desktop 实验只校验其版本格式；没有发明“现有 Desktop 太旧而禁止升级”的规则。将来 Server 发行读取端使用该声明核对客户端，此实验未实现 Server 发行或 Go 读取器。

`release-trust.test.mjs` 在 Main 发行信任公共 seam 验证签名、格式、字段、平台、版本、双向兼容、updater 描述绑定及真实文件字节。开发逐个 slice 记录 red → green：缺实现、未知格式、错误平台/兼容、metadata 绑定、文件字节检查分别先失败再实现；最后对最低 Desktop 字段语义同样先失败再修正。

## 真实 updater 公开接口证据

`windows-download.cjs` 在真实 Electron Main 中创建 `NsisUpdater`，未伪造 `process.platform`，未替换网络执行器，未调用 updater 私有方法。使用公开 `checkForUpdates()` 返回的 `updateInfo` 绑定签名描述，再调用公开 `downloadUpdate()`；HTTP loopback 服务记录真实请求，返回路径中的真实缓存文件再次流式核对字节大小与 SHA-512。host 是 Mac，因此 generic provider 实际读取 `latest-mac.yml`；这不是 Windows runtime 测试。

每个 updater 在任何操作前都设置 `autoDownload=false`、`autoInstallOnAppQuit=false`、`disableDifferentialDownload=true`、`disableWebInstaller=true`、`allowDowngrade=false`。实验保持操作顺序串行，下载前重新绑定候选，不允许未经绑定的后续 check 修改下载对象。实际生产并发编排及 Window 退出批准链没有在此实现。

| 场景                                         | 观察结果                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 坏 Ed25519 签名                              | 在调用 updater 前拒绝；feed 与制品请求均为零                                                         |
| 验证 A 后远端 metadata 变成 B                | updater 下载先前 check 的 A；只请求 A URL，真实缓存字节匹配 A                                        |
| 后续 check 让 updater 采用 B                 | 对已验签 A 的描述重绑失败；未下载 B                                                                  |
| metadata version、URL、size、digest 分别替换 | 在下载前拒绝；没有新增制品请求                                                                       |
| 新 updater 实例复用先前下载缓存              | 没有新增制品请求；外层重新校验实际字节通过                                                           |
| 同一个 updater 实例缓存被替换                | 库 `downloadUpdate()` 返回该缓存且没有重新请求；外层 `verifyArtifact` 拒绝。这证明安装前重验不可省略 |
| 新 updater 实例遇到被替换的旧缓存            | 库拒绝旧缓存并重新下载 A；外层真实字节验证通过                                                       |
| 远端 A URL 返回 B 字节                       | updater SHA-512 检查拒绝下载                                                                         |
| A URL 经 302 返回相同 A 字节                 | 真实请求到重定向路径，校验最终字节通过；重定向不能授权不同字节                                       |
| 下载后、安装前文件变成截断字节               | 外层校验失败，不获得安装资格                                                                         |

观察到的可信 A：version `1.0.1`，size `39`，SHA-512 `K+D7+Q1u3peAsLxeZhStiI3vcv4EZsY9Eeyz0oZqpTZJPm87LC1gKuRcPOhJOq1yJ/jr5Qa+pKZYHB1Nqu/IZg==`。精确临时 URL 与请求列表写入 `.scratch/340-release-feasibility/windows-runtime/result.json`，端口每次变化，不是公开发行地址。

## 复查命令

从仓库根目录运行，所有实验依赖与缓存保持在 `.scratch/`：

```sh
mkdir -p .scratch/340-release-feasibility/lab
npm install --prefix .scratch/340-release-feasibility/lab --no-audit --no-fund electron-updater@6.8.9
node --test scripts/release-feasibility/release-trust.test.mjs
node --check scripts/release-feasibility/release-trust.mjs
node --check scripts/release-feasibility/windows-download.cjs
mkdir -p .scratch/340-release-feasibility/windows-runtime/userData
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
writeFileSync('.scratch/340-release-feasibility/windows-runtime/package.json', JSON.stringify({
  name: 'nevix-windows-download-experiment', version: '1.0.0',
  main: resolve('scripts/release-feasibility/windows-download.cjs')
}))
NODE
apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .scratch/340-release-feasibility/windows-runtime
```

结果：Node 行为测试 6/6，通过；Electron runtime self-check 10/10，通过，正常 `app.quit()` 结束。脚本只验证退出默认安装关闭的配置与库公开下载行为，不能替代 Windows 上普通退出、稍后、批准退出及真实 NSIS 安装成功的最终验收。

没有使用 `verifyUpdateCodeSignature` 回调作为 Ed25519 门：6.8.9 在缺少 `publisherName` 时跳过系统签名回调，源码依据为该版本 `NsisUpdater.verifySignature`。外层发行签名与真实字节校验独立执行；Ed25519 不等于 Authenticode，不消除 SmartScreen。实际 Windows x64 NSIS 旧版 → 新版、安装前临近调用时的真实缓存不可变保障及企业策略/SmartScreen 仍需 Windows 真机补证。

## Windows runner 实验待执行

已准备 `.github/workflows/release-feasibility.yml` 的 Windows job（手动 `workflow_dispatch`，以及仅 `task/340-release-feasibility` 分支且实验路径变化时的 push）。它使用 `windows-latest` x64、现有 pnpm 11.21.0 frozen lockfile、锁定 builder 26.15.3 / Electron 39.8.10；updater 6.8.9 仅进入 scratch 实验包。没有生产签名秘密、Release 发布或 CNB 写入；仅上传本仓库 Actions 的实验日志与 NSIS 包，保留 7 天。整 job 25 分钟上限。**尚未推送、dispatch 或运行，不能视为 Windows 安装已经通过。**

`windows-installed.cjs` 由 Node 构建两个 `com.nevix.ai` 实验版本 `1.0.0`/`1.0.1`（产品名称 `Nevix Release Experiment`），首次以 NSIS 安装进 runner workspace 的 `.scratch/340-release-feasibility/windows-installed/installed/`。实验 userData、updater 缓存与日志均隔离到同一 scratch 范围；Main 在载入 updater 前只修改本进程 `LOCALAPPDATA` 为 `root/cache-home`，并使用固定 `updaterCacheDirName=updater`，避免 Windows runner 的 C:/D: 跨盘相对路径失效，不修改系统环境变量；关闭桌面/开始菜单快捷方式，`runAfterFinish=false`。没有购买 Authenticode，也不读取生产私钥。

安装后的 Main 读取 loopback 签名清单，并通过真实公开 updater 检测/下载、签名描述绑定、下载后/安装前真实缓存字节检查。脚本依次断言首次安装版本为旧版；下载后普通退出、选择稍后、重启仍为旧版；只有明确 `approved` 实验场景才调用 `quitAndInstall(true,true)`，等待真正的 NSIS 替换并由安装后可执行文件重新启动，最终读取真实 `app.getVersion()` 为新版。approved 场景代表受控自动化批准，不声称已经测试真实 User 原生确认及生产 Window 保存/上传 readiness。

本机仅完成脚本语法校验。Windows 运行结果将产生 `windows-installed/result.json`，包含各阶段真实执行路径、版本、平台、发行身份和 HTTP 请求记录；失败时保留 `runtime-error.json` 与构建产物。静默 CI 安装不能验收 SmartScreen 交互或企业设备政策，仍应在交付设备抽查。
