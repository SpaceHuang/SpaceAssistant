import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import path from 'path'
import { processTreeKiller, spawnCommandSafe } from '../spawnUtil'
import { describeExitCode, describeExitCodeDetails, describeHresult } from '../shell/shellExitCodes'
import { logShellAgentEvent } from '../shell/shellAgentLogger'
import { planShellExec, type ShellSpawnSpec } from '../shell/shellExecPlan'
import type { ShellConfig } from '../../src/shared/domainTypes'
import type { ToolExecutionContext, ToolExecutor, ToolExecutorResult } from './types'
import { buildShellEnv } from '../processOutputEncoding'
import { defaultContractForPlatform, expectedLabelForContract } from '../processOutput/contracts'
import { createChildStreamDecoder, decodeChildOutput } from '../processOutput/decodeChildOutput'
import { buildStreamDiagnostics, formatOutputDiagLine, resolveLossStage, resolveOutputTrust } from '../processOutput/diagnostics'
import { sanitizeToolOutput, toToolUserError } from './toolUserErrors'
import { SHELL_OUTPUT_TRUST_SUSPECT_NOTICE } from '../../src/shared/shellToolDisplay'
import { normalizeTerminalOutput } from '../../src/shared/terminalOutputSanitize'
import { PROGRESS_RAW_MAX_BYTES } from '../../src/shared/terminalScrollback'
import { shellTuiFallbackHintLines } from '../../src/shared/shellInteractiveTui'
import { RawByteBuffer, type RawByteSnapshot } from '../shell/boundedOutput'
import { OutputArtifactWriter } from '../shell/outputArtifactWriter'
import { createOutputPipelineSnapshot } from '../shell/outputPipeline'
import { ProgressThrottle } from '../shell/progressThrottle'
import { ExecutionLifecycle } from '../shell/executionLifecycle'
import { ProcessSupervisor } from '../shell/processSupervisor'
import { DialectRetryBreaker } from '../shell/dialectRetryBreaker'
import { buildShellArgs, profileForPlatform } from '../shell/shellProfiles'
import { cleanupExpiredOutputArtifacts } from '../shell/outputArtifactCleanup'
import { SHELL_CASE_IDS } from '../shell/shellCaseIds'
import { type PreparedShellExecution } from '../shell/preparedShellExecution'
import { planRunShellExecution, revalidatePreparedShellExecution, RunShellPlanError } from './runShellPlan'

const PROGRESS_TAIL = 4000
/** 进度用滚动文本窗口：只需覆盖 PROGRESS_TAIL，避免为进度保留全量文本。 */
const PROGRESS_TEXT_KEEP = 8 * 1024
const DEFAULT_IO_MAX = 100 * 1024
const dialectRetryBreaker = new DialectRetryBreaker()

export function appendRawTailBuffer(prev: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([prev, chunk])
  if (combined.length <= PROGRESS_RAW_MAX_BYTES) return Buffer.from(combined)
  return Buffer.from(combined.subarray(combined.length - PROGRESS_RAW_MAX_BYTES))
}

function shellProgressMessage(stdout: string, stderr: string): string {
  return normalizeTerminalOutput((stdout + stderr).slice(-PROGRESS_TAIL))
}

function stableFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** §9.5：对实际保留（head+tail，即落盘范围）的原始字节取 sha256，与文本 sha256 并存。 */
function rawBytesSha256(snapshot: RawByteSnapshot): string {
  const hash = createHash('sha256')
  hash.update(snapshot.head)
  hash.update(snapshot.tail)
  return hash.digest('hex')
}

export type { ShellSpawnSpec } from '../shell/shellExecPlan'

export function resolveShellSpawnSpec(shellConfig?: ShellConfig | null): ShellSpawnSpec {
  const exe = shellConfig?.executable?.trim()
  if (exe) {
    const prefix = shellConfig?.argsPrefix?.length ? shellConfig.argsPrefix : ['-lc']
    return { executable: exe, args: [...prefix, ''], shellId: path.basename(exe) }
  }
  if (process.platform === 'win32') {
    const profile = profileForPlatform(process.platform)
    return { executable: profile.executable, args: buildShellArgs(profile, ''), shellId: profile.id }
  }
  return {
    executable: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', ''],
    shellId: 'bash'
  }
}

