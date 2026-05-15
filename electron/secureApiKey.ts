import { safeStorage } from 'electron'

export function isSecretStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function encryptSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage），无法保存 API Key')
  }
  const buf = safeStorage.encryptString(plain)
  return Buffer.from(buf).toString('base64')
}

export function decryptSecret(b64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统不支持安全存储（safeStorage），无法读取 API Key')
  }
  return safeStorage.decryptString(Buffer.from(b64, 'base64'))
}
