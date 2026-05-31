import { access } from 'node:fs/promises'
import { join } from 'node:path'
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

/** headless 时 Playwright 默认走 headless_shell，其 CDP HTTP 端口不可靠；改用完整 Chromium。 */
export async function resolveFullChromiumExecutable(
  chromium: PlaywrightChromiumBrowserType
): Promise<string> {
  const exe = chromium.executablePath()
  const rev = exe.match(/(?:chromium[_-]headless[_-]shell|chromium)-(\d+)/i)?.[1]
  if (!rev || !exe.includes('headless_shell')) {
    return exe
  }

  const root = exe.replace(/chromium[_-]headless[_-]shell-\d+.*$/i, '')
  const candidates =
    process.platform === 'win32'
      ? [
          join(root, `chromium-${rev}`, 'chrome-win64', 'chrome.exe'),
          join(root, `chromium-${rev}`, 'chrome-win', 'chrome.exe')
        ]
      : process.platform === 'darwin'
        ? [
            join(
              root,
              `chromium-${rev}`,
              'chrome-mac',
              'Chromium.app',
              'Contents',
              'MacOS',
              'Chromium'
            )
          ]
        : [join(root, `chromium-${rev}`, 'chrome-linux', 'chrome')]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
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