export const runShellExecutor: ToolExecutor = {
  name: 'run_shell',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const command = typeof input.command === 'string' ? input.command : ''
    let prepared: PreparedShellExecution
    try {
      prepared = await planRunShellExecution(input, ctx)
    } catch (error) {
      const planError = error instanceof RunShellPlanError ? error : undefined
      const message = error instanceof Error ? error.message : String(error)
      const code = planError?.code ?? 'SHELL_PLAN_INVALID'
      const retry = code === 'SHELL_DIALECT_MISMATCH'
        ? dialectRetryBreaker.record(String(planError?.details.shellProfileId ?? profileForPlatform(process.platform).id), Array.isArray(planError?.details.signals) ? planError.details.signals as string[] : [])
        : undefined
      logShellAgentEvent('error', 'shell.exec.plan_failed', {
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        toolUseId: ctx.toolUseId,
        commandFingerprint: stableFingerprint(command),
        shell: planError?.details.shellProfileId ?? profileForPlatform(process.platform).id,
        error: sanitizeToolOutput(message, 'run_shell').text,
        caseId: SHELL_CASE_IDS.planInvalid
      })
      return {
        success: false,
        error: code,
        data: { code, reason: message, processResult: null, ...planError?.details, ...(retry ? { retryCount: retry.count, retryExhausted: retry.tripped } : {}), caseId: code === 'SHELL_EXECUTABLE_UNAVAILABLE' ? SHELL_CASE_IDS.executableUnavailable : code === 'SHELL_INTERACTIVE_TTY_REQUIRED' ? SHELL_CASE_IDS.tuiRequiresTerminal : code === 'SHELL_DIALECT_MISMATCH' ? SHELL_CASE_IDS.dialectMismatch : SHELL_CASE_IDS.planInvalid, ...(code === 'SHELL_INTERACTIVE_TTY_REQUIRED' ? { hints: shellTuiFallbackHintLines() } : {}) },
        duration: Date.now() - started
      }
    }
    const artifactDirectory = path.join(ctx.userDataDir, 'shell-output')
    void cleanupExpiredOutputArtifacts(artifactDirectory, 7 * 24 * 60 * 60 * 1000)
    const timeoutSec = prepared.timeoutMs / 1000
    const ioMax = prepared.ioMaxBytes

    const baseLog = {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      commandFingerprint: stableFingerprint(command),
      cwdFingerprint: stableFingerprint(prepared.cwd),
      shell: prepared.spawnSpec.shellId,
      timeoutSec,
      ioMaxBytes: ioMax,
      environmentFingerprint: prepared.dependencySnapshot.environmentFingerprint,
      planDigest: prepared.planDigest
    }

    logShellAgentEvent('info', 'shell.exec.start', baseLog)

    return executePreparedShellExecution(prepared, ctx, started, baseLog)
  }
}

/**
 * 执行已经完成计划和快照冻结的 shell invocation。
 * 调用方不得用原始 input/shellConfig 重建 spawn 参数；prepared 是唯一事实来源。
 */
