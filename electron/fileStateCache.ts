export interface FileState {
  path: string
  content: string
  mtime: number
  readAt: number
  isPartial: boolean
  /** 分段读取：content 非全文快照，edit/write 用 mtime 校验 */
  isRangeView?: boolean
}

/** 会话级：跟踪 read_file 内容，用于 edit/write 前置校验 */
export class FileStateCache {
  private cache = new Map<string, FileState>()
  private readonly MAX_SIZE = 100
  private readonly MAX_CONTENT_SIZE = 25 * 1024 * 1024

  get(absPath: string): FileState | undefined {
    return this.cache.get(absPath)
  }

  hasBeenRead(absPath: string): boolean {
    return this.cache.has(absPath)
  }

  invalidate(absPath: string): void {
    this.cache.delete(absPath)
  }

  set(absPath: string, state: FileState): void {
    if (state.content.length > this.MAX_CONTENT_SIZE) {
      this.cache.set(absPath, { ...state, isPartial: true })
    } else {
      this.cache.set(absPath, state)
    }
    while (this.cache.size > this.MAX_SIZE) {
      const first = this.cache.keys().next().value
      if (first) this.cache.delete(first)
      else break
    }
  }
}
