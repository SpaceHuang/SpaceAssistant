import { store } from '../store'
import { setSessions } from '../store/sessionSlice'
import { applyFileTreeInvalidation } from './fileTreeSyncBus'
import { applyFileContentInvalidation } from './fileContentSyncBus'

/**
 * 偏差 11:失效通知 → 通知驱动重取。
 * 主进程经 scope:invalidated 广播 { scope, version };渲染端只做版本比较:
 * 通知版本更高才重取(真相只从 Storage 取),多条通知防抖合并为一次重取。
 * scope 清单:session-list / session:<id> / session:<id>:messages / file-tree / file:<path>。
 */

const DEBOUNCE_MS = 150

let known = new Map<string, number>()
let pending = new Map<string, { version: number; hint?: unknown }>()
let timer: ReturnType<typeof setTimeout> | null = null
let messagesReloadHandler: ((sessionId: string) => void) | null = null
let flushing = false

export function registerMessagesReloadHandler(fn: ((sessionId: string) => void) | null): void {
  messagesReloadHandler = fn
}

export function startInvalidationService(): () => void {
  return window.api.onScopeInvalidated(({ scope, version, hint }) => {
    if (version <= (known.get(scope) ?? 0)) return
    // v2-B5:同 scope 后到通知不得整体覆盖先到者——file-tree 的 hint 合并(paths 并集、refreshExpanded 粘性),
    // 否则防抖窗内被丢路径的目录永不刷新
    const prev = pending.get(scope)
    if (scope === 'file-tree' && prev) {
      pending.set(scope, { version, hint: mergeTreeHints(prev.hint, hint) })
    } else {
      pending.set(scope, { version, hint })
    }
    scheduleFlush()
  })
}

type TreeHint = { paths?: string[]; refreshExpanded?: boolean }

function mergeTreeHints(a: unknown, b: unknown): TreeHint {
  const ha = (a ?? {}) as TreeHint
  const hb = (b ?? {}) as TreeHint
  const paths: string[] = []
  const seen = new Set<string>()
  for (const p of [...(ha.paths ?? []), ...(hb.paths ?? [])]) {
    if (!seen.has(p)) {
      seen.add(p)
      paths.push(p)
    }
  }
  return {
    paths,
    refreshExpanded: Boolean(ha.refreshExpanded || hb.refreshExpanded)
  }
}

function scheduleFlush(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flush()
  }, DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  if (flushing) {
    scheduleFlush()
    return
  }
  flushing = true
  try {
    const snapshot = new Map(pending)
    pending.clear()
    for (const [scope, entry] of snapshot) known.set(scope, entry.version)

    if (snapshot.has('session-list')) {
      try {
        const sessions = await window.api.sessionList()
        store.dispatch(setSessions(sessions))
      } catch {
        // v2-N5:重取失败回退该 scope 的版本基线,等待下一条通知再试(否则陈旧到下一次写入)
        const failed = snapshot.get('session-list')
        if (failed) known.set('session-list', failed.version - 1)
      }
    }

    for (const [scope, entry] of snapshot) {
      const m = /^session:(.+):messages$/.exec(scope)
      if (m) {
        // v2-N5:重载失败回退版本,保证下一条同 scope 通知仍会触发重取
        try {
          messagesReloadHandler?.(m[1])
        } catch {
          known.set(scope, entry.version - 1)
        }
        continue
      }
      // 偏差 11/3c:文件域失效转发到对应 bus(渲染端自行重取真相)
      if (scope === 'file-tree') {
        const hint = snapshot.get(scope)?.hint as { paths?: string[]; refreshExpanded?: boolean } | undefined
        applyFileTreeInvalidation(
          hint?.refreshExpanded
            ? { kind: 'refreshExpanded' }
            : { kind: 'paths', relPaths: hint?.paths ?? [] }
        )
        continue
      }
      if (scope.startsWith('file:')) {
        applyFileContentInvalidation(scope.slice('file:'.length))
      }
    }
  } finally {
    flushing = false
    if (pending.size > 0) scheduleFlush()
  }
}

export function resetInvalidationServiceForTest(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  known = new Map()
  pending = new Map()
  messagesReloadHandler = null
  flushing = false
}
