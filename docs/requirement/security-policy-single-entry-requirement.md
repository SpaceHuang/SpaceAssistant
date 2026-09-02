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
