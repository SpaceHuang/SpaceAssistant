# 搬迁后死链检查记录（2026-10-14）

> 检查范围：`git ls-files '*.md'`（390 篇）｜基线：`main` `17236274`｜执行：Agent
> 方法：解析每篇的 `](目标)` 链接，按**搬迁前/后**相对路径解析存在性；目标落到未入库目录（`docs/review/`、`docs/analysis/`、`docs/references/` 等，见 `.gitignore`）的记为「预期」，不计入。

## 结论

| 类别 | 数量 | 处理 |
| --- | --- | --- |
| 搬迁引入的断链（活跃文档） | 182 → **已修 183** | 逐条改指新路径（用受控编辑工具，未用脚本改写） |
| 归档件内部断链 | 389 | **接受**：按计划 §2.4「归档件内容零改动」，不改归档件正文 |
| 活跃文档残余断链 | 约 79 | 见下「残余清单分类」 |
| 模板示例链接（`_consolidation/docs-consolidation-rules.md`） | 6 | 非断链（模板占位符 `<模块>`、`<主题>`） |

## 残余清单分类（活跃文档）

| 类别 | 例 | 说明 |
| --- | --- | --- |
| 指向未入库目录 | `../review/…`、`../analysis/…`、`../references/…` | 目标本地存在或本就不在库内；**非本次搬迁引入** |
| 指向已不存在的历史评审件 | `../../review/2026-10-05-session-storage-complete-todo-review.md` 等 | 原本即断（文件从未入库或已删） |
| 过时相对路径 | `docs/requirement/tools-mcp/tools-requirement.md` 里的 `electron/tools/…`（缺 `../../../` 前缀） | 原本即断（搬迁前后同样解析不到） |
| `docs/废弃/工作区管理/*` | `../multi-workdir-requirement.md` 等 | 该目录为历史归档区，本次不动；链接过时属既有状态 |
| `docs/knowledge/wiki/index.md` | `modules/product-host/p-assembly/_index.md` | wiki 索引未入库/未生成，非本次引入 |

## 复核命令

```text
# 列出活跃文档（非 archive/）中断链
python3 - <<'EOF'   # 见 _consolidation 说明；或用编辑器逐个走查
EOF
rg -n '\]\(\s*\.\.?/' docs/develop --glob '!**/archive/**'
```

> 注：本项目内**不提供**批量改写脚本（策略禁止脚本直接读写仓库文档），残余项请用受控编辑工具逐个处理。

## 第二轮复查（2026-10-14 晚，全量 444 篇）

**口径**：排除 `archive/`（内容零改动）、`_consolidation/` 模板占位符，以及目标落在未入库目录（`docs/review/` / `docs/analyze/` / `docs/references/`）的情形。

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| 活跃文档断链（总计） | **76** | 见下 |
| 模板占位符（`./<模块>-现状.md`、`./history.md` 等） | 5 | 预期，非断链 |
| 记录文档内的示例文本（`](目标)`） | 1 | 预期 |
| 指向未入库 / 已删的评审件与历史件（`../review/…`、`../analyze/…`、`../references/…`、`../废弃/…`） | 25 | **接受**：目标在本地也不存在，属**原本即断** |
| `docs/废弃/`、`docs/knowledge/`、`docs/i18n/` 等**边界目录**内的旧链接 | 38 | **接受**：§2.5 约定这些目录不动 |
| **本次修复** | **7** | 见下表 |

**已修复的 7 处**：

| 文件 | 问题 | 修法 |
| --- | --- | --- |
| `_consolidation/docs-consolidation-rules.md` | 3 处链接多写一层 `../`（`../../agent-sdk/runtime/README.md`、`../../desktop-ui/README.md`、`../../platform-eng/README.md`） | 改为 `../…`（本文件位于 `docs/develop/_consolidation/`） |
| `requirement/tools-mcp/tools-requirement.md` | 4 处代码引用缺层级（`electron/tools/…`） | 改为 `../../../electron/…` |

**复查结论**：搬迁引入的断链**已清零**；其余 69 处均属「预期 / 原本即断 / 边界目录内」，无需处理。归档件内部的 398 处按 §2.4「内容零改动」保留。

## 复核命令

```text
git -c core.quotepath=false ls-files '*.md' > /tmp/md-list.txt   # 全量清单（本次 444 篇）
# 再用脚本解析 ](...)：跳过 archive/ 与 _consolidation/；目标在主工作目录存在则记为「未入库」
```
