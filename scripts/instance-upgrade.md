# Deployment Upgrade

客户主机只需 Linux x64、Docker/Compose 与发行包内的 `nevix-deploy`。提前保存当前版本
的完整签名包和清单、新版本完整签名包和清单，以及可恢复的备份存储空间。实例目录0700，
`.env` 与 Admin session 文件0600；工具拒绝符号链接和公开可读的配置。正式公钥尚未配置时
仍拒绝发行包，没有跳过验签、运行时公钥覆盖或在线拉镜像选项。

先在 Desktop 登录当前真实 Admin，独立核对客户 Server TLS SHA-256 指纹，并以安全
本地方式把当前 session 写入0600文件；不要放到命令行、日志或聊天中。按计划维护窗口执行：

```sh
./nevix-deploy upgrade --directory /opt/nevix \
  --original-bundle /secure/releases/nevix-1.0.0-linux-amd64.tar.gz \
  --original-manifest /secure/releases/nevix-1.0.0-linux-amd64.json \
  --bundle /secure/releases/nevix-1.0.1-linux-amd64.tar.gz \
  --manifest /secure/releases/nevix-1.0.1-linux-amd64.json \
  --server-url https://203.0.113.10 --tls-fingerprint <独立核对的SHA256> \
  --token-file /secure/current-admin.session --drain-timeout 30m \
  --backup /secure/backups/nevix-before-1.0.1.tar.gz
```

命令验证两份厂商签名、完整包字节/架构/镜像身份，候选版本必须更高且其最低源 Server
版本不高于当前版本。要求已安装 current/Compose/config 与原签名版本吻合，固定 project
`nevix`、三个卷和持久挂载保持不变，不执行 PostgreSQL 大版本升级。候选导入阶段只加载
已验证的本地镜像和版本目录，不替换运行中容器，不覆盖 `.env`。

随后通过当前 Admin 的钉扎 HTTPS 公开维护 API，用新 UUID 和 revision 暂停新任务，
等待已有 queued/running 任务结束。既有维护不会被接管。任务清空后停止 Server，防止用户、
上传或配置写入破坏一致性；执行完整逻辑数据库/角色密码、主密钥、TLS 和配置快照，并在
独立隔离 project/卷中真实恢复、解密全部 provider/storage 凭据、验收原版本与业务配置。
只有完整可恢复证明和私密归档落盘成功才进入替换。

替换只更新 Server 和边缘 Nginx，保留原 PostgreSQL/cert 容器、卷和客户配置。Server 继续
使用独立 DDL 凭据、现有 Goose 会话锁和 up-only 迁移，不给 runtime 角色 DDL。候选必须
通过真实 Docker health、HTTPS 运行版本、维护/任务排空事实、公开业务配置、原始 `.env`、
凭据解密、TLS/主密钥字节一致性验收，随后才恢复自己拥有的任务准入。原发行包、版本目录
和完整私密备份保留；没有自动容器更新，也没有远程 Admin 安装按钮。

## 中止和恢复

排空超时、备份或隔离恢复失败发生在替换前：命令恢复原 Server/Nginx并验版本，再恢复
自己拥有的暂停。不会接管其他 UUID/revision。恢复自身失败则保留0700实例目录内的
0600 `upgrade.json`，其中记录暂停意图、owner/revision、原/候选版本和备份路径，没有密码
或 session。不要删除未完成 journal 后继续升级。

进程被杀或主机重启时，如果 journal phase 是 `pause-intent` 或 `paused`，以下命令仅可
重启已验证的原 Server，核对运行版本，并恢复 journal 对应的确切维护；它不替换镜像、
不改数据库。既有其他维护或版本变化会拒绝操作。成功后用新的 backup 路径重新升级：

```sh
./nevix-deploy recover-upgrade --directory /opt/nevix \
  --original-bundle /secure/releases/nevix-1.0.0-linux-amd64.tar.gz \
  --original-manifest /secure/releases/nevix-1.0.0-linux-amd64.json \
  --server-url https://203.0.113.10 --tls-fingerprint <独立核对的SHA256> \
  --token-file /secure/current-admin.session
```

只要 phase 已进入 `replacing` 或 `verified`，替换可能已经执行了迁移。任何迁移、健康、
业务验收或恢复准入失败都会停止 Server/edge并保留维护事实/journal/备份，不自动
`pg_restore`、不执行 Goose down、也不把换回旧镜像当成数据库回滚。以 journal 的原版本
与 backup 路径执行[完整恢复](instance-backup-and-restore.md)；先 `verify-backup`，再由
运维明确提交 `--confirm RESTORE-LOSE-POST-BACKUP-WRITES`。恢复会丢弃备份后的数据库、
密钥与配置修改；OSS对象不回滚。恢复使用备份时有效的真实 Admin email/password私密文件，
不依赖旧 session，不从数据库伪造 Admin。只有完整恢复验收和准入恢复后才清理匹配的
upgrade journal。所有 Admin 失联时没有离线授权旁路。

成功恢复后的运行版本仍为原版本。修正问题后再升级；不要用同一归档路径覆盖旧备份。
备份本身没有密码加密，必须放在客户加密存储或受控离线介质，不得上传 CNB/GitHub。

## 验收

`make test-offline-runtime` 必须在 native Linux x64 的隔离无外联 Docker daemon 执行。
它使用测试专用签名和真实旧/新镜像，公开 Admin HTTPS、真实 Creation task准入与 worker，
外部 provider/OSS HTTPS 测试协作者控制 queued/running 排空；演练超时与密钥损坏在替换前
恢复，实际 PostgreSQL Goose 错误与实际 Docker unhealthy 在替换后关闭，然后明确一致恢复。
测试制品是临时 tracked source副本，不是正式 stable 包；没有给生产入口添加测试 key开关。
本地 Apple Silicon 测试或 emulation不是 native Linux x64 验收，记录实际 CI 结果后才能
声明升级/失败/恢复验收通过。
