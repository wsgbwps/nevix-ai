# 01 — Remembered Email 的安全登录闭环

**What to build:** 让返回的 User 在明确选择后，由当前设备安全记住最近一个成功密码登录响应中的权威邮箱；后续启动可直接从密码继续，但不保存密码、不延长 Session，也不让失败输入覆盖已验证设备状态。

**Blocked by:** None — can start immediately

**Status:** resolved

**Consumes**

- Authentication Domain 现有的加密 Session 封装与原子替换原则。
- Authentication typed IPC 的通用 invoke seam。
- Supabase 成功登录响应中的权威 `User.email`。
- Electron `safeStorage` 和既有 Desktop E2E/native secure-storage 验收 seam。

**Produces**

- 与 Session 独立的单槽 Remembered Email store interface，具有 read、replace 和 clear 行为。
- Authentication Domain-owned read/replace/clear typed IPC interface 与 handlers。
- 登录初始化、默认勾选、预填、初始焦点和非阻塞存储说明。

**Owns**

- Remembered Email 记录的版本、大小限制、加密存储、进程内 fallback、损坏删除和内部告警。
- 只有成功密码登录才 replace，取消勾选立即 clear，signup、recovery、Session restore 和 logout 不改变它的状态转换。
- Remembered Email 的 cross-process public interface；其他 ticket 不得向其中加入密码、token、User 列表、Profile 或 Organization 状态。

**Acceptance**

- [x] 成功登录仅保存 Supabase 响应中的权威邮箱；不同 User 的后续成功登录替换旧值。
- [x] 失败登录保留当前输入，不改变原保存值；重启后仍预填原值。
- [x] 存在 Remembered Email 时预填并聚焦密码；不存在时邮箱为空、复选框仍默认勾选并聚焦邮箱。
- [x] 取消勾选立即删除加密记录和进程内 fallback；重新勾选只表示下次成功登录愿意保存。
- [x] signup、signup verification、recovery、Session restore 和当前设备 logout 都不覆盖或清除 Remembered Email。
- [x] 安全存储不可用、Linux `basic_text`、加密失败或文件写入失败时不落明文；当前进程可继续使用该值并只说明一次。
- [x] 损坏或无效记录被删除、按空值继续，并产生不暴露实现细节的内部告警。
- [x] `Authentication Usability Desktop E2E`、Desktop lint/typecheck/build、packaged localization 与适用的 native secure-storage acceptance 通过。
- [x] 产品代码前在本 ticket 的本地 tracker 范围记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 即使其他十张票永不实现，本票仍可通过 Desktop E2E 和 native secure-storage acceptance 完整验收。

**Commutativity test:** 与 02–06 任意合并顺序都保持 main 完整且 CI 通过；与 03/04 的 Authentication UI 重叠只是机械性冲突。

## Implementation Plan

- **Acceptance boundary:** Remembered Email 仅在勾选后的成功密码登录中，以 Supabase 返回 User 的权威邮箱替换；失败登录、注册、恢复、Session restore 和 logout 不改变它；取消勾选立即清除；任何安全存储失败都不落明文且不阻断认证；启动预填、默认勾选、初始焦点和一次性非阻塞说明可通过 Desktop 用户界面观察。
- **Fixed point:** `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b` (`origin/main` at task start).
- **Primary Domain:** Desktop Authentication Domain.
- **Owning boundaries:** Remembered Email store 与 handlers 归 `apps/desktop/src/main/authentication/`; cross-process interface 归 `apps/desktop/src/shared/ipc/authentication/`; 登录状态与界面归现有 Authentication Feature 内最窄的 `model/`、`api/`、`ui/` 责任目录；验收场景归现有 Desktop Electron Playwright authentication seam；新增 Localized Surface 文案归 Authentication Feature 自有资源。
- **TDD seam:** 使用 spec 已确认的 Electron Playwright seam，按成功保存/替换、失败不覆盖、立即清除、启动预填与焦点、安全存储失败/损坏的垂直切片逐个 red → green；复用现有 native `safeStorage` acceptance，不新增前端单元测试框架。
- **Checks and review:** 开发中运行 focused authentication E2E 与 Desktop typecheck；完成后运行 ticket 要求的 lint/typecheck/build、packaged localization 和适用的 native secure-storage acceptance，再按 `code-review-findings/v1` 做一次 Standards/Spec 完整评审及必要的定向修复，最后绑定 final-state evidence。
- **Rollback:** 同一 PR 原子回滚 Authentication Domain store、typed IPC、登录 UI 与对应验收；不迁移数据库，不修改 Session 持久化契约，遗留密文对旧版本保持惰性。

## Comments

- 2026-08-14: [PR #53](https://github.com/wsgbwps/nevix-ai/pull/53) 已 squash merge 为 `5f1e2e9`。最终 head 的 [CI gate 31772615697](https://github.com/wsgbwps/nevix-ai/actions/runs/31772615697) 成功；Remembered Email Electron E2E、Desktop 静态检查/构建、packaged localization、原生安全存储验收与 final-state review 均通过，5 个 blocker 已关闭且无风险接受。
