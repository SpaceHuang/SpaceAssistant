# I-08 Butler task snapshot/resolver 集成记录（2026-10-05）

## 结论

I-08 完成。直接集成 `origin/main` 的 Butler task-level workDir/model-service 快照与 resolver；没有重做目录授权入口或新增配置策略。队列续跑在关闭并重开 SQLite 后仍保留 continuation intent、摘要和来源身份。

## 上游改动与存储分支冲突处理

- 主体复用 `origin/main` 提交 `01e373d3` 的 Butler task 配置校验、task/run 快照、model-service resolver、UI/API/preload 接线和原有测试；没有复制上游历史计划文档。
- `src/shared/api.ts`、`electron/main.ts` 的接口/活动 workDir profile 注入，及已有 `invocationAssembler.ts` 中按稳定 `modelId` 解析 `supportsThinking` 的逻辑，按上游实现并入现有存储代码；保留 storage 分支现有 History/usage/schema 行为。
- task 快照所需数据库字段和 v33 兼容迁移已在 I-01/I-02 的存储分支迁移链中；未引入与 storage schema v51 冲突的 main schema 版本号或重复迁移。
- 上游 `7a204bd9` 队列唤醒竞态行为已由 I-05 集成；本阶段只补 SQLite 重开后 continuation queue/intent 的验收，不复制第二套队列实现。
- 上游队列竞态测试夹具与 canonical History 契约不匹配；测试数据已补入其声明的 required user message，未改变生产 History 校验。

## 验收

- Butler task/config/invoker/IPC 定向测试：5 个文件、80 项通过；覆盖稳定 model ID、service、workDir 和 reasoning 快照，以及 mock provider 调用。未调用真实模型服务或真实用户 profile。
- Butler UI 与队列/迁移/assembler 定向测试：11 个文件、267 项通过。
- continuation SQLite reopen 回归：1 项通过；关闭原连接并重开数据库后，稳定 request ID 对应 intent 保持 `context-queue/queued`，领取后 turn 仍携带原 `sourceInvocationId`、`sourceTurnId` 和摘要。
- `npm run typecheck:shared`、`npm run typecheck:agent-sdk`、`npx tsc -p tsconfig.electron.json --noEmit`、`npm run i18n:check`、`git diff --check` 通过。
- `npm run typecheck:renderer` 当前失败于 `ChatView.tsx:588`：I-10 主线 `continuation-started` 联合类型尚未处理。此处保留至 I-10，不在 I-08 提前改 renderer。
- 一条额外合并回归命令因误包含完整 IM Hosted 授权矩阵而被中止；它不属于 I-08 验收范围，未据此宣称通过。Windows/外部平台验收按项目边界跳过。

## 范围

本切片只验证 Butler task 运行配置快照及存储/队列语义。Composer 目录选择/撤销继续复用 I-09 的 `origin/main` 实现；没有新增目录授权 UI、重复 IPC 或额外产品策略。
