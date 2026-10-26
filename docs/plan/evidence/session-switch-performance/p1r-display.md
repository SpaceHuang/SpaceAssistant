# P1-R 正文优先显示：RED 与方案期交互审查

日期：2026-10-27  
工作树：`.worktrees/session-storage-boundary-refactor`  
基线：`e9ecad21`（P1-03 已关闭）  
方案：`会话切换性能优化方案.md` §5 D-2、AC-8  
执行计划：`会话切换性能优化执行计划.md` R-01

## 范围与已批准行为

D-2 已批准的界面归属卡限定为既有失败 assistant 气泡：消息正文先显示，初始保留通用失败提示，查到原因后在原气泡补充；查询失败时继续保留通用提示。只使用已有气泡与样式，不加控件或文案。迟到原因必须同时匹配当前会话、当前显示请求代次，且目标消息仍存在。R-01 仅固化缺失行为并审查现有界面，不改生产 UI。

## RED 用例与 C2 结果

执行命令：

```bash
npm exec -- vitest run src/renderer/components/Chat/ChatView.failureReasonRestore.test.tsx src/renderer/services/turnFailureHydration.test.ts src/renderer/store/chatSlice.test.ts src/renderer/services/displayPageLoader.test.ts src/renderer/components/Chat/ChatMessageList.failureReason.test.tsx --reporter=dot
```

结果：5 files，38 passed，3 failed，0 skipped，耗时 2.98s。三项失败均为本阶段目标行为缺失的有效 RED：

| 用例 | 失败证据 | 缺失行为 |
|---|---|---|
| `ChatView 失败原因回溯 > 失败原因查询挂起时先提交并显示消息正文` | `findByText('partial')` 超时，界面仍为空 | 首屏等失败原因查询完成后才提交消息页 |
| `ChatView 失败原因回溯 > A→B→A 时旧 A 的晚到原因不能覆盖第二次 A 的结果` | 首次 A 的旧原因覆盖第二次 A 的新原因 | 失败原因结果缺少显示请求代次隔离 |
| `chatSlice > turnFailures > 消息移除后不接纳晚到的失败原因回溯` | state 仍包含被移除消息的原因 | reducer 合并原因时未验证目标消息仍存在 |

`turnFailureHydration.test.ts` 内既有的“回查失败时不影响消息加载”和“重复失败消息 ID 去重”用例在此运行通过；它们是基线覆盖，不计作新增 RED。A→B→A 用例在此次正式运行中无 React `act` 环境警告。

此前有一个失去输出通道的 Vitest 进程持续单核运行约 14 分钟，已终止；该进程未产生可用测试结果，不计入 C2。

## 方案期交互审查

执行 `$impeccable critique` 的双代理方案审查，目标 `src/renderer/components/Chat/ChatView.tsx`，设计基线为已批准 D-2、桌面 UI 现状与交互指南。审查前确认 `ChatBubble.tsx` 与 `layout.css` 的既有失败区。无生产 UI 文件改动。

- 当前 `fetchMessagePage` 等待失败原因回查后才返回，首屏 effect 随后才 dispatch 页面，因此原因查询阻塞正文显示；这是本阶段 P1 优先修复项。
- 迟到原因会改变失败气泡高度；特定 key 错误会改变通用说明并展示设置动作。实现后需验证滚动锚点、长原因与窄窗口。
- 失败区域使用 alert 语义，延迟补充可能重复播报；在既有范围内做无障碍回归，不新增文案或交互。
- 检测器对 ChatView 返回 0 项。浏览器可以访问本地地址但内容为空白，无法观察 ChatView；没有注入覆盖层或声称存在视觉标注。
- 审查评分 27/40；完整报告存于 `.impeccable/critique/2026-10-26T17-05-12Z__src-renderer-components-chat-chatview-tsx.md`。

## R-01 结论

R-01 具备计划要求的有效 RED、拒绝/重复查询基线、A→B→A 与移除消息反例，以及方案期审查记录。下一步进入 R-02：只改 `ChatView.tsx`、`turnFailureHydration.ts`、`chatSlice.ts` 与相关测试，先正文提交，后异步补原因，并以会话 + 请求代次 + 消息存在性拒绝迟到结果。

