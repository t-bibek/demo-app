import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/shared/types';

describe('formatDuration', () => {
  it('formats sub-minute durations with one decimal', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(4_120)).toBe('4.1s');
    expect(formatDuration(59_900)).toBe('59.9s');
  });

  it('switches to minute format at the displayed-60s boundary', () => {
    expect(formatDuration(59_960)).toBe('1m 00s'); // would render "60.0s" otherwise
    expect(formatDuration(60_000)).toBe('1m 00s');
  });

  it('never renders 60 in the seconds slot', () => {
    expect(formatDuration(119_700)).toBe('2m 00s'); // 1m 59.7s rounds up
    expect(formatDuration(179_999)).toBe('3m 00s');
  });

  it('formats minutes with zero-padded seconds', () => {
    expect(formatDuration(61_000)).toBe('1m 01s');
    expect(formatDuration(754_300)).toBe('12m 34s');
  });
});
