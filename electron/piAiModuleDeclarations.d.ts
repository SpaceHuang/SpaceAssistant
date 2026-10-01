declare module '@earendil-works/pi-ai/api/anthropic-messages' {
  export function stream(model: unknown, context: unknown, options: unknown): AsyncIterable<unknown>
}

declare module '@earendil-works/pi-ai/utils/transcript' {
  export function normalizeContext(context: unknown): unknown
}
