/** Fast token estimate (characters ÷ 3.5), used for prompt budgets and tests. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
