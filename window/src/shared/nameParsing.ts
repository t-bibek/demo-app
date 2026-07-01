/**
 * Participant-name hygiene shared by the meeting layer. Ported from the macOS
 * port's `NameParsing.swift` (which itself distilled the engine's C# CleanName /
 * IsLikelyPersonName heuristics). Kept in `shared/` so the meeting-identity and
 * roster code can reuse the exact same rules the engine applies.
 */

/**
 * Decorations meeting platforms append to a participant's accessible name, e.g.
 *   Zoom tile:  "Bidheyak Thapa, Computer audio unmuted, active speaker"
 *   Google Meet: "Jane Doe's video"
 */
const NAME_CUT_SEPARATORS = [
  ', computer audio', // Zoom video tiles
  ', audio',
  ', active speaker',
  ', speaking',
  ' is speaking',
  "'s video",
  '’s video', // Google Meet tiles (curly apostrophe)
  ', muted',
  ', unmuted',
  ', video on',
  ', video off',
  ', video is on',
  ', video is off',
  ', video is', // Teams roster status
  ', more options',
  ', pinned',
  ', context menu', // Teams: "<Name> (Guest), Context menu is available"
];

/**
 * Extracts a clean participant name from a raw accessibility string, or null if
 * the string isn't a plausible person name.
 */
