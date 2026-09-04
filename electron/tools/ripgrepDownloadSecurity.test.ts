import { describe, expect, it } from 'vitest'
import { downloadArchive } from '../../scripts/prepare-ripgrep.mjs'

function fakeResponse(body: Buffer, init: { ok?: boolean; status?: number; length?: string; location?: string } = {}) {
  let cancelled = false
  return { ok: init.ok ?? true, status: init.status ?? 200, headers: new Headers({ ...(init.length ? { 'content-length': init.length } : {}), ...(init.location ? { location: init.location } : {}) }), body: { getReader: () => ({ read: async () => cancelled ? { done: true } : (cancelled = true, { done: false, value: body }), cancel: async () => { cancelled = true }, releaseLock: () => undefined }) } }
}

describe('ripgrep download security', () => {
  it('拒绝非成功响应并限制到官方重定向目标', async () => {
    await expect(downloadArchive('https://github.com/BurntSushi/ripgrep/releases/download/x/a', async () => fakeResponse(Buffer.alloc(0), { ok: false, status: 404 }) as any)).rejects.toThrow(/HTTP 404/)
    await expect(downloadArchive('https://github.com/x', async (_url, options) => { expect(options?.redirect).toBe('manual'); return fakeResponse(Buffer.alloc(0), { status: 302, location: 'https://evil.example/file' }) as any })).rejects.toThrow(/untrusted ripgrep redirect/)
  })
  it('拒绝超大响应', async () => {
    await expect(downloadArchive('https://github.com/BurntSushi/ripgrep/releases/download/x/a', async () => fakeResponse(Buffer.alloc(1), { length: String(51 * 1024 * 1024) }) as any)).rejects.toThrow(/size limit/)
  })

  it('限制最多三次重定向，并在无 content-length 时流式中止超限响应', async () => {
    let calls = 0
    await expect(downloadArchive('https://github.com/a', async (requested) => {
      calls++
      return fakeResponse(Buffer.alloc(0), { status: 302, location: new URL('/next', requested).toString() }) as any
    })).rejects.toThrow(/redirect limit/)
    expect(calls).toBe(4)
    const oversized = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => { let count = 0; return { read: async () => { count++; return { done: false, value: Buffer.alloc(30 * 1024 * 1024) } }, cancel: async () => { expect(count).toBe(2) }, releaseLock: () => undefined } } } }
    await expect(downloadArchive('https://github.com/a', async () => oversized as any)).rejects.toThrow(/size limit/)
  })
})
