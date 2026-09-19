import type { FileTreeChangeEvent } from '../src/shared/fileTreeSync'
import { nextFileScopeVersion } from './fileScopeVersion'
import { broadcastScopeInvalidation } from './ipc/invalidationOutlet'

/**
 * 偏差 11/3c:文件树失效经统一事件出口广播 { scope: 'file-tree', version, hint }。
 * 不再携带树内容直连 webContents;渲染端收到更高版本后自行 file:list-directory 重取。
 * hint 仅含失效指示(变更路径列表 / 展开刷新),供渲染端精细化重取,不含真相。
 */
export function notifyFileTreeChanged(
  _sender: unknown,
  event: FileTreeChangeEvent
): void {
  const version = nextFileScopeVersion()
  const hint =
    event.kind === 'refreshExpanded'
      ? { refreshExpanded: true as const }
      : { paths: [...event.relPaths] }
  broadcastScopeInvalidation('file-tree', version, hint)
}
