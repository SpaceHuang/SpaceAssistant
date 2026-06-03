# 多工作目录配置与切换需求规格

> 版本：v1.0  
> 创建日期：2026年6月3日  
> 状态：草案  
> 前置依赖：[settings-requirement.md](./settings-requirement.md)、[detail-panel-file-list-requirement.md](./detail-panel-file-list-requirement.md)

---

## 1. 概述

### 1.1 功能定位

将当前单一工作目录配置升级为**多工作目录列表管理**，用户可在设置中配置多个项目目录，并在右侧栏通过下拉选择快速切换当前工作目录。切换后，会话列表、文件树、Wiki 等数据均切换到对应目录的数据。

### 1.2 目标

| ID | 目标 |
|----|------|
| G1 | 用户可配置多个工作目录，支持添加、移除、设置默认 |
| G2 | 工作目录列表为空时阻止设置保存，确保至少有一个有效目录 |
| G3 | 右侧栏文件模块标题改为下拉选择器，快速切换当前工作目录 |
| G4 | 切换工作目录后，会话列表、文件树、Wiki 等数据同步切换 |
| G5 | 与现有飞书远程多工作目录路由设计兼容（见 [feishu-integration-phase3-design.md](../develop/feishu-integration-phase3-design.md) §2） |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| 向后兼容 | 仅配置单一 `workDir` 时自动生成默认 profile，无需迁移 |
| 数据隔离 | 每个工作目录拥有独立的会话数据、Wiki、Skill 等 |
| 快速切换 | 下拉选择器提供即时切换，无需进入设置页 |
| 必填约束 | 至少保留一个工作目录，列表为空时阻止保存 |

---

## 2. 数据模型

### 2.1 WorkDirProfile 结构（已有定义）

```typescript
interface WorkDirProfile {
  id: string              // 唯一标识
  name: string            // 显示名称，如 "SpaceAssistant"
  path: string            // 绝对路径
  aliases?: string[]      // 别名，用于飞书远程指令匹配
  isDefault?: boolean     // 是否为默认目录
  sensitive?: boolean     // 是否为敏感项目（飞书远程禁止执行）
}
```

### 2.2 AppConfig 扩展（已有字段）

```typescript
interface AppConfig {
  workDir: string                    // 当前激活的工作目录路径（兼容字段）
  workDirProfiles: WorkDirProfile[]  // 工作目录列表
  activeWorkDirProfileId: string     // 当前激活的 profile ID
}
```

### 2.3 数据隔离规则

| 数据类型 | 隔离方式 |
|---------|---------|
| 会话列表 | 每个工作目录独立的会话数据文件 |
| Wiki | `<workDir>/llm-wiki/` 目录独立 |
| Skill | 项目级 Skill 在 `<workDir>/.space-skills/` |
| 文件树 | 直接读取 `<workDir>` 目录内容 |
| 项目记忆 | `<workDir>/SPACEASSISTANT.md` |

---

## 3. 设置界面改造

### 3.1 通用 Tab 工作目录区块

将原有单一输入框改为**列表管理界面**。

#### 3.1.1 界面结构

```
┌─ 工作目录 ────────────────────────────────────────┐
│ [添加目录]                                         │
├────────────────────────────────────────────────────┤
│ ○ 默认  SpaceAssistant                            │
│   路径：E:\Develop\SpaceAssistant                 │
│   [编辑] [移除]                                    │
├────────────────────────────────────────────────────┤
│ ○        MyProject                                │
│   路径：E:\Develop\MyProject                      │
│   [编辑] [移除]                                    │
├────────────────────────────────────────────────────┤
│ …                                                  │
└────────────────────────────────────────────────────┘
```

#### 3.1.2 列表项布局

每个工作目录条目占两行：

| 行 | 内容 |
|----|------|
| 第一行 | 默认单选按钮（Radio） + 名称 + 编辑按钮 + 移除按钮 |
| 第二行 | 路径（灰色文字，缩进） |

#### 3.1.3 操作按钮

