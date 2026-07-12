import { ErrorCodes } from '../../src/shared/errorCodes'

export const REMOTE_SESSION_BUSY_MESSAGE =
  '当前会话有任务正在执行，请等待完成后再发送新指令。'

export const REMOTE_PARALLEL_FULL_MESSAGE = '当前并行任务已满，请稍后再试。'

export const REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE =
  '当前会话有任务正在执行，无法切换工作目录。'

export const RemoteSessionGuardErrorCodes = {
  SESSION_BUSY: ErrorCodes.REMOTE_SESSION_BUSY,
  PARALLEL_FULL: ErrorCodes.REMOTE_PARALLEL_FULL,
  WORKDIR_SWITCH_BUSY: ErrorCodes.REMOTE_WORKDIR_SWITCH_BUSY
} as const
