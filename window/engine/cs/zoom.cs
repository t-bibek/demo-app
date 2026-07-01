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
                // tiles keep the base "speaker-bar-container__video-frame" class. The
                // name leaf follows the frame in the pre-order flatten — read it with
                // the shared ZoomWebTileName scan so this inline path and the raw-scan
                // ExtractZoomWebActiveSpeaker stay identical.
                if (n.ClassName.IndexOf("speaker-bar-container__video-frame--active", StringComparison.Ordinal) >= 0)
                {
                    z.InMeeting = true;
                    if (z.ActiveSpeaker.Length == 0)
                        z.ActiveSpeaker = ZoomWebTileName(nodes, i, "speaker-bar-container__video-frame");
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

        // The display name inside a Zoom-web video tile, read off the pre-order
        // flatten: scan forward from the tile's frame node until the next sibling
        // frame (boundaryToken) or a short look-ahead, and return the first
        // person-like leaf. The name is the avatar-img alt (camera OFF) or the
        // footer Text leaf (camera ON, always present). Anchored to the tile
        // structure so stray text never yields a false-positive speaker.
        static string ZoomWebTileName(List<UiNode> nodes, int frameIndex, string boundaryToken)
        {
            for (int k = frameIndex + 1; k < nodes.Count && k <= frameIndex + 16; k++)
            {
                UiNode c = nodes[k];
                // Reached the next tile's frame -> left this tile's subtree.
                if (c.ClassName.IndexOf(boundaryToken, StringComparison.Ordinal) >= 0) break;
                bool nameNode =
                    c.ClassName.IndexOf("video-avatar__avatar-img", StringComparison.Ordinal) >= 0 ||
                    c.ClassName.IndexOf("video-avatar__avatar-title", StringComparison.Ordinal) >= 0 ||
                    c.ClassName.IndexOf("video-avatar__avatar-footer", StringComparison.Ordinal) >= 0 ||
                    c.ControlType == "Text";
                if (!nameNode) continue;
                string sp = CleanName(c.Name);
                if (sp.Length > 0 && IsLikelyPersonName(sp)) return sp;
            }
            return "";
        }

        /// Active speaker on Zoom WEB, from the speaker-bar tile carrying the
        /// "--active" modifier (Zoom's own VAD); falls back to the big
        /// "speaker-active-container__video-frame" spotlight when the filmstrip has
        /// no active tile. Both classes exist ONLY in Chromium's RAW UIA view — the
        /// control view the main scan uses PRUNES them (verified: they vanish from a
        /// non-deep dump), which is why a talking remote used to collapse to
        /// "Someone". The live engine therefore reads them with a dedicated raw scan.
        /// Mirrors macOS ZoomWebProbe (active ?? big). Returns "" when nobody's tile
        /// is highlighted.
        public static string ExtractZoomWebActiveSpeaker(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
                if (nodes[i].ClassName.IndexOf(
                        "speaker-bar-container__video-frame--active", StringComparison.Ordinal) >= 0)
                {
                    string sp = ZoomWebTileName(nodes, i, "speaker-bar-container__video-frame");
                    if (sp.Length > 0) return sp;
                }
            for (int i = 0; i < nodes.Count; i++)
                if (nodes[i].ClassName.IndexOf(
                        "speaker-active-container__video-frame", StringComparison.Ordinal) >= 0)
                {
                    string sp = ZoomWebTileName(nodes, i, "speaker-active-container__video-frame");
                    if (sp.Length > 0) return sp;
                }
            return "";
        }

        // ---------------------------------------------------------------
        // Zoom Picture-in-Picture (the floating thumbnail you get when the
        // meeting is minimised). This is a SEPARATE top-level window whose main
        // window's title-based classifier misses (its title is empty when
        // collapsed, "Zoom" when expanded), so speaker tracking used to stop the
        // moment you minimised to PIP.
        //
        // Like macOS (zoomPipContent), Zoom names the active speaker in the PIP
        // itself with a "Talking: <name>" label — Zoom's OWN VAD. That is a
        // DIRECT active-speaker read (no audio gating needed), and reading it
        // also keeps the call alive while you are minimised to the thumbnail.
        // ---------------------------------------------------------------

        public class ZoomPip
        {
            public string Speaker = "";               // from "Talking: <name>"
            public List<string> Names = new List<string>();
        }

        // "Talking: Alice Smith" (Zoom's PIP active-speaker label). Tolerates a
        // leading glyph/space and an optional trailing state clause.
        static readonly Regex ZoomTalkingPattern = new Regex(
            "talking:\\s*(.+?)\\s*$", RegexOptions.IgnoreCase);

        /// Parse a Zoom PIP/floating-thumbnail window's nodes: the active speaker
        /// from its "Talking: <name>" label plus any participant-name labels.
        /// Speaker is "" when nobody is talking. Mirrors macOS zoomPipContent.
        public static ZoomPip ParseZoomPip(List<UiNode> nodes)
        {
            ZoomPip pip = new ZoomPip();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.Name.Length == 0 || n.Name.Length > 200) continue;
                Match m = ZoomTalkingPattern.Match(n.Name);
                if (m.Success)
                {
                    string sp = CleanName(m.Groups[1].Value);
                    if (sp.Length > 0 && IsLikelyPersonName(sp)) pip.Speaker = sp;
                    continue;
                }
                // A tile in the PIP can also carry the same ", Active speaker"
                // suffix as the main grid — accept that as the speaker too.
                Match t = ZoomTilePattern.Match(n.Name);
                if (t.Success && t.Groups[5].Value.IndexOf(
                        "Active speaker", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    string sp = CleanName(t.Groups[1].Value);
                    if (sp.Length > 0 && pip.Speaker.Length == 0) pip.Speaker = sp;
                }
            }
            // Person-like labels = the PIP's (tiny) roster; best-effort.
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.ControlType != "Text" && n.ControlType != "Pane") continue;
                if (ZoomTalkingPattern.IsMatch(n.Name)) continue;
                string nm = CleanName(n.Name);
                if (nm.Length > 0 && IsLikelyPersonName(nm) && !pip.Names.Contains(nm)) pip.Names.Add(nm);
            }
            if (pip.Speaker.Length > 0 && !pip.Names.Contains(pip.Speaker)) pip.Names.Insert(0, pip.Speaker);
            return pip;
        }

        /// Content test: does this window's nodes look like the Zoom PIP/floating
        /// thumbnail? Keys on Zoom's OWN markers ("Talking:", "video render",
        /// "Show video"), not a title/class, mirroring macOS zoomIsPipWindow —
        /// so it survives Zoom version changes that rename the window class.
        public static bool LooksLikeZoomPip(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                string s = nodes[i].Name;
                if (s.Length == 0) continue;
                string low = s.ToLowerInvariant();
                if (low.IndexOf("talking:", StringComparison.Ordinal) >= 0) return true;
                if (low.IndexOf("video render", StringComparison.Ordinal) >= 0) return true;
                if (low.IndexOf("show video", StringComparison.Ordinal) >= 0) return true;
            }
            return false;
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

        // ---------------------------------------------------------------
        // Zoom active-speaker PROBE — the Windows analog of the macOS
        // ZoomProbe command. Samples every Zoom meeting window ~4x/second for
        // N seconds and prints, per tick, WHO is the active speaker:
        //
        //   • badge  = the raw ", Active speaker" UIA marker on the video tile
        //              (native Zoom exposes name + mute + this suffix on each
        //              tile's Name — verified in logs\uia-dump-*.ndjson). The
        //              badge LINGERS on the last speaker during silence.
        //   • gated  = the badge CONFIRMED by audio — the local mic-capture peak
        //              for the self tile, the app playback peak for a remote —
        //              which is exactly what the live engine (Detect) logs. This
        //              is what disambiguates the lingering badge from real speech.
        //
        // Also writes an NDJSON timeline to logs\ and prints a per-speaker
        // talk-window summary at the end, so you can line up "who spoke when"
        // against a narrated back-and-forth ("me 0-10s, Bibek 10-20s, silent…").
        //
        // The WEB client (app.zoom.us in a browser) has NO per-tile badge, so
        // there the probe falls back to roster + audio, same as the engine.
        // ---------------------------------------------------------------
        public static void ZoomWatch(int seconds, int maxNodes, float remoteThr, float micThr)
        {
            Directory.CreateDirectory("logs");
            string fileName = Path.Combine("logs", string.Format(
                "zoom-watch-{0:yyyyMMdd-HHmmss}.ndjson", DateTime.Now));

            Console.WriteLine("Zoom active-speaker probe - sampling ~4x/s for " + seconds + "s");
            Console.WriteLine("  gated  = badge confirmed by audio (mic=self, playback=remote) = what the engine logs");
            Console.WriteLine("  badge  = raw \", Active speaker\" UIA marker (lingers during silence)");
            Console.WriteLine("  roster mic:  [on]=unmuted  [off]=muted   * = holds the active-speaker badge");
            Console.WriteLine("  thresholds: remote(playback) > " + remoteThr + "   mic(capture) > " + micThr);
            Console.WriteLine("  timeline -> " + fileName);

            // One-shot inventory so it is obvious whether we are looking at the
            // NATIVE desktop client or the WEB client (very different trees).
            TopWindows inv = FindTopWindows();
            int zoomWins = 0;
            foreach (MeetingWindow w in inv.Meetings)
            {
                if (w.Platform != "zoom") continue;
                zoomWins++;
                Console.WriteLine(string.Format("  window: '{0}'  {1}  proc={2}",
                    w.Title, w.IsBrowser ? "WEB (browser, no per-tile badge)" : "NATIVE", w.ProcName));
            }
            if (zoomWins == 0)
                Console.WriteLine("  (no Zoom meeting window found yet — JOIN a meeting; the probe keeps polling)");
            Console.WriteLine("");

            // Per-name talk windows (on the audio-gated verdict), for the summary.
            Dictionary<string, List<double>> onset = new Dictionary<string, List<double>>();
            Dictionary<string, List<double>> offset = new Dictionary<string, List<double>>();
            HashSet<string> speakingPrev = new HashSet<string>();

            long startT = NowMs();
            long endT = startT + (long)seconds * 1000;
            int tick = 0;
            using (StreamWriter sw = new StreamWriter(fileName, false, new UTF8Encoding(false)))
            {
                while (NowMs() < endT)
                {
                    tick++;
                    long ts = NowMs();
                    double elapsed = (ts - startT) / 1000.0;
                    HashSet<string> tickSpeaking = new HashSet<string>();
                    try
                    {
                        TopWindows tops = FindTopWindows();
                        SampleAudio();
                        // Same hangover the engine uses, so "gated" here matches
                        // what Run would actually log (bridges word gaps).
                        Bump(RenderActiveUntil, RenderPeaks, remoteThr, ts);
                        Bump(CaptureActiveUntil, CapturePeaks, micThr, ts);

                        bool sawZoom = false;
                        foreach (MeetingWindow w in tops.Meetings)
                        {
                            if (w.Platform != "zoom") continue;
                            sawZoom = true;
                            if (w.IsBrowser) PokeChromiumAccessibility(new IntPtr(w.Hwnd));
                            List<UiNode> nodes;
                            try { nodes = ScanMeetingWindow(w, maxNodes); }
                            catch (Exception) { continue; }

                            bool remoteActive = ActiveWithin(RenderActiveUntil, w.ProcName, ts);
                            bool selfActive = ActiveWithin(CaptureActiveUntil, w.ProcName, ts);
                            float rp = GetRenderPeak(w.ProcName);
                            float cp = GetCapturePeak(w.ProcName);

                            List<ZoomTile> tiles = ParseZoomVideoTiles(nodes);
                            List<string> badge = new List<string>();
                            List<string> gated = new List<string>();
                            List<string> rosterParts = new List<string>();
                            for (int i = 0; i < tiles.Count; i++)
                            {
                                ZoomTile t = tiles[i];
                                string mic = t.Unmuted ? "[on]" : "[off]";
                                string me = t.IsSelf ? "(me)" : "";
                                string mark = t.ActiveSpeaker ? "*" : "";
                                rosterParts.Add(t.Name + me + mic + mark);
                                if (!t.ActiveSpeaker) continue;
                                if (!badge.Contains(t.Name)) badge.Add(t.Name);
                                bool ok = t.IsSelf ? selfActive : remoteActive;
                                if (ok && !gated.Contains(t.Name)) gated.Add(t.Name);
                            }

                            // WEB client: the active speaker is the speaker-bar
                            // "--active" tile, which lives ONLY in the RAW view (the
                            // control-view scan above prunes it) — read it the same way
                            // the engine now does. It acts as the badge (Zoom's VAD,
                            // lingers on silence); audio confirms it into "gated". Falls
                            // back to the single-remote / "Someone" audio-only verdict.
                            if (tiles.Count == 0)
                            {
                                ZoomWeb web = ParseZoomWeb(nodes);
                                for (int i = 0; i < web.Names.Count; i++) rosterParts.Add(web.Names[i]);
                                string webActive = "";
                                try
                                {
                                    AutomationElement zdoc = GetDocument(w);
                                    if (zdoc == null) zdoc = w.Element;
                                    webActive = ExtractZoomWebActiveSpeaker(ScanNodes(zdoc, maxNodes, true));
                                }
                                catch (Exception) { }
                                if (webActive.Length > 0) badge.Add(webActive);
                                if (remoteActive || selfActive)
                                {
                                    if (webActive.Length > 0) gated.Add(webActive);
                                    else if (web.Names.Count == 1) gated.Add(web.Names[0]);
                                    else gated.Add("Someone");
                                }
                            }

                            for (int i = 0; i < gated.Count; i++) tickSpeaking.Add(gated[i]);

                            string badgeStr = badge.Count > 0 ? string.Join(", ", badge.ToArray()) : "-";
                            string gatedStr = gated.Count > 0 ? string.Join(", ", gated.ToArray()) : "-";
                            string roster = rosterParts.Count > 0 ? string.Join("  ", rosterParts.ToArray()) : "(no tiles)";
                            Console.WriteLine(string.Format(
                                "t={0,6:0.0}s  gated: {1,-22} badge: {2,-22} render={3:0.000} mic={4:0.000}  | {5}",
                                elapsed, gatedStr, badgeStr, rp, cp, roster));

                            Dictionary<string, object> row = new Dictionary<string, object>();
                            row["type"] = "zoomwatch";
                            row["tick"] = tick;
                            row["t"] = Math.Round(elapsed, 2);
                            row["window"] = w.Title;
                            row["native"] = !w.IsBrowser;
                            row["badge"] = badge;
                            row["speaking"] = gated;
                            row["render"] = Math.Round(rp, 3);
                            row["mic"] = Math.Round(cp, 3);
                            List<Dictionary<string, object>> rr = new List<Dictionary<string, object>>();
                            for (int i = 0; i < tiles.Count; i++)
                            {
                                Dictionary<string, object> tr = new Dictionary<string, object>();
                                tr["name"] = tiles[i].Name;
                                tr["self"] = tiles[i].IsSelf;
                                tr["unmuted"] = tiles[i].Unmuted;
                                tr["badge"] = tiles[i].ActiveSpeaker;
                                rr.Add(tr);
                            }
                            row["roster"] = rr;
                            sw.WriteLine(Json.Serialize(row));
                        }

                        // PIP / floating thumbnail: Zoom's "Talking: <name>" VAD
                        // is a DIRECT active-speaker read (no audio gate needed).
                        foreach (AutomationElement pipWin in tops.ZoomPips)
                        {
                            sawZoom = true;
                            List<UiNode> pnodes;
                            try { pnodes = ScanNodes(pipWin, 800); }
                            catch (Exception) { continue; }
                            ZoomPip pip = ParseZoomPip(pnodes);
                            if (pip.Speaker.Length > 0) tickSpeaking.Add(pip.Speaker);
                            string sp = pip.Speaker.Length > 0 ? pip.Speaker : "-";
                            string names = pip.Names.Count > 0 ? string.Join(", ", pip.Names.ToArray()) : "(none)";
                            Console.WriteLine(string.Format(
                                "t={0,6:0.0}s  PIP  talking: {1,-22} names: {2}", elapsed, sp, names));

                            Dictionary<string, object> prow = new Dictionary<string, object>();
                            prow["type"] = "zoomwatch";
                            prow["tick"] = tick;
                            prow["t"] = Math.Round(elapsed, 2);
                            prow["window"] = "Zoom PIP";
                            prow["pip"] = true;
                            prow["speaking"] = pip.Speaker.Length > 0 ? new List<string> { pip.Speaker } : new List<string>();
                            prow["names"] = pip.Names;
                            sw.WriteLine(Json.Serialize(prow));
                        }

                        if (!sawZoom)
                            Console.WriteLine(string.Format("t={0,6:0.0}s  (no Zoom meeting window)", elapsed));
                    }
                    catch (Exception ex) { Console.WriteLine("  probe error: " + ex.Message); }

                    // Talk-window bookkeeping on the tick-aggregated gated set.
                    foreach (string nm in tickSpeaking)
                    {
                        if (!speakingPrev.Contains(nm))
                        {
                            if (!onset.ContainsKey(nm))
                            {
                                onset[nm] = new List<double>();
                                offset[nm] = new List<double>();
                            }
                            onset[nm].Add(elapsed);
                            offset[nm].Add(elapsed);
                        }
                        else
                        {
                            offset[nm][offset[nm].Count - 1] = elapsed;
                        }
                    }
                    speakingPrev = tickSpeaking;
                    Thread.Sleep(250);
                }
            }

            Console.WriteLine("");
            Console.WriteLine("==== talk windows (audio-gated active speaker) ====");
            if (onset.Count == 0)
            {
                Console.WriteLine("  (no audio-confirmed speaker seen — narrate a back-and-forth and keep the");
                Console.WriteLine("   meeting audible; a badge with no matching audio is the lingering-badge case)");
            }
            foreach (KeyValuePair<string, List<double>> kv in onset)
            {
                StringBuilder wins = new StringBuilder();
                for (int i = 0; i < kv.Value.Count; i++)
                {
                    if (i > 0) wins.Append(", ");
                    wins.AppendFormat("{0:0.0}-{1:0.0}s", kv.Value[i], offset[kv.Key][i]);
                }
                Console.WriteLine(string.Format("  {0,-24} {1}", kv.Key, wins.ToString()));
            }
            Console.WriteLine("timeline: " + fileName);
        }
    }
}
