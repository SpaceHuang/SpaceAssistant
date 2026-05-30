export type BrowserDependencyFailureCode =
  | 'ok'
  | 'stagehand_missing'
  | 'playwright_missing'
  | 'chromium_missing'
  | 'chromium_headless_only'
  | 'chromium_path_unresolved'
  | 'node_version_low'
  | 'init_probe_failed'

export type BrowserDetectResult = {
  stagehand: { installed: boolean; version?: string }
  playwright: { installed: boolean; browsers: string[] }
  chromium: { ready: boolean; executableHint?: string; revision?: string }
  node: { version: string; meetsRequirement: boolean }
  canInitialize: boolean
  primaryFailure: BrowserDependencyFailureCode
  errors: string[]
  recommendedCwd: string
  installContext: 'development' | 'packaged'
}

export type BrowserDependencyToolError = {
  errorCode: BrowserDependencyFailureCode
  errorMessage: string
  recommendedCwd: string
  installCommand: string
  detectResult: BrowserDetectResult
}

export const CHROMIUM_INSTALL_CMD = 'npx playwright install chromium'
export const NPM_INSTALL_CMD = 'npm install @browserbasehq/stagehand playwright zod'
