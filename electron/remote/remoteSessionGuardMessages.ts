import { ErrorCodes } from '../../src/shared/errorCodes'

export const REMOTE_SESSION_BUSY_MESSAGE =
  '当前会话有任务正在执行，请等待完成后再发送新指令。'

export const REMOTE_PARALLEL_FULL_MESSAGE = '当前并行任务已满，请稍后再试。'

export const REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE =
  '当前会话有任务正在执行，无法切换工作目录。'

export const REMOTE_SESSION_SWITCH_BUSY_CALLER =
  '当前会话有任务正在执行，无法切换会话。'

export const REMOTE_SESSION_SWITCH_BUSY_TARGET =
  '目标会话有任务正在执行，请稍后再试。'

export const REMOTE_SESSION_SWITCH_DENIED_MESSAGE = '无法切换到该会话：会话不存在或无权访问'

export const RemoteSessionGuardErrorCodes = {
  SESSION_BUSY: ErrorCodes.REMOTE_SESSION_BUSY,
  PARALLEL_FULL: ErrorCodes.REMOTE_PARALLEL_FULL,
  WORKDIR_SWITCH_BUSY: ErrorCodes.REMOTE_WORKDIR_SWITCH_BUSY,
  SESSION_SWITCH_BUSY: ErrorCodes.REMOTE_SESSION_SWITCH_BUSY
} as const
