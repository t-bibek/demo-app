namespace MeetingSpeakerEngine
{
    public static partial class Engine
    {

        // ---------------------------------------------------------------
        // Zoom: roster parsing + alert-bubble speaker capture.
        // ---------------------------------------------------------------

        // Battle-tested participant row format (apresence/ZoomMeetingBotSDK):
        // "<Name>,(<roles>), [Screen sharing, ]<audio state>,<video state>[,extras]"
        static readonly Regex ZoomRosterRow = new Regex(
            "^(.*?),(?:\\(((?:Host|Co\\-host|Me)[^\\)]*)\\),|) (?:(Screen sharing), |)" +
            "(No Audio Connected|(?:Telephone|Computer audio) (?:un|)muted)," +
            "(No Video Connected|Video (?:on|off))(?:,(.*)|)$");

        static readonly Regex ZoomSectionHeader = new Regex(
            "^(In the Meeting|Waiting Room|Not Joined) \\(\\d+\\), (expanded|collapsed)$");

        public static List<string> ParseZoomRoster(List<UiNode> nodes)
        {
            List<string> participants = new List<string>();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.ControlType != "ListItem" || n.Name.Length == 0) continue;
                if (ZoomSectionHeader.IsMatch(n.Name)) continue;
                Match m = ZoomRosterRow.Match(n.Name);
                if (!m.Success) continue;
                string name = CleanName(m.Groups[1].Value);
                if (name.Length > 0 && !participants.Contains(name)) participants.Add(name);
            }
            return participants;
        }

        // ---------------------------------------------------------------
        // Zoom desktop video tiles. Verified against a live Zoom 7.x dump:
        //   "Bidheyak Thapa(Host, me), Computer audio unmuted,Video off, Active speaker"
        //   "Video content Sabitri, Computer audio unmuted,Video off"
        // The ", Active speaker" suffix marks the current speaker — readable
        // through UIA even with the window in the background.
        // ---------------------------------------------------------------

        public class ZoomTile
        {
            public string Name = "";
            public bool ActiveSpeaker;
            public bool Unmuted;
            public bool IsSelf;   // the local user's tile ("(me)" / "(Host, me)")
        }

        static readonly Regex ZoomTilePattern = new Regex(
            "^(?:Video content )?(.+?)\\s*(\\((?:Host|Co\\-host|Me|Guest)[^\\)]*\\))?," +
            "\\s*(No Audio Connected|(?:Computer audio|Telephone) (?:un)?muted)\\s*," +
            "\\s*(Video (?:on|off)|No Video Connected)(.*)$");

        static readonly Regex ZoomSelfMarker = new Regex("\\bme\\b", RegexOptions.IgnoreCase);

        public static List<ZoomTile> ParseZoomVideoTiles(List<UiNode> nodes)
        {
            List<ZoomTile> tiles = new List<ZoomTile>();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.Name.Length == 0 || n.Name.Length > 200) continue;
                if (n.ControlType == "ListItem") continue; // roster rows have their own parser
                Match m = ZoomTilePattern.Match(n.Name);
                if (!m.Success) continue;
                ZoomTile tile = new ZoomTile();
                tile.Name = CleanName(m.Groups[1].Value);
                if (tile.Name.Length == 0) continue;
                tile.IsSelf = m.Groups[2].Value.Length > 0 && ZoomSelfMarker.IsMatch(m.Groups[2].Value);
                tile.Unmuted = m.Groups[3].Value.EndsWith("unmuted", StringComparison.OrdinalIgnoreCase);
                tile.ActiveSpeaker = m.Groups[5].Value.IndexOf(
                    "Active speaker", StringComparison.OrdinalIgnoreCase) >= 0;
                bool exists = false;
                for (int t = 0; t < tiles.Count; t++)
                    if (tiles[t].Name == tile.Name)
                    {
                        exists = true;
                        if (tile.ActiveSpeaker) tiles[t].ActiveSpeaker = true;
                        if (tile.IsSelf) tiles[t].IsSelf = true;
                        break;
                    }
                if (!exists) tiles.Add(tile);
            }
            return tiles;
        }

        // Zoom WEB client (app.zoom.us/wc). Verified from a live dump — the
        // tree is much thinner than the desktop client:
        //   - participant video-tile name: node class "video-avatar__avatar-img"
        //     (and the roster pane class "participants-item__display-name").
        //   - local mute: a button named "unmute my microphone" exists while
        //     you are muted ("mute my microphone" while live).
        //   - participant count: the participants button name ends
        //     "...,N particpants" (Zoom's own spelling).
        // There is no per-tile "Active speaker" badge like the desktop client,
        // so speaker naming on web relies on audio gating + the roster.
        public class ZoomWeb
        {
            public List<string> Names = new List<string>();
            public bool InMeeting;
            public bool SelfMuted;
            public int Count = -1;
            // Active speaker read from the speaker-bar tile whose class carries the
            // "speaker-bar-container__video-frame--active" modifier (Zoom's own VAD;
            // idle tiles keep the base "...__video-frame" class). Empty on silence.
            public string ActiveSpeaker = "";
        }

        static readonly Regex ZoomWebCount = new Regex("([0-9]+)\\s*partic[ip]*ants?", RegexOptions.IgnoreCase);
        static readonly Regex ZoomHostFromTitle = new Regex("^(.+?)'s Zoom (Meeting|Webinar)", RegexOptions.IgnoreCase);

        /// Host display name from a Zoom title like "Alice's Zoom Meeting".
        public static string ZoomHostName(string title)
        {
            if (title == null) return "";
            Match m = ZoomHostFromTitle.Match(title);
            return m.Success ? CleanName(m.Groups[1].Value) : "";
        }

        public static ZoomWeb ParseZoomWeb(List<UiNode> nodes)
        {
            ZoomWeb z = new ZoomWeb();
            // Participant names live in the video-tile region (after the footer
            // controls). Some tiles carry the class "video-avatar__avatar-img";
            // others (camera on) expose the name only as a plain Text leaf, so
            // we also collect person-like Text once past the footer — but NOT
            // before it, where header tabs ("Home", "Meetings"...) would slip in.
            bool inTiles = false;
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];

                // Active speaker: the speaker-bar tile whose class carries the
                // "--active" modifier is whoever is talking (Zoom's own VAD); idle
                // tiles keep the base "speaker-bar-container__video-frame" class.
                // The nodes are a pre-order flatten, so the tile's name node follows
                // the frame. Anchor extraction on the title structure
                // (video-avatar__avatar-title / __avatar-img, the <img alt>) ONLY, so
                // stray text in the tile never yields a false-positive speaker.
                if (n.ClassName.IndexOf("speaker-bar-container__video-frame--active", StringComparison.Ordinal) >= 0)
                {
                    z.InMeeting = true;
                    for (int k = i + 1; k < nodes.Count && k <= i + 16; k++)
                    {
                        UiNode c = nodes[k];
                        // Reached the next tile's frame -> left this tile's subtree.
                        if (c.ClassName.IndexOf("speaker-bar-container__video-frame", StringComparison.Ordinal) >= 0)
                            break;
                        // Name source: the avatar-img alt (camera OFF) or the footer
                        // label (camera ON) — a Text leaf inside video-avatar__avatar-
                        // footer that is always present. Anchored to the tile structure
                        // so stray text never yields a false-positive speaker.
                        bool nameNode =
                            c.ClassName.IndexOf("video-avatar__avatar-img", StringComparison.Ordinal) >= 0 ||
                            c.ClassName.IndexOf("video-avatar__avatar-title", StringComparison.Ordinal) >= 0 ||
                            c.ClassName.IndexOf("video-avatar__avatar-footer", StringComparison.Ordinal) >= 0 ||
                            c.ControlType == "Text";
                        if (!nameNode) continue;
                        string sp = CleanName(c.Name);
                        if (sp.Length > 0 && IsLikelyPersonName(sp)) { z.ActiveSpeaker = sp; break; }
                    }
                    continue;
                }

                if (n.ControlType == "Button")
                {
                    string b = n.Name;
                    if (b.Equals("unmute my microphone", StringComparison.OrdinalIgnoreCase))
                    {
                        z.SelfMuted = true; z.InMeeting = true; inTiles = true;
                    }
                    else if (b.Equals("mute my microphone", StringComparison.OrdinalIgnoreCase))
                    {
                        z.InMeeting = true; inTiles = true;
                    }
                    else if (b.IndexOf("manage participants list", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        z.InMeeting = true; inTiles = true;
                        Match m = ZoomWebCount.Match(b);
                        if (m.Success)
                        {
                            int c;
                            if (int.TryParse(m.Groups[1].Value, out c)) z.Count = c;
                        }
                    }
                    else if (b.Equals("open the chat panel", StringComparison.OrdinalIgnoreCase) ||
                             b.Equals("leave", StringComparison.OrdinalIgnoreCase) ||
                             b.Equals("end", StringComparison.OrdinalIgnoreCase))
                    {
                        z.InMeeting = true; inTiles = true;
                    }
                    continue;
                }

                bool classNamed =
                    n.ClassName.IndexOf("video-avatar__avatar-img", StringComparison.Ordinal) >= 0 ||
                    n.ClassName.IndexOf("video-avatar__avatar-name", StringComparison.Ordinal) >= 0 ||
                    n.ClassName.IndexOf("participants-item__display-name", StringComparison.Ordinal) >= 0;
                bool tileText = inTiles && n.ControlType == "Text";
                if (!classNamed && !tileText) continue;

                string nm = CleanName(n.Name);
                if (nm.Length > 0 && IsLikelyPersonName(nm) && !z.Names.Contains(nm)) z.Names.Add(nm);
            }
            return z;
        }

        // Alert texts Zoom pushes through zBubbleBaseClass that are NOT the
        // active speaker (patterns from NVDA's zoom-enhancements add-on).
        static readonly Regex[] ZoomAlertPatterns = new Regex[] {
            new Regex(" (has|have) (joined|left) the meeting"),
            new Regex(" (has|have) (entered|left) the Waiting Room"),
            new Regex("^The host (muted|unmuted) you"),
            new Regex("^Host has stopped your video"),
            new Regex(" has (started|stopped) (screen )?shar(e|ing)"),
            new Regex("^From .+ to .+:"),
            new Regex(" (raised|lowered) (their )?hand"),
            new Regex("^(You are|Your) "),
            new Regex("(is being recorded|recording (in progress|of this meeting)|(started|stopped|paused|resumed) recording)",
                RegexOptions.IgnoreCase),
            new Regex("^Meeting is "),
            new Regex("^Live (transcription|streaming)", RegexOptions.IgnoreCase),
            new Regex(" (enabled|disabled|started|stopped|ended)\\.?$", RegexOptions.IgnoreCase),
        };

        /// Pull the active speaker name out of Zoom alert-bubble text, or null.
        public static string ZoomBubbleSpeaker(string bubbleText)
        {
            if (bubbleText == null) return null;
            string s = bubbleText.Trim();
            if (s.Length == 0) return null;
            for (int i = 0; i < ZoomAlertPatterns.Length; i++)
                if (ZoomAlertPatterns[i].IsMatch(s)) return null;
            // Possible "Speaking: X" / "Active speaker: X" phrasing.
            Match m = Regex.Match(s, "^(?:Active speaker|Speaking)\\s*:?\\s*(.+)$", RegexOptions.IgnoreCase);
            if (m.Success) s = m.Groups[1].Value.Trim();
            if (!IsLikelyPersonName(s)) return null;
            string cleaned = CleanName(s);
            return cleaned.Length > 0 ? cleaned : null;
        }

        /// True only when the foreground window IS one of the detected Zoom
        /// MEETING windows (hwnd match, not just same process — Ctrl+2 must not
        /// land in Zoom chat/settings windows).
        static bool IsZoomMeetingForeground(List<MeetingWindow> meetings)
        {
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return false;
                int fgHwnd = fg.ToInt32();
                foreach (MeetingWindow w in meetings)
                    if (w.Platform == "zoom" && w.Hwnd == fgHwnd) return true;
            }
            catch (Exception) { }
            return false;
        }

        /// Sends Ctrl+2; skipped while the user physically holds a modifier key
        /// (a held Shift would turn the probe into Ctrl+Shift+2 — a different
        /// Zoom shortcut — and a held Alt/Win into arbitrary chords).
        static bool SendCtrl2()
        {
            if ((GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0) return false;
            if ((GetAsyncKeyState(VK_MENU) & 0x8000) != 0) return false;
            if ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0) return false;
            if ((GetAsyncKeyState(VK_RWIN) & 0x8000) != 0) return false;
            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(VK_2, 0, 0, UIntPtr.Zero);
            keybd_event(VK_2, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            return true;
        }
    }
}
