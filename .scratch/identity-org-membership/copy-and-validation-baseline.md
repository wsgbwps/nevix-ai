# Organization Membership 文案与字段规则基线（原型回填）

原型目录按仓库规则清理后，本文档是原型 `i18n.ts` / `validation.ts` 的定稿提炼，为实现期**唯一**文案与字段校验基线。只收录已裁决胜出变体的文案（onboarding B、picker A、members B、audit B、profile A、accessLost A）；原型脚手架（prototype bar）与落选变体文案不收录。实现落盘时按 Feature 归属折叠进各 Feature 自有的 i18n resources，不再保留独立的 prototype 资源文件。

## 字段规则（validation 基线）

| 字段 | 规则 | 错误 key |
| --- | --- | --- |
| 显示名 | trim 后 1–50 字符，拒绝纯空白 | `displayNameRequired` / `displayNameTooLong` |
| 组织名称 | trim 后非空 | `orgNameRequired` |

## 文案基线（zh-CN / en）

### 通用 common

| key | zh-CN | en |
| --- | --- | --- |
| displayName | 显示名 | Display name |
| displayNamePlaceholder | 其他成员看到的名字 | The name other members see |
| orgName | 组织名称 | Organization name |
| orgNamePlaceholder | 例如：星云设计 | e.g. Nebula Design |
| email | 邮箱 | Email |
| emailPlaceholder | name@example.com | name@example.com |
| cancel | 取消 | Cancel |
| save | 保存 | Save |
| back | 返回 | Back |
| continue | 继续 | Continue |
| close | 关闭 | Close |
| youSuffix | （你） | (you) |
| roles.owner | 拥有者 | Owner |
| roles.admin | 管理员 | Admin |
| roles.member | 成员 | Member |
| memberCount | {{count}} 名成员 | {{count}} members |
| validation.displayNameRequired | 请输入显示名（不能为纯空白） | Enter a display name (not whitespace only) |
| validation.displayNameTooLong | 显示名最长 50 个字符 | Display name is 50 characters at most |
| validation.orgNameRequired | 请输入组织名称 | Enter an organization name |

### 启动恢复 startup

| key | zh-CN | en |
| --- | --- | --- |
| restoring | 正在恢复你的工作区… | Restoring your workspace… |

### Onboarding（变体 B：两步向导）

| key | zh-CN | en |
| --- | --- | --- |
| stepLabel | 第 {{current}} 步，共 {{total}} 步 | Step {{current}} of {{total}} |
| profileHeading | 你怎么称呼？ | What should we call you? |
| profileDescription | 显示名会在所有组织中展示给其他成员，之后可以随时修改。 | Your display name is shown to other members in every organization. You can change it later. |
| orgHeading | 创建你的第一个组织 | Create your first organization |
| orgDescription | 业务资源归组织所有；组织名称之后可以修改。 | Business resources belong to organizations. You can rename it later. |
| next | 继续 | Continue |
| back | 上一步 | Back |
| submit | 创建组织并进入 | Create organization and enter |

### 组织选择界面 picker（变体 A：居中列表 + 邀请区）

| key | zh-CN | en |
| --- | --- | --- |
| heading | 选择组织 | Select an organization |
| subheading | 选择一个组织进入工作区，设备会记住你上次的选择。 | Pick an organization to enter. This device remembers your last choice. |
| signedInAs | 已登录 {{email}} | Signed in as {{email}} |
| createOrg | 创建新组织 | Create new organization |
| signOut | 退出登录 | Sign out |
| lastUsed | 上次使用 | Last used |
| inviteSection | 待加入的邀请 | Pending invitations |
| inviteLine | {{inviter}} 邀请你加入「{{org}}」 | {{inviter}} invited you to join "{{org}}" |
| accept | 接受 | Accept |
| codeLabel | 邀请码 | Invitation code |
| codeHint | 邀请码已发送到你的邮箱，6 位字符，7 天内有效。 | The code was emailed to you. 6 characters, valid for 7 days. |
| codeSubmit | 验证并加入 | Verify and join |
| codeInvalid | 邀请码不正确，还剩 {{count}} 次尝试 | Incorrect code, {{count}} attempts left |
| joined | 已加入「{{org}}」 | Joined "{{org}}" |
| enterOrg | 进入组织 | Enter organization |

### App Shell / 组织切换 shell

| key | zh-CN | en |
| --- | --- | --- |
| members | 成员 | Members |
| audit | 审计日志 | Audit log |
| createOrg | 创建新组织 | Create new organization |
| switchToPicker | 全部组织 | All organizations |
| homePlaceholder | 首页（业务 Feature 占位） | Home (business Feature placeholder) |

### 成员与邀请管理 members（变体 B：标签页）

