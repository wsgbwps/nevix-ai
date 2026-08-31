# 切片 10 高风险实施计划:贯通图片生成(#160,spec #150)

Primary Domain:AI Creation;canonical owner:`creation`(server/internal/creation、apps/desktop features/creation、contracts/creation.yaml)。
高风险理由:持久数据 migration 0009、Provider Key 首次进入生成调用路径、输出形成 Media Asset 聚合。

## 现状基线(#159 已交付)

Task/Job/Slot 状态机、原子准入、治理、SKIP LOCKED 队列、worker、转存+探针、SSE、slot 私有下载端点、Desktop Workbench(composer/牌堆/菜单/四列结果卡/再生成/重试/indeterminate 确认)均已落地。#159 计划明确把 `media_assets` 聚合排到切片 10–12。

## 已确认缺口 → 交付物

1. **凭据接入**:`GenerationsClient` 不发 Authorization;`ProviderGateway` seam 无凭据参数。
   → `domain.ProviderGateway` 三方法增加 credential 参数;新增窄端口 `CallCredentialSource`;
   `ConnectionService.ActiveCallCredential`(GetActive→enabled/valid→vault.LoadKey→Open,明文仅调用期间存在);
   worker 在 driveSubmit 的 marker 事务**之前**解析凭据(失败=外部未执行,resetBudget hold,不产生 indeterminate);
   Poll/Cancel 前同样解析(失败=transient reschedule)。401/403 在途映射保持 transient(现有)。
2. **ratio 传达**:`submitImage` 现丢弃 Ratio、size 直传分辨率字面量。
   → 适配器内显式映射表 (ratio,resolution)→"WxH"(长边=1024/2048/4096,短边按比例取 8 的倍数,
   4:5 → 816x1024 / 1640x2048 / 3280x4096);manifest 外组合 fail-closed 报错,绝不静默替代。
   表是 release-gate 真实验收前的 pinned wire contract(沿用 generations.go 头注口径),一个常量可改。
3. **Media Asset 形成**:migration `0009_creation_media_assets.sql`(UNIQUE(task_id,slot_index)、
   不可变事实列、identity_app 仅 SELECT/INSERT);worker 在 transferAndPersist 同事务为成功 slot
   `ON CONFLICT DO NOTHING` 插入(重复 poll/恢复幂等;超额输出不建);图片输出探针后强制 mime=image/png,
   否则按转存失败 temporarily_unavailable。slot 事实列保留(Task 私有 Result),asset 行是独立聚合起点。
4. **policy rejection 快捷 retry 语义**:所有失败 slot 均为 input/output_policy_rejected 时,
   Desktop 不显示"只重试未完成项"(再次生成=编辑后新 Task 不受限)。Server 语义已对(不建 Asset)。
5. **Desktop 下载**:succeeded slot 卡片下载按钮(键盘可达),复用 loadResultBlobUrl +
   `<a download>`(nevix-<task>-<slot>.png)。原型无下载按钮,AC 明确要求,为记入 PR 的偏差增补。
6. **fake/E2E**:`scripts/dev/fake-kapon.mjs` 增加 POST /v1/images/generations(校验 Bearer+size+image
   数组,回临时 URL)+ GET 文件端点(PNG bytes);`apps/desktop/scripts/run-e2e.sh` 新增 image 组:
   启动 fake、写 readiness 证据文件(镜像 writeEvidenceFile 形状)、导出 KAPON_E2E_BASE_URL 与
   NEVIX_CREATION_READINESS_FILE;admin API 配置连接;spec:登录→建会话→prompt→提交→slot succeeded→下载。

## 测试(先测后码,seam 优先)

- kapon conformance(包内/记录式):auth header、size 映射表全 manifest 组合 property(completeness+确定性+长宽比)、
  402/429/503/400 分类、transport-lost→indeterminate、references 顺序。
- Module contract 真库(integrationtest):图片生命周期至 succeeded 且每 slot 恰一条 media asset;
  lease 重放/重复 poll 幂等(asset 不重复);部分成功 asset 保留;indeterminate/policy rejection 零 asset;
  超额输出不建 asset;非 PNG 输出 slot 失败。迁移测试含 0009 唯一约束。
- 边界:prompt 1–2000、reference-image 1–4 有序、8MiB/256–6000px/36MP/1:3–3:1(既有 upload 探针补断言)。
- Desktop component:下载按钮出现/触发、policy-rejected 无快捷 retry、960×600 主路径、键盘等价。
- Electron E2E:最短图片路径(见上)。

## 明确不做

视频(#161)、Asset Library/浏览端点(#162)、webhook、真实 Kapon 调用、OpenAPI contract 变更
(现有 TaskSubmit/Slot/result 端点已覆盖本切片 UI 所需)。

## 验证门

`go test ./...`(server)+ `make test-creation-integration` + desktop `pnpm test:unit`/
`test:component` + `image` E2E 组;QA 子代理逐项对照 #160 AC 验收。
