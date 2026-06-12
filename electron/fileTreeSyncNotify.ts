import type { WebContents } from 'electron'
import type { FileTreeChangeEvent } from '../src/shared/fileTreeSync'
import { safeWebContentsSend } from './safeWebContentsSend'

export function notifyFileTreeChanged(
  sender: WebContents | null | undefined,
  event: FileTreeChangeEvent
): void {
  safeWebContentsSend(sender, 'file:tree-changed', event)
}