| 按钮 | 图标 | 行为 |
|------|------|------|
| 添加目录 | mingcute add_line | 弹出 Popover 或 Modal，输入名称并选择路径 |
| 编辑 | mingcute edit_line | 弹出 Popover，修改名称、路径、别名 |
| 移除 | mingcute delete_line | 确认后移除；若为默认则自动转移默认标记 |

#### 3.1.4 添加目录 Popover

| 字段 | 控件 | 说明 |
|------|------|------|
| 名称 | Input | 必填，建议使用项目名 |
| 路径 | Input + 目录选择按钮 | 必填，选择后自动校验写入权限 |
| 别名 | Input（逗号分隔） | 可选，用于飞书远程指令匹配 |
| 敏感项目 | Switch | 可选，标记后禁止飞书远程执行 |
| 确认 | Button | 校验通过后添加到列表 |

#### 3.1.5 默认目录逻辑

| 规则 | 说明 |
|------|------|
| 单选约束 | 列表中只能有一个默认目录 |
| 必选约束 | 列表非空时必须有一个默认目录 |
| 自动转移 | 勾选新默认时，原默认自动取消 |
| 删除转移 | 删除默认目录后，自动将第一个设为默认 |
| 首次添加 | 第一个添加的目录自动设为默认 |

### 3.2 保存校验

| 校验项 | 规则 | 错误提示 |
|--------|------|---------|
| 列表非空 | 至少有一个工作目录 | 「请至少添加一个工作目录」 |
| 路径有效 | 所有路径可写入 | 「目录 {name} 不可写入：{error}」 |
| 名称唯一 | 名称不可重复 | 「工作目录名称不能重复」 |
| 路径唯一 | 路径不可重复 | 「工作目录路径不能重复」 |

### 3.3 向后兼容

| 场景 | 处理方式 |
|------|---------|
| 仅配置 `workDir` | 自动生成 `{ id: 'default', name: '默认目录', path: workDir, isDefault: true }` |
| `workDirProfiles` 为空 | 从 `workDir` 字段迁移生成默认 profile |
| 新安装 | 首次打开设置时提示配置工作目录 |

---

## 4. 右侧栏工作目录选择器

### 4.1 标题改造

将 `DetailPanelFileList` 组件的标题「文件」改为**下拉选择器**。

#### 4.1.1 界面结构

```
┌─ detail-panel-top ────────────────────────────────┐
│ [SpaceAssistant ▾]  [新建目录] [刷新]             │  ← 下拉选择器 + 工具栏
├────────────────────────────────────────────────────┤
│ 📁 src/                                           │
│ 📁 docs/                                          │
│ …                                                 │
└────────────────────────────────────────────────────┘
```

#### 4.1.2 下拉选择器规格

| 属性 | 规格 |
|------|------|
| 控件 | Ant Design Select |
| 选项来源 | `config.workDirProfiles` |
| 当前值 | `config.activeWorkDirProfileId` 对应的 profile |
| 显示内容 | **仅显示 `profile.name`（目录名称），不显示完整路径** |
| 宽度 | 自适应内容，最小 120px，最大 200px |
| 样式 | 与原标题样式一致，无边框，下拉图标小号 |

**关键约束**：下拉选择器及其选项列表**仅显示目录名称**（`profile.name`），**禁止显示完整路径**。若 `profile.name` 为空，则自动从 `profile.path` 提取目录的 basename（如 `E:\Develop\SpaceAssistant` → `SpaceAssistant`）。

#### 4.1.3 选项列表

| 显示 | 内容 |
|------|------|
| SpaceAssistant | profile.name，默认目录显示星号或粗体 |
| MyProject | 非默认目录正常显示 |

默认目录在选项中可显示标记（如 `★ SpaceAssistant` 或粗体）。

### 4.2 切换行为

用户在下拉中选择新工作目录后：

