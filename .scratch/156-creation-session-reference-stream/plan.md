# 高风险实施计划 — AI Creation V1 06/16(#156)

Spec: #150(切片 6)。Primary Domain: AI Creation,canonical owner `creation`(ADR-0012)。
本 PR 属高风险(public contract `contracts/`、持久数据 migration、授权 seam),按仓库规则先落计划。

## 前置依赖

- 依赖切片(1)–(5) 已全部合并(#[151]–[155]);#153 已交付,Blocked by 满足。
- 架构权威:ADR-0014(Go 唯一可信数据面)、ADR-0015(SLU + Go authz)、ADR-0016(trusted seams:
  creator-private 可见性、Creation domain-local 写事务、认证注入)、ADR-0003(复杂 Module 四层)。

## 验收边界(fixed point)

fixed point = 本分支 fork 自 origin/main 的 merge-base。scope 见下方 task-owned paths;
超出该集合的路径一律不改。

## 设计决定(规格内 implementation freedom 的最简形状)

### Server:creation 复杂 Module(ADR-0003 四层)

```
server/internal/creation/
├── module.go                    # LoadConfig / NewModule / Register / RunWorkers(唯一 lifecycle interface)
│                                # ErrUnexpectedDatabaseIdentity 再导出
├── domain/                      # Session、ReferenceMaterial 聚合根与值对象;Repository 接口
├── application/                 # 会话命令、素材命令(use-case 编排;不含 SQL/HTTP)
├── infrastructure/
│   ├── writetx/                 # domain-local 写事务 Runner(纪律同 identity/writetx,不 deep-import):
│   │                            #   以 identity_app 运行;构造时 + 每个写事务开始后校验
│   │                            #   session_user = current_user = identity_app;
│   │                            #   独占 begin/commit/rollback/cancel/panic 与 AfterCommit
│   ├── postgres/                # Session/Material Repository 实现 + keyset(cursor)编解码
│   ├── media/                   # 服务端权威探测:image(jpeg/png/webp 全解码)、MP4(H.264/m4a box 走查)、
│   │                            #   MP3(帧扫描/Xing/VBRI/CBR)、WAV(RIFF fmt/data);尺寸/像素数/时长/可读性
│   └── storage/
│       ├── store.go             # 内部 Storage interface(Put bounded+checksum / Get Range / Delete / Stat)
│       ├── filesystem.go        # production adapter(目录分片 blob/<u2>/<m2>/<uuid>)
│       ├── s3.go                # S3-compatible adapter(minio-go v7;ranged GetObject)
│       └── storagetest/         # 同一 conformance suite(仅测试可导入,upload/download/range/delete/checksum/cancel)
└── interface/http/              # chi handlers:multipart 流式上传(body 有界、超限即断)、Range 单区间下载
                                 # (206/Content-Range/on-the-fly checksum 校验,不一致中断流)、错误 envelope {"error","message"}
```

- **写路径纪律**:外部 Storage I/O 永不发生在持锁事务内。上传 = Put blob(有界流式 + SHA-256)
  → 成功后 Runner.Run(单条 INSERT);失败 best-effort 清理孤儿 blob。删除素材 = Run(DELETE row)
  + AfterCommit 删 blob。行不存在 ⇒ 素材不可用(满足「失败不留下可用素材」)。
- **认证注入**(ADR-0016):composition root 经 identity 新增的窄 accessor
  `(*identity.Module).SessionAuthenticator() authz.SessionAuthenticator` 取认证器,
  `creation.NewModule(ctx, pool, cfg, Deps{SessionAuthenticator})` 注入;creation 内部自建
  `authz.NewGuard`;全部 route 显式 RequireActiveUser。Admin 在本切片无任何 creation 路由
  (治理属后续切片)——creator-private 由查询层(WHERE owner=principal)+命令层共同强制,
  越权一律 404 不暴露存在性。
- **Module 挂载**:main.go 为每个 Module 开独立 chi Group(identity/creation 各自带 CORS +
  preflight twin HTTP skeleton;模块间互不 import,机制按契约刻意各自持有一份最小实现)。
- **Media 探测为 hand-written parser**(bbox: MP4/mvhd/mdia/hdlr/stsd(avc1|mp4a)、MP3 sync 扫描、
  WAV RIFF):时长是权威事实,可行包较少(abema/go-mp4 等),但自写范围有界(~400 行)且避免
  低维护依赖;go.mod 新增直接依赖仅 minio-go/v7 与 golang.org/x/image(webp 解码)。
- **上传大小上限(结构性常量,能力 manifest 属切片 8+)**:image ≤10 MiB(JPEG/PNG/WebP)、
  audio ≤50 MiB(MP3/WAV/M4A)、video ≤200 MiB(MP4/H.264);2–30s 时长包络、256–6000px、比例等
  generation 包络属提交时校验(spec「受限…素材不能进入新 Generation Specification」),
  上传只验类型/扩展名一致/上限/真实可读并记录实际宽高·像素·时长。
- **权利声明**:claims_version 整型列,V1 常量 1;升级只影响新行(不追溯)。

### OpenAPI-first contract

- 新增 `contracts/creation.yaml`(paths-only sibling,样式随 identity.yaml),master
  `contracts/openapi.yaml` 以 path-item `$ref` 聚合;info.version 0.10.0 → 0.11.0(只增不改)。
- 路径:`POST|GET /creation/sessions`,`GET|PATCH|DELETE /creation/sessions/{sessionId}`,
  `GET|POST /creation/sessions/{sessionId}/materials`,`GET|DELETE /creation/materials/{materialId}`。
- 复合 cursor:keyset(base64url JSON {created_at,id}),列表含全部排序键;不用 OFFSET。
- 稳定错误码(invalid_request/not_found/material_too_large/material_unsupported_media/
  material_unreadable_media/upload_malformed 等)逐一在 contract 描述;conformance 测试断言实际
  schema(required/enums/media types)+请求体形状(identity 只做 response 抽查——creation 用更完整
  的自有 validator,不加新共享层)。

### Migration(up-only,goose)

`NNNN_creation_sessions_and_reference_materials.sql`:两张表
(creation_sessions(owner_user_id→users FK+索引,name,created_at/updated_at/deleted_at;
部分索引 (owner_user_id,created_at DESC,id DESC) WHERE deleted_at IS NULL);
creation_reference_materials(session_id→sessions FK ON DELETE…保持行级联跟随会话语义再议:
会话逻辑删除不删素材 ⇒ 不用 CASCADE 行删除?FK 仍需 ON DELETE CASCADE 兜底硬删场景 +
每 FK 配对索引),kind/mime/byte_size/checksum/blob_key UNIQUE/宽高/像素/时长/claims_version;
CHECK 约束表达 kind 与维度一致性),末尾 GRANT … TO identity_app。

### Desktop(renderer Feature,无 Electron Main/IPC owner)

`features/creation/`:public index.ts 只导出页面组件 + runtime hook + resources;
api/(go client:multipart 上传、Bearer、稳定 reason 映射、镜像 contracts)、model/(runtime context,
沿用 authentication 模式)、ui/(Workbench 页:左侧私有 Session 列表 + 空态 + 右侧工作区 +
Reference 牌堆:48×64 折叠、hover/focus 展开、方向键焦点、Delete 删除、末尾添加入口、超宽横向滚动)。
thin route `app/routes/creation.tsx`,App Shell 侧栏入口,app i18n 聚合注册。

### 测试分层(Testing Decisions)

- **integration harness**:`make test-creation-integration` → `scripts/test-creation-integration.sh`
  (pinned postgres:17.5-alpine + minio,锁文件/端口断言/trap teardown 同 identity 版);
  gate var `NEVIX_CREATION_INTEGRATION_REQUESTED=1` ⇒ 缺环境 fail、零 skip、代表性 sentinel 必须全 PASS。
  覆盖:Module 契约(真库/真 FS/真 MinIO/fake-free)、migration、授权矩阵(creator/其他 member/admin)、
  会话生命周期、上传原子性与失败不留材、OpenAPI conformance、writetx role 拒绝、短文件流 smoke
  (并行上传/下载/Range/取消释放,~2 分钟)。
- **conformance suite**:filesystem+S3 共享 `storagetest`(两个 production adapters 同一 suite)。
- **Desktop**:playwright CT public-surface(files/fixtures 驱动 fake ports:loading/empty/error/
  keyboard 牌堆/竞态);HTTP adapter 轻量单测(URL/method/Bearer/reason mapping,node:test .mts)。
- **E2E 最短 tracer**:登录 → 打开 AI 创作 → 建会话 → 出现在列表(+上传一张 png → 牌堆出现);@smoke。
- **CI 分类**:`server/internal/creation/**` → server+e2e(classifier + tests 更新,fail-closed 兼容);
  server-ci.yml 增加 Creation integration step。

## Task-owned paths(验收边界内)

- `contracts/{openapi.yaml,creation.yaml}`
- `server/internal/creation/**`、`server/internal/identity/module.go`(仅新增窄 accessor)、
  `server/internal/migration/migrations/NNNN_*.sql`、`server/go.{mod,sum}`、`server/cmd/server/main.go`
- `apps/desktop/src/renderer/src/features/creation/**`、`.../src/renderer/src/app/routes/creation.tsx`、
  `.../app/shell/app-shell.tsx`、`.../app/i18n/*`(聚合注册)、desktop `tests/component/creation/**`、
  `tests/unit/*.test.mts`(creation http adapter)、`tests/e2e/creation/**`(或既有 e2e 目录约定)、
  `scripts/run-e2e.sh`(storage env)、e2e helpers 若需
- 根:`Makefile`(target)、`scripts/test-creation-integration.sh`、
  `scripts/classify-ci-changes.mjs` + `scripts/tests/classify-ci-changes.test.mjs`、
  `.github/workflows/server-ci.yml`
- `deploy/{docker-compose.yml,.env.example,Dockerfile.server?(storage 目录权限),README.md}`
- 共享区变更申报:`internal/*` 无变化(authz 只消费);contracts/openapi.yaml 是共享契约,
  PR 正文说明 impact。

## 顺序与验证

1. contracts + migration → verify: server `go build ./...` + migration 包测试
2. Go module(writetx/domain/storage/app/interface)逐层 → verify: package unit tests
3. harness + scripts + CI 分类 → verify: `make test-creation-integration` 本地绿、zero-skip 断言过
4. Desktop feature + CT + E2E → verify: typecheck/test:component/test:e2e-smoke 相关子集
5. QA 逐项 AC 对照(见 issue checklist)→ `/code-review` initial → disposition → targeted 收敛 → PR
