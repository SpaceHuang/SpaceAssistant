# 工具 path 字段别名归一化 - 执行 Todo 清单

> 来源：`docs/develop/tool-path-field-alias-normalization-tdd-plan.md`（v3）
>
> 目标：修复 `read_file` 等工具因模型把 `path` 写成 `filePath`/`file_path` 而被静默放行、最终触发「回复未能完成」的问题。
>
> 范围：修复项 1（执行器归一化）+ 2（校验器识别别名并报清晰错误）+ 4（系统提示/工具描述强调字段名）。不含修复项 3（放宽重复错误计数器）。
>
> 方法：严格 TDD，每个修复项内先写失败测试（Red）再改实现（Green），最后统一回归。
>
> 状态图例：`-[ ]` 未开始 ｜ `-[~]` 进行中 ｜ `-[x]` 已完成

---

## 一、共享 helper：extractPathField（基础，§4.1）

> 修复项 1+2 的共同基础，单点定义、单点测试，放 `electron/` 根便于校验器与执行器共用。

**Red**

- [x] 新建 `electron/toolPathField.test.ts`（node 环境），粘贴 §5.1 的 10 条用例（path 优先、filePath 回退、file_path 回退、多字段优先级、全缺失返回 undefined、非字符串跳过、空串/纯空白视为缺失、PATH_FIELD_ALIASES 顺序）。
- [x] 运行 `npx vitest run electron/toolPathField.test.ts`，确认因 `./toolPathField` 模块不存在而 Red。

**Green**

- [x] 新建 `electron/toolPathField.ts`，导出 `PATH_FIELD_ALIASES = ['path','filePath','file_path']` 与 `extractPathField(input)`（按优先级取第一个非空字符串；空串/纯空白视为缺失返回 undefined；非字符串跳过；原样返回不 trim）。
- [x] 在 JSDoc 中注明：仅用于 5 个文件类工具，**严禁**用于 wechat 的 filePath/imagePath（语义不同）。
- [x] 运行 `npx vitest run electron/toolPathField.test.ts`，转绿。

---

## 二、修复项 2：校验器识别别名 + 清晰错误（§4.3）

**Red**

- [x] 在 `electron/toolInputGuards.test.ts` 顶部补 import：`sanitizeToolErrorString`（from `./tools/toolUserErrors`）与 `toolErrMissingPath`（与既有 `assertSafeToolInput` import 合并）。
- [x] 在 `toolInputGuards.test.ts` 追加 §5.2「assertSafeToolInput - path field aliases」describe 块（12 条用例：read_file/list_directory/grep/edit_file/write_file 接受别名 + 缺参报错含 hint + 别名过长校验）。
- [x] 在 `toolInputGuards.test.ts` 追加 §5.5「toolErrMissingPath hint survives sanitizeToolErrorString」describe 块（read_file/edit_file/write_file 三工具循环：`sanitizeToolErrorString(toolErrMissingPath(toolName), toolName)` 仍含 `缺少必填参数 path` 与 `请勿使用 filePath 或 file_path`）。
- [x] 运行 `npx vitest run electron/toolInputGuards.test.ts`，确认新增用例 Red（旧用例不应变红）。

**Green**

- [x] 就地增强 `toolErrMissingPath`（`toolInputGuards.ts:37-39`）：尾部追加 hint，返回 `工具参数无效：${toolName} 缺少必填参数 path（注意字段名为 path，请勿使用 filePath 或 file_path）`。**不新增并列函数**。
- [x] 改 `assertSafeToolInput` 的 `read_file` case：用 `extractPathField` 取 path，`undefined` 时 `throw new Error(toolErrMissingPath('read_file'))`，再 `assertStringLen(p,'path',PATH_OR_GLOB_MAX)`（**改为必填**）。`offset`/`limit` 的 `optPositiveInt` 校验分支保持原样，勿误删。
- [x] 改 `list_directory` case：`const p = extractPathField(input); if (p !== undefined) assertStringLen(p,'path',PATH_OR_GLOB_MAX)`（保持可选）。
- [x] 改 `grep` case：同 list_directory（path 可选，仅校验长度）。
- [x] 改 `edit_file` case：用 `extractPathField`，`undefined` 抛 `toolErrMissingPath('edit_file')`，再 `assertStringLen`。
- [x] 改 `write_file` case：同 edit_file。
- [x] 运行 `npx vitest run electron/toolInputGuards.test.ts`，全绿。

---

## 三、修复项 1：执行器归一化（§4.2）

**Red**

- [x] 新建 `electron/tools/builtinExecutors.pathAlias.test.ts`（node 环境），照搬 `builtinExecutors.fileState.test.ts` 的 `makeCtx`/`tmpDir` 范式，粘贴 §5.3 全部用例（read_file/edit_file/write_file/list_directory/grep 接受别名 + read_file/edit_file/write_file 缺参报 hint + list_directory 无 path 默认列工作目录根 + 原始 path 仍可用回归）。
- [x] 运行 `npx vitest run electron/tools/builtinExecutors.pathAlias.test.ts`，确认别名用例 Red。

**Green**

