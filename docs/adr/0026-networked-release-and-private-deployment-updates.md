# ADR-0026: 联网版本分发与私有部署更新

## 状态

方案已收敛，待整案确认 — 2026-09-30。产品选择已由用户逐项确认；下列实现方案仍待整案确认与本地可行性验证，尚未授权实现或正式发布。接受后将取代 [ADR-0013](0013-onprem-single-tenant-delivery.md) 中基于 air-gap 的不引入 updater 与 Desktop 零外联约束，以及旧的客户现场编译分发形态；不改变 Go 唯一可信业务数据面的职责。

## 已确认

- 官方交付支持客户内网服务器与客户自己的香港云服务器，一套部署仍对应一个 Deployment Instance。Desktop 与 Server 均允许访问指定的官方公网更新源；首版不承诺完全离线或由客户 Server 转发桌面更新。
- 国内更新的首要验收标准为无需代理即可稳定检测、下载，可以接受较慢的下载速度；优先免 ICP 备案。选定 CNB 免费分发，仍须实测大陆三大运营商对更新清单与制品的访问质量。
- Desktop 只发布 Windows x64 与 macOS Apple Silicon 版本。自动检测并后台下载，User 确认后重启安装；下载与安装必须作为不同动作处理，并保留现有退出确认和本地状态保护。
- Server 自动检测新版本并向 Admin 提示，由客户运维者执行升级命令；首版不自动替换运行中的容器、不增加管理员点击即远程升级或定时自动升级。
- 继续使用现有 HTTPS 与边缘 HTTP/2 部署形状，首版不引入 HTTP/3。HTTP/2 不等于消除 TCP 队头阻塞，也不自动保证所有客户端请求或代理上游均使用 HTTP/2。
- 正式发布声明 Desktop 所需最低 Server 版本与 Server 所需最低 Desktop 版本。最新版 Desktop 与当前 Server 不兼容时不自动下载，保持当前版本并提示 Admin 先升级 Server；兼容版本正常后台下载。安装前再次核对兼容性；此原则不代表承诺永久兼容任意历史版本。
- 允许计划维护停机。升级前暂停新任务、等待运行中任务结束、备份数据库与主密钥/TLS 材料，再替换镜像并验收健康状态；等待超时或备份失败则中止。迁移继续 up-only，回退旧镜像不等于回滚数据库。
- 只有正式版本标签（如 `v1.0.1`）触发客户发布；普通代码 push 不更新客户。CI 检查、构建、签名、制品上传全部成功后才更新公开版本清单，避免引用尚未就绪的制品。
- 发布安装包与后端制品允许公开下载，源码继续私有；下载不携带客户数据或凭据。使用权限继续遵循合同与既定 License 决策，不以制品保密代替业务授权。
- 尚未向客户分发过安装包，属于首次正式发布，无既有安装身份迁移负担。
- 暂不采用付费发布托管或付费镜像仓库，未来有需要再迁移；香港 OSS + ACR 企业版候选未获采用。发布格式与更新协议应便于迁移，不预先实现多供应商抽象或双写分发。
- 厂商目前没有自有域名或香港主机，不能将“复用现有香港静态主机”作为当前可用方案，也不能声称已具备由厂商完全控制的稳定域名入口。
- 客户内网与香港云部署沿用固定 IP、自签 HTTPS 与首次指纹核对；官方更新源使用系统受信 HTTPS，与客户 Server URL 的证书信任分开。
- 源码与日常开发继续在 GitHub 私有仓库。腾讯 CNB 单独建立公开成品分发仓库，只存放发布说明、桌面安装包、更新清单与后端制品；GitHub Actions 完成构建后上传 CNB，不镜像或迁移源码。
- CNB 先使用免费额度，不绑定付费预算。厂商保留每次发布的本地制品副本并维护后续迁移路径；CNB 的免费额度、账户和仓库限制不是永久可用性保证。
- macOS 首次安装接受 User 在系统设置中明确放行；自动更新采用免费签名方向，不以购买 Apple Developer 会员作为首版前置条件。必须先验证稳定自签身份在本项目 Squirrel 链路的真实旧版本到新版本更新；若不可用，重新确认替代方案，不能默默降级为手动安装或绕过验证。
- Windows 首版采用 NSIS，不购买代码签名证书，接受部分设备可能出现 SmartScreen 提示；清单与安装包仍须以免费发布签名证明来源与完整性。不能把没有系统提示作为验收保证，也不能把 Ed25519 发布签名称为 Windows Authenticode。
- 后端只交付 Linux x64 成品。发行包包含所需镜像与 Compose/配置，客户导入镜像后运行 Compose，无需现场编译或新增付费 registry；Apple Silicon 桌面支持不扩张为后端 ARM64 支持。
- Desktop 首版更新入口采用系统菜单“检查更新”、下载完成通知与原生安装确认框。暂不新增设置页更新面板、进度与版本记录，也不为此新增 updater typed IPC owner。
- Desktop 启动后及每 12 小时检查，Server 启动后及每天检查，均支持手动检查。后台失败安静重试、手动失败明确告知，不影响已有业务；无法确认当前 Server 兼容性时暂缓 Desktop 自动下载与安装。

