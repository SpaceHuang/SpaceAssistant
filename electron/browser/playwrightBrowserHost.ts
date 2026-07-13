import { access, readdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { importEsmModule } from '../esmDynamicImport'

/** Playwright 为可选运行时依赖；编译期不引用 node_modules/playwright。 */
export interface PlaywrightChromiumBrowserType {
  executablePath(): string
}

export interface PlaywrightModule {
  chromium: PlaywrightChromiumBrowserType
}

interface ChromeLauncherHandle {
  port: number
  kill: () => Promise<void>
}

interface ChromeLauncherModule {
  launch(opts: {
    chromePath: string
    chromeFlags: string[]
    connectionPollInterval?: number
    maxConnectionRetries?: number
  }): Promise<ChromeLauncherHandle>
}

export interface PlaywrightBrowserHost {
  cdpUrl: string
  close: () => Promise<void>
}

const CONNECT_TIMEOUT_MS = 15_000

/** 轮询 Chromium /json/version 获取标准 CDP WebSocket（Stagehand 要求）。 */
export async function resolveCdpWebSocketUrl(
  port: number,
  timeoutMs: number = CONNECT_TIMEOUT_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (resp.ok) {
        const json = (await resp.json()) as { webSocketDebuggerUrl?: string }
        if (typeof json.webSocketDebuggerUrl === 'string') {
          return json.webSocketDebuggerUrl
        }
      } else {
        lastErr = `${resp.status} ${resp.statusText}`
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `连接 Chromium CDP 超时（端口 ${port}${lastErr ? `，${lastErr}` : ''}）`
  )
}

/** 从 Playwright executablePath() 返回值推断 browsers 根目录；无法推断时返回 null。 */
export function inferBrowsersRoot(exe: string): string | null {
  const m = exe.match(/^(.*?)[\\/]?chromium(?:[_-]headless[_-]shell)?-\d+/i)
  return m && m[1] ? m[1] : null
}

/**
 * 从 exe 路径提取 chromium-{rev}/ 之后的子路径（可执行文件相对路径）。
 * 用于同构定位其他 revision：executablePath() 已给出当前 Playwright 期望的真实目录结构
 * （如 chrome-mac-arm64/Google Chrome for Testing.app/...），复用它扫描已安装的其他 revision，
 * 无需对目录命名做任何硬编码假设。
 */
export function extractChromiumSubPath(exe: string): string | null {
  const m = exe.match(/[\\/]chromium(?:[_-]headless[_-]shell)?-\d+[\\/](.+)$/i)
  return m ? m[1] : null
}

/**
 * 平台相关的完整 Chromium 可执行文件候选子路径（相对 chromium-{rev}/ 目录），覆盖新旧命名。
 * - Playwright 1.40+ macOS 用 chrome-mac-{arm64,x64}/Google Chrome for Testing.app
 * - 早期版本用 chrome-mac/Chromium.app
 * 仅在「同构子路径」策略无法套用（如入口是 headless_shell 路径）时作为回退。
 */
export function fullChromiumSubPathParts(platform: string = process.platform): string[][] {
  if (platform === 'win32') {
    return [
      ['chrome-win64', 'chrome.exe'],
      ['chrome-win', 'chrome.exe']
    ]
  }
  if (platform === 'darwin') {
    return [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']
    ]
  }
  return [
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome']
  ]
}

/** 扫描 root 下所有 chromium-NNNN（排除 headless_shell）目录，返回 revision 降序列表。 */
export async function listInstalledFullChromiumRevs(root: string): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  return entries
    .map((name) => name.match(/^chromium-(\d+)$/i))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => parseInt(m[1], 10))
    .sort((a, b) => b - a)
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p)
      return p
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * 解析可用的完整 Chromium 可执行文件路径。
 * headless 时 Playwright 默认走 headless_shell，其 CDP HTTP 端点不可靠，需改用完整 Chromium。
 *
 * 当 Playwright 期望的 revision 与本地实际安装的不一致时（例如 npx 拉取了更新版本的 Playwright
 * 下载了更高 revision 的 Chromium），按以下顺序回退，避免版本精确匹配误报缺失：
 * 1. exe 本身非 headless_shell 且存在 —— 版本精确匹配，直接用；
 * 2. 同构子路径扫描 —— 复用 executablePath() 给出的真实目录结构，定位其他已安装 revision；
 * 3. 候选子路径回退 —— 用平台新旧命名候选，覆盖 headless_shell 入口或目录结构差异；
 * 4. 仍无完整 Chromium —— 返回原 exe，上层据此报 chromium_missing / headless_only。
 */
export async function resolveFullChromiumExecutable(
  chromium: PlaywrightChromiumBrowserType
): Promise<string> {
  const exe = chromium.executablePath()

  // 1. exe 本身就是完整 Chromium 且存在：版本精确匹配，直接用
  if (!exe.includes('headless_shell')) {
    try {
      await access(exe)
      return exe
    } catch {
      /* 精确 revision 缺失，回退扫描 */
    }
  }

  const root = inferBrowsersRoot(exe)
  if (!root) return exe

  const revs = await listInstalledFullChromiumRevs(root)
  const pj = process.platform === 'win32' ? win32.join : posix.join

  // 2. 同构子路径扫描：复用 executablePath() 给出的真实目录结构，定位其他 revision
  const subPath = extractChromiumSubPath(exe)
  if (subPath && !/headless/i.test(subPath)) {
    const hit = await firstExisting(revs.map((rev) => pj(root, `chromium-${rev}`, subPath)))
    if (hit) return hit
  }

  // 3. 候选子路径回退：覆盖 headless_shell 入口或目录结构差异（新旧命名）
  for (const rev of revs) {
    const hit = await firstExisting(
      fullChromiumSubPathParts().map((parts) => pj(root, `chromium-${rev}`, ...parts))
    )
    if (hit) return hit
  }

  // 4. 实在没有完整 Chromium，返回原 exe；上层据此报 chromium_missing / headless_only
  return exe
}

/**
 * 用 chrome-launcher + Playwright 自带的完整 Chromium 启动，暴露标准 CDP。
 * 避免：1) CJS require chrome-launcher；2) launchServer WS 非 CDP；3) headless_shell 无调试端口。
 */
export async function launchPlaywrightBrowserHost(headless: boolean): Promise<PlaywrightBrowserHost> {
  const { chromium } = await importEsmModule<PlaywrightModule>('playwright')
  const chromePath = await resolveFullChromiumExecutable(chromium)
  const { launch } = await importEsmModule<ChromeLauncherModule>('chrome-launcher')

  const chromeFlags = [
    headless ? '--headless=new' : undefined,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--site-per-process'
  ].filter((f): f is string => typeof f === 'string')

  const chrome = await launch({
    chromePath,
    chromeFlags,
    connectionPollInterval: 250,
    maxConnectionRetries: Math.ceil(CONNECT_TIMEOUT_MS / 250)
  })

  try {
    const cdpUrl = await resolveCdpWebSocketUrl(chrome.port)
    return {
      cdpUrl,
      close: async () => {
        await chrome.kill()
      }
    }
  } catch (e) {
    try {
      await chrome.kill()
    } catch {
      /* ignore */
    }
    throw e
  }
}
