# Linux x64 完整离线发行包

客户前置条件只有 Linux x64、Docker Engine（API >= 1.49；Engine >= 28.2）与
Docker Compose >= 2.38.0、可用 TCP 443、足够磁盘空间。后端不支持 ARM64。
精确版本运行记录见 `deploy/runtime-evidence.md`；未跑过的组合不冒充已验收。
Go/Node/Python/OpenSSL 只在厂商构建环境使用，客户主机不需要安装。

## 独立信任引导

先从厂商独立可信交付渠道获取 `nevix-deploy` Linux amd64 二进制与其发布者公钥
SHA-256 指纹。公钥编译在工具中，不能用发行包里的候选工具验证该包，也不能
相信和候选包放在一起的一份任意 checksum。首次工具交付依赖 IT 已信任的厂商
交接渠道；升级继续用已安装的受信工具验证新包后才替换工具。

目前正式 Ed25519 公钥尚未配置，正式工具会拒绝所有包。这是正式发行前置条件；
没有命令行公钥覆盖、实验密钥或跳过验证选项。公钥配置与独立工具交接完成后，
客户把完整 `.tar.gz` 与对应签名 `.json` 下载到本机即可，不需 registry 访问。

## 首次安装

```sh
./nevix-deploy verify --manifest nevix-linux-amd64.json --bundle nevix-linux-amd64.tar.gz
./nevix-deploy import --manifest nevix-linux-amd64.json --bundle nevix-linux-amd64.tar.gz --directory /opt/nevix
cp /opt/nevix/.env.example /opt/nevix/.env
chmod 600 /opt/nevix/.env
# 编辑固定 IP 与两个独立随机 URL-safe 密码；至少 24 字符，替换 change-me 示例。
./nevix-deploy install --manifest nevix-linux-amd64.json --bundle nevix-linux-amd64.tar.gz --directory /opt/nevix
```

验证先校验外部签名、大小、SHA-512，再处理 tar；拒绝越界路径、链接、额外文件、
重复项与不完整包。导入四个 linux/amd64 镜像后再次核验实际 config/平台 manifest
ID、层身份及签名绑定的固定上游 provenance，随后把真实不可变 `sha256:` ID 写入
`releases/<版本>/compose.yaml`。不要求 Docker load 保留 RepoDigest。归档和签名
应保留在独立备份中；安装目录不再保留大镜像 tar。

`install` 只接受尚未存在 `nevix_pgdata`、`nevix_tls`、`nevix_secrets` 的空实例；
已有实例使用升级/恢复入口。安装失败保留所有卷和日志，不自动删除数据。
`.env` 始终位于实例根目录，工具不会替换客户配置。项目固定 `nevix`，三个卷的
名字固定；版本目录变化不会产生另一组客户数据。其他管理命令也必须指定同一
`--env-file`、`--project-name` 和 `-f`：

```sh
docker compose --project-name nevix --env-file /opt/nevix/.env -f /opt/nevix/releases/<版本>/compose.yaml ps
docker compose --project-name nevix --env-file /opt/nevix/.env -f /opt/nevix/releases/<版本>/compose.yaml logs server
```

运行 Compose 没有 build，五个 service 全部 `pull_policy: never`、`linux/amd64`。
启动额外指定 `--no-build --pull never`；缺镜像/身份不符失败，不自动访问公共 registry。
只发布 nginx 443，自签 IP SAN、边缘 HTTP/2、TOFU、设置码保护均沿用部署手册。
完成首位 Admin 认领与独立 TLS 指纹交接，再向团队分发 Server URL。

## 厂商构建

在已提交且干净的源码 checkout 上执行：

```sh
./deploy/scripts/build-bundle.sh 1.0.0 1.0.0 1.0.0 /absolute/path/nevix-linux-amd64.tar.gz
```

参数依次是 Server 版本、最低 Desktop 版本、最早可升级 Server 版本、输出。
构建需要 Go、Git、Bash、Docker 的 containerd image store（已验证的 OCI save 形状）、
Docker registry 访问。builder 只从 `git archive HEAD deploy server` 提取 tracked
输入、按固定 digest 拉取上游，并构建明确版本的 Server/证书工具；闭集归档不含
源码/build context、真实 `.env`、签名私钥、客户数据库、TLS 私钥或主密钥。
完整归档生成后，由 stable 发布流程签名 URL、大小与 SHA-512；builder 不签名。

完整实例保护、隔离验证与明确恢复命令见
[`instance-backup-and-restore`](../scripts/instance-backup-and-restore.md)。原始签名包/清单
必须随版本保留，实例备份含客户秘密，不能放进公开成品仓库。

后续更新使用[Deployment Upgrade](../scripts/instance-upgrade.md)；不要重跑空实例 install，
不要将旧镜像当作数据库回滚。
