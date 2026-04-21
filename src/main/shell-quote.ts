// POSIX shell single-quote wrapper: wraps arg in '...' and escapes any embedded
// single quotes as '"'"' (close, escaped-quote in double-quotes, reopen).
export function shellQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\"'\"'") + "'"
}
