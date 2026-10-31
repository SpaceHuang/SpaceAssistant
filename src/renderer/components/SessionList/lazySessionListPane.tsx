import { lazy } from 'react'
import type { ComponentType } from 'react'

type SessionListPaneModule = { SessionListPane: ComponentType }

export function createLazySessionListPane(
  load: () => Promise<SessionListPaneModule> = () => import('./SessionListPane')
) {
  return lazy(async () => ({ default: (await load()).SessionListPane }))
}
