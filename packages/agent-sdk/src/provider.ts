export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'
export type ProviderInput = { model: string; reasoning: ReasoningEffort; prompt: string; signal?: AbortSignal }
export type ProviderOutput = { content: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }

export class UnsupportedReasoningError extends Error {
  readonly code = 'unsupported-reasoning'
  constructor(readonly requested: ReasoningEffort) { super(`provider does not support reasoning=${requested}`) }
}

export class ProviderInvocation {
  constructor(private readonly deps: {
    capabilities: { reasoning: readonly ReasoningEffort[] }
    invoke(input: ProviderInput): Promise<ProviderOutput>
  }) {}

  async run(input: ProviderInput): Promise<ProviderOutput> {
    if (!this.deps.capabilities.reasoning.includes(input.reasoning)) throw new UnsupportedReasoningError(input.reasoning)
    const output = await this.deps.invoke({ ...input, reasoning: input.reasoning })
    return output.usage ? {
      ...output,
      usage: { ...output.usage, totalTokens: output.usage.totalTokens ?? ((output.usage.inputTokens ?? 0) + (output.usage.outputTokens ?? 0)) }
    } : output
  }
}
