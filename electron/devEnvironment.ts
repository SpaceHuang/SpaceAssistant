import path from 'node:path'

export type DevEnvironment = {
  SPACEASSISTANT_DEV?: string
  SPACEASSISTANT_DEV_USER_DATA_DIR?: string
  ELECTRON_START_URL?: string
  VITE_DEV_SERVER_PORT?: string
}

export function isSpaceAssistantDev(env: DevEnvironment = process.env): boolean {
  return env.SPACEASSISTANT_DEV === '1'
}

export function getUserDataPath(defaultUserDataPath: string, env: DevEnvironment = process.env): string {
  if (!isSpaceAssistantDev(env)) return defaultUserDataPath
  const override = env.SPACEASSISTANT_DEV_USER_DATA_DIR?.trim()
  if (!override) return `${defaultUserDataPath}-dev`
  if (!path.isAbsolute(override)) throw new Error('DEV_USER_DATA_DIR_MUST_BE_ABSOLUTE')
  return override
}

export function getRendererURL(env: DevEnvironment = process.env): string {
  if (env.ELECTRON_START_URL) return env.ELECTRON_START_URL
  const port = env.VITE_DEV_SERVER_PORT ?? '9240'
  return `http://127.0.0.1:${port}`
}
