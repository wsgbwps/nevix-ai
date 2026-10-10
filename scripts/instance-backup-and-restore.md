# 完整 Deployment Instance 备份与确认恢复

客户主机只需要受信 `nevix-deploy`、Linux x64、受支持 Docker/Compose。正式公钥未配置时
工具仍会拒绝发行包；这里没有跳过验签、环境公钥覆盖或客户现场编译选项。

保存原始版本的完整签名发行包与清单；备份不替代它们。备份包含逻辑 PostgreSQL custom
格式 dump、两个数据库角色的密码 verifier、Creation Master Key（或经验证的未配置事实）、
TLS 证书/私钥、客户 `.env`、版本/发行摘要、维护事实和公共配置摘要。它不包含 OSS 对象，
客户 IT 必须另行保护 bucket。备份本身是客户私密材料，不是厂商签名的发行制品；内部
SHA-256 只查损坏，不证明来源。只恢复从自己受控备份库取得的文件，SQL dump 会在
隔离检查和确认恢复中执行。不得把客户备份、密码或 session 上传 CNB/GitHub。

备份及临时文件权限 0600，目录 0700；归档本身没有密码加密，必须放入客户加密磁盘或
受控离线介质。留足原始发行包解压、备份、隔离数据库和实际恢复的空间；单个数据库
dump 上限 128 GiB，超出此范围需另外设计并验收备份流程。临时恢复验证失败会清理
专属 proof project 的卷，不碰客户 `nevix_*` 卷。

## 取得完整备份

先在 Desktop 登录真实 Admin，独立核对部署 TLS SHA-256 指纹。将 session 通过安全
本地方式写入一个 0600 文件；不要写到命令行、普通日志或聊天。以下路径是占位符：

```sh
./nevix-deploy backup --directory /opt/nevix \
  --bundle /secure/releases/nevix-1.0.0-linux-amd64.tar.gz \
  --manifest /secure/releases/nevix-1.0.0-linux-amd64.json \
  --server-url https://203.0.113.10 --tls-fingerprint <独立核对的SHA256> \
  --token-file /secure/admin.session --drain-timeout 30m \
  --output /secure/backups/nevix-1.0.0-instance.tar.gz
```

工具验证原始发行、当前版本、Compose/config 与实际镜像身份；customer TLS 用精确
证书指纹、主机名和有效期验证，与官方发行源的系统 HTTPS 信任分开。拒绝 HTTP、
重定向和宽权限凭据文件。维护操作使用新 UUID 与当前 revision，经公开 Admin API
暂停新任务；已排队/运行任务继续完成。既有别人的维护不会被接管。等待超时或失败
只恢复自己拥有的暂停，失败不会进入替换。恢复失败会明确报告仍暂停。

任务清空以后仍有配置、用户和上传等写入口，所以工具停止 Server 并检查已停止，
再执行 `pg_dump`、快照主密钥/TLS/.env；不会复制运行中的 PostgreSQL 数据目录。
随后在全新隔离 project/卷上实际 `pg_restore --single-transaction --exit-on-error`，
验证所有已有 provider/storage 密文能由备份主密钥解密，再启动原签名版本并核对
真实 Admin、维护/任务状态、公开配置、版本与同一 TLS 身份。proof network 禁止外联，
不会调用真实供应商或 OSS。只有完整验证成功才保留输出文件。

备份完成或失败，旧 Server 都先恢复，再恢复自己的任务准入；错误不会悄悄清掉别人的
维护。若 Server/edge 无法重启、HTTPS 不通或 Admin session 已失效，维持暂停并报告，
由 IT 按公开 maintenance owner/revision 合同重试，不从数据库伪造 Admin。

## 再验证和恢复

长期恢复不能依赖历史 session。通过受控方式建立一个 0600 JSON 文件，只含备份时仍
有效的 Admin `email`、`password`；不要将其放进备份。工具会在恢复实例的真实公开
HTTPS login 获取新 session，不直接创建数据库会话。备份后修改的密码会被恢复到旧
值；如忘记备份时密码，工具拒绝开放准入，需走正式账户恢复流程。

```sh
./nevix-deploy verify-backup --directory /opt/nevix \
  --bundle /secure/releases/nevix-1.0.0-linux-amd64.tar.gz \
  --manifest /secure/releases/nevix-1.0.0-linux-amd64.json \
  --backup /secure/backups/nevix-1.0.0-instance.tar.gz \
  --server-url https://203.0.113.10 --tls-fingerprint <备份对应的独立指纹> \
  --credentials-file /secure/backup-era-admin.json
```

先完成此验证和人工备份核对，再执行恢复；恢复会丢弃备份之后数据库、配置与密钥的
修改，原 OSS 对象不回滚。仅换回旧镜像不会恢复数据库；工具不执行 Goose down，
不自动删除客户卷，不自动破坏性恢复。

```sh
./nevix-deploy restore --directory /opt/nevix \
  --bundle /secure/releases/nevix-1.0.0-linux-amd64.tar.gz \
  --manifest /secure/releases/nevix-1.0.0-linux-amd64.json \
  --backup /secure/backups/nevix-1.0.0-instance.tar.gz \
  --server-url https://203.0.113.10 --tls-fingerprint <备份对应的独立指纹> \
  --credentials-file /secure/backup-era-admin.json \
  --confirm RESTORE-LOSE-POST-BACKUP-WRITES
```

缺少确认时不会停止服务或改动数据库；归档校验与隔离完整恢复必须先通过。确认后停止
Server/edge，整体恢复数据库及角色密码、主密钥、TLS/.env，运行原签名版本；核对
公开业务和维护事实后才恢复准入。中途失败保持关闭/暂停，保存原备份与错误，修正
磁盘/凭据/运行条件后重试明确恢复；不得把“健康”或“旧镜像”当作数据库一致性证明。
恢复时禁止证书强制轮换，TLS 指纹保持备份身份，key 恢复为实际 Server UID/GID、
目录0700/文件0600；重启不会默默生成另一把主密钥。

灾难恢复到新主机时先通过可信交接获取工具与原始 signed bundle/manifest，并使用
`import` 导入全部镜像，再恢复到原固定 project `nevix`。不要在一个 Docker Engine
同时运行另一组 Nevix 客户数据；固定卷和 TCP443 是本版约束。

## 可执行演练

`make test-offline-runtime` 在 native Linux x64 的专属无外联 Docker daemon 执行。
真实 HTTPS Admin 认领/登录、Provider exact-action reauth 与隔离 provider fixture 建立
密文；随后验证未配置密钥、完整备份、损坏密钥失败恢复准入、其他维护 owner 保持、
历史 session 吊销后重新认证、无确认不破坏业务，以及明确恢复后数据/TLS/配置一致。
实际平台结果记录在 `deploy/runtime-evidence.md`；尚未通过的 CI 不算交付验收。

隔离 proof 不发布端口；Linux 运维进程通过其唯一 internal bridge 的 Nginx 私有 IP 验收，
HTTPS URL 的原客户主机名、证书指纹和有效期仍严格核对。Docker normal internal bridge 的
宿主可达形状见[官方说明](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)，
不是关闭网络隔离或跳过证书检查。传输错误只报告固定类别，不输出私密 subprocess/HTTP 字节。
