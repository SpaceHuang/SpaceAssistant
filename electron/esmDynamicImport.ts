type EsmImporter = <T>(specifier: string) => Promise<T>

/** 避免 tsc 将 import(specifier) 编译成 require(specifier) */
const esmImport: EsmImporter = (0, eval)('specifier => import(specifier)')

/** 在 CommonJS 主进程中加载 ESM 包 */
export function importEsmModule<T = unknown>(specifier: string): Promise<T> {
  return esmImport<T>(specifier)
}