| 步骤 | 操作 |
|------|------|
| 1 | 更新 `activeWorkDirProfileId` |
| 2 | 更新 `workDir` 字段（兼容） |
| 3 | 刷新会话列表（从新目录读取） |
| 4 | 刷新文件树（从新目录读取） |
| 5 | 刷新 Wiki 状态（检查新目录 Wiki 初始化） |
| 6 | 刷新项目记忆（读取新目录 SPACEASSISTANT.md） |
| 7 | 清空当前选中会话（避免跨目录数据混淆） |

### 4.3 切换确认

| 场景 | 处理 |
|------|------|
| 当前会话正在流式响应 | 提示「当前会话正在响应，请等待完成后再切换」 |
| 当前会话有未保存内容 | 无需特殊处理（会话数据实时保存） |
| 快速连续切换 | 防抖 300ms，避免频繁刷新 |

### 4.4 空列表处理

| 场景 | 显示 |
|------|------|
| `workDirProfiles` 为空 | 下拉显示「请先配置工作目录」，点击打开设置页 |
| 仅一个目录 | 下拉仍可点击，但选项只有一个 |

---

## 5. 数据切换详细流程

### 5.1 切换时数据刷新

```typescript
// 切换工作目录的 IPC 调用
await window.api.switchWorkDirProfile(profileId)
```

IPC 处理器执行：

| 序号 | 操作 | 说明 |
|------|------|------|
| 1 | 更新 `activeWorkDirProfileId` | 写入 DB |
| 2 | 更新 `workDir` | 写入 DB（兼容字段） |
| 3 | 返回新目录的会话列表 | 从 `<newWorkDir>/sessions/` 读取 |
| 4 | 返回新目录的配置快照 | Wiki、Skill 状态等 |

### 5.2 渲染进程响应

| 数据 | 刷新方式 |
|------|---------|
| 会话列表 | Redux `sessionSlice` 替换为新列表 |
| 文件树 | `FileTree` 组件 `workDir` prop 变化触发重新加载 |
| Wiki 状态 | Redux `configSlice` 更新 Wiki 配置 |
| 项目记忆 | `PROJECT_MEMORY_STATE` 重新加载 |
| 当前会话 ID | 清空，用户需重新选择 |

### 5.3 会话数据存储路径

| 目录 | 会话数据位置 |
|------|-------------|
| 原方案 | `{userData}/spaceassistant-data.json`（全局单一） |
| 新方案 | `{workDir}/.spaceassistant/sessions.json`（按目录隔离） |

**迁移策略**：
- 首次检测到新目录无会话数据时，从全局数据迁移（若全局数据属于该目录）
- 或：保持全局存储，但会话 metadata 增加 `workDirProfileId` 字段过滤

**推荐方案**：保持全局存储，会话增加 `workDirProfileId` 字段，切换时按该字段过滤显示。

### 5.4 会话数据结构扩展

```typescript
interface Session {
  // ... 现有字段
  workDirProfileId: string  // 新增：所属工作目录
}
```

| 规则 | 说明 |
|------|------|
| 新建会话 | 自动写入当前 `activeWorkDirProfileId` |
| 切换目录 | 会话列表仅显示 `workDirProfileId === activeId` 的会话 |
| 跨目录搜索 | 搜索结果可跨目录，点击时提示切换目录 |

---

## 6. 日志机制兼容性

### 6.1 当前日志系统架构

项目存在两套日志系统，均与工作目录强关联：

| 日志类型 | 文件路径 | 存储位置 |
|----------|----------|----------|
| Agent 日志 | `Agent-{YYYYmmdd}.log` | 开发态：`{项目根}/logs/`；打包态：`{workDir}/.agent/logs/` |
| 飞书 CLI 日志 | `FeishuCli-{YYYYmmdd}.log` | 同 Agent 日志目录 |
| 飞书审计日志 | `feishu-audit.log` | `{userData}/logs/`（全局共享） |

### 6.2 日志目录策略

**开发模式**（`npm run dev`）：
- 所有工作目录共享同一日志目录 `{项目根}/logs/`
- 原因：开发阶段便于集中查看，不受工作目录切换影响

