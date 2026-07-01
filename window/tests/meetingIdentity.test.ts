import { describe, expect, it } from 'vitest';
import {
  meetingCode,
  meetingId,
  normalizedMeetingTitle,
  participantId,
} from '../src/shared/meetingIdentity';

describe('meetingId', () => {
  it('prefers the meeting code from the URL over the title', () => {
    const id = meetingId('meet', 'https://meet.google.com/abc-defg-hij?authuser=0', '(2) Meet - whatever');
    expect(id).toBe('meet::abc-defg-hij');
  });

  it('pulls the Meet code from the title when the URL lacks it (UIA hides the omnibox)', () => {
    // The "(2) " unread prefix and " - Google Chrome" suffix must not churn the id.
    const a = meetingId('meet', undefined, '(2) Meet - abc-defg-hij - Google Chrome');
    const b = meetingId('meet', undefined, 'Meet - abc-defg-hij');
    expect(a).toBe('meet::abc-defg-hij');
    expect(b).toBe('meet::abc-defg-hij');
    expect(a).toBe(b);
  });

  it('maps a native Zoom window and its PIP to one constant id', () => {
    expect(meetingId('zoom', undefined, 'Zoom Meeting')).toBe('zoom::meeting');
    expect(meetingId('zoom', undefined, 'Zoom Meeting  40-minutes')).toBe('zoom::meeting');
    expect(meetingId('zoom', undefined, '')).toBe('zoom::meeting'); // collapsed PIP
  });

  it('keeps two distinct Teams meetings apart when falling back to the title', () => {
    const a = meetingId('teams', undefined, 'Standup | Microsoft Teams');
    const b = meetingId('teams', undefined, 'Retro | Microsoft Teams');
    expect(a).not.toBe(b);
    expect(a).toBe('teams::Standup');
  });
});

describe('meetingCode', () => {
  it('extracts codes per platform', () => {
    expect(meetingCode('zoom', 'https://app.zoom.us/wc/89012345678/join')).toBe('89012345678');
    expect(meetingCode('zoom', 'https://us02web.zoom.us/j/1234567890?pwd=x')).toBe('1234567890');
    expect(meetingCode('teams', 'https://teams.microsoft.com/l/meetup-join/19:meeting_AbC/0')).toBe('19:meeting_abc');
    expect(meetingCode('meet', 'https://meet.google.com/xza-ddbx-ebn')).toBe('xza-ddbx-ebn');
    expect(meetingCode('meet', undefined)).toBeUndefined();
  });
});

describe('normalizedMeetingTitle', () => {
  it('strips unread prefix, browser suffix, and Zoom minute badge', () => {
    expect(normalizedMeetingTitle('(3) Weekly Sync - Google Chrome')).toBe('Weekly Sync');
    expect(normalizedMeetingTitle('Zoom Meeting  40-minutes')).toBe('Zoom Meeting');
    expect(normalizedMeetingTitle('Meeting compact view | Standup | Microsoft Teams')).toBe('Standup');
  });
});

describe('participantId', () => {
  it('maps trivial spelling variance to one stable id', () => {
    const a = participantId('m', "David's Iphone");
    const b = participantId('m', 'David’sIphone'); // curly apostrophe, no space
    expect(a).toBe('m::davidsiphone');
    expect(a).toBe(b);
  });

  it('namespaces by meeting so the same name in two meetings differs', () => {
    expect(participantId('m1', 'Alice')).not.toBe(participantId('m2', 'Alice'));
  });
});
