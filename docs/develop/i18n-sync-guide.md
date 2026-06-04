# 新功能迭代的多语言同步指南

## 概述

本指南旨在规范 SpaceAssistant 项目在新增功能或修改现有功能时，如何保持多语言翻译机制的及时同步更新，确保产品在中文和英文环境下的一致性体验。

---

## 一、多语言架构概述

### 1.1 技术栈

- **国际化框架**：`i18next` + `react-i18next`
- **语言检测**：`i18next-browser-languagedetector`
- **类型安全**：TypeScript 自动生成类型

### 1.2 翻译资源结构

```
src/renderer/i18n/resources/
├── zh-CN/                    # 中文（翻译 key 的真实来源）
│   ├── common.json           # 通用文案
│   ├── config.json           # 设置页面
│   ├── chat.json             # 聊天界面
│   ├── errors.json           # 错误消息
│   ├── fileTree.json         # 文件树面板
│   ├── search.json           # 搜索功能
│   ├── feishu.json           # 飞书集成
│   ├── wiki.json             # Wiki 功能
│   └── detailPanel.json      # 详情面板
└── en-US/                    # 英文（镜像 zh-CN 的 key 结构）
    └── ...                   # 与 zh-CN 相同的文件结构
```

### 1.3 核心原则

| 原则 | 说明 |
|------|------|
| **zh-CN 为主** | 所有新增翻译 key 首先在 zh-CN 中定义 |
| **Key 对齐** | en-US 必须与 zh-CN 保持完全相同的 key 结构 |
| **类型推导** | TypeScript 类型从 zh-CN 自动生成 |
| **禁止硬编码** | 代码中禁止直接写入中文或英文文案 |

---

## 二、新功能迭代流程

### 2.1 标准工作流

```
┌─────────────────┐    ┌──────────────────────┐    ┌───────────────────┐
│ 1. 确定文案需求  │───▶│ 2. 在 zh-CN 添加 key │───▶│ 3. 在代码中使用   │
└─────────────────┘    └──────────────────────┘    └───────────────────┘
       │                         │                         │
       ▼                         ▼                         ▼
┌─────────────────┐    ┌──────────────────────┐    ┌───────────────────┐
│ 6. CI 检查通过   │◀───│ 5. 运行 i18n:check   │◀───│ 4. 同步 en-US     │
└─────────────────┘    └──────────────────────┘    └───────────────────┘
```

### 2.2 详细步骤

#### 步骤 1：确定文案需求

在开发新功能前，整理所有需要国际化的文案，包括：
- UI 标签和按钮文本
- 错误消息和提示
- 表单占位符和验证提示
- 状态描述和帮助文本

#### 步骤 2：在 zh-CN 中添加翻译 key

**Key 命名规范**：

| 层级 | 说明 | 示例 |
|------|------|------|
| 第1层 | 命名空间（已固定） | `chat`, `common`, `config` |
| 第2层 | 模块/组件名 | `bubble`, `input`, `confirm` |
| 第3层 | 语义/功能描述 | `retry`, `placeholder`, `allow` |
| 第4层 | 细分属性（可选） | `labels`, `descriptions` |

**示例**：
```json
// src/renderer/i18n/resources/zh-CN/chat.json
{
  "bubble": {
    "retry": "重试",
    "archiveToWiki": "归档到 Wiki"
  },
  "tool": {
    "labels": {
      "readFile": "读取文件",
      "listDirectory": "列出目录"
    }
  }
}
```

#### 步骤 3：更新 TypeScript 类型

运行命令自动生成类型：

```bash
npm run i18n:generate-types
```

该命令会更新 `src/renderer/i18n/types.ts`，包含：
- `I18nNamespaces` - 所有命名空间的联合类型
- `I18nKeyPaths` - 所有翻译 key 的联合类型
- `NamespaceKeyMap` - 命名空间到 key 的映射

#### 步骤 4：在代码中使用翻译

**推荐方式 - 使用类型化 Hook**：

```tsx
import { useTypedTranslation } from '@/renderer/i18n/useTypedTranslation'

function MyComponent() {
  const { t } = useTypedTranslation('chat')
  
  return (
    <Button onClick={handleRetry}>
      {t('bubble.retry')}  {/* 类型安全，自动提示 */}
    </Button>
  )
}
```

**通用方式 - 使用 useTranslation**：

```tsx
import { useTranslation } from 'react-i18next'

function MyComponent() {
  const { t } = useTranslation('common')
  
  return <span>{t('save')}</span>
}
```

**错误消息 - 使用错误码模式**：

```tsx
import { useTypedTranslation } from '@/renderer/i18n/useTypedTranslation'
import { ErrorCode } from '@/shared/errorCodes'

function ErrorDisplay({ errorCode }: { errorCode: ErrorCode }) {
  const { t } = useTypedTranslation('errors')
  return <ErrorMessage>{t(errorCode)}</ErrorMessage>
}
```

#### 步骤 5：同步英文翻译

在 `en-US` 对应的 JSON 文件中添加相同的 key：

```json
// src/renderer/i18n/resources/en-US/chat.json
{
  "bubble": {
    "retry": "Retry",
    "archiveToWiki": "Archive to Wiki"
  },
  "tool": {
    "labels": {
      "readFile": "Read File",
      "listDirectory": "List Directory"
    }
  }
}
```

#### 步骤 6：运行检查工具

