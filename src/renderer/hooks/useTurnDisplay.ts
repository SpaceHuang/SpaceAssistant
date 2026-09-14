import { useSyncExternalStore } from 'react'
import type { TurnDisplay } from '../../shared/turnDisplayProtocol'
import { turnDisplayStore } from '../services/turnDisplayStore'

export function useTurnDisplay(turnId: string | undefined): TurnDisplay | undefined {
  return useSyncExternalStore(
    (listener) => turnId ? turnDisplayStore.subscribeTurn(turnId, () => listener()) : () => undefined,
    () => (turnId ? turnDisplayStore.get(turnId) : undefined),
    () => undefined
  )
}

export function useTurnDisplays(): TurnDisplay[] {
  return useSyncExternalStore(
    (listener) => turnDisplayStore.subscribe(() => listener()),
    () => turnDisplayStore.all(),
    () => []
  )
}
