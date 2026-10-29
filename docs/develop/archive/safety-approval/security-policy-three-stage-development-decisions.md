# 安全策略三阶段架构实施口径

- 决定日期：2026-10-15（Asia/Shanghai）
- 交付范围：源码闭环，按计划“源码交付关闭门槛”验收。
- 外部验收：正式安装包、生产日志/数据库、跨平台文件系统真机、真实 IM/MCP 服务不在本次可控范围，记录为外部待验；不宣称已验证原生产现场或真实渠道。
- 阶段关闭：每个源码 Phase 收尾运行仓库要求的全量 `npm test`，通过后提交该阶段；中途迭代仅跑定向测试和必要门禁。
- 阶段顺序：服从计划 §7 DAG；P4-01 契约先行，P2-10 依赖其完成后再实现；外部发布验收 P5-08 不属于源码关闭的阻塞项。
- 底线目录落点初定：`src/shared/confirmation/systemInvariantRegistry.ts`，owner 为该共享确认域代码的维护者；由唯一静态表和 `src/shared/confirmation/systemInvariantRegistry.test.ts`（`npm exec vitest run src/shared/confirmation/systemInvariantRegistry.test.ts`）/CI 完整性检查维护；运行时代码不得读取该表计算 verdict；普通 policy locked/floor 仍留在策略规则契约中。该落点在 P3-01 复核并实现。
