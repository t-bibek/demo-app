/**
 * Incremental NDJSON (newline-delimited JSON) parser for a child-process
 * stdout stream. Handles chunks that split lines arbitrarily.
 */
export class NdjsonParser<T> {
  private buffer = '';

  constructor(
    private readonly onValue: (value: T) => void,
    private readonly onBadLine?: (line: string, error: unknown) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.parseLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  /** Flush a trailing line that was not newline-terminated (e.g. at process exit). */
  flush(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.parseLine(line);
  }

  private parseLine(line: string): void {
    try {
      this.onValue(JSON.parse(line) as T);
    } catch (error) {
      this.onBadLine?.(line, error);
    }
  }
}
