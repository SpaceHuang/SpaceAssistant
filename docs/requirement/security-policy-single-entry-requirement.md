# 需求：安全策略整合后的设置入口单一化（去重）

## 1. 背景

工具确认框架分支（commit `a1ee519` → `13f4d40` → `7579d89`）把原先分散在各设置页的安全相关选项整合进了统一的「安全策略」页（`工具 → 安全策略`，组件 `src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`）。整合后：

- 原设置页里对应的设置界面**已被删除**，但保留了一个 `Alert` 迁移提示 + 「前往『安全策略』」按钮（`ToolsSecurityShortcut.tsx`），共三处：
  - Shell 设置 → 信任命令管理（`ShellSettingsTab.tsx:73`，i18n `shell.trust.movedHint`）
  - 浏览器设置 → 信任域名管理（`BrowserSettingsTab.tsx:257`，i18n `browser.trust.movedHint`）
  - 远程 IM 通用设置 → 远程确认开关与链路硬约束（`RemoteImCommonSettings.tsx:186`，i18n `remoteImCommon.confirmMovedHint`）
- 文件确认模式（`tools.confirmMode`）UI 从 `ToolsSettingsTab` 整体移除，**连迁移提示都没有**，仅测试注释说明。

## 2. 问题

迁移提示长期保留导致：

1. **入口语义混乱**：原设置页出现一个"不能操作、只告诉你去别处"的占位块，用户需要理解"这个选项搬走了"这一历史信息，认知负担高。
2. **新旧用户信息不对称**：新用户根本不知道这些选项"原来在这"，提示对他们是无效噪音；老用户经过若干版本后也已适应新位置。
3. **维护成本**：三处 hint 文案 + 组件 + 测试断言需要随安全策略页结构调整持续同步（例如子分区改名后文案失准）。
4. **迁移覆盖不一致**：文件确认模式迁移时未加提示，说明迁移提示机制本身没有统一标准，属于临时补丁而非法案。

数据层面不存在同步问题（新旧读写同一份配置，旧 UI 已删，唯一写入方是新页），本需求只解决**入口/界面层**的去重。

## 3. 目标

每个被整合进「安全策略」的设置项，在应用中**有且仅有一个操作入口**（安全策略页）；原设置页不留任何迁移占位 UI。迁移信息改由版本更新说明/一次性引导承担，而不是常驻界面元素。

## 4. 需求明细

### R1 移除常驻迁移提示组件

- 删除 `src/renderer/components/Config/ToolsSecurityShortcut.tsx`。
- 移除三处使用点：`ShellSettingsTab.tsx:73-74`、`BrowserSettingsTab.tsx:257-258`、`RemoteImCommonSettings.tsx:186-187`。
- 删除对应 i18n key：`shell.trust.movedHint`、`browser.trust.movedHint`、`remoteImCommon.confirmMovedHint`（zh-CN 与 en-US 的 `config.json`），并检查 `toolsSecurity.openPage` 是否仍被其他入口使用，无引用则一并清理。
- 更新/删除对应测试断言：`BrowserSettingsTab.test.tsx:136-137`、`RemoteImCommonSettings.test.tsx:51-59`，以及 `ToolsSecurityShortcut` 自身测试（如有）。

### R2 迁移信息仅由更新说明承载（不加界面引导）

**已确认采用方案 B**：仅在版本更新日志 / 应用内 What's New 中说明信任命令、信任域名、远程确认等选项已统一迁移至「安全策略」页，应用内不增加任何一次性提示或引导界面。

### R3 导航可达性补偿

移除原位置的提示后，保证用户仍能从语境中到达安全策略页：

- 在「工具」设置 Tab 内，「安全策略」子 Tab 保持现有位置与命名不变。
- 若全局设置支持搜索（现状无，则列入可选增强）：搜索"信任命令""信任域名""远程确认"等关键词可定位到安全策略页对应分区。

### R4 建立迁移规范（后续跟进）

> **状态：暂缓，作为后续跟进项**，不在本次变更范围内。本次代码变更（R1）已完成，R4 待后续单独落地。

在 `docs/develop/` 增补一条约定（可并入现有设置开发文档）：今后任何设置项跨页迁移，禁止在原位置保留常驻迁移 UI 超过**一个大版本**；迁移信息通过一次性提示或更新日志承载。

### R5 MCP「调用前确认」设置收敛进安全策略（方案已确认，待实施）

> **状态：已实施**（含行为保持迁移；迁移时 strict/loose 套餐链路保持原样，仅 standard 链路转 custom）。本条与 R1–R3 同一范式（同一类安全决策只能有一个入口），但涉及语义合并，单独列出。

#### 现状

- 每个 MCP server 的 profile 带有 `toolConfirmPolicy: 'always' | 'readonly-auto'` 字段（`src/shared/mcpTypes.ts:84`），UI 入口在 `McpServerForm.tsx:139` 的「调用前确认」下拉（i18n `mcp.confirmPolicyLabel/confirmAlways/confirmReadonlyAuto`）。
- 它在 `electron/confirmation/toolCallGate.ts:219-239` 的**事实提取阶段**生效：`always` → 产 `mcp-tool` 信号，落默认规则 `mcp-tool-ask`（`src/shared/policy/defaultRules.ts:236`）→ 询问；`readonly-auto` 且注解安全（`readOnlyHint === true && destructiveHint !== true`）→ 不产信号、actionClass 降为 `read` → 默认表放行。

#### 问题

