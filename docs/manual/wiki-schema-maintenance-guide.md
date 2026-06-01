# Wiki Schema 维护指南

## 概述

`SCHEMA.md` 是 LLM Wiki 的核心配置文件，定义了知识库的组织结构、页面类型和工作流程。有效的 Schema 维护能让你的知识库更加有序、高效。

---

## 一、理解 Schema 的作用

### 1.1 Schema 的核心职责

| 职责 | 说明 |
|------|------|
| **目录约定** | 定义 `raw/`（原始资料）和 `wiki/`（整理后知识）的分工 |
| **页面类型** | 规范不同类型知识的存储位置（entity、concept、topic 等） |
| **工作流程** | 指导 AI 执行 Ingest、Query、Lint 的具体步骤 |
| **输出语言** | 指定 AI 回答的默认语言 |

### 1.2 默认 Schema 结构

```markdown
# LLM Wiki Schema
├── 目录说明          # raw/、wiki/、SCHEMA.md 的职责
├── 页面类型          # 5种标准页面类型定义
├── Ingest 工作流     # 资料收录流程
├── Query 工作流      # 查询回答流程
├── Lint 工作流       # 健康检查流程
└── 输出语言          # 默认 zh-CN
```

---

## 二、何时需要修改 Schema

### 2.1 典型场景

| 场景 | 说明 | 示例 |
|------|------|------|
| **新增页面类型** | 现有类型无法满足需求 | 增加 `project`、`book`、`paper` 等 |
| **调整工作流** | 修改 AI 的执行步骤 | 增加审核环节、改变搜索优先级 |
| **领域定制** | 为特定场景添加规则 | 编程知识库、学术研究库 |
| **优化结构** | 改进知识组织方式 | 调整目录层级、添加子分类 |

---

## 三、修改 Schema 的方法

### 3.1 方法一：直接编辑文件

1. 在「文件」面板的 **LLM Wiki** 分区找到 `SCHEMA.md`
2. 点击打开文件
3. 直接编辑内容
4. 保存后立即生效

### 3.2 方法二：通过聊天指令

```
/wiki query 请帮我修改 SCHEMA.md，增加一个 project 页面类型

/wiki query 请优化我的 Schema，让它更适合管理技术文档
```

### 3.3 修改前的准备

1. **备份当前版本**：用 Git 提交或复制一份
2. **明确目标**：想解决什么问题？要达成什么效果？
3. **测试计划**：修改后用哪些操作验证效果？

---

## 四、常见修改场景示例

### 4.1 场景一：增加自定义页面类型

**需求**：添加书籍笔记分类

```markdown
## 页面类型

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | wiki/entities/ | 人物、组织、产品等实体 |
| concept | wiki/concepts/ | 概念与术语 |
| topic | wiki/topics/ | 主题综合 / 综述 |
| source | wiki/sources/ | 与 raw 对应的摘要页 |
| query | wiki/queries/ | 由 Query 归档的分析页 |
| book | wiki/books/ | 书籍笔记 |  ← 新增
```

### 4.2 场景二：修改 Query 流程

**需求**：让 AI 优先查看综述页

```markdown
## Query 工作流

1. `read_file(wiki/index.md)` — 按分类定位候选页
2. **优先查看 topics/ 下的综述页**（修改）
3. `read_file` 深入阅读相关页
4. index 未覆盖时 `grep(pattern, path=wiki/)` 补充搜索
5. 综合回答，正文引用 `wiki/...` 路径
6. 用户要求时归档为 `wiki/queries/` 新页
```

### 4.3 场景三：添加领域特定规则

**需求**：为编程知识库添加规则

```markdown
## 领域规则（新增）

### 编程知识库规范
- 代码示例放入 `wiki/code/` 子目录
- API 文档放入 `wiki/api/` 子目录
- 版本号格式：`YYYY-MM-DD-版本号`
- 代码块使用 ```typescript 标记语言类型
```

---

## 五、维护最佳实践

### 5.1 保持简洁

- 只定义必要的规则，避免过度约束
- 不要规定每个页面的具体格式细节
- 给 AI 一定的灵活性

### 5.2 与 AI 协作

```markdown
# 让 AI 帮助优化
/wiki query 请分析我当前的 Wiki 使用情况，给出 Schema 优化建议

# 让 AI 解释规则
/wiki query 请解释 SCHEMA.md 中各个页面类型的区别

