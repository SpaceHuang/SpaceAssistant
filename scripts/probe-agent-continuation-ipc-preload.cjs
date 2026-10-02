const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentContinuationProbe', {
  continueFromCheckpoint: (payload) => ipcRenderer.invoke('chat:continue-from-checkpoint', payload)
})
