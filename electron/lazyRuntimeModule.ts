export function createLazyRuntimeModule<T>(load: () => T): () => T {
  let value: T | undefined
  return () => {
    if (value === undefined) value = load()
    return value
  }
}
