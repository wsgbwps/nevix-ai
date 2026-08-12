# 09 — Desktop 成员/邀请管理 + 组织设置

**What to build:** 设置页组织组首次落地。按页面归属指令，设置页左导航分账户（个人资料、语言）/ 组织（成员、审计日志——入口在 ticket 10 接线，Member 角色不显示）两组，侧栏顶部为当前组织上下文卡（组织标 + 组织名 + 角色）。成员与邀请管理采用定稿的 B 标签页：成员 / 待定邀请（带计数徽标）；邀请创建/重发/撤销走对话框；角色变更用 Select；移除成员与退出组织均需确认对话框；Member 角色只读、无邀请按钮；成员行只显示显示名与角色（RLS 下他人邮箱不可见）。组织设置：Owner/Admin 可改组织名，变更即时反映到组织上下文卡与选择列表，Member 只读。**共享原语例外声明：本 ticket 将 dialog、tabs、badge 三个 shadcn 原语加入 components/ui/，已在 spec 登记、用户已裁决，PR 描述中显式声明该例外并接受附加审查。**

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；07 — Go 成员管理命令组 + 通知矩阵；08 — Desktop 邀请自动浮现 + 接受邀请流

**Status:** in-review — PR #46

- [x] e2e：Owner/Admin 完成邀请创建/重发/撤销、角色变更、移除成员、退出组织全流程（含确认对话框）
- [x] e2e：Member 角色只读——无邀请按钮、无角色 Select、无审计入口
- [x] 待定邀请计数徽标与实际 pending 数一致
- [x] 组织改名即时反映到上下文卡与组织选择列表
- [x] PR 描述显式声明 dialog/tabs/badge 共享原语例外及影响与测试
- [x] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier；走 feature branch + PR

## Comments

- Implementation: [PR #46](https://github.com/wsgbwps/nevix-ai/pull/46)
- Local acceptance: full Desktop E2E PASS（68 passed，4 skipped）；最终审查 ledger 关闭 1 个已修复 blocker，无未关闭 finding。
- `resolved` 状态与合并证据按 branch wrap-up checklist 留待 PR 合并后记录。
