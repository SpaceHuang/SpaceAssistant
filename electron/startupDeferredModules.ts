type StagehandModule = { stagehandService: { closeAll: () => unknown | Promise<unknown> } }

export function createDeferredStagehandClose(
  load: () => Promise<StagehandModule> = () => import('./browser/stagehandService')
): () => Promise<void> {
  return async () => { await (await load()).stagehandService.closeAll() }
}
