# 工具结果信封契约（toolResultContract.ts）

对应源码：`packages/agent-sdk/src/toolResultContract.ts`。

工具结果的**单一契约**：失败码闭合枚举 + 不变量断言 + 事实优先归一。

## 归一纪律

`exitCode` / `terminationReason` / `aborted` 一律只取自**同一信封的 `data`**：

- `exitCode` ← `data.exitCode`（number）
- `terminationReason` ← `data.terminationReason`（string）
- `aborted` ← `data.status === 'cancelled'`

不得从进程回调、外部状态或调用方传参取值——否则"归一依据"与"事实"会分叉出第二份副本。

## 失败码（闭合枚举）

```ts
type ToolErrorCode =
  | 'TOOL_EXEC_FAILED'     // 执行了但失败：非零退出码 / 进程被杀（有事实依据）
  | 'TOOL_EXECUTOR_ERROR'  // 执行器自身异常（spawn 失败、内部抛出、文件系统意外）
  | 'POLICY_NOT_EXECUTED'  // 被安全 / 授权 / 预算拦下（未执行）
  | 'TOOL_USER_CANCELLED'  // 用户取消 / 超时前的主动中断
  | 'TOOL_INVALID_INPUT'   // 参数非法（校验层拒绝，未执行）

const TOOL_ERROR_CODES: readonly ToolErrorCode[]
function isToolErrorCode(code: unknown): code is ToolErrorCode
```

旧码映射（**长期保留，不设删除期限**；只作用于历史消息回显与归一）：

```ts
const LEGACY_TOOL_ERROR_CODE_MAP: Readonly<Record<string, ToolErrorCode>> = {
  SHELL_PROCESS_EXIT: 'TOOL_EXEC_FAILED',
  SHELL_SPAWN_ERROR: 'TOOL_EXECUTOR_ERROR',
  SHELL_TIMEOUT: 'TOOL_EXEC_FAILED',            // 由 terminationReason='timeout' 区分
  SHELL_CANCELLED: 'TOOL_USER_CANCELLED',
  SHELL_ARTIFACT_PATH_INVALID: 'TOOL_EXECUTOR_ERROR'
}
```

## 信封与归一函数

```ts
interface ToolResultEnvelope {
  success: boolean
  error?: string
  userMessageKey?: string
  userMessageParams?: Record<string, string | number>
  notExecuted?: true
  notExecutedReason?: string
  data?: unknown
}

type ToolResultInvariantId = 'I0' | 'I1' | 'I2' | 'I3' | 'I4' | 'I5'
interface ToolViolation { invariant: ToolResultInvariantId; detail: string }

function normalizeToolResultEnvelope(
  raw: unknown,
  opts?: { knownErrorCodes?: ReadonlySet<string> }
): { envelope: ToolResultEnvelope; violations: ToolViolation[] }
```

## 不变量

| ID | 规则 |
| --- | --- |
| I0 | `success` 必须是布尔 |
| I1 | `success === true ⇒ error == null && notExecuted !== true` |
| I2 | `data.exitCode === 0 && data.terminationReason === 'process_exit' && !aborted ⇒ success === true`（有事实的成功不得被判失败） |
| I3 | `notExecuted === true ⇒ success === false && notExecutedReason != null` |
| I4 | `aborted \|\| timedOut \|\| exitCode !== 0 ⇒ success === false` |
| I5 | `error` 若存在必须属于闭合枚举（或映射表内的旧码 / 宿主白名单 / `OUTPUT_LIMIT_REACHED`） |

## 归一顺序

1. **I0 前置**：`raw` 不是对象或缺布尔 `success` → 直接返回 `{ success: false, error: 'TOOL_EXECUTOR_ERROR', data: { status: 'result_invalid' } }` 并记录 I0 违规（不再继续）。
2. 从 `data` 提取事实：`exitCode`、`terminationReason`、`aborted`、`timedOut`。
3. **I2**：`exitOk`（`exitCode === 0 && terminationReason === 'process_exit' && !aborted`）而 `success !== true` → 改写为成功（清空 `error` / `notExecuted` / `notExecutedReason`）。
4. **I4**：`exitCode !== 0 || aborted || timedOut` 而 `success === true` → 改写为失败（`error` 缺省补 `TOOL_EXEC_FAILED`）。
5. **I3**：`notExecuted === true` 时补 `notExecutedReason = 'unknown'`（若缺），并强制 `success = false`。
6. **I1**：`success === true` 但仍带 `error` → 清除 `error`。
7. **I5**：`error` 存在且 `!success` 时校验是否在闭合枚举 / 旧码映射 / `opts.knownErrorCodes` / `OUTPUT_LIMIT_REACHED` 内，未知码只记违规（保留原值）。

返回归一后的信封与全部违规明细。**无进程事实的信封不做事实归一**（`exitOk` / `executionFailed` 都要求 `exitCode` 或 `terminationReason` 存在）。

## 使用注意

- 该函数是纯函数，不抛异常；调用方需自行决定是记录违规、上报还是拒绝。
- I2 / I4 的语义方向相反：事实为成功时**必须**归成成功，事实为失败时**必须**归成失败——防止"矛盾时把成功改判失败"这类历史 bug。