1. **策略框架外的暗豁免**：被 `readonly-auto` 放行的调用不产生信号，在安全策略规则视图中不可见、审计不到规则命中；strict 套餐（「宁可多问」）无法将其上调为 ask，与套餐语义矛盾。
2. **per-server 粒度无可兑现的安全收益**：该设置的本质是「是否信任 server 单方面声明的、不可验证的只读注解」。对不信任的 server，正确动作是不接入（其只读工具的读取面与返回内容注入面都不是确认弹窗能 containment 的）；而新建 server 默认即 `readonly-auto`（`mcpDrafts.ts:73`），差异化实际几乎不发生。粒度存在、收益为零，代价是 N 份存储、N 个入口、复杂度随 server 数线性增长。

#### 变更方案

1. **事实提取改为纯信号**（`toolCallGate.ts` MCP 分支）：不再读取 profile；总是产 `mcp-tool` 信号（带 serverId/toolName）；注解安全时**额外**产新信号 `mcp-readonly`（在 `src/shared/confirmation/types.ts` 信号联合类型中新增，payload 同 `mcp-tool`）。actionClass：注解安全 → `read`，否则 → `write`。
2. **默认规则表**（`defaultRules.ts`）：在 `mcp-tool-ask` **之前**新增 `mcp-readonly-allow`（match `{ signals: ['mcp-readonly'] }`，action `allow`，非 locked），并注释顺序依赖。strict 套餐自动将其上调为 ask；自定义套餐可覆盖为 ask/deny——「全局始终确认」由规则覆盖表达，不再需要独立开关。
3. **删除 per-server 字段全链路**：`mcpTypes.ts`（`McpToolConfirmPolicy`、两处 zod schema、`mcpToolNeedsConfirmation`）、`mcpConfigStore.ts`、`mcpIpc.ts`、`mcpDrafts.ts`、`McpServerForm.tsx` 下拉、i18n key `mcp.confirmPolicy*`（zh-CN/en-US），以及相关测试（`mcpTypes.test.ts`、`mcpDrafts.test.ts`、`McpServerForm`/`McpSettingsTab` 测试、electron 侧 mock 中的该字段）。
4. **迁移**：启动迁移读取现有 profile；若**任一** profile 为 `always`，向 `policy_rules` 写入 `mcp-readonly-allow` → `ask` 的覆盖，并将受影响链路套餐置为 `custom`（规则覆盖仅在 custom 套餐下生效，`policyRulesRuntime.ts:85`；custom + 仅此一条覆盖与其余默认规则行为等价，属行为保持型迁移）。全部为 `readonly-auto` 则无需动作。
5. **确认记忆不受影响**：`mcp-tool` 会话信任键（`policyEngine.ts:82-87`）派生逻辑不变；`mcp-readonly` 命中 allow 规则、不进确认，无需派生缓存键。
6. **未来如需 per-server 差异化**：正确出口是规则引擎给 `mcp-tool` 信号匹配加 serverId 维度做 ask/deny 覆盖（表达「不信任该 server」），不恢复注解信任开关。本期不做。

#### 验收标准

1. MCP server 表单不再出现「调用前确认」下拉；安全策略规则视图可见 `mcp-readonly-allow` 条目。
2. 行为等价：原 `always` profile 迁移后只读注解工具仍需确认；原 `readonly-auto` profile 行为不变。
3. strict 套餐下只读注解 MCP 工具转为询问。
4. `tsc` 双 gate、`i18n-check`、electron 与 renderer 相关测试全部通过。

## 5. 非目标

- 不改动任何配置的存储 key、读写通道或默认值（`config.tools`、`decision_cache`、`config.wechat/feishu` 等保持原样）。
- 不改动安全策略页本身的五区结构与功能。
- 不做设置全局搜索功能（仅作为 R3 的可选后续）。

## 6. 验收标准

1. Shell 设置、浏览器设置、远程 IM 通用设置三页中不再出现 `ToolsSecurityShortcut` 或任何迁移提示文案。
2. `ToolsSecurityShortcut.tsx` 及三个 `movedHint` i18n key 从代码库中移除，`i18n-check` 通过。
3. 安全策略页功能不受影响：确认记忆管理（信任命令/域名）、策略规则、审计设置均可正常读写。
4. 版本更新说明中包含迁移关系说明（信任命令/信任域名/远程确认 → 安全策略页）。
5. 相关单元测试更新后全部通过（`BrowserSettingsTab.test.tsx`、`RemoteImCommonSettings.test.tsx` 等）。

## 7. 影响面

| 类别 | 文件 |
|---|---|
| 删除 | `src/renderer/components/Config/ToolsSecurityShortcut.tsx` |
| 修改（UI） | `ShellSettingsTab.tsx`、`BrowserSettingsTab.tsx`、`RemoteImCommonSettings.tsx` |
| 修改（i18n） | `src/renderer/i18n/resources/zh-CN/config.json`、`en-US/config.json` |
| 修改（测试） | `BrowserSettingsTab.test.tsx`、`RemoteImCommonSettings.test.tsx` |
| 修改（发布说明） | 版本更新日志中补充迁移关系说明 |
| 文档 | `docs/develop/` 迁移规范约定（R4，后续跟进，本次不变更） |
| R5（待实施） | `toolCallGate.ts`、`defaultRules.ts`、`confirmation/types.ts`、`mcpTypes.ts`、`mcpConfigStore.ts`、`mcpIpc.ts`、`mcpDrafts.ts`、`McpServerForm.tsx`、i18n `mcp.confirmPolicy*`、迁移代码及相关测试 |
