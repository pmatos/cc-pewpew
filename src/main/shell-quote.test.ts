import { describe, it, expect } from 'vitest'
import { shellQuote } from './shell-quote'

describe('shellQuote', () => {
  it('wraps empty string as empty single-quote pair', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('wraps plain text without modification inside quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('wraps path with whitespace', () => {
    expect(shellQuote('a path with spaces')).toBe("'a path with spaces'")
  })

  it("escapes a single quote as '\"'\"'", () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'")
  })

  it('escapes multiple single quotes', () => {
    expect(shellQuote("a'b'c")).toBe("'a'\"'\"'b'\"'\"'c'")
  })

  it('escapes a string containing only a single quote', () => {
    expect(shellQuote("'")).toBe("''\"'\"''")
  })

  it('leaves backslashes literal inside single quotes', () => {
    expect(shellQuote('path\\to\\file')).toBe("'path\\to\\file'")
  })

  it('leaves double quotes literal inside single quotes', () => {
    expect(shellQuote('say "hi"')).toBe('\'say "hi"\'')
  })

  it('preserves trailing newline inside single quotes', () => {
    expect(shellQuote('foo\n')).toBe("'foo\n'")
  })

  it('preserves NUL byte (caller responsibility to reject upstream)', () => {
    expect(shellQuote('a\x00b')).toBe("'a\x00b'")
  })
})
