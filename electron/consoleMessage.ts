/** Read renderer console text across Electron's legacy callback args and details-object shape. */
export function extractWebContentsConsoleMessage(
  eventOrDetails: unknown,
  levelOrMessage?: unknown,
  legacyMessage?: unknown
): string | undefined {
  if (typeof legacyMessage === 'string') return legacyMessage
  if (levelOrMessage !== undefined) return undefined
  if (!eventOrDetails || typeof eventOrDetails !== 'object') return undefined
  const message = (eventOrDetails as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}
