# #340 真实后端大制品准备证据

已准备真实 Linux amd64 四镜像实验包，仅用于 CNB 大制品分发实验。**没有上传，未通过完整离线部署或升级验收，不是正式发行，不接受或取代 ADR-0013 / ADR-0026。**

- 输入 commit：`6f81e33aacbd214be35ea5ce71c51d12baf9f29e`。
- 制品：`.scratch/340-release-feasibility/cnb-upload-review/backend/nevix-backend-EXPERIMENTAL-linux-amd64-6f81e33.tar.gz`。
- 外包大小：`139659351` 字节（约 133.19 MiB）。
- 外包 SHA-256：`b60fab884cc862edafe0e48499e1a6f096ae948eaad80b1f58b2bd7fe4c80ab9`。
- 内部真实 `docker save`：`141867520` 字节；SHA-256 `a738f0b57062bed6df0c50fb4d80d7d510b91d1d3ddd75a3e362f0a06d3b70f8`。
- 构建环境：macOS 26.6.2 / Apple Silicon、OrbStack Docker Engine 29.4.0、Compose 5.1.2；镜像、归档只选择 `linux/amd64`。时间：2026-10-09。

## 实际镜像与身份

使用现有已提交 `deploy/Dockerfile.server` / `deploy/cert-init/Dockerfile` 构建真实 Nevix Server 与证书工具，拉取现有 Compose 精确 digest 的 Nginx / PostgreSQL，没有增加假数据或 padding。私有构建输入通过 `git archive` 导出到独立 scratch 目录，未把未跟踪文件或真实 `.env` 放入 context。现有正式镜像 tag、部署源码及 Compose 均未修改。

| 归档 tag                                         | 当前 Docker29 inspect ID / 平台 manifest digest                           | 归档 config digest                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `nevix-release-experiment-nginx:1.28.0-6f81e33`  | `sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c` | `sha256:c318e336065b17ff460aeac6d14bce5d0b13e35f25d5cb1843b635359fc00c9a` |
| `nevix-release-experiment-server:340-6f81e33`    | `sha256:8b6d5449fb2697190084231e36743cdb3bdaf3b7005a128f6fb585812d24783e` | `sha256:a6588c79ea1ce8208c6bb5b005dd2f2113f6bd1eda67a2a6411cf8730ea2be63` |
| `nevix-release-experiment-cert-init:340-6f81e33` | `sha256:6cc068fcf96ee206e8d1d6d2c716438fa387f60f20d8c1b34b55f77fd21c5026` | `sha256:be8290431b74bc5b05f5eaafbd928b0338607fd0b149fcde305953a51f970757` |
| `nevix-release-experiment-postgres:17.5-6f81e33` | `sha256:ec68817297c5984a00c85c9e3bbd88079d0217284f1a3f0525603a6f9b883916` | `sha256:deedec4d7fe463f0d7dac743340b1f6ebc12fdf788510ab616dbe6da9e1d9c1e` |

每个运行镜像的 JSON config 均验证为 `linux/amd64`。Docker29 的本机 inspect ID 与归档 OCI 平台 manifest 相同；旧 Docker 使用 config ID 的情况没有在此替代验证。`manifest.EXPERIMENTAL.json` 同时保留两种身份、归档 layer digest 和实际观察到的 RepoDigests。固定上游来源分别为：

- Nginx：`nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284`。
- PostgreSQL：`postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa`。
- Nevix 构建基础镜像沿用提交中的 Go / Alpine 固定 digest；证书工具安装 OpenSSL 的步骤也保持原状。没有承诺再次构建产生完全相同字节；当前制品按实测摘要识别。

## 候选公开内容与静态核对

仅上面的一个 `.tar.gz` 是候选上传制品；相邻 build log、完整 inspect、扫描器、私有构建 context 不属于上传清单。外包实际解压后包含以下 8 个常规文件：

```
.env.example
README.EXPERIMENTAL.md
SHA256SUMS
compose.EXPERIMENTAL.yml
images.tar
manifest.EXPERIMENTAL.json
nginx/nginx.conf
postgres/init-identity-app.sh
```

`.env.example` 只含已提交公开占位配置，没有读取真实部署 `.env`。PostgreSQL 首启脚本、证书工具镜像内的 `cert-init.sh`、Nginx 配置以及上游镜像自带的可执行脚本/配置属于实际运行制品，需随包分发；这不是仓库源码检出或原始 Go/TypeScript 源码包。公开文件审核应包含这些解释执行的运行资产。

已在 scratch **实际提取外包**，限制条目必须为上述闭集且没有 symlink、绝对路径或父目录跳转，逐个验证 `SHA256SUMS` 中全部 7 项。真实 Docker 归档 45 个 tar 条目、4 个运行镜像、24 个去重 runtime layers；流式读取内层 tar 扫描 6,345 个条目、3,936 个常规文件，结果：

