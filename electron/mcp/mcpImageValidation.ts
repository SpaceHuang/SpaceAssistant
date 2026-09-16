const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_BYTES = 512 * 1024

export type McpImageValidation = { byteLength: number; previewable: boolean; data?: string }

function signatureMatches(mime: string, bytes: Uint8Array): boolean {
  if (mime === 'image/png') return bytes.length >= 16 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]) && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.slice(-2)[0] === 0xff && bytes.slice(-2)[1] === 0xd9
  if (mime === 'image/gif') return bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
}

export function validateMcpImage(mimeType: string, data: string): McpImageValidation {
  if (!ALLOWED.has(mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) return { byteLength: 0, previewable: false }
  try {
    const bytes = Uint8Array.from(Buffer.from(data, 'base64'))
    const byteLength = bytes.byteLength
    return { byteLength, previewable: byteLength <= MAX_BYTES && signatureMatches(mimeType, bytes), ...(byteLength <= MAX_BYTES && signatureMatches(mimeType, bytes) ? { data } : {}) }
  } catch {
    return { byteLength: 0, previewable: false }
  }
}
