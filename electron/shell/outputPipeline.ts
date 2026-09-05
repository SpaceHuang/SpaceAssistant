import type { BoundedOutputSnapshot } from './boundedOutput'

export interface OutputPipelineSnapshot {
  readonly stdout: BoundedOutputSnapshot
  readonly stderr: BoundedOutputSnapshot
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

export function createOutputPipelineSnapshot(input: {
  stdout: BoundedOutputSnapshot
  stderr: BoundedOutputSnapshot
  terminalRaw?: Buffer
  inlineMaxBytes: number
  artifactMaxBytes: number
  artifact?: OutputPipelineSnapshot['artifact']
}): OutputPipelineSnapshot {
  const terminalRaw = input.terminalRaw ? Buffer.from(input.terminalRaw) : Buffer.alloc(0)
  return Object.freeze({
    stdout: Object.freeze({ ...input.stdout }),
    stderr: Object.freeze({ ...input.stderr }),
    terminalRawBytes: terminalRaw.length,
    terminalRawBase64: terminalRaw.length ? terminalRaw.toString('base64') : undefined,
    inlineMaxBytes: input.inlineMaxBytes,
    artifactMaxBytes: input.artifactMaxBytes,
    truncated: input.stdout.truncated || input.stderr.truncated,
    artifact: input.artifact ? Object.freeze({ ...input.artifact }) : undefined
  })
}