# 让 AI 执行修改
/wiki query 请帮我添加一个「project」页面类型
```

### 5.3 定期审查

```markdown
# 检查健康状况
/wiki lint

# 检查并自动修复
/wiki lint --fix
```

### 5.4 版本控制

- `SCHEMA.md` 在工作目录下，可使用 Git 管理
- 每次修改前提交，方便回滚
- 记录变更说明

### 5.5 渐进式演化

- 不要一次性做大改动
- 先从小的调整开始
- 观察效果后再扩展

---

## 六、注意事项

### 6.1 不要删除必要内容

保留以下核心部分：
- 目录说明（raw/、wiki/ 的职责）
- 页面类型定义
- 三大工作流（Ingest、Query、Lint）

### 6.2 保持格式一致

- 使用统一的 Markdown 表格格式
- 使用统一的列表样式
- 保持缩进和换行一致

### 6.3 保护原始资料

**不要修改**「禁止写入 raw/」的规则，这是保护原始资料的重要机制。

### 6.4 测试变更

修改后进行以下测试：

| 测试项 | 命令 | 验证点 |
|--------|------|--------|
| 收录资料 | `/wiki ingest raw/test.md` | 是否正常更新 wiki 页 |
| 查询回答 | `/wiki query xxx` | 是否引用正确路径 |
| 健康检查 | `/wiki lint` | 是否发现问题 |

---

## 七、常见问题

### Q1：修改 Schema 会影响已有的 wiki 页面吗？

**A**：不会直接影响，但新的 Ingest 会按照新规则创建页面。已有页面需要手动整理或通过 `/wiki lint --fix` 修复。

### Q2：可以完全自定义页面类型吗？

**A**：可以，但建议至少保留 `entity`、`concept`、`topic` 三种核心类型，确保基本功能正常。

### Q3：Schema 可以使用中文吗？

**A**：可以，默认就是中文。但关键字（如 `raw/`、`wiki/`）建议保持英文。

### Q4：如何撤销 Schema 的修改？

**A**：如果使用 Git，直接回滚提交即可。如果没有版本控制，手动恢复备份文件。

---

## 八、示例：优化后的 Schema

```markdown
# LLM Wiki Schema

> 本文件定义 Wiki 目录约定与 ingest / query / lint 工作流。可与 LLM 协作演化。

## 目录说明

- `raw/`：只读原始资料（用户写入；LLM **仅 read**）
- `wiki/`：LLM 维护的结构化 Markdown 页面（read/write）
- `SCHEMA.md`：本规范文件

## 页面类型

| 类型 | 目录 | 说明 |
|------|------|------|
| entity | wiki/entities/ | 人物、组织、产品等实体 |
| concept | wiki/concepts/ | 概念与术语 |
| topic | wiki/topics/ | 主题综合 / 综述 |
| source | wiki/sources/ | 与 raw 对应的摘要页 |
| query | wiki/queries/ | 由 Query 归档的分析页 |
| book | wiki/books/ | 书籍阅读笔记 |

## Ingest 工作流

1. `read_file` 读取 raw 文件
2. 分析要点，识别相关 entity、concept、topic
3. 创建或更新对应的 wiki 页面
4. 更新 `wiki/index.md`
5. 向 `wiki/log.md` 追加 ingest 条目

**禁止：** 不得修改 `raw/`；不得删除 log 历史。

## Query 工作流

1. `read_file(wiki/index.md)` — 按分类定位候选页
2. 优先查看 `topics/` 下的综述页
3. `read_file` 深入阅读相关页
4. index 未覆盖时 `grep(pattern, path=wiki/)` 补充搜索
5. 综合回答，正文引用 `wiki/...` 路径
6. 用户要求时归档为 `wiki/queries/` 新页

## Lint 工作流

检查项：
- 矛盾声明
- 过时结论
- 孤儿页（无入链）
- 缺页（引用但不存在）
- 缺链（实体首次出现无对应页）
- index 与文件系统不一致

## 领域规则

### 技术文档规范
- 代码示例使用 ```typescript 标记语言类型
- 版本号格式：`YYYY-MM-DD-v1.0`
- API 文档放入 `wiki/api/` 子目录

## 输出语言

默认 zh-CN。
```

---

**文档版本**: 1.0  
**创建日期**: 2026-06-01  
**适用范围**: SpaceAssistant LLM Wiki Schema 维护
