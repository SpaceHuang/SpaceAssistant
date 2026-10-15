# 确认卡片信任机制优化 — 产品需求文档

**版本：** 1.5  
**日期：** 2026-06-06  
**状态：** 已精简（移除频率限制 C8）  
**关联文档：** 
- [shell-command-tool-requirement.md](./shell-command-tool-requirement.md)（Shell 命令确认卡片）
- [web-browser-tools-requirement.md](./web-browser-tools-requirement.md)（网页访问确认卡片、可信域名机制）
- [tools-requirement.md](./tools-requirement.md)（工具确认框架）
- [remote-private-chat-security-optimization-requirement.md](./remote-private-chat-security-optimization-requirement.md)（v1.6：结构化 Shell 信任；字符串 `startsWith` 不再满足发布门槛）

> **跨文档同步（2026-07）：** 远程 IM「确认并信任」须写入结构化 argv 范围；含 Shell 元语法的命令不可信任、不可命中免确认。冲突以远程私聊安全需求 v1.6 为准。

---

## 目录

1. [概述](#1-概述)
2. [问题分析](#2-问题分析)
3. [目标与非目标](#3-目标与非目标)
4. [用户故事](#4-用户故事)
5. [设计方案](#5-设计方案)
6. [安全与权限](#6-安全与权限)
7. [UI 与交互设计](#7-ui-与交互设计)
8. [数据模型变更](#8-数据模型变更)
9. [实现要点](#9-实现要点)
10. [验收标准](#10-验收标准)
11. [相关文件](#11-相关文件)
12. [多语言资源规划](#12-多语言资源规划)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前的确认机制存在以下问题：
- **Shell 命令**：每次执行都弹出确认卡片，用户需要频繁确认，尤其在执行一系列相似命令时体验不佳
- **网页访问**：虽然已有可信域名机制，但内置可信域名数量有限，用户需要手动添加到设置页，操作繁琐

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 降低操作摩擦 | 用户可在确认卡片一键信任，无需反复确认 |
| 智能信任 | 区分高风险操作，仅对低风险操作提供信任选项 |
| 持久化信任 | 域名信任写入配置，跨会话生效 |
| 安全可控 | 信任列表可在设置页查看和管理 |

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **风险感知** | 高风险操作（如敏感路径、注入风险）不提供信任选项 |
| **用户控制** | 信任关系可在设置页查看、编辑、删除 |
| **透明度** | 信任操作后有明确提示，说明后续行为 |
| **最小权限** | 信任范围精确（命令级别或域名级别） |

---

## 2. 问题分析

### 2.1 当前痛点

| 场景 | 当前体验 | 期望体验 |
|------|----------|----------|
| 执行 `npm install` | 每次都弹出确认卡片 | 首次确认后，后续不再询问 |
| 执行 `git status` | 每次都弹出确认卡片 | 首次确认后，后续不再询问（低风险） |
| 访问常用网站 | 每次都弹出确认卡片，或需手动添加可信域名 | 确认时一键信任，自动加入可信域名 |

### 2.2 现有能力差距

| 差距 | 影响 |
|------|------|
| Shell 命令无信任机制 | 用户重复确认，操作效率低 |
| 域名信任需手动配置 | 操作路径长，用户体验差 |
| 无风险级别判断 | 无法区分安全命令与危险命令 |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | Shell 命令确认卡片添加「信任此命令」选项，低风险命令可跳过后续确认 |
| G2 | 网页访问确认卡片添加「信任此域名」选项，自动加入可信域名 |
| G3 | 高风险操作（敏感路径、注入风险）不显示信任选项 |
| G4 | 设置页提供信任列表管理功能（查看、删除） |
| G5 | 信任操作有明确反馈，告知用户后续行为 |
| G6 | 设置页「脚本执行」模块添加「大模型生成的脚本自动允许执行」选项，默认关闭 |
| G7 | 设置页「文件操作」模块的「文件写入确认模式」新增第三个选项「自动放行安全写入」，仅对满足安全要求的写入操作免确认 |

### 3.2 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| NG1 | 不支持信任整个工具 | 仅支持命令级或域名级信任 |
| NG2 | 不支持全局免确认 | 始终保留用户确认能力 |
| NG3 | 不自动信任高风险命令 | 安全优先，敏感操作必须确认 |

---

## 4. 用户故事

### US-01：信任 Shell 命令

**作为** 开发者，**当** 我确认执行 `npm install` 时，**我希望** 能选择「信任此命令，后续不再询问」，**以便** 后续执行相同命令时无需重复确认。

### US-02：信任常用域名

**作为** 用户，**当** 我确认访问 `https://docs.github.com/...` 时，**我希望** 能选择「信任此域名，后续不再询问」，**以便** 自动将 `github.com` 加入可信域名，后续访问同域名不再确认。

### US-03：高风险命令无信任选项

**作为** 注重安全的用户，**当** Agent 执行涉及敏感路径的命令时（如 `cat ~/.ssh/id_rsa`），**我希望** 确认卡片不显示信任选项，**以便** 每次都必须手动确认。

### US-04：管理信任列表

**作为** 用户，**我希望** 在设置页查看和管理已信任的命令和域名列表，**以便** 可随时移除不再信任的项。

### US-05：大模型生成脚本自动执行

**作为** 高级用户，**我希望** 在设置页「脚本执行」模块中开启「大模型生成的脚本自动允许执行」选项，**以便** 模型生成的脚本无需手动确认即可直接执行。

### US-06：自动放行安全写入

**作为** 频繁使用 Agent 修改项目文件的开发者，**当** 我在设置页将「文件写入确认模式」切换为「自动放行安全写入」时，**我希望** Agent 对工作目录内、未命中敏感路径、规模合理的 `write_file` / `edit_file` 调用自动放行，**以便** 减少在常规重构、批量改名、生成模板代码场景下的人工确认次数；**同时** 对任何不满足安全条件的写入仍弹出 diff 卡片，确保关键写入仍在我的控制下。

---

## 5. 设计方案

### 5.1 Shell 命令信任机制

#### 5.1.1 信任条件

仅对**低风险命令**显示信任选项：

| 条件 | 是否显示信任选项 |
|------|------------------|
| 无注入风险（无 `$()`、反引号等） | ✅ |
| 无提权风险（无 `sudo`、`doas`） | ✅ |
| 无重定向（无 `>`、`>>`） | ✅ |
| 无敏感路径命中 | ✅ |
| 命令路径在 workDir 内 | ✅ |
| 以上任一不满足 | ❌ |

#### 5.1.2 信任规则

| 项 | 规则 |
|----|------|
| 信任范围 | 命令**前缀匹配**（命令 + 主参数级别） |
| 存储位置 | `ShellConfig.trustedCommands`（持久化） |
| 生效范围 | 全局，跨会话（不区分工作目录） |
| 优先级 | 高于默认确认策略 |

**信任匹配逻辑：**
```
用户执行命令 → 检查是否匹配 trustedCommands 中的命令前缀
              → 匹配成功且无安全警示 → 直接执行，不弹出确认卡片
              → 不匹配或有警示 → 弹出确认卡片（可选择信任）
```

**前缀匹配示例：**
| 已信任命令 | 自动信任的衍生命令 |
|------------|--------------------|
| `npm install` | `npm install react`, `npm install -D typescript` |
| `git status` | `git status --short`, `git status -s` |
| `node -v` | `node --version` |

#### 5.1.3 信任记录结构

```typescript
interface TrustedShellCommand {
  id: string                    // UUID
  command: string               // 命令前缀（如 "npm install"）
  createdAt: number             // 创建时间戳
  lastUsedAt?: number           // 最后使用时间
}
```

#### 5.1.4 信任记录清理策略

为防止信任记录无限增长，系统采用以下清理策略：

| 清理条件 | 触发行为 | 说明 |
|----------|----------|------|
| `lastUsedAt < 当前时间 - 90天` | 标记为过期 | 超过 90 天未使用标记为过期 |

**清理操作：**
1. **过期标记**：系统定期检查（每次启动或每周），将超过 90 天未使用的记录标记为过期
2. **手动清理**：用户可在设置页一键清理所有过期记录，过期记录在列表中直接显示"已过期"状态

### 5.3 大模型生成脚本自动执行

#### 5.3.1 功能说明

在设置页「脚本执行」模块中添加「大模型生成的脚本自动允许执行」开关选项，默认关闭。

| 项 | 说明 |
|----|------|
| 选项名称 | 大模型生成的脚本自动允许执行 |
| 默认值 | 关闭（false） |
| 生效范围 | 全局，跨会话 |
| 优先级 | 高于信任命令匹配（开启时跳过所有确认） |

#### 5.3.2 启用后的行为

| 场景 | 行为 |
|------|------|
| 模型调用 `run_shell` | 直接执行，不弹出确认卡片 |
| 高风险命令检测 | 仍执行安全检查，检测到高风险时拒绝执行并提示 |
| 审计日志 | 记录 `shell.auto_allow.execute` 事件 |

#### 5.3.3 安全边界

| 风险类型 | 缓解措施 |
|----------|----------|
| 恶意脚本自动执行 | 默认关闭，需用户手动开启 |
| 高风险操作绕过 | 启用后仍进行安全检查，敏感路径、注入等拒绝执行 |
| 用户误开启 | 开启时有二次确认提示，说明安全风险 |

#### 5.3.4 UI 设计

```
┌─────────────────────────────────────────────────────────────┐
│ 脚本执行设置                                                 │
│ ─────────────────────────────────────────────────────────── │
│                                                           │
│ [ ] 大模型生成的脚本自动允许执行                              │
│     开启后，模型生成的脚本将直接执行，不再弹出确认卡片。         │
│     ⚠️ 请注意安全风险，仅在信任当前工作环境时开启。             │
│                                                           │
│ [信任的命令列表]                                            │
│ ─────────────────────────────────────────────────────────── │
│ ☐ npm install                          已使用 5 次          │
│ ☐ git status                           已使用 3 次          │
│                                                           │
│ [批量删除]                                                  │
└─────────────────────────────────────────────────────────────┘
```

---

### 5.4 自动放行安全写入

#### 5.4.1 功能说明

设置页 → 工具 → 文件操作 → 「文件写入确认模式」由当前的两个选项扩展为三个：

| 选项值 | 标签 | 行为 |
|--------|------|------|
| `diff`（默认） | 展示文件修改内容 | 写入前弹出 diff 确认卡片 |
| `direct` | 直接确认 | 写入前弹出简化确认卡片（无 diff） |
| `auto`（**新增**） | 自动放行安全写入 | 写入操作若**全部**满足"安全写入条件"，直接执行不弹卡；任一条件不满足时**自动回落**到 `diff` 模式弹卡确认 |

| 项 | 说明 |
|----|------|
| 选项值 | `auto` |
| 默认值 | 不默认启用（保持 `diff` 为默认） |
| 适用工具 | `write_file`、`edit_file`（及未来新增的写入类工具） |
| 生效范围 | 全局，跨会话 |
| 优先级 | 低于 Shell 的「大模型生成的脚本自动允许执行」（两者作用域不同，不冲突） |
| 不可关闭的安全检查 | 路径越权、敏感路径、二进制文件、`fileStateCache` 一致性等已有校验照常执行；自动放行仅替代"用户确认"这一步 |

#### 5.4.2 安全写入条件

`auto` 模式下，**必须同时满足以下所有条件**，否则回落为 `diff` 弹卡：

| # | 条件 | 校验位置 | 不满足时的行为 |
|---|------|----------|----------------|
| C1 | 解析后的绝对路径位于 `ctx.workDir` 之内（已由 `resolveSafePathReal` 保证） | `electron/pathSecurity.ts` | 工具直接返回 `路径超出工作目录范围` 错误（无需弹卡） |
| C2 | 路径未命中"敏感路径前缀"（复用 `isSensitivePath` 的判定，覆盖 `.ssh/`、`.gnupg/`、`.aws/`、`.kube/`、`.env*`、`*.pem`、`*.key`、`id_rsa*`、`userData/` 等） | `electron/shell/shellSensitivePaths.ts`（共享给文件工具） | 回落 `diff` 弹卡，并在卡片顶部展示「敏感路径警示」 |
| C3 | 路径不在只读保护区（如 Wiki raw 目录、`.git/`、`node_modules/` 内部受保护区） | `electron/tools/builtinExecutors.ts` 现有 `wikiRawWriteBlocked` 等 | 工具直接拒绝（与现状一致） |
| C4 | 目标不是二进制文件（沿用现有 `editFileExecutor` 的文本判定） | `electron/tools/builtinExecutors.ts` | 工具直接拒绝（与现状一致） |
| C5 | 编辑/覆盖**已存在文件**时，`fileStateCache` 必须命中且内容未被外部修改 | `editFileExecutor` / `writeFileExecutor` 现有校验 | 工具直接返回相应错误（与现状一致） |
| C6 | 单次写入字节数 ≤ `autoApproveMaxBytes`（默认 `256 KB`） | 新增于 `writeFileAutoApproval.ts` | 回落 `diff` 弹卡，理由：「写入体量超过自动放行阈值」 |
| C7 | 单次 `edit_file` 的替换跨度（`old_string` + `new_string`）≤ `autoApproveMaxEditChars`（默认 `64 KB`） | 同上 | 回落 `diff` 弹卡 |

**设计理由**：
- C1–C5 是已有安全基线，无任何放松，仅是声明"自动放行不绕过既有校验"。
- C6–C7 是新增的"自动放行预算"，本质是把"高风险特征"反向定义为"超过常规规模"，避免一次性巨量写入逃过人工眼。

#### 5.4.3 判定流程

```
模型调用 write_file / edit_file
    → 路径解析（resolveSafePathReal）           [失败 → 工具拒绝]
    → 工具内已有安全校验（C3/C4/C5）            [失败 → 工具拒绝]
    → 读取 toolsConfig.confirmMode
        ├── 'diff'    → 弹出 diff 卡片（现状）
        ├── 'direct'  → 弹出直接确认卡片（现状）
        └── 'auto'    → 进入"自动放行评估"
              → 评估 C2 / C6 / C7
              ├── 全部通过 → 直接执行写入，记录 file.auto_approve 审计
              └── 任一不通过 → 回落 'diff' 弹卡，卡片顶部展示"自动放行未通过：{原因}"
```

放行决策由新增模块 `electron/tools/writeFileAutoApproval.ts` 集中实现，返回 `{ approve: true } | { approve: false, reason: AutoApprovalRejectReason }`，便于测试与审计。

#### 5.4.4 与"信任命令"机制的关系

| 维度 | 信任命令（5.1） | 自动放行安全写入（5.4） |
|------|------------------|--------------------------|
| 粒度 | 精确到命令字符串 | 不针对具体路径/内容，按规则判定 |
| 持久化对象 | `trustedCommands[]` | 仅一个枚举值 `confirmMode='auto'` |
| 安全策略 | 命中危险特征即不显示信任入口 | 命中危险特征即回落 `diff` 弹卡 |
| 触发位置 | 用户在确认卡片上勾选 | 用户在设置页主动切换 |

两者**互不依赖**，但 UI 文案上保持一致的"安全检查永不绕过"措辞，避免用户误解。

#### 5.4.5 UI 设计

**设置页 — 文件操作模块（三选一）：**

```
┌─────────────────────────────────────────────────────────────┐
│ 文件操作设置                                                 │
│ ─────────────────────────────────────────────────────────── │
│ 文件写入确认模式                                             │
│ ( ) 展示文件修改内容（默认）                                 │
│ ( ) 直接确认                                                 │
│ (●) 自动放行安全写入                                         │
│     满足以下全部条件时自动执行，不弹出确认卡片：               │
│       • 写入路径在工作目录内                                  │
│       • 未命中敏感路径（密钥、凭据、配置目录等）               │
│       • 单次写入 ≤ 256 KB                                    │
│     不满足时仍会弹出"展示文件修改内容"卡片。                   │
│                                                           │
│ [×] 文件历史备份                                             │
│     每文件最多快照数：[ 100 ]                                │
└─────────────────────────────────────────────────────────────┘
```

**阈值配置**：当前版本不向用户暴露 `autoApproveMaxBytes` 和 `autoApproveMaxEditChars` 配置入口，使用合理的默认值即可（256KB / 64KB）。如未来用户有需求，再考虑在高级设置中暴露。

**自动放行后的 Toast（在聊天界面右下角）：**

```
✓ 已自动写入 src/utils/foo.ts（+12 / -3）。
  [查看 diff]
```

**自动放行未通过、回落弹卡时（在确认卡片顶部增加一条提示）：**

```
┌─────────────────────────────────────────────────────────────┐
│ ⓘ 自动放行未通过：写入体量超过自动放行阈值（512 KB > 256 KB） │
│   本次写入需要您手动确认。                                    │
├─────────────────────────────────────────────────────────────┤
│ 📝 write_file → src/data/large.json                         │
│ ... (diff 内容) ...                                          │
│    [✓ 确认执行]   [✗ 拒绝]                                   │
└─────────────────────────────────────────────────────────────┘
```

#### 5.4.6 安全边界

| 风险类型 | 缓解措施 |
|----------|----------|
| 模型批量覆盖关键文件 | C6/C7（体量阈值）限制单次写入与单次替换跨度，超过阈值立即回落 `diff` |
| 模型写入凭据目录 | C2 复用敏感路径前缀（与 Shell 同源），命中即回落弹卡 |
| 路径越权 | 工具层 `resolveSafePathReal` 已强制校验，无放行入口 |
| 用户误开启 | 切到 `auto` 时弹出二次确认对话框，列举受影响行为与回落条件 |
| 自动放行行为不可追溯 | 全部自动放行记录 `file.auto_approve` 审计日志；回落记录 `file.auto_approve.fallback` 并附原因码 |

---

### 5.2 域名信任机制

#### 5.2.1 信任选项

在 `navigate(open)` 确认卡片中添加「信任此域名」选项。

#### 5.2.2 信任行为

| 项 | 行为 |
|----|------|
| 提取域名 | 使用简化规则提取二级域名（见下表） |
| 存储位置 | `BrowserConfig.trustedDomains`（与现有配置合并） |
| 生效范围 | 全局，跨会话（同现有可信域名机制） |
| 子域匹配 | 信任 `github.com` 后，`*.github.com` 均生效 |
| 端口处理 | 忽略端口，信任域名不关心端口号 |

#### 5.2.3 域名提取规则

域名提取遵循以下简化规则：

| URL | 提取结果 | 说明 |
|-----|----------|------|
| `https://docs.github.com/en/actions` | `github.com` | 子域名 `docs.github.com` → 二级域名 `github.com` |
| `https://www.example.co.uk/path` | `example.co.uk` | 预定义公共后缀列表识别 `co.uk` |
| `https://api.github.com:8080/v3` | `github.com` | 忽略端口 `:8080` |
| `https://localhost:3000` | `localhost` | 本地主机直接信任 |
| `https://192.168.1.100` | `192.168.1.100` | IP 地址直接信任 |

**设计理由**：
- 优先使用二级域名提取（适用于 99% 场景：.com/.cn/.net 等）
- 对已知公共后缀（如 co.uk、com.au）维护小型映射表
- 避免引入完整 PSL 库（约 100KB），减少包体积
- 忽略端口号，因为同一域名的不同端口应共享信任状态

**与现有会话内域名记忆的关系：**

| 机制 | 范围 | 持久化 | 触发方式 |
|------|------|--------|----------|
| 会话内记忆 | 单一会话 | 否（内存） | 用户确认即可 |
| 信任域名 | 全局 | 是（配置） | 用户明确选择「信任此域名」 |

---

## 6. 安全与权限

### 6.1 安全边界

| 风险类型 | 缓解措施 |
|----------|----------|
| 恶意命令被信任 | 仅低风险命令显示信任选项 |
| 敏感路径访问 | 命中敏感路径时强制确认，无信任选项 |
| 命令注入 | 注入检测失败时拒绝执行，不显示信任选项 |
| 权限提升 | `sudo` 等提权命令强制确认，无信任选项 |
| 信任列表滥用 | 设置页可查看和删除信任项 |

### 6.2 审计日志

| 事件 | 记录内容 |
|------|----------|
| 信任命令 | `shell.trust.command` → `{command, timestamp}` |
| 信任域名 | `browser.trust.domain` → `{domain, timestamp}` |
| 删除信任项 | `trust.remove` → `{type, item, timestamp}` |
| 自动放行写入 | `file.auto_approve` → `{tool, relPath, bytesWritten, sessionId, timestamp}` |
| 自动放行回落 | `file.auto_approve.fallback` → `{tool, relPath, reason, sessionId, timestamp}` |
| 切换写入确认模式 | `file.confirm_mode.change` → `{from, to, timestamp}` |

---

## 7. UI 与交互设计

### 7.1 Shell 命令确认卡片

**常规命令（低风险）：**
```
┌─────────────────────────────────────────────────────────────┐
│ 💻 run_shell                   ⏳ confirming                │
│ ─────────────────────────────────────────────────────────── │
│ 安装项目依赖（description）                                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ npm install                                             │ │
│ └─────────────────────────────────────────────────────────┘ │
│ 工作目录：E:\Projects\my-app                               │
│ 超时：300s                                                 │
│                                                           │
│ [✓] 信任此命令，后续不再询问                                │
│                                                           │
│    [✓ 确认执行]    [✗ 拒绝]                                │
└─────────────────────────────────────────────────────────────┘
```

**高风险命令（无信任选项）：**
```
┌─────────────────────────────────────────────────────────────┐
│ 💻 run_shell                   ⏳ confirming                │
│ ╔══════════════════════════════════════════════════════════╗
│ ║ ⚠️ 路径安全警示                                           ║
│ ║ • 命令包含工作目录外的路径：../../.ssh/…                  ║
│ ║ • 命令涉及敏感路径（密钥/凭据目录）                        ║
│ ║ Shell 是受控 CLI，不是文件沙箱。                           ║
│ ╚══════════════════════════════════════════════════════════╝
│ ─────────────────────────────────────────────────────────── │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ cat ../../../.ssh/id_rsa                                │ │
│ └─────────────────────────────────────────────────────────┘ │
│ 工作目录：E:\Projects\my-app                               │
│    [✓ 我了解风险，确认执行]    [✗ 拒绝]                    │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 网页访问确认卡片

```
┌─────────────────────────────────────────────────────────────┐
│ 🌐 browser (navigate)          ⏳ confirming                │
│ ─────────────────────────────────────────────────────────── │
│ 打开网页：https://docs.github.com/en/actions               │
│                                                           │
│ [✓] 信任此域名，后续不再询问                                │
│                                                           │
│    [✓ 确认访问]    [✗ 拒绝]                                │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 设置页信任列表管理

**Shell 命令信任列表：**
```
┌─────────────────────────────────────────────────────────────┐
│ 已信任的 Shell 命令                                         │
│ ─────────────────────────────────────────────────────────── │
│ ☐ npm install                          已使用 5 次          │
│ ☐ git status                           已使用 3 次          │
│ ☐ node -v                              已使用 2 次          │
│                                                           │
│ [批量删除]                                                  │
└─────────────────────────────────────────────────────────────┘
```

**可信域名列表（复用现有）：**
```
┌─────────────────────────────────────────────────────────────┐
│ 可信域名（访问时无需确认）                                   │
│ ─────────────────────────────────────────────────────────── │
│ ☐ github.com                           2026-06-06 添加      │
│ ☐ docs.github.com                      2026-06-05 添加      │
│ ☐ example.com                          2026-06-04 添加      │
│                                                           │
│ [添加域名]    [批量删除]                                     │
└─────────────────────────────────────────────────────────────┘
```

### 7.4 信任成功提示

**Toast 提示：**
```
✓ 已信任「npm install」，后续执行将不再询问。
  可在设置页管理信任列表。
```

---

## 8. 数据模型变更

### 8.1 ShellConfig 扩展

```typescript
interface ShellConfig {
  // ... 现有字段 ...
  
  /** 已信任的命令列表（低风险命令可跳过确认） */
  trustedCommands?: TrustedShellCommand[]
  
  /** 是否自动允许执行大模型生成的脚本 */
  autoAllowScriptExecution?: boolean
}

interface TrustedShellCommand {
  id: string
  command: string           // 完整命令字符串
  createdAt: number         // 创建时间戳
  lastUsedAt?: number       // 最后使用时间
  usageCount: number        // 使用次数
}
```

### 8.1.1 ToolsConfig 扩展（文件写入确认模式）

`ToolsConfig.confirmMode` 在原有 `'diff' | 'direct'` 联合类型上扩展第三个枚举值 `'auto'`，同时新增自动放行阈值字段。默认值保持 `'diff'`。

```typescript
interface ToolsConfig {
  // ... 现有字段 ...

  /** 写入类工具的确认模式 */
  confirmMode: 'diff' | 'direct' | 'auto'

  /** auto 模式下，单次写入允许的最大字节数（默认 256 * 1024） */
  autoApproveMaxBytes?: number

  /** auto 模式下，单次 edit_file 允许的 old_string + new_string 字符上限（默认 64 * 1024） */
  autoApproveMaxEditChars?: number
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  // ...
  confirmMode: 'diff',
  autoApproveMaxBytes: 256 * 1024,
  autoApproveMaxEditChars: 64 * 1024
}
```

**兼容性**：`mergeToolsConfig` 已使用 `{ ...DEFAULT_TOOLS_CONFIG, ...partial }`，旧配置文件中缺失这些字段会自动获得默认值；旧配置中 `confirmMode === 'diff' | 'direct'` 保持原行为，不会被升级为 `'auto'`。

### 8.2 BrowserConfig 变更

`trustedDomains` 字段已存在，信任操作直接追加到该列表。

### 8.3 IPC 扩展

| 通道 | 功能 | 说明 |
|------|------|------|
| `shell:manage-trusted-commands` | 添加/获取/删除信任命令 | 合并通道，支持多种操作类型 |
| `config:set` | 添加信任域名 | 复用现有通道，通过 `trustedDomains` 字段更新 |

**设计说明**：
- 域名信任复用现有 `config:set` 通道（已有 `trustedDomains` 配置），简化实现
- Shell 信任命令合并为单一通道，减少维护成本
- 审计日志通过现有机制实现，无需独立通道

---

## 9. 实现要点

### 9.1 模块划分

| 模块 | 职责 |
|------|------|
| `shellCommandTrust.ts` | Shell 命令信任管理（添加、查询、删除） |
| `browserDomainTrust.ts` | 域名信任管理（复用现有 trustedDomains） |
| `toolCallCard.tsx` | 确认卡片 UI（添加信任选项 / 回落原因提示） |
| `ToolsSettingsTab.tsx` | 设置页信任列表 + 写入确认模式三选一 |
| `writeFileAutoApproval.ts` | **新增**：集中实现"自动放行评估"，输入 `{ctx, tool, abs, rel, content?, edit?}`，输出 `{approve, reason?}`；纯函数判定，无状态 |

**模块复用说明**：文件工具直接 `import { isSensitivePath } from 'shell/shellSensitivePaths.ts'`，无需新增独立模块 `fileSensitivePaths.ts`。如需共享类型定义，可考虑在 `shared` 目录放置。

### 9.2 信任判断流程

**Shell 命令：**
```
模型调用 run_shell
    → shellSecurity 检查
    → 判断是否低风险（无注入、无敏感路径等）
    → 检查是否在 trustedCommands 中
    → [已信任] 直接执行
    → [未信任] 弹出确认卡片（低风险显示信任选项）
    → 用户确认时勾选「信任此命令」
    → 添加到 trustedCommands
```

**网页访问：**
```
模型调用 browser(navigate, open)
    → urlSecurity 检查
    → 检查是否在 trustedDomains 中
    → [已信任] 直接执行
    → [未信任] 弹出确认卡片（显示信任选项）
    → 用户确认时勾选「信任此域名」
    → 提取域名并添加到 trustedDomains
```

**文件写入（auto 模式）：**
```
模型调用 write_file / edit_file
    → 路径解析 + 二进制 / 只读 / fileStateCache 等已有校验   [失败 → 工具拒绝]
    → 读取 toolsConfig.confirmMode
        ├── diff / direct → 走原有弹卡流程
        └── auto:
              → writeFileAutoApproval.evaluate(...)
                  · 命中敏感路径？
                  · 字节数 > autoApproveMaxBytes ?
                  · edit 跨度 > autoApproveMaxEditChars ?
              ├── 全部通过 → 直接执行写入，发 Toast，写 file.auto_approve 日志
              └── 任一不通过 → 弹 diff 卡片（携带原因码与可读理由），
                                 卡片上不再显示"以后此类自动放行"等加重信任的选项
                                 写 file.auto_approve.fallback 日志
```

### 9.3 测试要求

| 测试文件 | 覆盖内容 |
|----------|----------|
| `shellCommandTrust.test.ts` | 信任添加、查询、删除、匹配逻辑 |
| `browserDomainTrust.test.ts` | 域名提取、信任追加、子域匹配 |
| `toolChatLoop.test.ts` | 信任命令跳过确认、高风险命令强制确认 |
| `writeFileAutoApproval.test.ts` | **新增**：覆盖 C2 / C6 / C7 各回落分支；含 workDir 内外路径、敏感前缀命中、字节阈值边界、edit 跨度边界等用例 |
| `builtinExecutors.autoApprove.test.ts` | **新增**：`write_file` / `edit_file` 在 `confirmMode='auto'` 下不调用 `tool:confirm-request`、在回落场景下会调用且 payload 中包含原因码 |
| `ToolsSettingsTab.autoApprove.test.tsx` | **新增**：三选一渲染、切到 `auto` 时弹出二次确认 |

---

## 10. 验收标准

### 10.1 功能验收

- [ ] Shell 命令确认卡片在低风险时显示「信任此命令」选项
- [ ] 高风险命令（敏感路径、注入等）不显示信任选项
- [ ] 信任的命令后续执行不再弹出确认卡片
- [ ] 网页访问确认卡片显示「信任此域名」选项
- [ ] 信任域名自动加入 `trustedDomains`，后续访问同域名不再确认
- [ ] 设置页可查看和删除信任命令列表
- [ ] 设置页可查看和删除可信域名列表
- [ ] 信任操作后显示成功提示
- [ ] 域名提取正确处理 `docs.github.com` → `github.com`
- [ ] 域名提取正确处理 `example.co.uk` 等特殊 TLD（通过预定义公共后缀列表）
- [ ] 域名提取忽略端口号
- [ ] 超过 90 天未使用的信任命令标记为过期
- [ ] 设置页支持一键清理过期信任命令
- [ ] 设置页「脚本执行」模块显示「大模型生成的脚本自动允许执行」开关
- [ ] 该选项默认关闭
- [ ] 开启后模型生成的脚本直接执行，不弹出确认卡片
- [ ] 开启时有二次确认提示，说明安全风险
- [ ] 开启后仍进行安全检查，高风险命令拒绝执行

**新增：文件写入自动放行（auto 模式）验收**

- [ ] 设置页「文件写入确认模式」显示三个单选按钮（diff / direct / auto）
- [ ] 默认值为 `diff`，不自动切换到 `auto`
- [ ] 首次切换到 `auto` 时弹出二次确认对话框，说明条件与风险
- [ ] `auto` 模式下安全写入全部通过：写入直接执行，不弹出确认卡片
- [ ] 写入完成后在聊天界面显示 Toast（含文件路径、行数变化、查看 diff 入口）
- [ ] 路径命中敏感前缀（.ssh、.env 等）时回落为 diff 弹卡，卡片顶部显示原因
- [ ] 单次写入超过 256 KB 时回落为 diff 弹卡
- [ ] 单次 edit 跨度超过 64 KB 时回落为 diff 弹卡
- [ ] 全部自动放行操作记录到审计日志（`file.auto_approve`）
- [ ] 全部回落事件记录到审计日志（`file.auto_approve.fallback`）
- [ ] 切换确认模式记录到审计日志（`file.confirm_mode.change`）
- [ ] 阈值参数（`autoApproveMaxBytes` 等）当前版本不暴露 UI，使用默认值

### 10.2 安全验收

- [ ] `sudo`、命令替换、敏感路径等高风险操作始终强制确认
- [ ] 注入检测失败时拒绝执行，不显示信任选项
- [ ] 信任操作记录审计日志

### 10.3 UI 验收

- [ ] 信任选项为 checkbox，位于确认按钮上方
- [ ] 高风险命令确认卡片无信任选项
- [ ] Toast 提示清晰说明信任行为和管理入口
- [ ] 设置页信任列表显示使用次数和添加时间

---

## 11. 相关文件

| 区域 | 文件 | 变更类型 |
|------|------|----------|
| 类型定义 | `src/shared/domainTypes.ts` | 扩展 ShellConfig + ToolsConfig（confirmMode 加 'auto'、新增 autoApprove* 阈值字段） |
| 信任管理 | `electron/shell/shellCommandTrust.ts` | 新增 |
| 脚本执行控制 | `electron/shell/shellExecutionController.ts` | 新增/修改 |
| 文件自动放行 | `electron/tools/writeFileAutoApproval.ts` | **新增** |
| 文件工具集成 | `electron/tools/builtinExecutors.ts` | 在 `write_file` / `edit_file` 调用 `writeFileAutoApproval.evaluate` 决定是否走确认 |
| 工具循环 | `electron/toolChatLoop.ts` | `confirmMode === 'auto'` 时跳过 `tool:confirm-request`，回落时携带原因码与可读理由 |
| 敏感路径共享 | `electron/shell/shellSensitivePaths.ts` | 供文件工具复用（无需移动文件） |
| 确认卡片 | `src/renderer/components/Chat/ToolCallCard.tsx` | 顶部新增"自动放行未通过"提示区 |
| 设置页 | `src/renderer/components/Config/ToolsSettingsTab.tsx` | 三选一 + 二次确认 |
| i18n | `src/renderer/i18n/resources/zh-CN/config.json` | 新增文案（autoApprove.*） |
| i18n | `src/renderer/i18n/resources/zh-CN/chat.json` | 新增文案（autoApprove Toast 与回落提示） |
| i18n | `src/renderer/i18n/resources/zh-CN/common.json` | 新增文案 |
| i18n | `src/renderer/i18n/resources/en-US/*.json` | 按 i18n-sync-guide 同步同名 key |
| IPC | `electron/appIpc.ts` | 信任命令相关通道（`shell:manage-trusted-commands`），域名信任复用现有 `config:set` |
| 测试 | `electron/shell/shellCommandTrust.test.ts` | 新增 |
| 测试 | `electron/shell/shellExecutionController.test.ts` | 新增 |
| 测试 | `electron/tools/writeFileAutoApproval.test.ts` | **新增** |
| 测试 | `electron/tools/builtinExecutors.autoApprove.test.ts` | **新增** |
| 测试 | `src/renderer/components/Config/ToolsSettingsTab.autoApprove.test.tsx` | **新增** |

---

## 12. 多语言资源规划

### 12.1 命名空间分配

| 命名空间 | 用途 | 涉及组件 |
|----------|------|----------|
| `config` | 设置页面 | ToolsSettingsTab.tsx |
| `chat` | 确认卡片、工具调用 | ToolCallCard.tsx |
| `common` | 通用提示、按钮文本 | 全局复用 |
| `errors` | 错误消息 | 安全拒绝提示 |

### 12.2 config 命名空间翻译 key

```json
// src/renderer/i18n/resources/zh-CN/config.json
{
  "shell": {
    "trust": {
      "title": "已信任的 Shell 命令",
      "expired": "已过期",
      "batchDelete": "批量删除",
      "cleanExpired": "清理过期记录",
      "cleanExpiredConfirm": "确定清理 {count} 条过期记录？",
      "lastUsed": "上次使用：{date}"
    },
    "autoAllow": {
      "title": "大模型生成的脚本自动允许执行",
      "description": "开启后，模型生成的脚本将直接执行，不再弹出确认卡片。",
      "warning": "请注意安全风险，仅在信任当前工作环境时开启。",
      "confirmTitle": "确认开启自动执行？",
      "confirmMessage": "开启后，模型生成的脚本将直接执行，不再弹出确认卡片。",
      "confirmWarning": "⚠️ 请确保您信任当前工作环境，避免执行恶意命令。"
    }
  },
  "tools": {
    "file": {
      "confirmModeLabel": "文件写入确认模式",
      "confirmDiff": "展示文件修改内容",
      "confirmDirect": "直接确认",
      "confirmAuto": "自动放行安全写入",
      "autoApprove": {
        "description": "满足以下全部条件时自动执行，不弹出确认卡片：",
        "conditionInWorkDir": "写入路径在工作目录内",
        "conditionNotSensitive": "未命中敏感路径（密钥、凭据、配置目录等）",
        "conditionMaxBytes": "单次写入 ≤ {size}",
        "fallbackHint": "不满足时仍会弹出"展示文件修改内容"卡片。",
        "confirmTitle": "确认切换为自动放行安全写入？",
        "confirmMessage": "开启后，符合安全条件的 write_file / edit_file 调用将不再弹出确认卡片，仅在体量过大或命中敏感路径时回落为弹卡。",
        "confirmWarning": "⚠️ 路径越权与敏感目录保护仍然有效。"
      }
    }
  },
  "browser": {
    "trust": {
      "title": "可信域名（访问时无需确认）",
      "addedDate": "{date} 添加",
      "addDomain": "添加域名",
      "batchDelete": "批量删除"
    }
  }
}
```

### 12.3 chat 命名空间翻译 key

```json
// src/renderer/i18n/resources/zh-CN/chat.json
{
  "toolCall": {
    "confirm": {
      "trustThisCommand": "信任此命令，后续不再询问",
      "trustThisDomain": "信任此域名，后续不再询问",
      "execute": "确认执行",
      "reject": "拒绝",
      "confirmAndExecute": "确认执行",
      "iUnderstandRisk": "我了解风险，确认执行"
    },
    "securityWarning": {
      "title": "路径安全警示",
      "outsideWorkDir": "命令包含工作目录外的路径",
      "sensitivePath": "命令涉及敏感路径（密钥/凭据目录）",
      "shellNotSandbox": "Shell 是受控 CLI，不是文件沙箱。"
    }
  },
  "toast": {
    "trustCommandSuccess": "已信任「{command}」，后续执行将不再询问。",
    "trustCommandManage": "可在设置页管理信任列表。",
    "trustDomainSuccess": "已信任「{domain}」，后续访问将不再询问。",
    "trustDomainManage": "可在设置页管理可信域名。",
    "fileAutoApproved": "已自动写入 {path}（+{added} / -{removed}）。",
    "fileAutoApprovedViewDiff": "查看 diff"
  },
  "fileAutoApprove": {
    "fallbackBanner": "自动放行未通过：{reason}。本次写入需要您手动确认。",
    "reasonSensitivePath": "目标路径命中敏感目录",
    "reasonOversize": "写入体量超过自动放行阈值（{actual} > {limit}）",
    "reasonEditTooLarge": "单次替换文本过大（{actual} > {limit}）"
  }
}
```

### 12.4 common 命名空间翻译 key

```json
// src/renderer/i18n/resources/zh-CN/common.json
{
  "button": {
    "confirm": "确认",
    "cancel": "取消",
    "delete": "删除",
    "save": "保存",
    "close": "关闭"
  },
  "status": {
    "confirming": "待确认",
    "executing": "执行中",
    "success": "成功",
    "failed": "失败"
  },
  "time": {
    "justNow": "刚刚",
    "minutesAgo": "{count} 分钟前",
    "hoursAgo": "{count} 小时前",
    "daysAgo": "{count} 天前"
  }
}
```

### 12.5 errors 命名空间翻译 key

```json
// src/renderer/i18n/resources/zh-CN/errors.json
{
  "shell": {
    "injection": "命令包含注入风险，已拒绝执行",
    "sensitivePath": "命令涉及敏感路径，已拒绝执行",
    "privilegeEscalation": "命令包含提权操作，已拒绝执行",
    "autoAllowBlocked": "已启用自动执行，但命令「{command}」被安全检查拦截"
  },
  "browser": {
    "invalidDomain": "无效的域名格式"
  }
}
```

### 12.6 开发流程

按照 [i18n-sync-guide.md](../../develop/i18n-sync-guide.md) 的规范执行：

```
1. 在 zh-CN 添加翻译 key（如上述 12.2-12.5）
2. 运行 npm run i18n:generate-types 生成 TypeScript 类型
3. 在代码中使用 useTypedTranslation('namespace') 调用
4. 在 en-US 同步相同的 key 结构
5. 运行 npm run i18n:check 验证
```

### 12.7 代码使用示例

```tsx
// 确认卡片中使用
import { useTypedTranslation } from '@/renderer/i18n/useTypedTranslation'

function ToolCallCard() {
  const { t } = useTypedTranslation('chat')
  
  return (
    <>
      <Checkbox>
        {t('toolCall.confirm.trustThisCommand')}
      </Checkbox>
      <Button type="primary">
        {t('toolCall.confirm.confirmAndExecute')}
      </Button>
    </>
  )
}

// 设置页中使用
import { useTypedTranslation } from '@/renderer/i18n/useTypedTranslation'

function ToolsSettingsTab() {
  const { t } = useTypedTranslation('config')
  
  return (
    <>
      <Switch 
        checked={autoAllowEnabled}
        onChange={handleAutoAllowChange}
      />
      <span>{t('shell.autoAllow.title')}</span>
    </>
  )
}
```

---

**文档版本**: v1.6  
**创建日期**: 2026-06-06  
**修订记录**: 
- v1.6 (2026-06-06): 根据评审意见优化需求设计
  - §5.1.2 命令信任改为前缀匹配，不再区分工作目录
  - §5.1.3 移除 `usageCount` 字段
  - §5.1.4 简化信任记录清理策略（移除统计清零和自动提示）
  - §5.2.3 简化域名提取规则（移除完整 PSL 依赖）
  - §5.4.5 阈值参数当前版本不暴露 UI
  - §8.3 简化 IPC 设计（合并通道，复用现有配置通道）
  - §9.1 移除 `fileSensitivePaths.ts` 新增模块建议
- v1.5 (2026-06-06): 移除自动放行频率限制（C8）
  - §5.4.2 删除 C8（每会话每分钟 30 次上限），安全条件收敛为 C1–C7
  - §5.4.5 UI 设计「自动放行条件」列表删掉"每分钟 ≤ 30 次"一行
  - §5.4.6 安全边界表合并到 C6/C7 体量阈值
  - §8 删除 `autoApproveMaxRatePerMinute` 字段与默认值
  - §9 `writeFileAutoApproval.ts` 由"带频率窗口"改为"纯函数无状态"
  - §9 流程文本与测试用例同步删掉频率评估/测试
  - §10 验收标准删掉"60 秒 30 次回落"
  - §12 i18n 删 `conditionMaxRate` / `reasonRateLimited`，`confirmMessage` 删"写入频率过高"措辞
- v1.4 (2026-06-06): 精简"自动放行安全写入"特性，移除过度设计
  - §5.4.2 删除 C9（同文件 10 秒去抖）与 C10（会话临时降级）；安全条件收敛为 C1–C7
  - §5.4 删除原 5.4.4「用户可控的临时降级」整节，章节号顺移
  - 设置页 UI 删除"暂停自动放行 30 分钟"按钮与"信任工作环境/回顾审计日志"提示语
  - Toast 删除「撤销并改为逐条确认」按钮
  - §5.4.6 安全边界删除"覆盖循环"行与"Toast 永远带撤销按钮"措辞
  - §8 删除 `autoApproveSameFileDebounceMs` 字段；IPC 删除 `file:auto-approval-stats` / `file:set-session-override` / `file:reset-session-override` 三条通道（本特性不再引入任何新 IPC 通道）
  - §9 `writeFileAutoApproval` 描述与测试用例同步收敛
  - §10 验收标准减少 4 条（撤销 Toast、暂停按钮、重启状态、同文件去抖）
  - §11 文件清单删除 `preload.ts` 与 `appIpc.ts` 的"新增通道"描述
  - §12 i18n 删除 `pauseBtn` / `pausedHint` / `resumeBtn` / `warning` / `fileAutoApprovedRevert` / `reasonSameFileDebounce` / `reasonSessionOverride`
- v1.3 (2026-06-06): 新增"自动放行安全写入"特性
  - 目标新增 G7：写入确认模式增加 `auto` 选项
  - 用户故事新增 US-06
  - 新增 §5.4「自动放行安全写入」：功能说明、安全写入条件、判定流程、与信任命令的关系、UI 设计、安全边界
  - §6 审计日志新增 `file.auto_approve` / `file.auto_approve.fallback` / `file.confirm_mode.change`
  - §8 新增 `ToolsConfig.confirmMode = 'auto'` 与 `autoApprove*` 阈值字段
  - §9 新增 `writeFileAutoApproval.ts` 模块与对应测试文件
  - §10 新增自动放行验收标准
  - §11 文件清单同步更新
  - §12 i18n 新增 `tools.file.autoApprove.*` 与 `fileAutoApprove.*` 文案规划
- v1.2 (2026-06-06): 补充多语言资源规划
  - 新增第 12 章「多语言资源规划」
  - 明确命名空间分配（config、chat、common、errors）
  - 详细规划各命名空间下的翻译 key 结构
  - 补充开发流程和代码使用示例
- v1.1 (2026-06-06): 根据评审意见优化
  - 补充域名提取规则（PSL 支持、特殊 TLD 处理、端口忽略）
  - 新增信任记录清理策略（usageCount 清零、过期标记、手动清理）
  - 优化 IPC 通道设计（独立通道支持审计日志）
  - 补充相关验收标准
**适用范围**: SpaceAssistant — 确认卡片信任机制优化