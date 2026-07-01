import { describe, expect, it } from 'vitest';
import { NdjsonParser } from '../src/shared/ndjson';

describe('NdjsonParser', () => {
  it('parses complete lines', () => {
    const values: unknown[] = [];
    const parser = new NdjsonParser((v) => values.push(v));
    parser.push('{"a":1}\n{"b":2}\n');
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles lines split across chunks', () => {
    const values: unknown[] = [];
    const parser = new NdjsonParser((v) => values.push(v));
    parser.push('{"speakers":["Al');
    parser.push('ice"],"ts":1}\n{"x":');
    parser.push('2}\n');
    expect(values).toEqual([{ speakers: ['Alice'], ts: 1 }, { x: 2 }]);
  });

  it('handles CRLF line endings', () => {
    const values: unknown[] = [];
    const parser = new NdjsonParser((v) => values.push(v));
    parser.push('{"a":1}\r\n{"b":2}\r\n');
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports unparseable lines without throwing', () => {
    const values: unknown[] = [];
    const bad: string[] = [];
    const parser = new NdjsonParser(
      (v) => values.push(v),
      (line) => bad.push(line),
    );
    parser.push('not json\n{"ok":true}\n');
    expect(values).toEqual([{ ok: true }]);
    expect(bad).toEqual(['not json']);
  });

  it('skips empty lines', () => {
    const values: unknown[] = [];
    const parser = new NdjsonParser((v) => values.push(v));
    parser.push('\n\n{"a":1}\n\r\n');
    expect(values).toEqual([{ a: 1 }]);
  });

  it('flush parses a trailing unterminated line', () => {
    const values: unknown[] = [];
    const parser = new NdjsonParser((v) => values.push(v));
    parser.push('{"a":1}');
    expect(values).toEqual([]);
    parser.flush();
    expect(values).toEqual([{ a: 1 }]);
  });
});