| key | zh-CN | en |
| --- | --- | --- |
| title | 成员 | Members |
| inviteCta | 邀请成员 | Invite member |
| inviteDialogTitle | 邀请成员 | Invite member |
| inviteDialogDescription | 邀请码将发送到该邮箱；对方在 Desktop 输码后加入，默认角色为成员。 | A code is emailed to this address. They join as a Member after entering it in Desktop. |
| send | 发送邀请 | Send invitation |
| sent | 邀请已发送至 {{email}} | Invitation sent to {{email}} |
| membersTab | 成员 | Members |
| invitesTab | 待定邀请 | Pending invitations |
| pendingSection | 待定邀请（{{count}}） | Pending invitations ({{count}}) |
| emptyInvites | 暂无待定邀请。 | No pending invitations. |
| resend | 重发 | Resend |
| resent | 已重发，新邀请码 7 天内有效。 | Resent. The new code is valid for 7 days. |
| revoke | 撤销 | Revoke |
| revoked | 已撤销该邀请。 | Invitation revoked. |
| expires | {{days}} 天后过期 | Expires in {{days}} days |
| setAdmin | 设为管理员 | Make Admin |
| setMember | 设为成员 | Make Member |
| changeRole | 变更角色 | Change role |
| remove | 移除成员 | Remove member |
| removeTitle | 移除 {{name}}？ | Remove {{name}}? |
| removeDescription | 移除后其访问立即结束，并会收到邮件通知。该操作会记入审计日志。 | Their access ends immediately and they are notified by email. This is recorded in the audit log. |
| confirmRemove | 确认移除 | Remove |
| leave | 退出组织 | Leave organization |
| leaveTitle | 退出「{{org}}」？ | Leave "{{org}}"? |
| leaveDescription | 退出后你将失去该组织的访问权限，可经再次邀请加入。 | You will lose access to this organization. You can rejoin with a new invitation. |
| confirmLeave | 确认退出 | Leave |
| roleUpdated | 已更新 {{name}} 的角色。 | Updated the role of {{name}}. |
| memberReadOnly | 成员角色仅可查看成员列表。 | The Member role can only view the roster. |

### 审计日志 audit（变体 B：按天叙事时间线）

| key | zh-CN | en |
| --- | --- | --- |
| title | 审计日志 | Audit log |
| description | 组织安全事件，滚动保留 365 天，不可修改。 | Organization security events. Kept for 365 days, immutable. |
| filterAll | 全部事件 | All events |
| export | 导出 | Export |
| exported | 已导出 {{count}} 条记录。 | Exported {{count}} entries. |
| colTime | 时间 | Time |
| colActor | 操作者 | Actor |
| colAction | 动作 | Action |
| colTarget | 对象 | Target |
| colDetail | 详情 | Detail |
| actions.orgCreated | 创建组织 | Organization created |
| actions.invitationCreated | 发出邀请 | Invitation created |
| actions.invitationResent | 重发邀请 | Invitation resent |
| actions.invitationRevoked | 撤销邀请 | Invitation revoked |
| actions.invitationAccepted | 接受邀请 | Invitation accepted |
| actions.memberRemoved | 移除成员 | Member removed |
| actions.roleChanged | 变更角色 | Role changed |
| actions.settingsUpdated | 更新组织设置 | Settings updated |
| today | 今天 | Today |
| yesterday | 昨天 | Yesterday |

注：`exported` 在原型中带"（原型以浏览器下载模拟本地写文件）"说明，实现时为真实本地写文件，文案按上表去掉该括号。

### 个人资料 profile（变体 A：设置页区块）

| key | zh-CN | en |
| --- | --- | --- |
| navLabel | 个人资料 | Profile |
| title | 个人资料 | Profile |
| description | 显示名在所有组织中共享；登录邮箱不属于个人资料。 | Your display name is shared across organizations. Your sign-in email is not part of the profile. |
| saved | 显示名已更新。 | Display name updated. |
| menuEdit | 编辑显示名 | Edit display name |
| dialogTitle | 编辑显示名 | Edit display name |
| dialogDescription | 显示名在所有组织中展示给其他成员。 | Your display name is shown to other members in every organization. |

### 设置页框架 settingsChrome

| key | zh-CN | en |
| --- | --- | --- |
| groupAccount | 账户 | Account |
| groupOrg | 组织 | Organization |
| languageDescription | 选择 Desktop 界面的显示语言。 | Choose the language used in the Desktop interface. |

### 失权告知 accessLost（变体 A：阻断对话框）

| key | zh-CN | en |
| --- | --- | --- |
| title | 你已失去「{{org}}」的访问权限 | You lost access to "{{org}}" |
| description | 你的成员身份已结束。如果是误操作，请联系组织管理员重新邀请。 | Your membership has ended. If this was a mistake, ask an organization admin to invite you again. |
| confirm | 知道了 | Got it |
