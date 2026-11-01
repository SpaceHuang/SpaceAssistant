import { lazy, type ComponentType } from 'react'

type FileOverlayModule = { FileOverlay: ComponentType }

export function createLazyFileOverlay(load: () => Promise<FileOverlayModule> = () => import('./FileOverlay')) {
  return lazy(async () => ({ default: (await load()).FileOverlay }))
}
