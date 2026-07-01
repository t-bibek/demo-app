import { Platform } from './types';
import { cleanParticipantName } from './nameParsing';

/**
 * Stable meeting + participant identity. Ported from the macOS port's
 * `MeetingIdentity.swift`.
 *
 * The raw window title is unsafe as a key: Google Meet prepends a `"(2) "`
 * unread-count prefix that flips mid-call, PWAs often have an empty title, and
 * the browser suffix changes without the meeting changing. So we key on the
 * meeting CODE parsed from the URL/title when present and fall back to a
 * normalized title otherwise.
 */

/** Derives a STABLE meeting id from a window's URL (preferred) or title. */
export function meetingId(platform: Platform, url: string | undefined, title: string): string {
  const code = meetingCode(platform, url);
  if (code) return `${platform}::${code}`;

  // The URL usually lacks the code on Windows (Chromium hides the omnibox from
  // UIA). For Meet the code is ALSO in the title ("Meet - kkr-ytwy-yzg - ..."),
  // so pull it from there rather than keying on the volatile full title.
  if (platform === 'meet') {
    const m = title.toLowerCase().match(/[a-z]{3}-[a-z]{3,4}-[a-z]{3}/);
    if (m) return `meet::${m[0]}`;
  }
  // Native Zoom (no URL): the "Zoom Meeting" window AND its Picture-in-Picture
  // thumbnail are the SAME call — key on a constant so they don't spawn a second
  // meeting or churn the id (you're in one native Zoom call at a time).
  if (platform === 'zoom' && !url) {
    return 'zoom::meeting';
  }
  return `${platform}::${normalizedMeetingTitle(title)}`;
}

/**
 * Deterministic per-participant id. The engine exposes no real per-user id, so
 * identity is the normalized display name namespaced by the meeting. A genuine
 * rename therefore reads as leave+join — documented, and the best UIA allows.
 */
export function participantId(meetingId: string, name: string): string {
  const clean = cleanParticipantName(name) ?? name.trim();
  // Reduce to lowercased alphanumerics so trivial spelling variance across scans
  // (curly vs straight apostrophe, spacing — "David's Iphone" vs "David'sIphone")
  // maps to ONE stable id; otherwise the same person churns leave/join.
  const key = clean.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return `${meetingId}::${key || clean.toLowerCase()}`;
}

/**
 * Extracts the platform's meeting code from a page URL, e.g.
 *   `meet.google.com/xza-ddbx-ebn`    -> `"xza-ddbx-ebn"`
 *   `app.zoom.us/wc/89012345678/join` -> `"89012345678"`
 *   `.../l/meetup-join/19:meeting_AbC` -> `"19:meeting_AbC"`
 * Returns undefined when no code is present (caller falls back to the title).
 */
export function meetingCode(platform: Platform, url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.toLowerCase();
  switch (platform) {
    case 'meet': {
      const m = u.match(/[a-z]{3}-[a-z]{3,4}-[a-z]{3}/);
      return m ? m[0] : undefined;
    }
    case 'zoom': {
      const m = u.match(/\/(?:j|wc)\/(\d+)/);
      return m ? m[1] : undefined;
    }
    case 'teams': {
      const m = u.match(/meetup-join\/[^/?#]+/);
      return m ? m[0].replace('meetup-join/', '') : undefined;
    }
  }
}

/**
 * Strips the volatile chrome from a window title so two reads of the SAME call
 * produce the same key: the leading `"(2) "` unread-count prefix, the recording
 * clause, and the trailing browser-name segment.
 */
export function normalizedMeetingTitle(title: string): string {
  let s = title.replace(/^\(\d+\)\s*/, '');
  // Teams' compact/PIP window prepends "Meeting compact view | " to the same call
  // title — strip it so the compact and main windows are ONE meeting.
  s = s.replace(/^Meeting compact view\s*\|\s*/i, '');
  s = cutAtFirst(s, [
    ' - Camera and microphone recording',
    ' - Microphone recording',
    ' - Camera recording',
    ' - Google Chrome',
    ' - Chrome',
    ' - Microsoft Edge',
    ' - Microsoft Edge',
    ' - Brave',
    ' - Vivaldi',
    ' - Opera',
    ' - Safari',
    ' - Mozilla Firefox',
    ' - Firefox',
    ' | Microsoft Teams', // Teams window-title suffix
  ]);
  // Zoom's native title gains a free-tier "NN-minutes" suffix near the 40-min
  // limit ("Zoom Meeting  40-minutes"). Strip it and collapse whitespace so it
  // maps to the same id as "Zoom Meeting" instead of churning the meeting.
  s = s.replace(/\s+\d+[\s-]min(?:ute)?s?\b.*$/i, '');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Truncates `s` at the earliest case-insensitive occurrence of any marker. */
function cutAtFirst(s: string, markers: string[]): string {
  let cut = s.length;
  const lower = s.toLowerCase();
  for (const m of markers) {
    const i = lower.indexOf(m.toLowerCase());
    if (i >= 0 && i < cut) cut = i;
  }
  return s.slice(0, cut);
}
