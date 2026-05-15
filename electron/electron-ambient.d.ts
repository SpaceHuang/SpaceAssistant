export {}

/** 供 `Electron.MenuItemConstructorOptions` 等全局写法使用（与 `electron` 包类型对齐）。 */
declare global {
  namespace Electron {
    interface MenuItemConstructorOptions {
      label?: string
      role?: string
      type?: string
      accelerator?: string
      click?: () => void
      submenu?: Electron.MenuItemConstructorOptions[]
      [key: string]: unknown
    }
  }
}

/**
 * 当 `node_modules/electron` 未完整下载时提供占位类型。
 * 安装好 electron 后（`npm run reinstall:electron`）可删除本文件及上方 `declare global`。
 */
declare module 'electron' {
  export interface WebContents {
    send(channel: string, ...args: unknown[]): void
    isDestroyed(): boolean
    toggleDevTools(): void
    [key: string]: unknown
  }

  export interface IpcMainInvokeEvent {
    sender: WebContents
    readonly frameId: number
    readonly processId: number
    [key: string]: unknown
  }

  export interface IpcMain {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
    on(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => void): this
    [key: string]: unknown
  }

  export class BrowserWindow {
    readonly webContents: WebContents
    constructor(options?: Record<string, unknown>)
    isDestroyed(): boolean
    on(event: string, listener: (...args: unknown[]) => void): this
    loadFile(filePath: string): Promise<void>
    loadURL(url: string): Promise<void>
    static getAllWindows(): BrowserWindow[]
    [key: string]: unknown
  }

  export interface MessageBoxOptions {
    type?: string
    title?: string
    message?: string
    [key: string]: unknown
  }

  export const dialog: {
    showMessageBox(browserWindow: BrowserWindow, options: MessageBoxOptions): Promise<unknown>
    [key: string]: unknown
  }

  export const app: {
    readonly name: string
    readonly isPackaged: boolean
    whenReady(): Promise<void>
    on(event: string, listener: (...args: unknown[]) => void): this
    quit(): void
    getPath(name: string): string
    [key: string]: unknown
  }

  export const Menu: {
    setApplicationMenu(menu: unknown): void
    buildFromTemplate(template: Electron.MenuItemConstructorOptions[]): unknown
    [key: string]: unknown
  }

  export const shell: {
    openExternal(url: string): Promise<void>
    [key: string]: unknown
  }

  export const safeStorage: {
    isEncryptionAvailable(): boolean
    encryptString(value: string): Uint8Array
    decryptString(buffer: Uint8Array): string
    [key: string]: unknown
  }

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void
    [key: string]: unknown
  }

  export interface IpcRenderer {
    invoke(channel: string, ...args: unknown[]): Promise<any>
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): this
    removeListener(channel: string, listener: (...args: any[]) => void): this
    [key: string]: unknown
  }

  export const ipcRenderer: IpcRenderer

  export const ipcMain: IpcMain
}