## 拟采用的实现方案（待整案确认与验证）

- 固定 Desktop App ID 为已有 Main 使用的 `com.nevix.ai`，同步打包身份。Windows 产出 x64 NSIS，macOS 产出 arm64 DMG（首次安装）与 ZIP（自动更新）。复用现有 electron-builder v26，安装对应版本 electron-updater；不依赖尚未发布的新版签名功能。
- 发布渠道先只提供 stable。CNB 主站公开 raw 路径提供签名版本清单，制品指向不可变版本 Release 附件。客户端不调用需认证的 CNB OpenAPI，不持有 CNB token。
- 发布清单用厂商自有 Ed25519 密钥签名；Desktop、Server 与升级工具内置受信公钥，使用各自标准库验签，不自行实现密码算法。签名覆盖版本、平台/架构、兼容条件、下载 URL、文件大小与摘要；验签后才信任这些字段。签名与对应清单内容须绑定，避免分开读取时混用两个版本。
- Desktop Main 的平台 updater 负责检测、验签、下载和原生交互，客户 Server URL 与证书信任继续经 connection owner。`autoDownload=false` 与 `autoInstallOnAppQuit=false` 阻止库越过外层验证；验证通过后程序自动开始下载，实现产品所选的后台下载体验。以本次 updater 实际采用的版本、URL、大小与摘要绑定已验签清单，下载完成后验证真实文件字节，安装前再次检查文件身份与 Server 兼容性。
- 检查、下载与安装操作串行。缓存安装包不是受信事实；每次准备安装都须验签与校验，不允许退出钩子、重启、旧缓存或并发检查绕过验证。原生 updater 的 install 调用必须发生在 User 确认且既有 Window 保存/丢弃与上传退出准备完成之后；由 Window lifecycle 复用现有退出 continuation，批准后仅执行一次安装 action，普通退出继续调用 `app.quit()`。取消或 renderer 失联时清除待安装 action；当前 `requestApplicationQuit()` 返回 void 不是批准事实。updater 不解释 renderer 业务状态，也不新增 typed IPC。
- Go 公布运行版本与 `min_desktop_version`，发布清单声明候选 Desktop 的最低 Server 版本。Desktop 在启动/连接与安装前比对；最新版不兼容时继续使用当前版本并提示先升级 Server。Server 的发布检测与 Admin 提示采用简单 release 责任范围，不增加 Docker socket、远程执行或安装权限；任务暂停/排空事实仍由 owning Creation Module 负责，升级脚本不得直写业务表。
- 后端制品用 Docker 镜像归档交付，包含 Nevix server、证书工具与固定来源的 Nginx/Postgres；Compose 不含客户 build 步骤，显式禁止缺镜像时自动公网拉取。保留上游来源 digest 与实际镜像身份的验证；不能假定 `docker load` 一定保留 registry RepoDigest，发行 Compose 的身份引用须在支持的 Docker Engine 上实际验收。固定 `nevix` project 与持久卷名称，不覆盖客户配置、不随应用更新升级 PostgreSQL 大版本。
- 正式发布 CI 按版本串行：检查与构建 → 签名 → 创建 draft Release → 上传并确认完整附件 → 转为正式 Release → 验收匿名可读 → 最后一次 commit 更新公开渠道清单。禁用正式制品覆盖，附件显式永久保留；失败不推进渠道指针，也不让较旧构建后完成时覆盖新指针。这是发现新版本的可见性门，不是 CNB 多资源原子事务。
- 发布与部署资产继续归 `deploy/`，备份/恢复工具归 `scripts/`，Main updater 归 Desktop 平台责任；CI 放现有 `.github/workflows/`。不新建顶层 source owner、不迁移 GitHub 私有源码。第一步只验证 Mac 免费签名与 CNB 实际更新链路，通过后再实现完整功能。
- 后续迁移存储商先保留 CNB 旧入口并发布迁移版本，迁移清单与制品持续使用受信签名；Mac 更换签名身份可能还需桥接版本。旧源失效时不能自动救回尚未迁移客户端，本地备份提供人工安装/部署恢复。签名私钥保持厂商受控且有安全离线备份，不进入 CNB、客户实例或安装包；原始发布制品与清单单独保留本地备份。

