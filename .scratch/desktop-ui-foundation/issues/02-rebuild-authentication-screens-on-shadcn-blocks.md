# 02 — 认证界面统一重做（login-02 / signup-02 布局）

**What to build:** 未认证用户看到全新的认证区：登录、注册、注册验证、忘记密码、恢复验证、设置新密码六个界面，以及恢复中、恢复失败、配置错误三个状态界面，全部共享同一两栏外壳——左栏顶部品牌行加垂直居中表单，右栏品牌渐变封面面板（窗口宽度不足时封面自动隐藏，不使用任何图片资产）。表单控件统一为 shadcn Input/Label/Field。注册表单新增 Confirm Password：两次输入不一致时显示错误并禁止提交，其值不随注册请求发送。不出现社交登录按钮，也不新增 Full Name 等 Profile 字段。密码字节规则提示、存在性中立提示、错误映射、重发冷却、提交中去重、验证码专用输入交互等现有行为全部保留。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 六个认证 flow 界面与三个状态界面共享同一两栏外壳；小窗口下封面面板隐藏、表单保持可用
- [ ] 全部输入控件迁移到 shadcn Input/Label/Field（共享 UI 层新增，PR 描述说明影响与测试）；无残留手写原生 input 样式
- [ ] 注册表单含 Email / Password / Confirm Password；不一致时显示本地化错误且禁止提交；confirm 值不进入注册请求，signUp 契约不变
- [ ] 登录保留"忘记密码"与"创建账号"入口；无社交登录按钮及其分隔符；无 Full Name 字段
- [ ] 现有行为零回归：12–72 UTF-8 字节提示、存在性中立提示、登录/注册/验证/恢复错误映射、重发 60 秒冷却、提交中防重复、六位验证码过滤交互、全部 notice 文案
- [ ] 认证 flow 仍由 Authentication Feature 状态机驱动，无路由化
- [ ] 新增/调整文案在 authentication namespace 下双语（zh-CN/en）齐全，通过 i18n 资源契约
- [ ] 认证 e2e 按新 DOM 更新并全部通过；不锁定组件内部实现
- [ ] 架构校验通过：改动不越出 Authentication Feature 与共享 UI 层
