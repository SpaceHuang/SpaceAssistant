import { scrollBehaviorPreference } from './motionPreference'

/** 距底部在此范围内视为「贴底」，流式更新时继续自动滚动 */
export const CHAT_SCROLL_NEAR_BOTTOM_PX = 120

export function isChatScrollNearBottom(
  el: HTMLElement,
  threshold = CHAT_SCROLL_NEAR_BOTTOM_PX
): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  return distance <= threshold
}

export function scrollChatToBottom(
  el: HTMLElement,
  options?: { behavior?: ScrollBehavior; force?: boolean; stickToBottom?: boolean }
): void {
  const { behavior = 'smooth', force = false, stickToBottom = true } = options ?? {}
  if (!force && !stickToBottom) return
  el.scrollTo({
    top: el.scrollHeight,
    behavior: scrollBehaviorPreference(behavior)
  })
}
