import { lazy } from 'react'
import type { ComponentType } from 'react'

type DetailPanelModule = { DetailPanel: ComponentType }

export function createLazyDetailPanel(
  load: () => Promise<DetailPanelModule> = () => import('./index')
) {
  return lazy(async () => ({ default: (await load()).DetailPanel }))
}
