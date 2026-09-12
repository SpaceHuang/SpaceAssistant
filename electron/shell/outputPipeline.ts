import type { RawByteSnapshot } from './boundedOutput'
import { projectRawTextWithAlignment } from './rawTextProjection'

export interface OutputPipelineSnapshot {
  readonly stdout: RawByteSnapshot
  readonly stderr: RawByteSnapshot
  readonly stdoutText: string
  readonly stderrText: string
  /** 截断切片的字符对齐无法确认（多字节非自同步编码）：上层必须把该流降级为可疑输出。 */
  readonly stdoutAlignmentUncertain: boolean
  readonly stderrAlignmentUncertain: boolean
  readonly terminalRawBytes: number
  readonly terminalRawBase64?: string
  readonly inlineMaxBytes: number
  readonly artifactMaxBytes: number
  readonly truncated: boolean
  readonly artifact?: {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
  }
}

/** 统一输出边界：原始字节快照（事实）+ 文本投影（解码 head+marker+tail）。 */
export function createOutputPipelineSnapshot(input: {
  stdout: RawByteSnapshot
  stderr: RawByteSnapshot
  stdoutLabel: string
  stderrLabel: string
  terminalRaw?: Buffer
  inlineMaxBytes: number
  artifactMaxBytes: number
  artifact?: OutputPipelineSnapshot['artifact']
}): OutputPipelineSnapshot {
  const terminalRaw = input.terminalRaw ? Buffer.from(input.terminalRaw) : Buffer.alloc(0)
  const stdout = Object.freeze({ ...input.stdout })
  const stderr = Object.freeze({ ...input.stderr })
  const stdoutProjection = projectRawTextWithAlignment(stdout, input.stdoutLabel)
  const stderrProjection = projectRawTextWithAlignment(stderr, input.stderrLabel)
  return Object.freeze({
    stdout,
    stderr,
    stdoutText: stdoutProjection.text,
    stderrText: stderrProjection.text,
    stdoutAlignmentUncertain: stdoutProjection.alignmentUncertain,
    stderrAlignmentUncertain: stderrProjection.alignmentUncertain,
    terminalRawBytes: terminalRaw.length,
    terminalRawBase64: terminalRaw.length ? terminalRaw.toString('base64') : undefined,
    inlineMaxBytes: input.inlineMaxBytes,
    artifactMaxBytes: input.artifactMaxBytes,
    truncated: stdout.truncated || stderr.truncated,
    artifact: input.artifact ? Object.freeze({ ...input.artifact }) : undefined
  })
}
