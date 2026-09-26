import * as ts from 'typescript'

export type RunScriptLanguage = 'python' | 'javascript' | 'typescript' | 'powershell'
export type ScriptInterpreterPaths = Partial<Record<Exclude<RunScriptLanguage, 'python'>, string>>

export function normalizeRunScriptLanguage(value: unknown): RunScriptLanguage {
  if (value === undefined || value === null || value === '') return 'python'
  if (value === 'python' || value === 'javascript' || value === 'typescript' || value === 'powershell') return value
  throw new Error('UNSUPPORTED_SCRIPT_LANGUAGE')
}

export type ScriptLaunch = { command: string; args: string[]; interpreterName: string; code: string }

export function resolveNonPythonScriptLaunch(
  language: Exclude<RunScriptLanguage, 'python'>,
  source: string,
  interpreterPaths: ScriptInterpreterPaths = {},
  platform: NodeJS.Platform = process.platform
): ScriptLaunch {
  if (language === 'javascript') {
    return { command: interpreterPaths.javascript?.trim() || 'node', args: ['--input-type=module', '-e', source], interpreterName: 'node', code: source }
  }
  if (language === 'typescript') {
    const result = ts.transpileModule(source, {
      fileName: 'run-script.ts',
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true }
    })
    if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('INVALID_TYPESCRIPT_SCRIPT')
    return {
      command: interpreterPaths.typescript?.trim() || 'node',
      args: ['--input-type=module', '-e', result.outputText],
      interpreterName: 'node',
      code: source
    }
  }
  if (language === 'powershell') {
    const command = interpreterPaths.powershell?.trim() || (platform === 'win32' ? 'powershell.exe' : 'pwsh')
    const encoded = Buffer.from(source, 'utf16le').toString('base64')
    return { command, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], interpreterName: 'powershell', code: source }
  }
  throw new Error('UNSUPPORTED_SCRIPT_LANGUAGE')
}