export function cleanParticipantName(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // "View <Name>'s profile" / "View <Name>'s profile" -> <Name>
  for (const apostrophe of ["'s profile", '’s profile']) {
    const lo = s.toLowerCase().indexOf('view ');
    const hi = s.toLowerCase().indexOf(apostrophe.toLowerCase());
    if (lo >= 0 && hi >= 0 && lo + 'view '.length < hi) {
      s = s.slice(lo + 'view '.length, hi);
      break;
    }
  }

  // Teams self tile: "Myself video, <Name>, unmuted, ..." -> drop the prefix.
  for (const prefix of ['myself video, ', 'my video, ']) {
    if (s.toLowerCase().startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }

  // Cut at the earliest decoration clause.
  let cut = s.length;
  const lower = s.toLowerCase();
  for (const sep of NAME_CUT_SEPARATORS) {
    const i = lower.indexOf(sep.toLowerCase());
    if (i >= 0 && i < cut) cut = i;
  }
  s = s.slice(0, cut);

  // Strip a trailing role/status parenthetical: "David Thapa (Guest)" -> "David
  // Thapa", "(You)" -> "" (then rejected). Mirrors the Zoom roster strip.
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  s = s.replace(/^[\s,’']+|[\s,’']+$/g, '');

  return isLikelyPersonName(s) ? s : null;
}

/** True when `text` carries a "this tile/participant is speaking" marker. */
export function isSpeakingMarker(text: string): boolean {
  const l = text.toLowerCase();
  return (
    l.includes('active speaker') ||
    l.includes('is speaking') ||
    l.includes(', speaking') ||
    l.includes('speaking,') ||
    l.includes('voice level') ||
    l.includes('is talking')
  );
}

const REJECT_EXACT = new Set<string>([
  'mute', 'unmute', 'camera', 'share', 'chat', 'participants', 'leave',
  'join', 'settings', 'more', 'reactions', 'raise', 'stop', 'start',
  'video', 'audio', 'view', 'present', 'record', 'menu', 'close',
  'minimize', 'search', 'send', 'someone', 'you', 'host', 'co-host',
  // Zoom web toolbar labels that leak in as fake tiles:
  'react', 'switch', 'avatar', 'end', 'home', 'apps', 'notes', 'whiteboard',
  // Google Meet panel / chrome labels that leak in as fake tiles:
  'people', 'contributors', 'in call',
  // Teams meeting-stage chrome that leaks in as fake tiles:
  'cancel', 'nobody',
  // Browser/PWA chrome + call-control buttons that leak as fake people:
  'reload', 'back', 'forward', 'refresh', 'extensions', 'extension',
  'lock', 'bookmark', 'bookmarks', 'downloads', 'history', 'profile',
]);

// Window chrome / browser / URL fragments + meeting CONTROL labels that are never
// a person's name (toolbar buttons leak in as 2-word labels).
const REJECT_SUBSTRINGS = [
  'meeting', 'zoom', 'teams', 'google', 'chrome', 'safari', 'edge',
  'http', '://', 'search bar', 'address', 'microphone', 'webcam',
  'joined', 'left the',
  'share screen', 'screen share', 'sharing', 'present', 'everyone',
  'view all', 'add people', 'host control', 'call control', 'more option',
  'activities', 'settings', 'captions', 'reaction',
  'turn on', 'turn off', 'leave call', 'leave now', 'leave meeting',
  'raise hand', 'lower hand', 'more options', 'show everyone',
  'turn camera', 'camera on', 'camera off', 'raise your', 'your hand',
  'calling control', 'join info', 'copy join', 'learn more', 'passcode',
  'meeting compact', 'meeting options', 'people invited', 'waiting in',
  'resize', 'gallery', 'top gallery', 'pin ', 'spotlight', 'reframe',
  'incognito', 'new tab', 'this tab', 'site information', 'cookies',
  'pretty-print', 'bookmark', 'address bar', 'missing authentication',
  'background', 'replaced', 'no longer', 'presenting', 'pinned',
  'is now on', 'is now off', 'recording', 'transcription',
  'companion', 'my video', 'you are', 'permission', 'ellipsis', 'panel',
  'options', 'upgrade to', 'my notes', 'my audio', 'stop video', 'start video',
  'share content', 'shared content', 'content view', 'mute mic', 'unmute mic',
  'encryption status', 'calling indicator', 'turn audio on', 'elapsed time',
];

const STOPWORD_TOKENS = new Set<string>([
  'and', 'for', 'with', 'the', 'you', "you're", '’you’re',
  "can't", 'can’t', 'someone', 'else', 'people', 'contributors',
  'notifications', 'feature', 'search', 'continuously', 'framed',
  'meet', 'unmute',
  'screen', 'fullscreen', 'picture', 'profile', 'others', 'anyway',
]);

const MEETING_CODE = /^[a-z]{3}-[a-z]{3,4}-[a-z]{3}$/;

/** Cheap heuristic to reject UI chrome / window titles / URLs. */
export function isLikelyPersonName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 50) return false;
  // Structural junk: real names never contain braces/brackets/quotes/markup,
  // pipes, bullets or dash separators — rejects JSON blobs and toast rows.
  if (/[{}[\]<>"=|•·–—:]/.test(t)) return false;
  // Display names don't contain digits — rejects "55 seconds left", "2 others".
  if (/\d/.test(t)) return false;
  // A display name is at most a few words; long runs are sentences / toasts.
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  // Reject ALL-CAPS tokens of 3+ letters (USD, FAQ, VOIP...): labels, not names.
  for (const w of words) {
    const letters = (w.match(/\p{L}/gu) ?? []).join('');
    if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
      return false;
    }
  }
  const lower = t.toLowerCase();

  if (REJECT_EXACT.has(lower)) return false;
  if (REJECT_SUBSTRINGS.some((sub) => lower.includes(sub))) return false;

  for (const tok of lower.split(/[\s,()]+/).filter(Boolean)) {
    if (STOPWORD_TOKENS.has(tok)) return false;
    if (MEETING_CODE.test(tok)) return false;
  }

  // Notifications/toasts (sentences), clock times, and meeting codes aren't names.
  if (t.endsWith('.')) return false;
  if (lower === 'pm' || lower === 'am') return false;
  if (MEETING_CODE.test(t)) return false;
  if (/^\d{1,2}:\d{2}/.test(t)) return false;

  return /\p{L}/u.test(t);
}
