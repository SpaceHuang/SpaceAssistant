import type { ContextPort, ContextScope } from '../../packages/agent-sdk/src/context'
import { createContextPortRouter } from '../../packages/agent-sdk/src/context'
import { createStorageSessionContextAdapter } from './contextAdapter'
import type { SessionContextSurfaceMessage } from '../sessionContextCompaction'

export type BoundSessionContext = Readonly<{ adapter: import('../../packages/agent-sdk/src/context').SessionContextAdapter; messages: SessionContextSurfaceMessage[]; windowId: string }>
type RouterEntry = Readonly<{
  router: ReturnType<typeof createContextPortRouter>
  createAdapter(input: { sessionId: string; isBusy(): boolean }): Promise<BoundSessionContext>
}>
const routers = new WeakMap<ContextPort, RouterEntry>()

export function createSessionStorageContextRouter(createAdapter: RouterEntry['createAdapter']): ContextPort {
  const router = createContextPortRouter()
  routers.set(router.port, Object.freeze({ router, createAdapter }))
  return router.port
}

export function bindSessionStorageContextPort(storagePort: ContextPort, scope: ContextScope, scopedPort: ContextPort): () => void {
  const router = routers.get(storagePort)
  if (!router) throw new Error('SESSION_CONTEXT_ROUTER_NOT_REGISTERED')
  return router.router.bind(scope, scopedPort)
}

export function createBoundSessionContextAdapter(storagePort: ContextPort, input: Parameters<RouterEntry['createAdapter']>[0]): ReturnType<RouterEntry['createAdapter']> {
  const entry = routers.get(storagePort)
  if (!entry) throw new Error('SESSION_CONTEXT_ROUTER_NOT_REGISTERED')
  return entry.createAdapter(input)
}
