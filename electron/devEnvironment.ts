export type DevEnvironment = {
  SPACEASSISTANT_DEV?: string
  ELECTRON_START_URL?: string
  VITE_DEV_SERVER_PORT?: string
}

export function isSpaceAssistantDev(env: DevEnvironment = process.env): boolean {
  return env.SPACEASSISTANT_DEV === '1'
}

export function getRendererURL(env: DevEnvironment = process.env): string {
  if (env.ELECTRON_START_URL) return env.ELECTRON_START_URL
  const port = env.VITE_DEV_SERVER_PORT ?? '9240'
  return `http://127.0.0.1:${port}`
}