```bash
# 基础检查（推荐）
npm run i18n:check

# 严格检查（CI 使用）
npm run i18n:check:strict
```

**检查内容**：

| 检查项 | 说明 | 失败条件 |
|--------|------|----------|
| Key 对齐 | zh-CN 和 en-US 的 key 是否一致 | 存在只在一方出现的 key |
| JSON 格式 | 所有 JSON 文件是否合法 | JSON 解析失败 |
| 硬编码中文 | 源代码中是否有硬编码中文 | `--strict-hardcoded` 模式下源码含中文 |

---

## 三、命名空间使用规范

### 3.1 命名空间分配

| 命名空间 | 用途 | 示例 |
|----------|------|------|
| `common` | 全局通用文案 | 按钮文本、通用提示、状态标签 |
| `chat` | 聊天界面相关 | 消息气泡、输入框、工具调用 |
| `config` | 设置页面 | 表单标签、配置项说明 |
| `errors` | 错误消息 | API 错误、系统错误、业务错误 |
| `fileTree` | 文件树面板 | 右键菜单、工具栏、提示 |
| `search` | 搜索功能 | 搜索框、结果展示 |
| `feishu` | 飞书集成 | 远程状态、配置、提示 |
| `wiki` | Wiki 功能 | Wiki 面板、初始化、操作 |
| `detailPanel` | 详情面板 | 文件详情、引用文件列表 |

### 3.2 新增命名空间流程

如果需要新增命名空间（如新增模块）：

1. 在 `zh-CN/` 和 `en-US/` 目录下创建新的 JSON 文件
2. 在 `src/renderer/i18n/index.ts` 中导入并注册
3. 运行 `npm run i18n:generate-types` 更新类型

---

## 四、CI/CD 集成

### 4.1 自动检查

项目已配置以下自动检查：

| 脚本 | 触发时机 | 检查内容 |
|------|----------|----------|
| `predev` | `npm run dev` 前 | 自动生成类型 |
| `prebuild:renderer` | `npm run build:renderer` 前 | 自动生成类型 |
| `npm run i18n:check` | PR 提交时（建议） | Key 对齐、JSON 格式 |

### 4.2 GitHub Actions 配置

在 `.github/workflows/ci.yml` 中添加：

```yaml
- name: Run i18n checks
  run: npm run i18n:check:strict
```

---

## 五、常见问题与解决方案

### 5.1 Key 未找到（Missing key）

**问题**：运行时显示 `[missing key]`

**解决方案**：
1. 确认在 `zh-CN` 中已定义该 key
2. 运行 `npm run i18n:generate-types` 更新类型
3. 确认使用了正确的命名空间

### 5.2 类型错误（TypeScript error）

**问题**：`Argument of type 'string' is not assignable to parameter of type...`

**解决方案**：
1. 确保使用 `useTypedTranslation` 并指定正确的命名空间
2. 确认 key 已在 `zh-CN` 中定义
3. 重新运行 `npm run i18n:generate-types`

### 5.3 英文翻译遗漏

**问题**：`i18n:check` 报告 en-US 缺少 key

**解决方案**：
1. 根据提示在 `en-US` 对应的 JSON 文件中添加缺失的 key
2. 确保 key 路径与 zh-CN 完全一致

### 5.4 硬编码中文检测

**问题**：`i18n:check:strict` 报告源码中存在硬编码中文

**解决方案**：
1. 将中文文案提取到翻译资源文件
2. 在代码中使用 `t()` 函数调用
3. 测试文件中的中文可暂时保留（非严格模式不报错）

---

## 六、最佳实践

### 6.1 Key 命名建议

- **使用 camelCase**：`userName` 而非 `user_name` 或 `user-name`
- **保持语义清晰**：`button.submit` 而非 `btn_sbm`
- **避免过深嵌套**：最多 4 层（命名空间 + 3 层）
- **保持一致性**：同类功能使用相同的命名模式

### 6.2 翻译维护建议

- **定期同步**：每次代码提交前运行 `npm run i18n:check`
- **批量更新**：新增多个 key 时，先完成 zh-CN，再同步 en-US
- **使用翻译工具**：可借助专业翻译平台（如 Crowdin、Transifex）管理
- **保留上下文**：在翻译文件中添加注释说明使用场景（可选）

### 6.3 性能优化

- **按需加载**：对于大型命名空间，考虑使用 i18next 的按需加载功能
- **避免重复翻译**：通用文案统一放在 `common` 命名空间
- **缓存机制**：i18next 默认启用 localStorage 缓存，减少重复加载

---

## 七、工具命令速查

| 命令 | 功能 |
|------|------|
| `npm run i18n:generate-types` | 从 zh-CN 生成 TypeScript 类型 |
| `npm run i18n:check` | 检查 key 对齐和 JSON 格式 |
| `npm run i18n:check:strict` | 严格模式检查（含硬编码中文检测） |
| `npm run dev` | 启动开发服务器（自动生成类型） |
| `npm run build:renderer` | 构建渲染进程（自动生成类型） |

---

## 附录：翻译资源文件模板

```json
{
  "componentName": {
    "action": "操作描述",
    "label": "标签文本",
    "placeholder": "占位提示",
    "error": {
      "required": "必填错误",
      "invalid": "格式错误"
    }
  }
}
```

---

**文档版本**：v1.0  
**适用项目**：SpaceAssistant  
**最后更新**：2026年6月
