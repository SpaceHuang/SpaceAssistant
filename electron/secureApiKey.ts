import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { safeStorage } from 'electron'

// 威胁模型：这里的 AES-GCM 用于避免 API Key / MCP Secret 在应用的数据处理过程中
// 因配置读取、文件检查或上下文拼装等路径意外以明文暴露，尤其避免模型无意读到 Key
// 后将其带出本机。应用密钥随程序固定，因此本方案不防护能读取本机文件或运行本机代码的
// 攻击者破解密文；抵御这类本机攻击不是本功能的目标。
const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const FORMAT_PREFIX = 'sa1:'
const SECRET_KEY = createHash('sha256')
  .update('SpaceAssistant-local-secret-storage-key-v1!', 'utf8')
  .digest()

export function isSecretEncrypted(value: string): boolean {
  return value.startsWith(FORMAT_PREFIX)
}

export function isLegacySecret(value: string): boolean {
  return !isSecretEncrypted(value.startsWith('legacy:') ? value.slice('legacy:'.length) : value)
}

export function markLegacySecret(value: string): string {
  return isLegacySecret(value) ? `legacy:${value}` : value
}

export function setLegacySecretDecryptor(decryptor: (encoded: string) => string): void {
  legacyDecryptor = decryptor
}

let legacyDecryptor: ((encoded: string) => string) | undefined

export function encryptSecret(plain: string): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, SECRET_KEY, nonce)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${FORMAT_PREFIX}${Buffer.concat([nonce, tag, ciphertext]).toString('base64')}`
}

export function decryptSecret(encoded: string): string {
  if (!isSecretEncrypted(encoded)) {
    const legacyPayload = encoded.startsWith('legacy:') ? encoded.slice('legacy:'.length) : encoded
    if (legacyDecryptor) return legacyDecryptor(legacyPayload)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Legacy safeStorage is unavailable')
    return safeStorage.decryptString(Buffer.from(legacyPayload, 'base64'))
  }
  const payload = Buffer.from(encoded.slice(FORMAT_PREFIX.length), 'base64')
  if (payload.length < NONCE_BYTES + TAG_BYTES) throw new Error('Invalid secret storage payload')
  const nonce = payload.subarray(0, NONCE_BYTES)
  const tag = payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = payload.subarray(NONCE_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, SECRET_KEY, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
