type AnthropicSseScenario = Readonly<{ kind: 'sse'; events: readonly Record<string, unknown>[]; closePrematurely?: boolean }>
type AnthropicHttpErrorScenario = Readonly<{ kind: 'http-error'; status: number; body: unknown }>
type AnthropicNetworkErrorScenario = Readonly<{ kind: 'network-error'; message: string }>
type AnthropicHandlerScenario = Readonly<{ kind: 'handler'; respond: (request: AnthropicHarnessRequest) => Response | Promise<Response> }>
export type AnthropicStreamScenario = AnthropicSseScenario | AnthropicHttpErrorScenario | AnthropicNetworkErrorScenario | AnthropicHandlerScenario

export type AnthropicHarnessRequest = Readonly<{ url: string; method: string; body: string | null; signal: AbortSignal | null }>

/**
 * Deterministic model-boundary fixture. Only `fetch` is replaced; Anthropic SDK parsing, SSE iteration,
 * client factory, stream consumers, and persistence remain real. Temporary filesystem fixtures follow INV-04.
 */
export function createAnthropicStreamHarness() {
  const scenarios: AnthropicStreamScenario[] = []
  const requests: AnthropicHarnessRequest[] = []
  const encoder = new TextEncoder()
  let fallbackScenario: AnthropicStreamScenario | undefined

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const requestBody = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request ? await input.clone().text() : null
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : null)
    const request = { url, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), body: requestBody, signal: requestSignal }
    requests.push(request)
    const scenario = scenarios.shift() ?? fallbackScenario
    if (!scenario) throw new Error('anthropic-stream-harness: no scripted response remains')
    if (scenario.kind === 'handler') return scenario.respond(request)
    if (scenario.kind === 'network-error') throw new TypeError(scenario.message)
    if (scenario.kind === 'http-error') {
      return new Response(JSON.stringify(scenario.body), {
        status: scenario.status,
        headers: { 'content-type': 'application/json' }
      })
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of scenario.events) {
          const eventName = String(event.type ?? 'message')
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`))
        }
        if (scenario.closePrematurely) controller.error(new TypeError('anthropic-stream-harness: connection closed before terminal event'))
        else controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  return {
    fetch,
    requests,
    enqueue(scenario: AnthropicStreamScenario) { scenarios.push(scenario) },
    setFallback(scenario: AnthropicStreamScenario | undefined) { fallbackScenario = scenario },
    get pendingScenarioCount() { return scenarios.length }
  }
}