**打包模式**（生产环境）：
- 日志按工作目录隔离，写入 `{workDir}/.agent/logs/`
- 原因：每个项目独立维护日志，便于问题定位

### 6.3 工作目录切换时的日志处理

| 阶段 | 操作 |
|------|------|
| 切换前 | 等待当前日志写入完成（`flushAgentLogger()`） |
| 切换中 | 更新 logger 的 `getWorkDir` 函数返回值 |
| 切换后 | 新日志自动写入新工作目录的日志目录 |

### 6.4 Logger 初始化与更新

```typescript
// 初始化时传入动态工作目录获取函数
initAgentLogger({
  getWorkDir: () => getCurrentWorkDir(),  // 动态获取，而非静态值
  isPackaged: app.isPackaged,
  mainDirname: __dirname
})

// 切换工作目录后，无需重新初始化
// getWorkDir() 会返回新的工作目录路径
```

### 6.5 日志事件扩展

新增工作目录切换事件：

```typescript
export type AgentLogEventName =
  | 'workdir.switch.start'
  | 'workdir.switch.done'
  | 'workdir.switch.error'
  // ... 现有事件

// 切换时记录日志
logAgentEvent('info', 'workdir.switch.start', {
  fromProfileId: oldProfileId,
  fromProfileName: oldProfileName,
  toProfileId: newProfileId,
  toProfileName: newProfileName
})
```

### 6.6 飞书审计日志

工作目录切换同样写入飞书审计日志：

```typescript
type FeishuAuditEvent = 
  | { type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
```

### 6.7 兼容性保障

| 保障项 | 说明 |
|--------|------|
| 无中断写入 | 切换时先 flush 再切换，避免日志丢失 |
| 动态路径 | `getWorkDir` 使用函数而非静态值，支持动态切换 |
| 开发/生产分离 | 开发态共享日志，生产态按目录隔离 |
| 向后兼容 | 单一工作目录时行为与原有一致 |

---

## 7. 飞书远程兼容

### 7.1 与 Phase 3 设计对齐

本需求与 [feishu-integration-phase3-design.md](../develop/feishu-integration-phase3-design.md) §2 设计一致：

| 对齐项 | 说明 |
|--------|------|
| `WorkDirProfile` 结构 | 完全复用已有定义 |
| 别名匹配 | 飞书远程指令可通过别名指定目录 |
| 默认目录 | 未指定时使用 `isDefault: true` 的目录 |
| 敏感标记 | `sensitive: true` 禁止远程执行 |

### 7.2 远程切换审计

飞书远程切换工作目录时写入审计日志：

```typescript
type FeishuAuditEvent = 
  | { type: 'workdir_switch'; profileId: string; profileName: string; ts: number }
```

---

## 7. 界面样式规格

### 7.1 设置页工作目录列表

| 元素 | 样式 |
|------|------|
| 列表容器 | 无边框，每项底部分割线 |
| 条目第一行 | `display: flex; align-items: center; gap: 8px` |
| 名称 | `font-weight: 500` |
| 路径 | `color: var(--ant-color-text-secondary); font-size: 12px; margin-left: 24px` |
| 按钮 | 小号图标按钮，无文字 |
| 默认标记 | Radio 使用 Ant Design 默认样式 |

### 7.2 右侧栏下拉选择器

| 元素 | 样式 |
|------|------|
| Select | `border: none; background: transparent; font-weight: 500` |
| 下拉图标 | `font-size: 10px; margin-left: 4px` |
| 选项 | 默认目录 `font-weight: 600` 或显示 `★` 前缀 |
| 宽度 | `min-width: 120px; max-width: 200px` |

---

## 8. IPC 通道扩展

### 8.1 新增通道

