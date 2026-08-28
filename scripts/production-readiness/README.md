# Production Readiness runner

Nevix 发布级 Production Readiness 的手动执行工具(spec #150、ticket #158;实际
探针执行归 T16 #166)。它以注入的凭据对固定国内 Kapon 路由执行 readiness
checklist 的真实调用,并把通过的证据记录为 Server 可加载的 evidence 文档;
Server 在启动时读取该文档,决定哪些媒体能力激活进 Capability Manifest。

## 安全纪律

- 凭据只经环境变量 `KAPON_API_KEY` 注入;缺失即拒绝执行。普通 CI 永不持有、
  永不读取该变量;本工具不进入任何普通 PR 流水线。
- 凭据不被打印、不落盘、不进入 evidence 文档。
- 只访问审核过的固定路由 `https://models.kapon.cloud`;没有可配置 Endpoint、
  没有 fallback。
- 只有真实执行且通过的 slot 才会追加 evidence entry;任何失败或未实现的
  探针都会响亮失败,绝不伪造证据。

## 与 Server 的单一事实源

checklist 定义在 `server/internal/creation/domain/readiness-checklist.json`,
由 Server `go:embed` 并被本脚本按仓库路径读取。slot id 在两侧逐字一致:
重命名必须同步进行,否则 Server 拒绝加载引用未知 slot 的 evidence 文档。

## 用法

```bash
# 枚举全部 checklist slot
node scripts/production-readiness/probe.mjs --list

# 目录 sanity 探测(真实 GET /v1/models,不记录证据)
KAPON_API_KEY=... node scripts/production-readiness/probe.mjs --check-credential

# 执行指定 slot 并把通过的证据追加进 evidence 文档
KAPON_API_KEY=... node scripts/production-readiness/probe.mjs \
  --slot image.resolution.2k --slot image.resolution.4k \
  --evidence-out /var/lib/nevix/secrets/production-readiness.json
```

T16(#166)之前,所有生成/探测类 slot 的执行实现尚未落地:执行会响亮失败并
指向 #166,不会写入任何证据。

## 激活与恢复

1. T16 按 checklist 逐 slot 执行真实调用;每个通过的 slot 记入 evidence 文档。
2. 将 evidence 文档放到部署机(官方 Compose 的默认路径为 secrets 卷内的
   `production-readiness.json`,见 `deploy/docker-compose.yml` 与 `deploy/README.md`)。
3. 重启 Server;`GET /creation/capability-manifest` 即发布已激活媒体的可提交值。
4. 证据损坏或引用未知 slot 时 Server 拒绝启动(fail loud);删除文件即回到
   "全部未激活"的出厂状态。

镜像侧的恢复:Evidence 丢失不产生安全问题 —— 只回到未激活状态;重新运行
checklist 得到新文档即可。主密钥的恢复流程与 readiness 无关(见 #157 交付的
凭据恢复)。
