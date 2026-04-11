/**
 * Rough token estimator used to budget diff size before sending it to an
 * AI provider.
 *
 * We use the classic GPT-3-era rule of thumb: one token ≈ four characters
 * of English. Claude's tokenizer averages closer to 3.5, so this function
 * slightly *overestimates* token usage for Claude, which means we fit a
 * little less content than we could — the safe direction to fail.
 *
 * Provider adapters (step 7+) can override this with a real tokenizer if
 * they ship one. For diff budgeting we only need to be right within
 * ~20%, so the heuristic is fine.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