| 通道 | 方向 | 参数 | 返回 |
|------|------|------|------|
| `workdir:switch` | invoke | `{ profileId: string }` | `{ success: boolean, sessions: Session[], config: Partial<AppConfig> }` |
| `workdir:add` | invoke | `{ profile: WorkDirProfile }` | `{ success: boolean, error?: string }` |
| `workdir:remove` | invoke | `{ profileId: string }` | `{ success: boolean, error?: string }` |
| `workdir:update` | invoke | `{ profileId: string, updates: Partial<WorkDirProfile> }` | `{ success: boolean }` |
| `workdir:list` | invoke | — | `WorkDirProfile[]` |

### 8.2 复用现有通道

| 通道 | 改造 |
|------|------|
| `config:set` | 接收 `workDirProfiles` 和 `activeWorkDirProfileId` |
| `config:get` | 返回包含上述字段 |

---

## 9. 用户故事

### US-WD01：配置多个项目目录

**作为** 同时维护多个项目的开发者，**当** 我在设置中配置工作目录，**我希望** 可以添加多个项目路径并标记默认，**以便** 快速在不同项目间切换。

### US-WD02：快速切换当前项目

**作为** 正在开发 SpaceAssistant 的用户，**当** 我想切换到 MyProject 查看其会话历史，**我希望** 在右侧栏下拉直接选择，**以便** 无需进入设置页即可切换。

### US-WD03：防止误删所有目录

**作为** 配置工作目录的用户，**当** 我尝试移除最后一个工作目录，**我希望** 系统阻止并提示，**以便** 不会导致应用无工作目录可用。

### US-WD04：飞书远程指定项目

**作为** 手机飞书用户，**当** 我发送「在 SA 项目里跑测试」，**我希望** Agent 自动切换到 SpaceAssistant 目录执行，**以便** 远程操作正确项目。

---

## 10. 测试用例

### 10.1 设置页

| 用例 | 验证点 |
|------|--------|
| 添加第一个目录 | 自动设为默认 |
| 添加第二个目录 | 不自动设为默认 |
| 勾选新默认 | 原默认自动取消 |
| 移除默认目录 | 第一个自动成为新默认 |
| 移除最后一个目录 | 阻止并提示 |
| 保存时空列表 | 阻止保存，显示错误 |
| 路径不可写 | 显示错误，阻止添加 |
| 名称重复 | 显示错误，阻止添加 |

### 10.2 右侧栏切换

| 用例 | 验证点 |
|------|--------|
| 下拉显示 | 显示所有 profile 名称 |
| 选择新目录 | 会话列表刷新为新目录数据 |
| 选择新目录 | 文件树刷新为新目录内容 |
| 选择新目录 | Wiki 状态刷新 |
| 流式响应中切换 | 提示等待完成 |
| 空列表时点击 | 打开设置页 |

### 10.3 数据隔离

| 用例 | 验证点 |
|------|--------|
| 新建会话 | 自动关联当前 workDirProfileId |
| 切换目录 | 仅显示该目录的会话 |
| 切回原目录 | 原会话列表恢复显示 |

---

## 11. 实施任务拆分

| 序号 | 任务 | 说明 |
|------|------|------|
| T1 | 设置页工作目录列表 UI | 通用 Tab 改造 |
| T2 | IPC 通道实现 | workdir:* 通道 |
| T3 | 右侧栏下拉选择器 | DetailPanelFileList 改造 |
| T4 | 会话数据隔离 | Session 增加 workDirProfileId |
| T5 | 切换时数据刷新 | Redux 更新逻辑 |
| T6 | 向后兼容迁移 | 单 workDir 自动生成 profile |
| T7 | 飞书远程兼容 | 别名匹配、审计日志 |

---

## 12. 验收标准

- [ ] 设置页可添加、移除、编辑工作目录
- [ ] 设置页可勾选默认工作目录
- [ ] 工作目录列表为空时阻止保存
- [ ] 右侧栏显示工作目录下拉选择器
- [ ] 下拉选择后会话列表切换为新目录数据
- [ ] 下拉选择后文件树切换为新目录内容
- [ ] 新建会话自动关联当前工作目录
- [ ] 仅配置单一 workDir 时自动兼容

---

**文档结束**