- 无 `.go` / `.ts` / `.tsx`、`.git` 或真实 `.env` 文件路径。
- 无实际完整 PEM 私钥块。
- 无客户 PostgreSQL 数据文件、数据库 dump/backup、`server.key` / `server.pem` 或 `provider-credential-master.key` 文件路径。
- 仅有实际构建出的运行镜像与原始上游运行资产；未导出任何既有容器/客户 volume。

这些检查证明本次明确的条目/规则，不等于对任意二进制秘密或未来构建的全面保证。旁边 `artifact-review.json`、`outer-tar-entries.txt`、`docker-save-entries.txt`、`static-scan.json` 和 `runtime-layer-paths.private.json` 保存本次复核证据。

## 实验 Compose 差异及 smoke

scratch 的 `compose.EXPERIMENTAL.yml` 沿用现有服务、网络、权限、依赖和运行配置，只作制品实验需要的修改：移除两处 `build`，所有服务显式 `platform: linux/amd64` / `pull_policy: never`，替换为明确实验 tag，并把 project name 从 `nevix` 改为 `nevix-release-experiment-340`。改名防止实验资产误碰正式 named volumes，不是接受正式实例身份迁移。

使用公开 `.env.example` 运行 `docker compose ... config --quiet` 通过；**未运行 compose up，未 docker load，未初始化 PostgreSQL、生成 TLS/主密钥或挂载生产卷**。image tag 本身不是可信身份，不能假定 save/load 保留 RepoDigests；空 Linux 主机导入后的身份验证和实际禁止公网拉取的首次启动仍待单独验收。

只启动过一个隔离 Server smoke 容器：`--network none --read-only --cap-drop ALL --security-opt no-new-privileges`，未传部署环境变量、挂卷或发布端口。进程退出码 `1`，输出：`identity: missing required deployment variable: CORS_ALLOWED_ORIGINS`。这验证缺配置 fail closed，不是服务健康、数据库连接、迁移或恢复验收。

## 可复查命令

从仓库根目录执行；以下仅构建/拉取/保存或只读检查，不启动部署：

```sh
mkdir -p .scratch/340-release-feasibility/backend-build-input
 git archive 6f81e33aacbd214be35ea5ce71c51d12baf9f29e server deploy/Dockerfile.server deploy/cert-init deploy/docker-compose.yml deploy/nginx/nginx.conf deploy/postgres/init-identity-app.sh deploy/.env.example | tar -x -C .scratch/340-release-feasibility/backend-build-input
 docker build --platform linux/amd64 --label org.opencontainers.image.revision=6f81e33aacbd214be35ea5ce71c51d12baf9f29e -t nevix-release-experiment-server:340-6f81e33 -f .scratch/340-release-feasibility/backend-build-input/deploy/Dockerfile.server .scratch/340-release-feasibility/backend-build-input/server
 docker build --platform linux/amd64 --label org.opencontainers.image.revision=6f81e33aacbd214be35ea5ce71c51d12baf9f29e -t nevix-release-experiment-cert-init:340-6f81e33 .scratch/340-release-feasibility/backend-build-input/deploy/cert-init
 docker pull --platform linux/amd64 'postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa'
 docker pull --platform linux/amd64 'nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284'
 docker tag 'postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa' nevix-release-experiment-postgres:17.5-6f81e33
 docker tag 'nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284' nevix-release-experiment-nginx:1.28.0-6f81e33
 docker image save --platform linux/amd64 -o .scratch/340-release-feasibility/cnb-upload-review/backend/bundle/images.tar nevix-release-experiment-server:340-6f81e33 nevix-release-experiment-cert-init:340-6f81e33 nevix-release-experiment-postgres:17.5-6f81e33 nevix-release-experiment-nginx:1.28.0-6f81e33
 docker compose --env-file .scratch/340-release-feasibility/cnb-upload-review/backend/bundle/.env.example -f .scratch/340-release-feasibility/cnb-upload-review/backend/bundle/compose.EXPERIMENTAL.yml config --quiet
 docker run --rm --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges nevix-release-experiment-server:340-6f81e33
 COPYFILE_DISABLE=1 tar -czf .scratch/340-release-feasibility/cnb-upload-review/backend/nevix-backend-EXPERIMENTAL-linux-amd64-6f81e33.tar.gz -C .scratch/340-release-feasibility/cnb-upload-review/backend/bundle .
 shasum -a 256 .scratch/340-release-feasibility/cnb-upload-review/backend/nevix-backend-EXPERIMENTAL-linux-amd64-6f81e33.tar.gz
```

现成 scratch 的扫描与实际提取复核命令：`python3 .scratch/340-release-feasibility/backend-build-input/scan-artifact.py`、`python3 .scratch/340-release-feasibility/backend-build-input/verify-artifact.py`。它们不是部署工具，也不进入候选公开文件。

未测：离线 load/身份保持、完整首次部署、维护排空、migration、备份恢复、大陆三网完整下载。制品未上传、未作为受信生产发行签名；最终正式后端发行仍须自己的完整验收。
