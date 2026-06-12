import { contextBridge, ipcRenderer } from 'electron'
import type { FloatingNotificationWindowApi, FloatingNotificationData } from '../src/shared/api'

const api: FloatingNotificationWindowApi = {
  notificationReady: () => ipcRenderer.invoke('notification:ready'),
  notificationGetData: () => ipcRenderer.invoke('notification:get-data'),
  notificationFocusSession: (payload) => ipcRenderer.invoke('notification:focus-session', payload),
  notificationShowMain: () => ipcRenderer.invoke('notification:show-main'),
  notificationDismiss: () => ipcRenderer.invoke('notification:dismiss'),
  notificationOnUpdate: (cb) => {
    const fn = (_e: unknown, data: FloatingNotificationData) => cb(data)
    ipcRenderer.on('notification:update', fn)
    return () => ipcRenderer.removeListener('notification:update', fn)
  },
  notificationOnClose: (cb) => {
    const fn = () => cb()
    ipcRenderer.on('notification:close', fn)
    return () => ipcRenderer.removeListener('notification:close', fn)
  }
}

contextBridge.exposeInMainWorld('api', api)
