import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFileMetadata, readFileForViewer } from './fileReadHelpers'
import { MAX_FILE_READ_SIZE } from '../src/shared/fileTypes'

describe('fileReadHelpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-file-ipc-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads text file as utf8', async () => {
    const file = path.join(tmpDir, 'hello.txt')
    await fs.writeFile(file, 'hello world', 'utf8')
    const result = await readFileForViewer(file)
    expect(result).toEqual({ kind: 'text', content: 'hello world', encoding: 'utf8' })
  })

  it('returns too_large for files over limit', async () => {
    const file = path.join(tmpDir, 'big.bin')
    const size = MAX_FILE_READ_SIZE + 1
    await fs.writeFile(file, Buffer.alloc(size))
    const result = await readFileForViewer(file)
    expect(result.kind).toBe('too_large')
    if (result.kind === 'too_large') {
      expect(result.size).toBe(size)
    }
  })

  it('returns unsupported for blocked extensions', async () => {
    const file = path.join(tmpDir, 'doc.pdf')
    await fs.writeFile(file, '%PDF', 'utf8')
    const result = await readFileForViewer(file)
    expect(result).toEqual({ kind: 'unsupported', ext: '.pdf' })
  })

  it('reads image as base64', async () => {
    const file = path.join(tmpDir, 'pic.png')
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await readFileForViewer(file)
    expect(result.kind).toBe('image')
    if (result.kind === 'image') {
      expect(result.mimeType).toBe('image/png')
      expect(result.encoding).toBe('base64')
    }
  })

  it('getFileMetadata returns size and mtime', async () => {
    const file = path.join(tmpDir, 'meta.ts')
    await fs.writeFile(file, 'export {}', 'utf8')
    const meta = await getFileMetadata(file)
    expect(meta.size).toBeGreaterThan(0)
    expect(meta.mtime).toBeGreaterThan(0)
    expect(meta.isText).toBe(true)
  })
})
