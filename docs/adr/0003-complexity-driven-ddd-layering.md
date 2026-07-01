# Go 后端按复杂度决定分层深度

复杂 module（如 videogen：异步编排、外部 AI 供应商适配、状态机）采用完整 DDD 四层（domain → application → infrastructure → interface）。简单 CRUD module（如 projmgmt）使用单文件 `module.go`，handler 和 storage 内联，等真正出现第二个 adapter 时再拆出 repository 接口。

## Considered Options

- **所有 module 统一四层**：对 projmgmt 级别的简单模块来说是纯粹的 ceremony，创建 4 个目录 + 4 个文件只为一个 CRUD handler。
- **所有 module 单文件起步**：videogen 的复杂度会让单文件迅速膨胀到不可维护。
- **按复杂度分层**：简单的保持简单，复杂的获得结构。判断标准是"出现第二个 adapter 时再拆"——一个 adapter 是假设的 seam，两个 adapter 才是真实的 seam。
