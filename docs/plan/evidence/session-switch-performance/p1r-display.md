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