## R-02 GREEN

实现后运行计划 C2 五文件组：5 files，43 passed；另将 `ChatView.queuedBar.test.tsx` 纳入关联回归，最终 6 files，67 passed，未捕获异步错误。`npm run typecheck:renderer` 通过。

实现要点：

- `fetchMessagePage` 现在只等待主消息页请求，立即返回，并单独记录页请求耗时。失败原因查询从页面提交后启动，不再挡首屏或 prepend。
- 首屏、向前翻页、消息失效重载三个调用点均在完成 `setDisplayPage` / `prependDisplayPage` 后发起原因查询；翻页仅对本次读到的新页补查。
- 独立递增 display request generation，不再复用 context-summary generation。失败原因 reducer 合并时核对会话、display generation、目标消息仍在当前显示页且属于该会话。消息移除同时清理原因缓存；旧代次页面不能覆盖新页。
- A→B→A 测试确认首次 A 的请求完成后仍保留第二次 A 的原因；拒绝查询测试等待正文与通用提示出现并跨一个事件循环，避免遗漏未处理 rejection；移除消息、错误会话和旧 generation 均由 reducer 用例覆盖。
- 扩展回归发现 `ChatView.queuedBar.test.tsx` 的 IPC mock 重复返回同一个对象，而 trace 元数据按真实 contextBridge 行为附着到单次响应对象。将其改为每次返回新对象后，该既有跨会话回归通过。

C2 GREEN 覆盖：正文先显示、迟到原因原位补齐、拒绝查询降级、同页重复 ID 去重（既有 service 用例）、A→B→A、消息移除、旧 generation/错误 session 拒绝、翻页先 prepend，以及消息重载回归。R-02 只改 renderer 读取时序和 Redux 校验；没有改 IPC、失败气泡样式或文案。

## R-03 渲染阶段验收

实现后复核采用两个互不共享结论的只读评估：A 检查交互/时序/辅助技术，B 独立运行 detector 并检查浏览器及测试证据。A 评分 31/40：页面与诊断查询解耦、消息代次隔离、失败时保持正文是主要优势；剩余风险为长原因补入后改变气泡高度、读屏对 `role="alert"` 子树迟到更新的播报、缺少原因时无法区分无记录与查询失败。以上不改变已批准 D-2，本轮不新增控件、文案或样式。

- Impeccable detector 对 `ChatView.tsx` 返回 `[]`（0 项）。浏览器自动化 surface 不可用（没有已启用 browser），因此无法观察实时 UI、测量窄窗口布局或确认非底部阅读位置的虚拟列表锚定。CSS 已有 `flex-wrap`、`min-width: 0`、`overflow-wrap: anywhere`、`white-space: pre-wrap`，并新增长无空格原因文本保留测试；这只能证明内容未被截断，不能代替浏览器布局验收。
- 自动失败原因补入路径检查没有发现主动调用滚到底部；自动滚动仍受 `stickToBottom` 状态限制。非底部滚动锚点在原因导致行高变化时仍缺浏览器/真机证据，作为已知限制保留。
- 扩展 C2 相关组：9 files，103 passed。包括正文先显示、分页先 prepend、回查拒绝、A→B→A、reducer 消息/会话/代次校验、长原因文本、失败气泡及视口贴底/离底、键盘触发“滚到最新”回归。首次新增长文本测试误用了项目未安装的 `toHaveStyle` matcher（1 fail）；移除该 matcher 后同一组全绿，最终结果仅计第二次运行。
- C7 `npm run typecheck:renderer` 通过。没有新增文案，C8 不适用。
- 页请求与失败原因回查现分别记录 `renderer-page-request`、`failure-reason-hydration` 阶段；挂起查询测试验证正文提交不再等待原因查询。
- 本地 impeccable 完整快照记录在 `.impeccable/critique/2026-10-26T17-18-09Z__src-renderer-components-chat-chatview-tsx.md`；该目录被 git 忽略。此提交中的摘要与验证结果可长期审阅。

R-03 结论：本机 C2/C7 与 AC-8 时序验收通过；真实窄屏渲染、滚动锚定及读屏播报仍未验收。实现未修改视觉范围。提交前对本阶段 renderer 改动及证据单独 review。