export async function executePreparedShellExecution(
  prepared: PreparedShellExecution,
  ctx: ToolExecutionContext,
  started: number,
  baseLog: Record<string, unknown>
): Promise<ToolExecutorResult> {
  try {
    await revalidatePreparedShellExecution(prepared, {
      shellConfig: ctx.shellConfig,
      policyRevision: ctx.policyRevision
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: 'PLAN_STALE',
      data: { code: 'PLAN_STALE', reason: message },
      duration: Date.now() - started
    }
  }
  const command = prepared.command
  const timeoutSec = prepared.timeoutMs / 1000
  const ioMax = prepared.ioMaxBytes
  const contract = prepared.profile.outputEncoding
  const spec: ShellSpawnSpec = {
    executable: prepared.spawnSpec.executable,
    args: [...prepared.spawnSpec.args],
    shellId: prepared.spawnSpec.shellId
  }
  const env = prepared.environment
  const sendProgressSafely = (payload: string | { rawDelta: string; seq: number; rawEncoding: string } | { message: string; processPid: number; processGroupId?: number; processOwnerToken?: string }): void => {
    try {
      ctx.sendProgress('shell', payload)
    } catch (error) {
      // IPC/renderer progress failure must not escape an EventEmitter callback or prevent settle.
      void ctx.recordDiagnostic?.({ code: 'SHELL_PROGRESS_SEND_FAILED', message: error instanceof Error ? error.message : String(error) })
    }
  }
  sendProgressSafely('启动命令…')
  const stdoutDecoder = createChildStreamDecoder({ contract })
  const stderrDecoder = createChildStreamDecoder({ contract })
  let progressStdoutTail = ''
  let progressStderrTail = ''
  let interrupted = false
  let proc: ChildProcess
  let timedOut = false
  let outputLimited = false
  let terminalHandled = false
  let terminateForOutputLimit = (): void => undefined
  let terminationResult: Awaited<ReturnType<ProcessSupervisor['terminate']>> | undefined
  const terminalMode = ctx.shellOutputMode === 'terminal'
  let progressSeq = 0
  let progressEventCount = 0
  let rawTailBuf: Buffer = Buffer.alloc(0)
  let pendingRawDelta: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let spawnAtMs = 0
  const progressThrottle = new ProgressThrottle({ minIntervalMs: 50, maxEventsPerSecond: 20, minBytes: 16 * 1024 })
  // 事实层：原始字节 head/tail（§9.2），文本只是它的投影。
  const stdoutRaw = new RawByteBuffer(ioMax)
  const stderrRaw = new RawByteBuffer(ioMax)
  const artifactMaxBytes = Math.max(ioMax * 20, 2 * 1024 * 1024)
  const artifactRoot = path.resolve(ctx.userDataDir, 'shell-output')
  const artifactName = `${createHash('sha256').update(ctx.toolUseId).digest('hex')}.log`
  const artifactPath = path.resolve(artifactRoot, artifactName)
  if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`)) {
    return {
      success: false,
      error: 'SHELL_ARTIFACT_PATH_INVALID',
      data: { code: 'SHELL_ARTIFACT_PATH_INVALID' },
      duration: Date.now() - started
    }
  }
  const artifactWriter = new OutputArtifactWriter(artifactPath, artifactMaxBytes)
  let artifactStarted = false
  let artifactOpenError: Error | undefined
  let artifactPrefix: Buffer[] = []
  let artifactPrefixBytes = 0
  const activateArtifact = (): void => {
    if (artifactStarted) return
    artifactStarted = true
    void artifactWriter.open().catch((error) => {
      artifactOpenError = error instanceof Error ? error : new Error(String(error))
    })
    for (const prefix of artifactPrefix) artifactWriter.appendBytes(prefix)
    artifactPrefix = []
  }
  /** 原始字节直存（§9.2）：解码之前先留存事实。 */
  const recordArtifactBytes = (bytes: Buffer): void => {
    if (bytes.length === 0) return
    if (artifactStarted) {
      artifactWriter.appendBytes(bytes)
      return
    }
    artifactPrefix.push(Buffer.from(bytes))
    artifactPrefixBytes += bytes.length
    if (artifactPrefixBytes > ioMax) activateArtifact()
  }

  /**
   * §12-#11：终端回放必须用与主通道一致的编码标签。
   * 解码器锁定前用契约期望标签（不会拿到 'unknown'），锁定后用检测结果。
   */
  const terminalRawEncoding = (): string => {
    const stdoutMeta = stdoutDecoder.meta
    if (stdoutMeta.provisional !== true) return stdoutMeta.encoding
    const stderrMeta = stderrDecoder.meta
    if (stderrMeta.provisional !== true) return stderrMeta.encoding
    return expectedLabelForContract(contract) ?? 'utf-8'
  }
  const pushProgress = (stdoutSnap: string, stderrSnap: string, rawChunk?: Buffer) => {
    if (terminalMode && rawChunk && rawChunk.length > 0) {
      rawTailBuf = appendRawTailBuffer(rawTailBuf, rawChunk)
      pendingRawDelta = appendRawTailBuffer(pendingRawDelta, rawChunk)
      if (!progressThrottle.shouldSend(Date.now(), rawChunk.length)) return
      progressSeq += 1
      progressEventCount += 1
      const rawDelta = pendingRawDelta
      pendingRawDelta = Buffer.alloc(0)
      sendProgressSafely({ rawDelta: rawDelta.toString('base64'), seq: progressSeq, rawEncoding: terminalRawEncoding() })
      return
    }
    if (!progressThrottle.shouldSend(Date.now(), Buffer.byteLength(stdoutSnap + stderrSnap))) return
    progressEventCount += 1
    sendProgressSafely(shellProgressMessage(stdoutSnap, stderrSnap))
  }
  const flushPendingRawDelta = (): void => {
    if (!terminalMode || pendingRawDelta.length === 0) return
    progressSeq += 1
    progressEventCount += 1
    const rawDelta = pendingRawDelta
    pendingRawDelta = Buffer.alloc(0)
    sendProgressSafely({ rawDelta: rawDelta.toString('base64'), seq: progressSeq, rawEncoding: terminalRawEncoding() })
  }

  const enforceOutputLimit = () => {
    // MINOR：上限判定只需计数，不能每个 chunk 构造两次 O(ioMax) 字节拷贝。
    const total = stdoutRaw.totalBytes + stderrRaw.totalBytes
    const limit = Math.max(ioMax * 20, 2 * 1024 * 1024)
    if (total < limit || outputLimited) return
    outputLimited = true
    interrupted = true
    terminateForOutputLimit()
  }

  return await new Promise((resolve) => {
    const lifecycle = new ExecutionLifecycle<ToolExecutorResult>()
    const settle = (reason: Parameters<ExecutionLifecycle<ToolExecutorResult>['finalize']>[0], result: ToolExecutorResult): void => {
      if (lifecycle.finalize(reason, result)) resolve(result)
    }
    spawnAtMs = Date.now()
    proc = spawn(spec.executable, spec.args, {
      cwd: prepared.cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform === 'darwin'
    })
    if (proc.pid) sendProgressSafely({ message: '进程已启动', processPid: proc.pid, processGroupId: process.platform === 'darwin' ? proc.pid : undefined, processOwnerToken: `${ctx.requestId}:${ctx.toolUseId}` })
    const supervisor = new ProcessSupervisor(proc, processTreeKiller)
    terminateForOutputLimit = () => {
      void supervisor.terminate().then((result) => { terminationResult = result })
    }

    logShellAgentEvent('info', 'shell.exec.spawned', {
      ...baseLog,
      pid: proc.pid ?? null,
      shell: spec.shellId
    })

    const onDataOut = (b: Buffer) => {
      const chunk = stdoutDecoder.write(b)
      stdoutRaw.appendBytes(b)
      enforceOutputLimit()
      recordArtifactBytes(b)
      if (chunk) progressStdoutTail = (progressStdoutTail + chunk).slice(-PROGRESS_TEXT_KEEP)
      pushProgress(progressStdoutTail, progressStderrTail, terminalMode ? b : undefined)
    }
    const onDataErr = (b: Buffer) => {
      const chunk = stderrDecoder.write(b)
      stderrRaw.appendBytes(b)
      enforceOutputLimit()
      recordArtifactBytes(b)
      if (chunk) progressStderrTail = (progressStderrTail + chunk).slice(-PROGRESS_TEXT_KEEP)
      pushProgress(progressStdoutTail, progressStderrTail, terminalMode ? b : undefined)
    }

    proc.stdout?.on('data', onDataOut)
    proc.stderr?.on('data', onDataErr)

    const killTimer = setTimeout(() => {
      interrupted = true
      timedOut = true
      void supervisor.terminate().then((result) => { terminationResult = result })
    }, timeoutSec * 1000)

    const onAbort = () => {
      interrupted = true
      void supervisor.terminate().then((result) => { terminationResult = result })
    }
    ctx.signal.addEventListener('abort', onAbort)

    let processResourcesCleaned = false
    const cleanupProcessResources = (): void => {
      if (processResourcesCleaned) return
      processResourcesCleaned = true
      clearTimeout(killTimer)
      ctx.signal.removeEventListener('abort', onAbort)
      proc.stdout?.removeListener('data', onDataOut)
      proc.stderr?.removeListener('data', onDataErr)
    }

    proc.on('error', (err) => {
      if (terminalHandled) return
      terminalHandled = true
      cleanupProcessResources()
      flushPendingRawDelta()
      logShellAgentEvent('error', 'shell.exec.error', {
        ...baseLog,
        pid: proc.pid ?? null,
        spawnError: sanitizeToolOutput(err.message, 'run_shell').text,
        caseId: SHELL_CASE_IDS.spawnError,
        durationMs: Date.now() - started
      })
      const spawnErrorMessage = err.message
      void (async () => {
        if (artifactPrefixBytes > 0) activateArtifact()
        await artifactWriter.close().catch(() => undefined)
        settle('transport_error', {
          success: false,
          error: 'SHELL_SPAWN_ERROR',
          userMessage: toToolUserError(err, { toolName: 'run_shell' }),
          data: {
            code: 'SHELL_SPAWN_ERROR',
            status: 'spawn_failed',
            processResult: null,
            caseId: SHELL_CASE_IDS.spawnError,
            convergenceCaseId: SHELL_CASE_IDS.promiseConvergence
          },
          duration: Date.now() - started
        })
      })()
    })

    proc.on('close', (code, signal) => {
      if (terminalHandled) return
      terminalHandled = true
      cleanupProcessResources()
      const exitAtMs = Date.now()
      const tailOut = stdoutDecoder.end()
      const tailErr = stderrDecoder.end()
      if (tailOut) progressStdoutTail = (progressStdoutTail + tailOut).slice(-PROGRESS_TEXT_KEEP)
      if (tailErr) progressStderrTail = (progressStderrTail + tailErr).slice(-PROGRESS_TEXT_KEEP)
      flushPendingRawDelta()

      const stdoutMeta = stdoutDecoder.meta
      const stderrMeta = stderrDecoder.meta
      const rawOut = stdoutRaw.snapshotBytes()
      const rawErr = stderrRaw.snapshotBytes()
      const truncated = rawOut.truncated || rawErr.truncated
      const exitCode = code ?? (signal ? null : interrupted ? null : 1)
      const externalSignal = signal ?? undefined
      const cancelled = ctx.signal.aborted || (interrupted && !timedOut)
      const success = !cancelled && code === 0
      const failed = !success
      const contractConflict = stderrMeta.contractConflict ?? stdoutMeta.contractConflict

      void (async () => {
        if (interrupted && !terminationResult) {
          terminationResult = await supervisor.terminate()
        }
        let persistedOutputPath: string | undefined
        let artifact: { path: string; bytes: number; sha256: string } | undefined
        let artifactCloseError: Error | undefined

        const outputPipeline = createOutputPipelineSnapshot({
          stdout: rawOut,
          stderr: rawErr,
          stdoutLabel: stdoutMeta.encoding,
          stderrLabel: stderrMeta.encoding,
          terminalRaw: rawTailBuf,
          inlineMaxBytes: ioMax,
          artifactMaxBytes
        })
        const outText = outputPipeline.stdoutText
        const errText = outputPipeline.stderrText
        // §8.4：截断切片的字符对齐无法自证（多字节非自同步编码）等价于弱证据：
        // 拿不到可靠文本就不能当真值交付。
        const stdoutDiag = buildStreamDiagnostics(stdoutMeta, outText, stdoutDecoder.weakEvidence || outputPipeline.stdoutAlignmentUncertain)
        const stderrDiag = buildStreamDiagnostics(stderrMeta, errText, stderrDecoder.weakEvidence || outputPipeline.stderrAlignmentUncertain)
        const outputTrust = resolveOutputTrust(stdoutDiag, stderrDiag)
        const lossStage = resolveLossStage({ contract, meta: stderrMeta, text: errText })
          ?? resolveLossStage({ contract, meta: stdoutMeta, text: outText })
        const hresult = describeHresult(errText) ?? describeHresult(outText)

        // §9.4 自动产出条件：失败 / 解码可疑 / 截断 / （既有）超过 ioMaxBytes
        const artifactReason = failed
          ? 'failed'
          : outputTrust === 'suspect' || contractConflict !== undefined
            ? 'suspect'
            : truncated
              ? 'truncated'
              : artifactStarted
                ? 'size'
                : undefined
        if (!artifactStarted && artifactReason && !artifactOpenError) activateArtifact()
        try {
          if (artifactStarted && !artifactOpenError) artifact = await artifactWriter.close()
        } catch (error) {
          artifactCloseError = error instanceof Error ? error : new Error(String(error))
        }
        if (artifact) persistedOutputPath = artifact.path

        const exitDetails = describeExitCodeDetails(typeof exitCode === 'number' ? exitCode : undefined)
        const exitCodeHint = describeExitCode(typeof exitCode === 'number' ? exitCode : undefined)
        const totalMs = Date.now() - started
        const planMs = spawnAtMs - started
        const spawnToExitMs = exitMs(spawnAtMs, exitAtMs)
        const logLevel = success ? 'info' : timedOut || (typeof exitCode === 'number' && exitCode !== 0) ? 'warn' : 'info'
        const outputDiag = [
          formatOutputDiagLine({ stream: 'stdout', diagnostics: stdoutDiag, contract, contractConflict: stdoutMeta.contractConflict, rawArtifactPath: artifact?.path }),
          formatOutputDiagLine({ stream: 'stderr', diagnostics: stderrDiag, contract, contractConflict: stderrMeta.contractConflict, rawArtifactPath: artifact?.path })
        ]
        const stdoutBytes = Buffer.byteLength(outText, 'utf8')
        const stderrBytes = Buffer.byteLength(errText, 'utf8')

        logShellAgentEvent(logLevel, 'shell.exec.finish', {
          ...baseLog,
          pid: proc.pid ?? null,
          exitCode,
          signal: externalSignal,
          exitCodeHint,
          exitCodeFamily: exitDetails?.family,
          exitCodeSemantics: exitDetails?.semantics,
          interrupted,
          timedOut,
          cancelled,
          truncated,
          persistedOutput: Boolean(persistedOutputPath),
          outputArtifactBytes: artifact?.bytes ?? 0,
          outputArtifactSha256: artifact?.sha256,
          outputArtifactReason: artifactReason,
          rawArtifactReason: artifactReason,
          rawArtifactPath: artifact?.path,
          rawArtifactBytes: artifact?.bytes ?? 0,
          rawArtifactSha256: artifact?.sha256,
          outputPersistError: (artifactOpenError?.message ?? artifactCloseError?.message)
            ? sanitizeToolOutput(artifactOpenError?.message ?? artifactCloseError?.message ?? '', 'run_shell').text
            : undefined,
          stdoutBytes,
          stderrBytes,
          stdoutRawBytes: rawOut.totalBytes,
          stderrRawBytes: rawErr.totalBytes,
          stdoutTextBytes: stdoutBytes,
          stderrTextBytes: stderrBytes,
          stdoutSha256: stableFingerprint(outText),
          stderrSha256: stableFingerprint(errText),
          stdoutRawSha256: rawBytesSha256(rawOut),
          stderrRawSha256: rawBytesSha256(rawErr),
          decodeReplacements: stdoutDiag.replacements + stderrDiag.replacements,
          stdoutEncoding: stdoutMeta.encoding,
          stderrEncoding: stderrMeta.encoding,
          encodingSource: stderrMeta.source,
          encodingConfidence: stderrMeta.confidence,
          contractKind: contract.kind,
          contractConflict,
          lossStage,
          planMs,
          spawnToExitMs,
          outputTrust,
          outputDiag,
          stdoutRedacted: sanitizeToolOutput(normalizeTerminalOutput(outText), 'run_shell').redacted,
          stderrRedacted: sanitizeToolOutput(normalizeTerminalOutput(errText), 'run_shell').redacted,
          durationMs: totalMs,
          success
        })

        const stdoutSafe = sanitizeToolOutput(normalizeTerminalOutput(outText), 'run_shell')
        const stderrSafe = sanitizeToolOutput(normalizeTerminalOutput(errText), 'run_shell')
        const data = {
          stdout: stdoutSafe.text,
          stderr: stderrSafe.text,
          stdoutBytes,
          stderrBytes,
          stdoutRawBytes: rawOut.totalBytes,
          stderrRawBytes: rawErr.totalBytes,
          stdoutTextBytes: stdoutBytes,
          stderrTextBytes: stderrBytes,
          decodeReplacements: stdoutDiag.replacements + stderrDiag.replacements,
          // §10.4：hints 走 processResultProjection 的 hints 白名单，模型/远程 IM 都能读到同一句提示。
          hints: outputTrust === 'suspect' ? [SHELL_OUTPUT_TRUST_SUSPECT_NOTICE] : undefined,
          decode: {
            stdout: stdoutDiag,
            stderr: stderrDiag,
            contractConflict,
            lossStage
          },
          outputTrust,
          outputDiag,
          contract: contract.kind === 'oem' ? { kind: 'oem', codepage: contract.codepage } : { kind: contract.kind },
          stdoutRedaction: stdoutSafe.redacted ? { redacted: true, redactionReason: stdoutSafe.redactionReason, originalBytes: stdoutSafe.originalBytes, visibleBytes: stdoutSafe.visibleBytes } : undefined,
          stderrRedaction: stderrSafe.redacted ? { redacted: true, redactionReason: stderrSafe.redactionReason, originalBytes: stderrSafe.originalBytes, visibleBytes: stderrSafe.visibleBytes } : undefined,
          exitCode,
          exitCodeHint,
          exitCodeFamily: exitDetails?.family,
          exitCodeSemantics: exitDetails?.semantics,
          exitCodeAdvice: exitDetails?.advice,
          hresult,
          interrupted: interrupted || ctx.signal.aborted,
          truncated,
          persistedOutputPath,
          outputArtifactBytes: artifact?.bytes ?? 0,
          outputArtifactSha256: artifact?.sha256,
          outputArtifactReason: artifactReason,
          stdoutRawSha256: rawBytesSha256(rawOut),
          stderrRawSha256: rawBytesSha256(rawErr),
          // §9.4：artifact 内容为原始字节；path 在投影层降级为 artifactId（与 persistedOutputPath 同规则）
          rawArtifact: artifact
            ? {
                path: artifact.path,
                bytes: artifact.bytes,
                rawBytes: rawOut.totalBytes + rawErr.totalBytes,
                omittedBytes: rawOut.omittedBytes + rawErr.omittedBytes,
                truncated,
                sha256: artifact.sha256,
                suspect: outputTrust === 'suspect',
                note: 'unredacted' as const
              }
            : undefined,
          outputPersistError: artifactOpenError?.message ?? artifactCloseError?.message,
          outputPersistErrorCode: artifactOpenError || artifactCloseError ? 'OUTPUT_PERSIST_FAILED' : undefined,
          caseId: outputLimited
            ? SHELL_CASE_IDS.unboundedOutput
            : artifactOpenError || artifactCloseError
              ? SHELL_CASE_IDS.outputPersistFailed
              : undefined,
          progressCaseId: progressEventCount > 0 ? SHELL_CASE_IDS.progressFlood : undefined,
          terminationSignal: terminationResult?.signal,
          treeKillVerified: terminationResult?.treeKillVerified,
          terminationErrorCode: terminationResult && !terminationResult.treeKillVerified ? 'TERMINATION_UNCONFIRMED' : undefined,
          terminationCaseId: terminationResult && !terminationResult.treeKillVerified ? SHELL_CASE_IDS.terminationUnconfirmed : undefined,
          outputLimitReached: outputLimited,
          captureCaseId: (rawOut.totalBytes > 0 && stdoutSafe.text.length === 0) || (rawErr.totalBytes > 0 && stderrSafe.text.length === 0)
            ? 'SHELL_OUTPUT_CAPTURE_LOST'
            : undefined,
          status: ctx.signal.aborted ? 'cancelled' : timedOut ? 'timed_out' : outputLimited ? 'output_limited' : externalSignal ? 'signalled' : code === 0 ? 'succeeded' : 'failed',
          terminationReason: ctx.signal.aborted ? 'user_cancel' : timedOut ? 'timeout' : outputLimited ? 'output_limit' : externalSignal ? 'external_signal' : 'process_exit',
          signal: externalSignal ?? terminationResult?.signal,
          durationMs: totalMs,
          planMs,
          spawnToExitMs,
          shell: spec.shellId,
          planDigest: prepared.planDigest,
          environmentFingerprint: prepared.environmentFingerprint
        }

        if (ctx.signal.aborted) {
          settle('user_cancel', {
            success: false,
            error: 'SHELL_CANCELLED',
            userMessage: '用户取消执行',
            data,
            duration: Date.now() - started
          })
          return
        }
        if (timedOut) {
          settle('timeout', {
            success: false,
            error: 'SHELL_TIMEOUT',
            userMessage: `命令执行超时（${timeoutSec} 秒）`,
            data,
            duration: Date.now() - started
          })
          return
        }
        if (outputLimited) {
          settle('output_limit', {
            success: false,
            error: 'OUTPUT_LIMIT_REACHED',
            data,
            duration: Date.now() - started
          })
          return
        }
        if (code !== 0 || externalSignal) {
          const reason = exitCodeHint ? `命令执行失败（${exitCodeHint}）` : `命令执行失败（退出码: ${code ?? 'signal'}）`
          settle('process_exit', {
            success: false,
            error: 'SHELL_PROCESS_EXIT',
            userMessage: toToolUserError(new Error(reason), { toolName: 'run_shell' }),
            data,
            duration: Date.now() - started
          })
          return
        }
        settle('process_exit', { success: true, data, duration: Date.now() - started })
      })()
    })
  })
}

function exitMs(spawnAtMs: number, exitAtMs: number): number {
  return Math.max(0, exitAtMs - spawnAtMs)
}

/** 测试 shell 可执行路径 */
export async function testShellExecutable(
  executable: string,
  argsPrefix: string[] | undefined,
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const spec: ShellSpawnSpec = {
    executable,
    args: argsPrefix?.length ? argsPrefix : process.platform === 'win32' ? ['/d', '/c', ''] : ['--noprofile', '--norc', '-c', ''],
    shellId: path.basename(executable)
  }
  const execPlan = planShellExec(process.platform === 'win32' ? 'echo ok' : 'echo ok', cwd, spec)
  const spawned = spawnCommandSafe(spec.executable, execPlan.spawnArgs, { cwd: execPlan.cwd, env: buildShellEnv() })
  if ('error' in spawned) return { ok: false, error: spawned.error }
  return new Promise((resolve) => {
    const outBufs: Buffer[] = []
    spawned.proc.stdout?.on('data', (b: Buffer) => {
      outBufs.push(b)
    })
    spawned.proc.on('close', (code) => {
      const { text } = decodeChildOutput(Buffer.concat(outBufs), { contract: defaultContractForPlatform() })
      resolve(code === 0 && text.includes('ok') ? { ok: true } : { ok: false, error: `退出码 ${code}` })
    })
    spawned.proc.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
}
