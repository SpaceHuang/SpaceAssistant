# I-09 Composer directory-grant 主线集成记录（2026-10-05）

## 结论

I-09 完成。复用 `origin/main` 提交 `810d38e2` 的 composer plus-menu/目录授权实现，并把 session grant 快照接回现有 invocation→tool gate→read permit→executor 链。没有新增第二套授权 UI、API 或策略。

## 上游代码复用与实际差异

- `src/renderer/components/Chat/MessageInput.tsx` 与 `810d38e2` 父提交逐字节一致；直接应用该提交的原始文件补丁。I-09 红测最初因该 composer 文件仍是旧版而找不到“选择目录”菜单项，修复后菜单加入/撤销测试通过。
- `electron/sessionDirectoryGrants.ts`、`src/shared/sessionDirectoryGrant.ts` 与 session IPC grant handlers 已在工作区；复用它们。将上游 `session-directory-grants:list/add/remove` preload 转发和 `SpaceAssistantApi` 类型补回，同时补齐该 composer 复用的 context-compaction API preload 转发/类型。
- 直接应用上游的 `sessionDirectoryGrantMatcher`、read permit target 绑定、tool gate grant 归属、executor 撤销/根目录身份/范围复核和诊断投影实现及测试。
- `invocationAssembler.ts` 与存储分支、I-07/I-08 有真实重叠；保留当前 model identity、History/usage、spill 与 storage 逻辑，仅合并 `810d38e2` 中 desktop 有效 grant snapshot、system context、per-tool grant context 和即时 active-grant identity recheck 的原始 hunks。
- 主线 `MessageInput.test.tsx` 使用了仓库未配置的 `toHaveTextContent` matcher；保持测试语义，改为检查 DOM `textContent`。主线 i18n chat JSON 与生成类型也一并接入。
- I-04 记录曾写“复用目录授权模块”，但之后复核发现 composer 和 renderer→preload→executor 通路当时并未完整进入当前树。本阶段补全该实际缺口；I-04 原有 session IPC/存储生命周期实现保留。

## 验收

- 定向执行链套件：9 个文件、245 项通过，覆盖 invocation snapshot/revocation、grant matcher、tool gate、permit executor、session IPC spoofing、grant stores/shared path semantics 和 registered tools。
- Composer UI：`src/renderer/components/Chat/MessageInput.test.tsx` 8/8 通过，覆盖 plus-menu 选择目录、展示授权和撤销。
- 合计涉及的主线与存储执行链定向用例 253 项通过。
- `npm run typecheck:shared`、`npm run typecheck:agent-sdk`、`npx tsc -p tsconfig.electron.json --noEmit`、`npm run i18n:check`、`git diff --check` 通过。
- `npm run typecheck:renderer` 仍由 I-10 的 `ChatView.tsx:588` 阻断：`continuation-started` 联合类型未被当前主线 renderer 分支处理；不在 I-09 越序修复。
- 未访问真实用户 profile；测试只使用临时目录和隔离数据库。Windows/外部平台验收按项目边界跳过。

## 集成链核对

`MessageInput` → `SpaceAssistantApi`/preload → trusted `sessionIpc` handlers → session metadata grant → `invocationAssembler` snapshot/即时撤销检查 → tool gate selected-directory source → permit target → executor session/root identity/scope revalidation → registered-tool audit projection 均已接通。选择目录只开放读取上下文；写入、Shell 与其他破坏性操作仍受原确认策略控制。
