export const MAX_PR_SPEC_NUMBERS = 200

export type PrSpecResult = { numbers: number[] } | { error: string }

const TOKEN_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

export function parsePrSpec(input: string): PrSpecResult {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { error: 'Enter at least one PR number.' }

  const tokens: string[] = []
  for (const part of trimmed.split(',')) {
    const token = part.trim()
    if (token.length > 0) tokens.push(token)
  }
  if (tokens.length === 0) return { error: 'Enter at least one PR number.' }

  const result = new Set<number>()
  for (const token of tokens) {
    const match = TOKEN_RE.exec(token)
    if (!match) return { error: `Invalid PR spec: "${token}".` }

    const lo = Number.parseInt(match[1], 10)
    const hi = match[2] === undefined ? lo : Number.parseInt(match[2], 10)

    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 1 || hi < 1) {
      return { error: 'PR numbers must be 1 or greater.' }
    }
    if (hi < lo) return { error: `Invalid range "${token}": start > end.` }
    if (hi - lo + 1 > MAX_PR_SPEC_NUMBERS) {
      return { error: `Range "${token}" is too large (max ${MAX_PR_SPEC_NUMBERS}).` }
    }

    for (let n = lo; n <= hi; n++) {
      result.add(n)
      if (result.size > MAX_PR_SPEC_NUMBERS) {
        return { error: `Too many PR numbers (max ${MAX_PR_SPEC_NUMBERS}).` }
      }
    }
  }

  return { numbers: Array.from(result).sort((a, b) => a - b) }
}
