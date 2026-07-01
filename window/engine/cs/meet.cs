namespace MeetingSpeakerEngine
{
    public static partial class Engine
    {

        // ---------------------------------------------------------------
        // Caption-based detection (Google Meet + Microsoft Teams).
        //
        // Caption rows surface in the accessibility tree as a speaker-name
        // text leaf followed by caption-text leaves. CSS classes of web
        // elements are exposed as UIA ClassName by Chromium's native UIA
        // provider (Chrome 138+/Edge/WebView2), so known class fragments are
        // used as primary anchors with structural patterns as fallback.
        // The current speaker = author of the newest caption block, pulsed
        // only when that block's text CHANGED since the previous poll (a
        // static caption means nobody is saying anything new).
        // ---------------------------------------------------------------

        /// Extract (speaker, text) caption blocks from a Meet document scan.
        public static List<string[]> ExtractMeetCaptionBlocks(List<UiNode> nodes)
        {
            List<string[]> blocks = new List<string[]>();

            // Locate the captions region: aria-label contains "Captions"
            // (exclude the "Turn on/off captions" buttons).
            int capIdx = -1;
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.ControlType == "Button") continue;
                if (n.Name.IndexOf("Captions", StringComparison.Ordinal) >= 0 &&
                    !n.Name.StartsWith("Turn", StringComparison.OrdinalIgnoreCase))
                {
                    capIdx = i;
                    break;
                }
            }
            if (capIdx < 0) return blocks;

            int end = Math.Min(nodes.Count, capIdx + 1 + 150);
            string speaker = null;
            StringBuilder text = new StringBuilder();
            for (int i = capIdx + 1; i < end; i++)
            {
                UiNode n = nodes[i];
                bool isNameNode =
                    // Known Meet caption-name classes (rotate with releases; from
                    // TranscripTonic / Recall.ai's open-source Meet bot).
                    (n.ClassName.IndexOf("KcIKyf", StringComparison.Ordinal) >= 0 ||
                     n.ClassName.IndexOf("NWpY1d", StringComparison.Ordinal) >= 0 ||
                     n.ClassName.IndexOf("xoMHSc", StringComparison.Ordinal) >= 0) ||
                    // Structural fallback: an avatar image starts a caption block;
                    // the next short text leaf is the speaker name.
                    (i > capIdx + 1 && nodes[i - 1].ControlType == "Image" &&
                     n.ControlType == "Text" && IsLikelyPersonName(n.Name));

                if (isNameNode && n.Name.Length > 0)
                {
                    if (speaker != null && text.Length > 0)
                        blocks.Add(new string[] { speaker, text.ToString() });
                    speaker = n.Name;
                    text = new StringBuilder();
                    continue;
                }

                if (speaker != null && n.ControlType == "Text" && n.Name.Length > 0)
                {
                    if (text.Length > 0) text.Append(' ');
                    text.Append(n.Name);
                }

                // Controls trailing the region end it — but the region can also
                // LEAD with controls (caption settings gear), so only stop once
                // at least one block has been seen.
                if ((n.ControlType == "Button" || n.ControlType == "ToolBar") &&
                    (blocks.Count > 0 || speaker != null))
                {
                    break;
                }
            }
            if (speaker != null && text.Length > 0)
                blocks.Add(new string[] { speaker, text.ToString() });
            return blocks;
        }

        // ---------------------------------------------------------------
        // Tile-class speaking indicators for Meet and Teams (no captions
        // needed). Chromium's UIA provider exposes the HTML class attribute
        // as the UIA ClassName, so the speaking-indicator CSS classes surface.
        //   Meet:  the SPEAKING tile gains "kssMZb" — the same single token the
        //          macOS engine uses (SpeakerCore/MeetSpeakerRules.builtin,
        //          verified against ground truth). Older Vexa tokens
        //          (Oaajhc/HX2H7/wEsLMd/OgVli) are kept as extra coverage but
        //          Google has rotated away from them. Names sit in "notranslate".
        //   Teams: the voice-level ring carries "vdi-frame-occlusion".
        // These are obfuscated and Google rotates them (~6 weeks). Keep this list
        // in sync with the macOS MeetSpeakerRules; refresh from a `-Watch` capture
        // against a narrated call when gallery-view detection goes quiet.
        // ---------------------------------------------------------------

        // "kssMZb" FIRST — the macOS-parity token (the durable gallery signal).
        // Built-in default; overridable at runtime from meet-rules.json so a class
        // rotation is a config drop, not a rebuild (see LoadMeetRules).
        static readonly string[] MeetSpeakingClassesBuiltin =
            new string[] { "kssMZb", "Oaajhc", "HX2H7", "wEsLMd", "OgVli" };
        static string[] MeetSpeakingClasses = MeetSpeakingClassesBuiltin;

        /// Path of the optional class-rotation override file — the Windows analog of
        /// the macOS meet-rules.json (Application Support/MeetSpeakerDetector). Lives
        /// beside the app's session log in %APPDATA%\meeting-speaker-logger.
        public static string MeetRulesPath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "meeting-speaker-logger", "meet-rules.json");
        }

        /// Load Meet speaking-class overrides — mirrors macOS MeetSpeakerRules.resolved().
        /// Reads meet-rules.json ({ "speakingClasses": ["kssMZb", …], "silentClasses":
        /// [], "version": "…" }); falls back to the built-in list when absent/invalid.
        /// When Google rotates kssMZb, drop the new token into that file — no rebuild.
        /// Parse the "speakingClasses" array out of a meet-rules.json string.
        /// Returns null when absent/empty/invalid so the caller keeps the built-in
        /// list. Pure (no I/O) so it can be unit-tested.
        public static string[] ParseMeetSpeakingClasses(string json)
        {
            try
            {
                Dictionary<string, object> obj =
                    new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object sc;
                if (obj == null || !obj.TryGetValue("speakingClasses", out sc)) return null;
                // JavaScriptSerializer may hand back the JSON array as object[] or an
                // ArrayList depending on version — accept any non-string enumerable.
                System.Collections.IEnumerable arr = sc as System.Collections.IEnumerable;
                if (arr == null || sc is string) return null;
                List<string> toks = new List<string>();
                foreach (object o in arr)
                {
                    string s = o as string;
                    if (!string.IsNullOrEmpty(s)) toks.Add(s);
                }
                return toks.Count > 0 ? toks.ToArray() : null;
            }
            catch (Exception) { return null; }
        }

        public static void LoadMeetRules()
        {
            MeetSpeakingClasses = MeetSpeakingClassesBuiltin;   // reset to default first
            try
            {
                string path = MeetRulesPath();
                if (!File.Exists(path)) return;
                string[] toks = ParseMeetSpeakingClasses(File.ReadAllText(path));
                if (toks != null)
                {
                    MeetSpeakingClasses = toks;
                    EmitStatus("info", string.Format(
                        "Loaded {0} Meet speaking class(es) from {1}.", toks.Length, path));
                }
            }
            catch (Exception ex)
            {
                EmitStatus("warn", "meet-rules.json load failed; using built-in classes: " + ex.Message);
            }
        }
        static readonly string[] MeetNameClasses = new string[] { "notranslate", "zWGUib", "XWGOtd", "dwSJ2e" };

        public static List<string> DetectMeetTileSpeakers(List<UiNode> nodes)
        {
            List<string> speakers = new List<string>();
            for (int i = 0; i < nodes.Count; i++)
            {
                bool speaking = false;
                for (int c = 0; c < MeetSpeakingClasses.Length; c++)
                    if (ClassNameHasToken(nodes[i].ClassName, MeetSpeakingClasses[c])) { speaking = true; break; }
                if (!speaking) continue;
                string name = NearbyPersonName(nodes, i, MeetNameClasses);
                if (name != null && !speakers.Contains(name)) speakers.Add(name);
            }
            return speakers;
        }

        // ---------------------------------------------------------------
        // Geometry-based active speaker (port of the macOS engine's
        // meetActiveSpeaker / MeetTileObservation). The DURABLE signal is tile
        // GEOMETRY: Meet's speaker/spotlight view promotes the active speaker's
        // tile far larger than the others, and that is rotation-proof — unlike
        // the CSS speaking classes, which change with releases. The rotating
        // class stays only as a remote-only fallback for gallery view. Requires
        // BoundingRectangle geometry from the scan; degrades to the class path
        // (DetectMeetTileSpeakers) when geometry is unavailable.
        // See docs/meet-active-speaker-no-hardcoded-css.md (macOS side).
        // ---------------------------------------------------------------

        public class MeetTile
        {
            public string Name = "";
            public double Area;
            public bool Speaking;   // a MeetSpeakingClass token appeared inside the tile
            public bool IsMe;       // a "(You)" / "You" self label appeared inside the tile
            // Tile bounding box (screen coords) — lets the raw-view "kssMZb" speaking
            // boxes be matched back to this named tile by geometry.
            public double X, Y, W, H;

            public bool ContainsPoint(double px, double py)
            {
                return W > 0 && H > 0 && px >= X && px <= X + W && py >= Y && py <= Y + H;
            }
        }

        // Meet tiles never fill the whole viewport; a "tile" bigger than this is
        // really a page/stage container (or a header node like the meeting code),
        // so it must not be mistaken for a participant tile.
        const double MeetMaxTileArea = 1400000;

        /// Build one observation per on-screen participant tile: name + tile
        /// AREA (geometry) + speaking-class + self flag. A name label is attached
        /// to its enclosing tile-sized box (area 8k..1.8M px^2, aspect <= 4) — the
        /// same heuristic macOS uses to climb from a name node to its tile. Keeps
        /// the largest tile per name (the real video tile, not a tiny duplicate).
        public static List<MeetTile> ParseMeetTiles(List<UiNode> nodes)
        {
            Dictionary<string, MeetTile> byKey = new Dictionary<string, MeetTile>();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode nameNode = nodes[i];
                if (nameNode.W <= 0) continue;                 // geometry required
                if (nameNode.ControlType != "Text") continue;  // names are text leaves
                bool youMark = nameNode.Name == "You" ||
                    nameNode.Name.IndexOf("(You)", StringComparison.OrdinalIgnoreCase) >= 0;
                string cn = CleanName(nameNode.Name);
                bool realName = cn.Length > 0 && cn != "You" && IsLikelyPersonName(cn);
                if (!realName && !youMark) continue;

                // Enclosing tile = the smallest tile-sized box that contains this
                // name label.
                UiNode tile = null;
                double best = double.MaxValue;
                for (int t = 0; t < nodes.Count; t++)
                {
                    UiNode cand = nodes[t];
                    // Real participant tiles are "oZRSLe" containers. Requiring it
                    // keeps dialog/header text ("Your meeting's ready", the meeting
                    // code, "Joined as …") from being mistaken for a tile.
                    if (!ClassNameHasToken(cand.ClassName, "oZRSLe")) continue;
                    double a = cand.Area();
                    if (a < 8000 || a > MeetMaxTileArea) continue;
                    double aspect = cand.W >= cand.H
                        ? (cand.H > 0 ? cand.W / cand.H : 99)
                        : (cand.W > 0 ? cand.H / cand.W : 99);
                    if (aspect > 4.0) continue;
                    if (!cand.Contains(nameNode)) continue;
                    if (a < best) { best = a; tile = cand; }
                }
                if (tile == null) continue;                    // no geometry tile -> class path covers it

                bool speaking = false;
                bool isMe = youMark;
                for (int s = 0; s < nodes.Count; s++)
                {
                    UiNode inside = nodes[s];
                    if (!tile.Contains(inside)) continue;
                    if (!speaking)
                        for (int c = 0; c < MeetSpeakingClasses.Length; c++)
                            if (ClassNameHasToken(inside.ClassName, MeetSpeakingClasses[c])) { speaking = true; break; }
                    if (!isMe && (inside.Name == "You" ||
                        inside.Name.IndexOf("(You)", StringComparison.OrdinalIgnoreCase) >= 0))
                        isMe = true;
                }

                string key = realName ? cn : "self";
                MeetTile existing;
                if (!byKey.TryGetValue(key, out existing))
                {
                    MeetTile mt = new MeetTile();
                    mt.Name = realName ? cn : "";
                    mt.Area = tile.Area();
                    mt.Speaking = speaking;
                    mt.IsMe = isMe;
                    mt.X = tile.X; mt.Y = tile.Y; mt.W = tile.W; mt.H = tile.H;
                    byKey[key] = mt;
                }
                else
                {
                    if (tile.Area() > existing.Area)
                    {
                        existing.Area = tile.Area();
                        existing.X = tile.X; existing.Y = tile.Y; existing.W = tile.W; existing.H = tile.H;
                    }
                    existing.Speaking = existing.Speaking || speaking;
                    existing.IsMe = existing.IsMe || isMe;
                    if (existing.Name.Length == 0 && realName) existing.Name = cn;
                }
            }
            return new List<MeetTile>(byKey.Values);
        }

        /// The single clearly-dominant tile (speaker/spotlight view), else null
        /// for gallery view (roughly equal tiles) — so geometry never GUESSES in
        /// gallery. Mirrors macOS meetPromotedTile (>= 1.5x the next tile).
        public static MeetTile MeetPromotedTile(List<MeetTile> tiles)
        {
            if (tiles.Count == 0) return null;
            if (tiles.Count == 1) return tiles[0];
            tiles.Sort(delegate (MeetTile a, MeetTile b) { return b.Area.CompareTo(a.Area); });
            if (tiles[1].Area <= 0) return null;
            if (tiles[0].Area >= tiles[1].Area * 1.5) return tiles[0];
            return null;
        }

        /// Bounding boxes (x,y,w,h) of every node carrying a Meet speaking class
        /// (kssMZb, …) in a RAW-VIEW node list. Meet's active-speaker class lives
        /// on a decorative wrapper that Chromium PRUNES from the default UIA view
        /// but keeps in the raw view — proven via a live -Dump -Deep capture. The
        /// engine scans the raw tree just for these boxes, then matches each back
        /// to a named tile from the (clean) control-view scan by geometry. This is
        /// the Windows route to the same signal macOS reads via AXDOMClassList.
        public static List<double[]> ExtractMeetSpeakingBoxes(List<UiNode> rawNodes)
        {
            List<double[]> boxes = new List<double[]>();
            for (int i = 0; i < rawNodes.Count; i++)
            {
                UiNode n = rawNodes[i];
                if (n.W <= 0 || n.H <= 0) continue;
                if (n.Area() > MeetMaxTileArea) continue;   // ignore stage-sized wrappers
                bool speaking = false;
                for (int c = 0; c < MeetSpeakingClasses.Length; c++)
                    if (ClassNameHasToken(n.ClassName, MeetSpeakingClasses[c])) { speaking = true; break; }
                if (speaking) boxes.Add(new double[] { n.X, n.Y, n.W, n.H });
            }
            return boxes;
        }

        /// Mark a tile as speaking when a raw-view speaking-class box's CENTRE
        /// falls inside it (the kssMZb wrapper shares the tile's on-screen region).
        public static void MarkMeetSpeakingByBoxes(List<MeetTile> tiles, List<double[]> speakBoxes)
        {
            if (speakBoxes == null) return;
            for (int b = 0; b < speakBoxes.Count; b++)
            {
                double[] r = speakBoxes[b];
                double cx = r[0] + r[2] / 2.0;
                double cy = r[1] + r[3] / 2.0;
                for (int t = 0; t < tiles.Count; t++)
                    if (tiles[t].ContainsPoint(cx, cy)) { tiles[t].Speaking = true; break; }
            }
        }

        /// VAD-gated active-speaker resolution. Order: the real per-tile speaking
        /// signal (kssMZb, read from the raw view) FIRST — it names exactly whoever
        /// is talking, whatever the layout — then tile GEOMETRY as a fallback only
        /// when no tile carries the class (e.g. the class rotated).
        ///
        /// Geometry must NOT come first: in speaker/spotlight view a tile is always
        /// promoted (the pinned/enlarged one), which is not necessarily the current
        /// speaker — checking geometry first logged only the big tile and ignored
        /// whoever actually spoke once the participants panel was closed.
        ///
        /// Self tiles are named by the mic path when the self name is resolved, so
        /// they're skipped here; when self is UNRESOLVED the class still names the
        /// local user by their real tile name (never the placeholder "You").
        public static List<string> MeetActiveSpeaker(List<MeetTile> tiles, bool vad,
                                                     bool presentationActive, string selfName)
        {
            List<string> names = new List<string>();
            if (!vad) return names;

            // 1) Real speaking class (kssMZb) — the precise signal, any layout.
            for (int i = 0; i < tiles.Count; i++)
            {
                MeetTile t = tiles[i];
                if (t.Speaking && !t.IsMe && t.Name.Length > 0 &&
                    t.Name != "You" && t.Name != selfName && !names.Contains(t.Name))
                    names.Add(t.Name);   // via class
            }
            if (names.Count > 0) return names;

            // 2) Geometry fallback — a clearly promoted tile, only when NO tile
            //    carried the speaking class (class missing / rotated).
            if (!presentationActive)
            {
                MeetTile promoted = MeetPromotedTile(tiles);
                if (promoted != null && !promoted.IsMe && promoted.Name.Length > 0 &&
                    promoted.Name != "You" && promoted.Name != selfName)
                    names.Add(promoted.Name);   // via geometry
            }
            return names;   // empty -> someone floor
        }

        static readonly string[] MeetPresentingPhrases = new string[] {
            "is presenting", "stop presenting", "you are presenting",
            "stop sharing", "is sharing their screen"
        };

        /// Is a presentation / screen-share dominating the Meet stage? Then the
        /// shared screen fills the main tile and would be mistaken for the
        /// speaker, so geometry is suppressed (macOS meetPresentationActive).
        public static bool MeetPresentationActive(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                string nm = nodes[i].Name;
                if (nm.Length == 0 || nm.Length > 120) continue;
                string low = nm.ToLowerInvariant();
                for (int p = 0; p < MeetPresentingPhrases.Length; p++)
                    if (low.IndexOf(MeetPresentingPhrases[p], StringComparison.Ordinal) >= 0)
                        return true;
            }
            return false;
        }

        // Google Meet mic state from the call-control button (verified from a
        // live populated tree): "Turn off microphone" = currently ON (the
        // button's action), "Turn on microphone" = currently muted. The live
        // text "Your microphone is turned on/off." corroborates.
        public static int DetectMeetMicState(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.ControlType == "Button")
                {
                    if (n.Name.Equals("Turn off microphone", StringComparison.OrdinalIgnoreCase)) return Mic.Unmuted;
                    if (n.Name.Equals("Turn on microphone", StringComparison.OrdinalIgnoreCase)) return Mic.Muted;
                }
                if (n.ControlType == "Text")
                {
                    if (n.Name.StartsWith("Your microphone is turned on", StringComparison.OrdinalIgnoreCase)) return Mic.Unmuted;
                    if (n.Name.StartsWith("Your microphone is turned off", StringComparison.OrdinalIgnoreCase)) return Mic.Muted;
                }
            }
            return Mic.Unknown;
        }

        public class MeetRoster
        {
            public List<string> All = new List<string>();      // everyone on the tiles/roster
            public List<string> Remotes = new List<string>();  // names a host can "Mute X's microphone"
            public string Self = "";                            // the one non-remote, when unambiguous
        }

        static readonly Regex MeetMuteOther = new Regex("^Mute (.+?)'s microphone$", RegexOptions.IgnoreCase);

        /// Names + self/remote split for Meet. Self is identified as the roster
        /// member who is NOT mutable-by-host (you never get a "Mute you"
        /// button) — reliable when you are host; otherwise Self stays blank.
        public static MeetRoster ParseMeetRoster(List<UiNode> nodes)
        {
            MeetRoster r = new MeetRoster();
            string selfMarker = "";   // resolved from Meet's own "(You)" label
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];

                if (n.ControlType == "Button")
                {
                    Match m = MeetMuteOther.Match(n.Name);
                    if (m.Success)
                    {
                        string rem = CleanName(m.Groups[1].Value);
                        if (rem.Length > 0 && !r.Remotes.Contains(rem)) r.Remotes.Add(rem);
                    }
                    continue;
                }

                // Roster list items, and on-screen video-tile name labels that
                // sit just after a tile container group (class "oZRSLe").
                bool isRosterItem = n.ControlType == "ListItem";
                bool isTileName = n.ControlType == "Text" && i > 0 &&
                    ClassNameHasToken(nodes[i - 1].ClassName, "oZRSLe");
                if (!isRosterItem && !isTileName) continue;

                // Meet labels the local user's own row/tile "<Name> (You)" — the
                // authoritative self signal, independent of whether you're host.
                // Capture it BEFORE CleanName strips the "(You)" suffix.
                if (selfMarker.Length == 0 &&
                    n.Name.IndexOf("(You)", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    string self = CleanName(n.Name);
                    if (self.Length > 0 && self != "You" && IsLikelyPersonName(self)) selfMarker = self;
                }

                string name = CleanName(n.Name);
                if (name.Length == 0 || !IsLikelyPersonName(name)) continue;
                if (!r.All.Contains(name)) r.All.Add(name);
            }

            // Self, preferred order: Meet's own "(You)" marker (works whether or
            // not you host), else the single roster member nobody can host-mute.
            if (selfMarker.Length > 0)
            {
                r.Self = selfMarker;
            }
            else
            {
                List<string> candidates = new List<string>();
                for (int i = 0; i < r.All.Count; i++)
                    if (!r.Remotes.Contains(r.All[i])) candidates.Add(r.All[i]);
                if (candidates.Count == 1 && r.Remotes.Count > 0) r.Self = candidates[0];
            }
            return r;
        }

        // ---------------------------------------------------------------
        // Platform dispatch
        // ---------------------------------------------------------------

        /// In-call markers gate detection: a window is only TREATED as an
        /// active meeting when call controls are present. This stops ordinary
        /// browser tabs mentioning Meet, and Teams CHAT windows (whose chat
        /// rows could otherwise be parsed as caption rows), from producing
        /// phantom speakers.
        public static bool HasMeetCallMarkers(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                string name = nodes[i].Name;
                if (name.Length == 0 || name.Length > 60) continue;
                if (name == "Leave call" ||
                    name.StartsWith("Turn on captions", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("Turn off captions", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("Turn off microphone", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith("Turn on microphone", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }
}