## 实现前的验证约束

- 客户端与客户 Server 不持有 CNB token。CNB 主站公开 raw 文件可作为清单入口；实测公开仓库 OpenAPI latest 查询仍要求认证，因此不能将这个 API 当作匿名客户端更新入口。CI 可使用厂商写入凭据上传附件。
- 拟采用的“Release 附件先就绪、公开渠道清单后更新”须通过失败中断与并发发布检查；验收确认前不将其视为已经实现的发布协议。
- 当前 builder 26.15.3 对应 updater 6.8.9 不具备新版文档中的 Ed25519 清单验签功能。免费签名方案必须在可信调用边界验证发布者签名与制品身份；只在 YAML 增加 signature 字段或依靠随包提供的 checksum 都不构成验签。发布私钥不得进入 CNB 成品、客户端或客户 Server。
- CNB 已有公开附件的匿名 HEAD、单段 Range 与跨 asset 主机重定向获得可用实测，但多段 Range 未表现为 multipart。实际 Nevix 安装包和完整后端包仍须验收；首版先完整下载，不将差量下载作为发布前置或承诺。大陆三网验收覆盖匿名清单、完整安装包/镜像包、失败重试与 TLS 验证，不能据较小样例承诺实际性能。
- Mac 免费自签链路须验证旧包到新包的安装、首次放行、正常退出不自动安装、明确确认后的退出准备与安装。未来更换签名身份可能需要过渡版本；不能承诺任意旧客户端可跳过过渡版本直接安装 Developer ID 签名包。
- 安全验收至少覆盖清单被篡改、包被替换、错误架构、旧缓存、版本不兼容、并发检查与非更新退出。坏签名/坏摘要一律不下载或不安装；CNB 故障不得阻断已部署的业务。
- Linux x64 从空 Docker 环境导入完整制品后应能在禁止公网拉镜像时启动；维护暂停/等待、备份失败、迁移失败、健康失败须有明确中止与恢复路径，不能把启动健康等同于数据库回滚保障。

## 依据

