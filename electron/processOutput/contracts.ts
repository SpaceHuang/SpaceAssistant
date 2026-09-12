import { execFileSync } from 'child_process'
import type { OutputEncodingContract } from '../../src/shared/outputEncoding'

export const AUTO_CONTRACT: OutputEncodingContract = Object.freeze({ kind: 'auto' })
export const UTF8_CONTRACT: OutputEncodingContract = Object.freeze({ kind: 'utf8' })
export const UTF16LE_CONTRACT: OutputEncodingContract = Object.freeze({ kind: 'utf16le' })

export function oemContract(codepage: number): OutputEncodingContract {
  return Object.freeze({ kind: 'oem', codepage })
}

/**
 * OEM 代码页 → WHATWG TextDecoder 标签。
 * 437/850 等 DOS 经典代码页没有内置解码器，返回 undefined，由 §8.4 的「可逆兜底」接管。
 */
const OEM_CODEPAGE_LABELS: Readonly<Record<number, string>> = Object.freeze({
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258'
})

export function labelForOemCodepage(codepage: number | undefined): string | undefined {
  if (typeof codepage !== 'number' || !Number.isInteger(codepage)) return undefined
  return OEM_CODEPAGE_LABELS[codepage]
}

/** 契约的「期望标签」；`auto` 与无内置解码器的 CP 返回 undefined。 */
export function expectedLabelForContract(contract: OutputEncodingContract): string | undefined {
  switch (contract.kind) {
    case 'utf8':
      return 'utf-8'
    case 'utf16le':
      return 'utf-16le'
    case 'oem':
      return labelForOemCodepage(contract.codepage)
    default:
      return undefined
  }
}

const OEMCP_REGISTRY_PATH = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'
const OEMCP_QUERY_TIMEOUT_MS = 3000

let oemCodepageCache: { value: number | undefined } | undefined

/**
 * 宿主 OEM 代码页（§7.4 主真值）：读注册表并缓存到进程级。
 * 失败返回 undefined，契约退化为 `auto` + 探测。
 */
export function detectOemCodepageSync(platform: NodeJS.Platform = process.platform): number | undefined {
  if (platform !== 'win32') return undefined
  if (oemCodepageCache) return oemCodepageCache.value
  let value: number | undefined
  try {
    const output = execFileSync('reg', ['query', OEMCP_REGISTRY_PATH, '/v', 'OEMCP'], {
      encoding: 'utf8',
      timeout: OEMCP_QUERY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const match = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(String(output))
    if (match) {
      const parsed = Number(match[1])
      if (Number.isInteger(parsed) && parsed > 0) value = parsed
    }
  } catch {
    value = undefined
  }
  oemCodepageCache = { value }
  return value
}

export function resetOemCodepageCacheForTest(): void {
  oemCodepageCache = undefined
}

/** 内置 profile 的默认契约：Windows 用宿主 OEM CP，其它平台用 UTF-8。 */
export function defaultContractForPlatform(platform: NodeJS.Platform = process.platform): OutputEncodingContract {
  if (platform !== 'win32') return UTF8_CONTRACT
  const codepage = detectOemCodepageSync(platform)
  return codepage === undefined ? AUTO_CONTRACT : oemContract(codepage)
}

/** 解析本次探测实际可用的 OEM CP：契约 > 显式入参 > 宿主探测。 */
export function resolveOemCodepage(
  contract: OutputEncodingContract,
  explicit: number | undefined,
  platform: NodeJS.Platform = process.platform
): number | undefined {
  if (contract.kind === 'oem') return contract.codepage
  if (typeof explicit === 'number') return explicit
  return detectOemCodepageSync(platform)
}
