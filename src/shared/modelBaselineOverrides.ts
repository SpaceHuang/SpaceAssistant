/** Endpoint capability decisions that remain conservative pending direct verification. */
export const UNRESOLVED_MODEL_VISION_OVERRIDES: Record<string, boolean> = {
  'deepseek-flash': false,
  // Preserve the previous vision route until the configured MiniMax endpoint is tested.
  'minimax-m2.7': true
}

/** Keep a usable input headroom for Kimi until the provider's output cap is exposed separately. */
export const MODEL_PARAMETER_OVERRIDES: Record<string, { maximumContext?: number; maxTokens?: number }> = {
  'kimi-k2.7-code': { maxTokens: 98_304 }
}
