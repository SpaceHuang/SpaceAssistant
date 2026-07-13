import { describe, expect, it } from 'vitest'
import {
  resolveCdpWebSocketUrl,
  resolveFullChromiumExecutable,
  inferBrowsersRoot,
  extractChromiumSubPath,
  fullChromiumSubPathParts,
  listInstalledFullChromiumRevs
} from './playwrightBrowserHost'
import type { PlaywrightChromiumBrowserType } from './playwrightBrowserHost'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

describe('resolveCdpWebSocketUrl', () => {
  it('times out when no browser listens on port', async () => {
    const port = await new Promise<number>((resolve) => {
      const { createServer } = require('node:net') as typeof import('node:net')
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const p = typeof addr === 'object' && addr ? addr.port : 0
        s.close(() => resolve(p))
      })
    })
    await expect(resolveCdpWebSocketUrl(port, 500)).rejects.toThrow(/CDP 超时/)
  })
})

function fakeChromium(exePath: string): PlaywrightChromiumBrowserType {
  return { executablePath: () => exePath }
}

/** 当前平台的 path.join（用于在测试中构造与平台一致的路径）。 */
const pj = process.platform === 'win32' ? win32.join : posix.join
/** 当前平台首选的完整 Chromium 子路径结构（真实命名）。 */
const platParts = fullChromiumSubPathParts()[0]

async function makeBrowsersRoot(): Promise<string> {
  return mkdtemp(pj(tmpdir(), 'pw-browsers-'))
}

/** 在 root 下放置指定 revision 的完整 Chromium 占位文件，返回其可执行路径。 */
async function placeFullChromium(root: string, rev: string, parts: string[] = platParts): Promise<string> {
  const exe = pj(root, `chromium-${rev}`, ...parts)
  await mkdir(pj(exe, '..'), { recursive: true })
  await writeFile(exe, '')
  return exe
}

describe('inferBrowsersRoot', () => {
  it('extracts root from full chromium path', () => {
    const exe = '/users/x/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    expect(inferBrowsersRoot(exe)).toBe('/users/x/ms-playwright')
  })

  it('extracts root from headless_shell path', () => {
    const exe = '/users/x/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
    expect(inferBrowsersRoot(exe)).toBe('/users/x/ms-playwright')
  })

  it('returns null when no chromium revision present', () => {
    expect(inferBrowsersRoot('/some/path/chrome.exe')).toBeNull()
  })
})

describe('extractChromiumSubPath', () => {
  it('extracts sub-path after chromium-{rev}/ from a full chromium path', () => {
    const exe = '/r/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    expect(extractChromiumSubPath(exe)).toBe(
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    )
  })

  it('extracts sub-path from a headless_shell path', () => {
    const exe = '/r/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
    expect(extractChromiumSubPath(exe)).toBe('chrome-headless-shell-mac-arm64/chrome-headless-shell')
  })

  it('returns null when no chromium revision present', () => {
    expect(extractChromiumSubPath('/some/path/chrome.exe')).toBeNull()
  })
})

describe('fullChromiumSubPathParts', () => {
  it('win32 lists chrome-win64 then chrome-win', () => {
    const parts = fullChromiumSubPathParts('win32')
    expect(parts[0]).toEqual(['chrome-win64', 'chrome.exe'])
    expect(parts[1]).toEqual(['chrome-win', 'chrome.exe'])
  })

  it('darwin lists Google Chrome for Testing.app (arm64/x64) then legacy Chromium.app', () => {
    const parts = fullChromiumSubPathParts('darwin')
    expect(parts[0]).toEqual(['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'])
    expect(parts[2]).toEqual(['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'])
  })

  it('linux lists chrome-linux then chrome-linux64', () => {
    const parts = fullChromiumSubPathParts('linux')
    expect(parts[0]).toEqual(['chrome-linux', 'chrome'])
    expect(parts[1]).toEqual(['chrome-linux64', 'chrome'])
  })
})

describe('listInstalledFullChromiumRevs', () => {
  it('lists chromium-NNNN dirs descending and excludes headless_shell', async () => {
    const root = await makeBrowsersRoot()
    await placeFullChromium(root, '1228')
    await placeFullChromium(root, '1225')
    await mkdir(pj(root, 'chromium_headless_shell-1228', 'chrome-headless-shell-mac-arm64'), { recursive: true })
    expect(await listInstalledFullChromiumRevs(root)).toEqual([1228, 1225])
  })

  it('returns empty list when root is unreadable', async () => {
    expect(await listInstalledFullChromiumRevs(pj(tmpdir(), 'nonexistent-pw-browsers-root'))).toEqual([])
  })
})

describe('resolveFullChromiumExecutable', () => {
  it('returns exe directly when the exact full chromium exists', async () => {
    const root = await makeBrowsersRoot()
    const exe = await placeFullChromium(root, '1223')
    expect(await resolveFullChromiumExecutable(fakeChromium(exe))).toBe(exe)
  })

  it('falls back via same-structure sub-path to another installed revision', async () => {
    const root = await makeBrowsersRoot()
    // Playwright 期望 1223（同结构路径不存在），但本地装了 1228
    const exe1228 = await placeFullChromium(root, '1228')
    const expected1223 = pj(root, 'chromium-1223', ...platParts)
    expect(await resolveFullChromiumExecutable(fakeChromium(expected1223))).toBe(exe1228)
  })

  it('falls back via candidate sub-paths when the entry is a headless_shell path', async () => {
    const root = await makeBrowsersRoot()
    const exe1228 = await placeFullChromium(root, '1228')
    // headless_shell 入口：同构子路径含 headless 被排除，走候选子路径回退
    const headlessExe = pj(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    expect(await resolveFullChromiumExecutable(fakeChromium(headlessExe))).toBe(exe1228)
  })

  it('prefers the newest revision when multiple are installed', async () => {
    const root = await makeBrowsersRoot()
    const exe1228 = await placeFullChromium(root, '1228')
    await placeFullChromium(root, '1225')
    const expected1223 = pj(root, 'chromium-1223', ...platParts)
    expect(await resolveFullChromiumExecutable(fakeChromium(expected1223))).toBe(exe1228)
  })

  it('returns the original exe when no full chromium is installed (non-headless entry)', async () => {
    const root = await makeBrowsersRoot()
    const expected1223 = pj(root, 'chromium-1223', ...platParts)
    expect(await resolveFullChromiumExecutable(fakeChromium(expected1223))).toBe(expected1223)
  })

  it('returns the headless_shell exe unchanged when only headless_shell is installed', async () => {
    const root = await makeBrowsersRoot()
    const headlessDir = pj(root, 'chromium_headless_shell-1223', 'chrome-headless-shell-mac-arm64')
    await mkdir(headlessDir, { recursive: true })
    const headlessExe = pj(headlessDir, 'chrome-headless-shell')
    await writeFile(headlessExe, '')
    expect(await resolveFullChromiumExecutable(fakeChromium(headlessExe))).toBe(headlessExe)
  })
})