- [x] 改 `read_file` 执行器（`builtinExecutors.ts:173`）：`const rel = extractPathField(input)`；`rel === undefined` 返回 `{ success:false, error: toolErrMissingPath('read_file') }`。
- [x] 改 `edit_file` 执行器（`:444`）：用 `extractPathField`，缺参返回 `toolErrMissingPath('edit_file')`（现存 `:446` 调用不变，函数已增强）。
- [x] 改 `write_file` 执行器（`:546`）：用 `extractPathField`，缺参返回 `toolErrMissingPath('write_file')`（现存 `:548` 调用不变）。
- [x] 改 `list_directory` 执行器（`:288`）：`const rel = extractPathField(input) ?? '.'`。
- [x] 改 `grep` 执行器（`:816`）：`const relPath = extractPathField(input) ?? ''`。
- [x] 运行 `npx vitest run electron/tools/builtinExecutors.pathAlias.test.ts electron/tools/builtinExecutors.fileState.test.ts electron/tools/builtinExecutors.wiki.test.ts electron/tools/builtinExecutors.autoApprove.test.ts`，全绿。

---

## 四、修复项 4a：工具描述强调字段名（§4.4a）

**Red**

- [x] 新建 `src/shared/builtinToolDefinitions.test.ts`（与 `builtinToolDefinitions.artifact.test.ts` 并列，vitest 默认 jsdom 环境，纯数据断言），粘贴 §5.4a 用例（循环断言 read_file/edit_file/write_file/list_directory/grep 的 description 含 `path` 且含 `请勿使用 filePath 或 file_path`）。
- [x] 运行 `npx vitest run src/shared/builtinToolDefinitions.test.ts`，确认 Red。

**Green**

- [x] 在 `src/shared/builtinToolDefinitions.ts` 的 read_file/edit_file/write_file/list_directory/grep 五个工具 `description` 末尾追加一句：`路径字段名为 path（小写），请勿使用 filePath 或 file_path。`（面向 LLM，不纳入 i18n）。
- [x] 运行 `npx vitest run src/shared/builtinToolDefinitions.test.ts`，转绿。

---

## 五、修复项 4b：系统提示强调字段名（§4.4b）

**Red**

- [x] 在 `electron/llmSystemPrompt.test.ts` 追加 §5.4b「buildFinalSystemPrompt - tool convention hint」describe 块：zh-CN 含 `工具调用约定`/`字段名为 \`path\`` 且 `\n\n## 工具调用约定`；en-US 含 `Tool call conventions`/`named \`path\`` 且 `\n\n## Tool call conventions`。`system` 传非空值确保 hint 非首段。
- [x] 运行 `npx vitest run electron/llmSystemPrompt.test.ts`，确认新增用例 Red。

**Green**

- [x] 在 `electron/llmSystemPrompt.ts` 新增 `buildToolConventionHint(locale)`：zh/en 双语，穷举 5 个文件类工具、排除 wechat。
- [x] 在 `buildFinalSystemPrompt` 中于 `appendUiLocaleSystemHint`（`:74`）之前**无条件**以 `\n\n` 注入该 hint。
- [x] 运行 `npx vitest run electron/llmSystemPrompt.test.ts`，转绿。

---

## 六、验收与回归（§7）

- [~] 运行 `npm test`，全量通过；重点确认：`toolPathField.test.ts`（新）、`toolInputGuards.test.ts`（追加）、`builtinExecutors.pathAlias.test.ts`（新）、`builtinExecutors.fileState.test.ts`（回归）、`src/shared/builtinToolDefinitions.test.ts`（新）、`electron/llmSystemPrompt.test.ts`（追加）。
- [x] 运行 `npm run build:electron`，类型检查通过。
- [x] 运行 `npm run build:renderer`，类型检查通过。
- [x] 行为变更排查 A（read_file 改必填）：`grep -rn "readFileExecutor.execute\|execute.*read_file" electron/ src/` 确认无内部调用方在无 path 下调用；检查 `builtinExecutors.*.test.ts`、`readFileRange.test.ts` 是否有 `{}` 入参的 read_file 调用，按需补 path。
- [x] 行为变更排查 B（空串/纯空白路径）：`grep -rn "path: ''\|path: '   '" electron/ src/` 确认无内部夹具依赖「空串 = workDir」或「空白路径报错」的旧语义。
- [x] 端到端回归：用 `deepseek-v4-pro` 复现「read_file 传 `filePath`」场景，确认 ① 正常读到文件（不再返回 `路径是目录而非文件: 。…`）② 不再触发「同一工具错误已连续出现 3 次」中止 ③ 用户不再看到「回复未能完成」。
- [x] 查 `.agent/logs/Agent-{YYYYmmdd}.log`：`tool.error` 中 `路径是目录而非文件` 条目消失，`llm.error` 中 `同一工具错误已连续出现` 条目消失。
- [ ] PR 说明中点明两项行为变更：read_file 的 path 由可选改必填；空串/纯空白路径在 list_directory/grep 下走默认值而非报错。

> 范围限定（A4）：上述「不再中止」仅针对**别名误用**场景。若模型**完全不用**任何 path 类字段，guard 缺参错误仍会走 `noteFailure` 连续 3 次 abort，该场景属修复项 3，不在本计划范围，验收时勿误判为回归。

---

## 附：风险备忘（非 todo，实现时遵循）

- **wechat `filePath` 撞名**：`extractPathField` 严禁用于 wechat 工具入参；若后续把别名归一化下沉到 `coalesceToolUseInputs`，须按 toolName 白名单处理，避免污染 wechat 的 `filePath`/`imagePath`。
- **hint 文案 sanitize 透传约束**：hint 须保持简短（<240 字符）、含中文、不得含路径示例或绝对路径（否则触发 `containsInternalDetails` 被 `defaultForTool` 吞噬）。该不变量由 §5.5 测试守护，改文案时须同步确认该断言仍绿。
- **别名扩展**：若日志未来出现 `filepath`/`Path` 等变体，追加到 `PATH_FIELD_ALIASES` 即可，单点扩展。
