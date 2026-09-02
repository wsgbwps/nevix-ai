# Production Readiness evidence 与业界实践的边界

> 研究日期：2026-09-01
> 状态：本研究促成了同日的架构收缩；当前决定见
> [ADR-0016](../adr/0016-ai-creation-v1-trusted-seams.md)。下文所述 runtime
> evidence 机制是变更前现状，不是当前运行合同。

## 研究问题与结论

研究的问题是：业界是否普遍采用“对真实第三方 AI Provider 逐 capability
slot 执行 smoke，生成版本化 JSON evidence，由 Server 启动加载，版本不匹配则
整个进程拒绝启动”的机制？

**没有找到要求这种完整形态的行业标准，也没有证据支持把它称为普遍做法。**
官方资料支持若干相邻但职责分开的实践：发布/运营就绪审查、部署门禁与可追溯
产物、渐进交付、运行时健康状态、AI 评估与验证。它们通常分别影响发布决定、
部署流量、单项功能或健康状态；没有一份规定应用进程必须加载真实第三方 smoke
的可变文件，更没有规定 schema 漂移应终止整个业务进程。

这是对所查资料的范围归纳，不是“所有公司从不这样做”的统计性断言。

## 变更前的 Nevix 机制

变更前，Nevix 将以下四项耦合在一起：

1. 手动 workflow 计划执行真实 Kapon smoke。
2. checklist 和 JSON evidence 以 schema/manifest version 绑定。
3. 部署方把 evidence 复制进 secrets volume 后重启 Server。
4. Server 启动解析 evidence；旧 schema 或未知 slot 会阻止整个进程启动。

本地开发又生成 synthetic evidence，但只在缓存文件不存在时生成。旧缓存不会随
schema 自动更新，因此直接造成了本次 `schema_version: 2` 被当前实现拒绝、
`make server` 失败的问题。与此同时，真实 generation/inspection probe 尚未实现，
所以复杂的运行时门禁还没有产生相称的真实发布保障。

## 一手资料显示的正常分层

| 实践 | 官方资料支持的职责 | 不等价于 |
| --- | --- | --- |
| Operational Readiness Review | AWS 将 ORR 定义为 GA 前及生命周期中的 checklist review/inspection | 应用启动读取 ORR 输出 |
| Deployment gate / artifact | GitHub Environment 在 deployment job 前执行保护规则；artifact 用于共享和归档 | artifact 自动成为运行时 policy |
| Progressive delivery | Argo Rollouts 在 analysis 失败时中止 rollout | 第三方依赖失败终止整个应用 |
| Feature evaluation | OpenFeature 让应用按 flag 值和默认值改变功能行为 | 原始测试日志就是 flag 配置 |
| Runtime health | Kubernetes 区分 startup、liveness、readiness；readiness 失败可停止导流而不杀进程 | 所有外部依赖异常都必须 startup-fail |
| AI evaluation | TFX 分开完整 evaluation 与小型 `ModelBlessing`，由 Pusher 消费 blessing | Nevix 的 JSON/slot/部署形态是行业标准 |

## 当前采用的轻量流程

- Capability Manifest 是随代码发布的版本化合同；Desktop 镜像允许值，Server
  执行权威校验。
- 普通 CI 使用 fake adapter 和契约测试，不持有生产 Kapon Token。
- 每个 Deployment Instance 只运行 Connection Check，确认 Token 与固定模型可见性。
- 首次正式发布、固定模型变化或供应商合同变化时，开发者人工走一次真实生成
  smoke，把结果记入 release checklist 或 issue。
- smoke 结果不进入 Server 配置、不控制能力激活、不要求部署方复制文件或重启。
- Provider 调用失败影响对应 Creation task/media，不影响 Server 其他业务启动。

这套流程牺牲了逐 slot 自动追溯，换取更小的个人开发与私有化运维成本；在真实
发布频率、团队规模或合规要求证明需要前，不再引入 attestation/activation 子系统。

## Sources

- [AWS Well-Architected：Operational Readiness](https://docs.aws.amazon.com/wellarchitected/latest/framework/ops-07.html)
- [GitHub Docs：Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub Docs：Store and share data with workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [SLSA terminology](https://slsa.dev/spec/v1.0/terminology) 与 [Provenance](https://slsa.dev/spec/v1.2/provenance)
- [Kubernetes：Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [OpenFeature：Evaluation API](https://openfeature.dev/docs/reference/concepts/evaluation-api/)
- [Argo Rollouts：Analysis](https://argo-rollouts.readthedocs.io/en/stable/features/analysis/)
- [TensorFlow TFX：Evaluator](https://www.tensorflow.org/tfx/guide/evaluator) 与 [ModelBlessing](https://www.tensorflow.org/tfx/api_docs/python/tfx/v1/types/standard_artifacts/ModelBlessing)
- [NIST AI RMF 1.0](https://doi.org/10.6028/NIST.AI.100-1)
