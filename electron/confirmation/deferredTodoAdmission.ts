import type { AppDatabase } from '../database/sqliteStore'
import { createDeferredTodoCapacityController, type DeferredTodoCapacityLifecycle } from './deferredTodoCapacity'
import { createDeferredTodoStore, type CreateDeferredTodoInput } from './deferredTodoStore'

type CapacityPort = {
  reserve(input: Record<string, unknown>): Promise<{ ok: true; duplicate?: boolean } | { ok: false; reason: string }> | { ok: true; duplicate?: boolean } | { ok: false; reason: string }
  activate?(reservationId: string, invocationId: string, now?: number): boolean
  release(reservationId: string, invocationId: string): boolean | Promise<boolean>
}

export function createDeferredTodoAdmission<TTodo>(input: {
  capacity: CapacityPort
  todoStore: { create(todo: TTodo): unknown | Promise<unknown> }
  dispatch: (...args: never[]) => unknown
  sendReceipt(receipt: { code: string }): void | Promise<void>
  fallback?: () => Promise<unknown>
}) {
  return {
    async defer(request: {
      reservation: Record<string, unknown> & { reservationId: string; invocationId: string }
      todo: TTodo
      ttlMs: number
    }): Promise<unknown> {
      if (!Number.isFinite(request.ttlMs) || request.ttlMs < 0) throw new TypeError('DEFERRED_TODO_TTL_INVALID')
      if (request.ttlMs === 0) return input.fallback ? input.fallback() : { kind: 'undetermined' }
      const reserved = await input.capacity.reserve(request.reservation)
      if (!reserved.ok) {
        await input.sendReceipt({ code: 'deferred-capacity-exhausted' })
        return { kind: 'deny', cause: 'no-answerer' }
      }
      try {
        const created = await input.todoStore.create(request.todo)
        const now = typeof request.reservation.now === 'number' ? request.reservation.now : Date.now()
        if (!reserved.duplicate && input.capacity.activate && !input.capacity.activate(request.reservation.reservationId, request.reservation.invocationId, now)) {
          throw new Error('DEFERRED_TODO_RESERVATION_ACTIVATION_FAILED')
        }
        return { kind: 'deferred', created }
      } catch (error) {
        await input.capacity.release(request.reservation.reservationId, request.reservation.invocationId)
        throw error
      }
    }
  }
}

export function createPersistentDeferredTodoAdmission(db: AppDatabase, input: {
  limits?: { sessionLimit?: number; identityLimit?: number }
  dispatch: (...args: never[]) => unknown
  sendReceipt(receipt: { code: string }): void | Promise<void>
  fallback?: () => Promise<unknown>
}) {
  const capacity = createDeferredTodoCapacityController(db, input.limits)
  const todoStore = createDeferredTodoStore(db, { capacity: capacity as DeferredTodoCapacityLifecycle })
  const admission = createDeferredTodoAdmission({
    capacity,
    todoStore: { create: (todo: CreateDeferredTodoInput) => todoStore.create(todo) },
    dispatch: input.dispatch,
    sendReceipt: input.sendReceipt,
    ...(input.fallback ? { fallback: input.fallback } : {})
  })
  return { ...admission, capacity, todoStore }
}
