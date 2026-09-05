import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputArtifactWriter } from './outputArtifactWriter'

describe('OutputArtifactWriter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('按顺序增量写入并限制 artifact 字节数', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-artifact-'))
    const file = path.join(dir, 'output.log')
    const writer = new OutputArtifactWriter(file, 10)
    await writer.open()
    writer.append('12345')
    writer.append('67890abcdef')
    const [result, secondResult] = await Promise.all([writer.close(), writer.close()])

    expect(result.bytes).toBe(10)
    expect(result.sha256).toBe('c775e7b757ede630cd0aa1113bd102661ab38829ca52a6422ab782862f268646')
    expect(secondResult).toEqual(result)
    expect(await fs.readFile(file, 'utf8')).toBe('1234567890')
  })

  it('queued write 失败时仍关闭 file handle，并保留写入错误', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-artifact-error-'))
    const close = vi.fn(async () => undefined)
    const write = vi.fn(async () => { throw new Error('WRITE_FAILED') })
    vi.spyOn(fs, 'open').mockResolvedValue({ close, write } as never)
    const writer = new OutputArtifactWriter(path.join(dir, 'output.log'), 10)
    await writer.open()
    writer.append('broken')

    await expect(writer.close()).rejects.toThrow('WRITE_FAILED')
    expect(close).toHaveBeenCalledOnce()
  })

  it('open 延迟期间 append 与 close 不丢失数据，也不与打开竞态', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-artifact-delayed-open-'))
    const file = path.join(dir, 'output.log')
    const actualOpen = fs.open
    let releaseOpen!: () => void
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      await openGate
      return actualOpen(...args)
    })

    const writer = new OutputArtifactWriter(file, 1024)
    const opening = writer.open()
    writer.append('prefix:')
    writer.append('body')
    const closing = writer.close()
    releaseOpen()

    await opening
    await expect(closing).resolves.toMatchObject({ bytes: 11 })
    expect(await fs.readFile(file, 'utf8')).toBe('prefix:body')
  })
})
