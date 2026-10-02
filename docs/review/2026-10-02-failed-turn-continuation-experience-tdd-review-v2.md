# `codex/failed-turn-continuation-experience-tdd` 重审（第二轮）

结论：**请求修改，仍有 1 项阻断问题**。上轮 4 项问题已有对应修复：附件来源已归一化；普通 Turn、checkpoint continuation 与意图映射分别有原子提交路径；排队收据 ID 和摘要传递已补齐；来源选择增加了更新用户输入的边界检查。

## 阻断问题

1. **Critical：正在运行的 Turn 使“继续”无法进入排队路径。** `electron/outbound/outboundAcceptor.ts:369-375` 在出站分类之前读取会话最新 Invocation，并要求其末事件必须是 `invocation-completed` 或 `invocation-failed`；运行中的 Invocation 正常具有非终态末事件，因此直接返回 `CONTINUATION_INTENT_HISTORY_UNAVAILABLE`。用户在一个 Turn 运行期间输入“继续”时，后面的 `decideOutbound` 排队分支（`:563-569`）不可达，原输入和附件均未受理。上轮新增的排队测试仅把 `listActive` 设为运行中，未建立对应的非终态 canonical History，因此未覆盖真实场景。应将非终态最新 Invocation 视为当前运行边界，先完成受理/排队判断；如果旧失败来源已经被新任务覆盖，排队项应作为普通新输入处理。补含真实进行中 History 的受理与排水测试。

## 验证

- 定向测试：4 个文件、117 项通过。
- `npm run typecheck:renderer`、`npm run typecheck:shared`：通过。
- 全量 `npm test`：844 个测试文件通过、1 个跳过；7684 项通过、106 项跳过。
