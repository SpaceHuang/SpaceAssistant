import type { ContextPort, ContextScope } from '../../packages/agent-sdk/src/context'
import { createContextPortRouter } from '../../packages/agent-sdk/src/context'
import type { BoundSessionContext, SessionContextStoragePort } from './host/ports'

type RouterEntry = Readonly<{
  router: ReturnType<typeof createContextPortRouter>
  createAdapter(input: { sessionId: string; isBusy(): boolean }): Promise<BoundSessionContext>
}>
const routers = new WeakMap<ContextPort, RouterEntry>()

export function createSessionStorageContextRouter(createAdapter: RouterEntry['createAdapter']): SessionContextStoragePort {
  const router = createContextPortRouter()
  const port = Object.freeze({
    readCurrent: router.port.readCurrent,
    commitReplacement: router.port.commitReplacement,
    bind: (scope: ContextScope, scopedPort: ContextPort) => router.bind(scope, scopedPort),
    createBoundAdapter: (input: { sessionId: string; isBusy(): boolean }) => createAdapter(input)
  }) as SessionContextStoragePort
  routers.set(port, Object.freeze({ router, createAdapter }))
  return port
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
