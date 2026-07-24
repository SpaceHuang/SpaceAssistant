import { pendingConfirmStore } from './pendingConfirmStore'

/** Eager-init confirm IPC listeners before any chat run can emit confirm-request. */
export function initConfirmStores(): void {
  pendingConfirmStore.init()
}
