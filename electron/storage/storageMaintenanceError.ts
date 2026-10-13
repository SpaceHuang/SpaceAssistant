/** 存储维护域的稳定错误码载体；独立成模块供 streamingCopy 等底层原语引用，避免循环依赖。 */
export class StorageMaintenanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StorageMaintenanceError'
    this.code = code
  }
}