- [electron-builder v26 自动更新](https://www.electron.build/v26/docs/features/auto-update/)：支持 electron-updater、generic HTTP(S) 更新源、Windows NSIS 与 macOS 更新；macOS 要求签名，更新需要 ZIP 制品。仓库锁定 builder 26.15.3，对应 updater 6.8.9 尚未安装。
- [对应版本 MacUpdater 源码](https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/electron-updater/src/MacUpdater.ts#L228)：下载前设置 `autoInstallOnAppQuit=false` 可阻止下载完成后自动交给 Squirrel 暂存；安装须在 User 确认与退出准备完成后显式触发。不能只在界面显示“稍后”而保留默认退出安装行为。
- [Apple 手动打开应用说明](https://support.apple.com/en-us/102445)：DMG 安装与是否购买 Developer ID 是不同问题；未经认可签名/公证的应用可能由用户在系统设置中放行，企业设备策略可能限制这一入口。能手动运行不等于已经验证跨版本自动更新。
- [Squirrel 签名验证源码](https://github.com/Squirrel/Squirrel.Mac/blob/0e5d146ba13101a1302d59ea6e6e0b3cace4ae38/Squirrel/SQRLCodeSignature.m#L71)与 [Apple 自签身份说明](https://developer.apple.com/library/technotes/tn2206/_index.html)：旧、新应用满足相同签名要求是所选原生更新链路的真实条件，不是硬编码的付费条件。稳定自签身份是否能用于本项目自动更新尚需真实旧版本到新版本验证；不能把普通 ad-hoc 构建直接当作可用方案。
- [Sparkle 安全文档](https://sparkle-project.org/documentation/#3-segue-for-security-concerns)：可用自有 Ed25519 密钥验证更新包，Developer ID 是推荐项而非所有更新系统的唯一技术前提。接入 Electron 需要额外原生框架与发布链路，当前未决定采用。
- 腾讯 CNB [免费额度](https://docs.cnb.cool/zh/saas/pricing.html)、[权限表](https://docs.cnb.cool/zh/guide/role-permissions.html)与[附件插件](https://cnb.cool/wmde/attachments/-/blob/main/README.md)：公开 Release 附件可匿名下载，100 GiB 对象额度与其他对象共用，插件声明支持 64 GB 以内文件；[服务协议](https://docs.cnb.cool/zh/saas/terms.html)允许额度调整及超额资源限制/回收。可作为免费分发试验候选，不能据此承诺永久免费或大陆网络稳定；须验收实际安装包/镜像包大小、GET/HEAD/Range、清单发布入口及重定向行为。源码不放入该公开成品仓库。
- [OSS 自定义域名](https://help.aliyun.com/zh/oss/user-guide/access-buckets-via-custom-domain-names)与 [HTTPS](https://help.aliyun.com/zh/oss/user-guide/access-oss-by-https-protocol)：香港 bucket 的绑定域名无需 ICP，可直接托管 HTTPS 证书。这是厂商发布基础设施候选，与客户业务 Object Storage Connection 分离。
- [ACR 版本差异](https://help.aliyun.com/zh/acr/product-overview/differences-between-personal-edition-instances-and-enterprise-edition-instances)：个人版面向开发测试，不能直接以免费为由将其定为正式发布渠道；企业版候选因当前费用限制不采用。无论具体渠道，交付依赖的 Nginx/Postgres 固定镜像也须分发，避免客户仍须访问 Docker Hub。
- [Docker 镜像导出](https://docs.docker.com/reference/cli/docker/image/save/)与[导入](https://docs.docker.com/reference/cli/docker/image/load/)：可以用包含所需镜像的压缩发布包代替镜像仓库。此为减少新增服务的候选；若采用，须验证镜像身份、目标架构以及现有 digest 钉扎合同在导入后的兑现方式。
- [腾讯云备案场景](https://cloud.tencent.com/document/product/243/19630)：香港服务器与大陆域名服务的备案条件不同；HTTPS、私有部署或端口号不单独构成备案豁免依据。
- [HTTP/2 标准](https://www.rfc-editor.org/rfc/rfc9113.html#section-1)：HTTP/2 不处理 TCP 队头阻塞。
- [Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)：现有 Compose 可承担容器替换，不需要先引入独立部署平台。
