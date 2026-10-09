# abcc-cli 代理守则

AstroBox 表盘资源的发布 / 更新命令行工具。结构与约定见 README.md「实现说明」。

- 发布规则（manifest、校验、版本、表盘 ID、PR）一律复用子模块 `vendor/AstroBoxCreatorConsole/app/` 的函数，不在本仓库复制或重写。确需改动 ABCC 时，提交到子模块的 `cli-support` 分支并更新子模块指针。
- 流程编排放 `packages/publish-core/src/`，命令行交互放 `cli/`。
- 测试放 `tests/`，不得访问真实网络：GitHub 用 `tests/fake-github.ts`，AstroBox 接口用 `mock.module`。改全局状态（账号、环境、localStorage、fetch）的测试必须在结束时还原。
- 提交前运行 `bun run typecheck` 与 `bun test`。
