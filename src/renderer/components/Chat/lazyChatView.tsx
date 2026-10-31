import { lazy, type ComponentType } from 'react'

type ChatViewModule = { ChatView: ComponentType }

export function createLazyChatView(load: () => Promise<ChatViewModule> = () => import('./ChatView')) {
  return lazy(async () => ({ default: (await load()).ChatView }))
}
