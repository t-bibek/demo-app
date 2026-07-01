namespace MeetingSpeakerEngine
{
    public static partial class Engine
    {

        /// Extract (speaker, text) caption blocks from a Teams document scan.
        public static List<string[]> ExtractTeamsCaptionBlocks(List<UiNode> nodes)
        {
            List<string[]> blocks = new List<string[]>();
            // Caption rows use Fluent UI's ChatMessageCompact component
            // (row class "fui-ChatMessageCompact", children carry
            // "fui-ChatMessageCompact__author" / similar suffixes).
            Regex rowClass = new Regex("(^|\\s)fui-ChatMessageCompact(\\s|$)");
            for (int i = 0; i < nodes.Count; i++)
            {
                if (!rowClass.IsMatch(nodes[i].ClassName)) continue;

                string speaker = null;
                StringBuilder text = new StringBuilder();
                int end = Math.Min(nodes.Count, i + 1 + 12);
                for (int j = i + 1; j < end; j++)
                {
                    UiNode n = nodes[j];
                    if (rowClass.IsMatch(n.ClassName)) break;
                    if (n.ControlType != "Text" || n.Name.Length == 0) continue;
                    if (speaker == null &&
                        (n.ClassName.IndexOf("author", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         IsLikelyPersonName(n.Name)))
                    {
                        speaker = n.Name;
                    }
                    else
                    {
                        if (text.Length > 0) text.Append(' ');
                        text.Append(n.Name);
                    }
                }
                if (speaker != null && text.Length > 0)
                    blocks.Add(new string[] { speaker, text.ToString() });
            }
            return blocks;
        }

        // Names of REMOTE participant tiles whose video-frame subtree carries the
        // active-speaker className (`vdi-frame-occlusion`) — the macOS `.structural`
        // signal, ported (commit "Teams: className speaker signal"). The class sits
        // on a decorative child INSIDE the tile's box, visible only in the RAW UIA
        // view the Teams scan now uses, so we map each speaking-class node to the
        // MenuItem tile that geometrically CONTAINS it (index-proximity is unreliable
        // in the raw tree) and read that tile's name + mute via ParseTeamsTiles.
        // Self and muted tiles are excluded (self speech is mic-driven; a muted
        // remote isn't talking). Returns EVERY speaking tile — so two remotes talking
        // at once are BOTH named, which the single-remote mute-gate cannot do.
        // Callers gate this on remote playback audio so a lingering class during
        // silence never invents a speaker.
        public static List<string> DetectTeamsSpeakingTiles(List<UiNode> nodes)
        {
            List<string> speakers = new List<string>();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode tileNode = nodes[i];
                if (tileNode.ControlType != "MenuItem" || tileNode.Area() <= 0) continue;
                if (tileNode.Name.IndexOf(',') < 0) continue;
                List<UiNode> one = new List<UiNode>();
                one.Add(tileNode);
                List<TeamsTile> parsed = ParseTeamsTiles(one);
                if (parsed.Count == 0) continue;
                TeamsTile tile = parsed[0];
                if (tile.IsSelf || !tile.Unmuted) continue;
                for (int j = 0; j < nodes.Count; j++)
                {
                    if (j == i || !tileNode.Contains(nodes[j])) continue;
                    if (!ClassNameHasToken(nodes[j].ClassName, TeamsSpeakingClass)) continue;
                    if (!speakers.Contains(tile.Name)) speakers.Add(tile.Name);
                    break;
                }
            }
            return speakers;
        }

        // Teams mic state from the mic toolbar button's accessible name, which
        // describes the ACTION: "Mute" / "Mute mic" = currently live (unmuted),
        // "Unmute" / "Unmute mic" = currently muted.
        public static int DetectTeamsMicState(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.ControlType != "Button") continue;
                if (n.Name.StartsWith("Unmute", StringComparison.OrdinalIgnoreCase)) return Mic.Muted;
                if (n.Name.StartsWith("Mute mic", StringComparison.OrdinalIgnoreCase) ||
                    n.Name.Equals("Mute", StringComparison.OrdinalIgnoreCase)) return Mic.Unmuted;
            }
            return Mic.Unknown;
        }

        // Teams video tiles (verified live on the native client, ms-teams /
        // TeamsWebView — see logs\uia-dump-1-20260701-163822.ndjson). Tile
        // accessible names are comma-separated with TWO distinct grammars:
        //   self tile:   "Myself video, BIDHEYAK THAPA, Unmuted, video is on, Fit to frame, Has context menu"
        //   remote tile: "Bibek Thapa External unfamiliar, video is on, Context menu is available"   (UNMUTED)
        //                "Biheyak Thapa External unfamiliar, muted, Context menu is available"       (muted)
        // Three things the OLD parser got wrong on real strings:
        //   1. The name is NOT the token before the mute word — a camera-on
        //      remote reads "<Name> …, video is on, muted, …", so tokens[mute-1]
        //      picked up "video is on". The name is token[1] for self (after the
        //      "Myself video" marker) and token[0] for a remote.
        //   2. A remote's org-relationship BADGE ("External unfamiliar") is
        //      concatenated onto the name with no comma and must be stripped.
        //   3. An UNMUTED remote DROPS the mute word entirely (Teams announces
        //      mic state only when muted), so an absent mute token reads as
        //      UNMUTED — the signal the mute-gate speaker attribution depends on.
        public class TeamsTile
        {
            public string Name = "";
            public bool IsSelf;
            public bool Unmuted;
        }

        // Org-relationship badges Teams appends to a remote's tile name with no
        // separating comma ("<Name> External unfamiliar"). Stripped so the name
        // resolves to the real display name. The whole phrase must precede its
        // parts so it is removed in a single cut.
        static readonly string[] TeamsNameBadges = new string[] {
            "External unfamiliar", "External", "Unfamiliar"
        };

        static string StripTeamsBadges(string name)
        {
            string s = name.Trim();
            bool changed = true;
            while (changed)
            {
                changed = false;
                for (int i = 0; i < TeamsNameBadges.Length; i++)
                {
                    string b = TeamsNameBadges[i];
                    if (s.Length > b.Length + 1 &&
                        s.EndsWith(" " + b, StringComparison.OrdinalIgnoreCase))
                    {
                        s = s.Substring(0, s.Length - b.Length - 1).Trim();
                        changed = true;
                    }
                }
            }
            return s;
        }

        public static List<TeamsTile> ParseTeamsTiles(List<UiNode> nodes)
        {
            List<TeamsTile> tiles = new List<TeamsTile>();
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                if (n.Name.Length == 0 || n.Name.Length > 200) continue;
                if (n.ControlType == "Button" || n.ControlType == "ListItem") continue;
                if (n.Name.IndexOf(',') < 0) continue;

                string[] tokens = n.Name.Split(new string[] { ", " }, StringSplitOptions.None);
                // A tile is identified structurally by a context-menu affordance
                // OR an explicit mute token — the anchors Teams always appends.
                int muteIdx = -1;
                bool hasContextMenu = false;
                for (int t = 1; t < tokens.Length; t++)
                {
                    string tok = tokens[t].Trim();
                    if (muteIdx < 0 &&
                        (tok.Equals("Muted", StringComparison.OrdinalIgnoreCase) ||
                         tok.Equals("Unmuted", StringComparison.OrdinalIgnoreCase))) muteIdx = t;
                    if (tok.IndexOf("Context menu", StringComparison.OrdinalIgnoreCase) >= 0)
                        hasContextMenu = true;
                }
                // An unmuted remote has no mute token, so "context menu" alone
                // must qualify it as a participant tile.
                if (muteIdx < 0 && !hasContextMenu) continue;

                bool isSelf = tokens[0].Trim().StartsWith("Myself", StringComparison.OrdinalIgnoreCase);
                // Name position depends on the grammar (see the block comment):
                //   self   -> token[1] (after the "Myself video" marker)
                //   remote -> token[0], with the trailing org badge stripped.
                string nameTok;
                if (isSelf)
                {
                    if (tokens.Length < 2) continue;
                    nameTok = tokens[1].Trim();
                }
                else
                {
                    nameTok = StripTeamsBadges(tokens[0].Trim());
                }
                if (nameTok.EndsWith(" video", StringComparison.OrdinalIgnoreCase))
                    nameTok = nameTok.Substring(0, nameTok.Length - 6).Trim();
                if (nameTok.Equals("Myself", StringComparison.OrdinalIgnoreCase)) continue;
                string name = CleanName(nameTok);
                if (name.Length == 0 || !IsLikelyPersonName(name)) continue;

                TeamsTile tile = new TeamsTile();
                tile.Name = name;
                tile.IsSelf = isSelf;
                // Explicit "Muted" => muted; explicit "Unmuted" OR no mute token
                // (the unmuted-remote case) => unmuted.
                tile.Unmuted = muteIdx < 0 ||
                    tokens[muteIdx].Trim().Equals("Unmuted", StringComparison.OrdinalIgnoreCase);
                bool exists = false;
                for (int t = 0; t < tiles.Count; t++)
                    if (tiles[t].Name == tile.Name) { exists = true; break; }
                if (!exists) tiles.Add(tile);
            }
            return tiles;
        }

        public static bool HasTeamsCallMarkers(List<UiNode> nodes)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                UiNode n = nodes[i];
                // HTML ids map to UIA AutomationId in WebView2 and are the most
                // stable Teams hooks (hangup-button, closed-captions-button).
                if (n.AutomationId == "hangup-button" || n.AutomationId == "closed-captions-button")
                    return true;
                if (n.ControlType == "Button" && (n.Name == "Leave" || n.Name.StartsWith("Leave (")))
                    return true;
            }
            return false;
        }

        // ---------------------------------------------------------------
        // Teams speaking-CLASS probe. The macOS engine names a Meet speaker off a
        // per-tile CSS class that lights up while they talk (kssMZb, read via
        // AXDOMClassList) — derived by a co-variance run, not a guess. For Teams
        // no such class is proven (TeamsSpeakerRules.speakingClasses is empty),
        // so before we key attribution on one we must SEE it toggle. This samples
        // every participant tile ~3x/s and prints the +added / -removed class
        // tokens whenever a tile's class set CHANGES. Scanned in the RAW UIA view
        // so Chromium's decorative voice-level nodes (pruned from the control
        // view) are visible. If, across a narrated back-and-forth, one class
        // toggles in sync with who is talking, that is the Teams "kssMZb" — feed
        // it to DetectTeamsTileSpeakers. If nothing toggles but mute, the mute-
        // gate is the ceiling (matches macOS docs/teams-active-speaker-detection).
        // ---------------------------------------------------------------

        // Add one node's full SIGNATURE to the set: class tokens (c:), text words
        // (t:) and AutomationId (a:). A speaking indicator could be ANY of these —
        // a toggled CSS class, an added "voice level"/"speaking" text node, or a
        // mic/active aria id — so the probe watches all three, not just classes.
        // Everything is a space-free token so set-diffing stays simple.
        static void AddSig(SortedDictionary<string, bool> set, UiNode n)
        {
            if (!string.IsNullOrEmpty(n.ClassName))
            {
                string[] parts = n.ClassName.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < parts.Length; i++)
                {
                    // Drop the per-instance Fluent style hash (___xxxxx) — it changes
                    // per element/render and would swamp a real toggle.
                    if (parts[i].StartsWith("___", StringComparison.Ordinal)) continue;
                    set["c:" + parts[i]] = true;
                }
            }
            if (!string.IsNullOrEmpty(n.Name))
            {
                string[] words = n.Name.Split(new char[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < words.Length; i++) set["t:" + words[i].ToLowerInvariant()] = true;
            }
            if (!string.IsNullOrEmpty(n.AutomationId)) set["a:" + n.AutomationId] = true;
        }

        static string TokenSetDelta(string prev, string cur)
        {
            HashSet<string> a = new HashSet<string>(prev.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
            HashSet<string> b = new HashSet<string>(cur.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
            StringBuilder sb = new StringBuilder();
            foreach (string t in b) if (!a.Contains(t)) { if (sb.Length > 0) sb.Append(' '); sb.Append('+').Append(t); }
            foreach (string t in a) if (!b.Contains(t)) { if (sb.Length > 0) sb.Append(' '); sb.Append('-').Append(t); }
            return sb.ToString();
        }

        public static void TeamsWatch(int seconds, int maxNodes, float remoteThr, float micThr)
        {
            Directory.CreateDirectory("logs");
            string fileName = Path.Combine("logs", string.Format(
                "teams-watch-{0:yyyyMMdd-HHmmss}.ndjson", DateTime.Now));

            Console.WriteLine("Teams speaking-SIGNAL probe - sampling ~3x/s for " + seconds + "s (RAW view)");
            Console.WriteLine("  NARRATE one remote at a time. Watch for a 'TILE CHANGED' delta (class c:,");
            Console.WriteLine("  text t:, aria a:) or a {area} jump that tracks WHOSE turn it is.");
            Console.WriteLine("  render=ms-teams playback peak (a remote is audible)   mic=your capture peak");
            Console.WriteLine("  [on]/[off]=tile unmuted/muted   {N}=tile area px   timeline -> " + fileName);
            Console.WriteLine("");

            Dictionary<string, string> prevTokens = new Dictionary<string, string>();
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
                    try
                    {
                        TopWindows tops = FindTopWindows();
                        SampleAudio();
                        Bump(RenderActiveUntil, RenderPeaks, remoteThr, ts);
                        Bump(CaptureActiveUntil, CapturePeaks, micThr, ts);

                        bool sawTeams = false;
                        foreach (MeetingWindow w in tops.Meetings)
                        {
                            if (w.Platform != "teams") continue;
                            sawTeams = true;
                            // RAW view: keep the decorative/animated nodes the control
                            // view prunes (where a voice-level indicator would live).
                            AutomationElement doc = GetDocument(w);
                            AutomationElement scope = doc != null ? doc : w.Element;
                            List<UiNode> nodes;
                            try { nodes = ScanNodes(scope, maxNodes, true); }
                            catch (Exception) { continue; }

                            float rp = GetRenderPeak(w.ProcName);
                            float cp = GetCapturePeak(w.ProcName);

                            StringBuilder roster = new StringBuilder();
                            List<string> changeLines = new List<string>();

                            for (int i = 0; i < nodes.Count; i++)
                            {
                                UiNode tileNode = nodes[i];
                                if (tileNode.ControlType != "MenuItem") continue;
                                if (tileNode.Name.IndexOf(',') < 0) continue;
                                if (tileNode.Name.IndexOf("Context menu", StringComparison.OrdinalIgnoreCase) < 0 &&
                                    tileNode.Name.IndexOf("muted", StringComparison.OrdinalIgnoreCase) < 0) continue;

                                List<UiNode> one = new List<UiNode>();
                                one.Add(tileNode);
                                List<TeamsTile> parsed = ParseTeamsTiles(one);
                                if (parsed.Count == 0) continue;
                                TeamsTile tile = parsed[0];

                                // Full tile signature across its on-screen subtree
                                // (class + text + AutomationId), plus its area (a
                                // spotlight promotion is a geometry speaking signal).
                                SortedDictionary<string, bool> sig = new SortedDictionary<string, bool>();
                                double area = tileNode.Area();
                                AddSig(sig, tileNode);
                                if (area > 0)
                                    for (int j = 0; j < nodes.Count; j++)
                                        if (j != i && tileNode.Contains(nodes[j])) AddSig(sig, nodes[j]);
                                string sigStr = string.Join(" ", new List<string>(sig.Keys).ToArray());

                                string key = tile.IsSelf ? "me" : tile.Name;
                                string label = tile.Name + (tile.IsSelf ? "(me)" : "") + (tile.Unmuted ? "[on]" : "[off]");
                                if (area > 0) label += "{" + ((int)Math.Round(area)) + "}";
                                if (roster.Length > 0) roster.Append("  ");
                                roster.Append(label);

                                string prev;
                                if (prevTokens.TryGetValue(key, out prev) && prev != sigStr)
                                    changeLines.Add("    TILE CHANGED  " + label + "  " + TokenSetDelta(prev, sigStr));
                                prevTokens[key] = sigStr;

                                Dictionary<string, object> row = new Dictionary<string, object>();
                                row["type"] = "teamswatch";
                                row["tick"] = tick;
                                row["t"] = Math.Round(elapsed, 2);
                                row["name"] = tile.Name;
                                row["self"] = tile.IsSelf;
                                row["unmuted"] = tile.Unmuted;
                                row["area"] = Math.Round(area);
                                row["render"] = Math.Round((double)rp, 3);
                                row["mic"] = Math.Round((double)cp, 3);
                                row["sig"] = sigStr;
                                sw.WriteLine(Json.Serialize(row));
                            }

                            Console.WriteLine(string.Format(
                                "t={0,6:0.0}s  render={1:0.000} mic={2:0.000}  {3}",
                                elapsed, rp, cp, roster.Length > 0 ? roster.ToString() : "(no tiles)"));
                            for (int c = 0; c < changeLines.Count; c++) Console.WriteLine(changeLines[c]);
                        }
                        if (!sawTeams)
                            Console.WriteLine(string.Format("t={0,6:0.0}s  (no Teams meeting window)", elapsed));
                    }
                    catch (Exception ex) { Console.WriteLine("  probe error: " + ex.Message); }
                    Thread.Sleep(300);
                }
            }

            Console.WriteLine("");
            Console.WriteLine("timeline: " + fileName);
            Console.WriteLine("VERDICT: a token/area that appears on tile A only during A's turn and tile B");
            Console.WriteLine("only during B's turn is the speaking signal -> wire it into DetectTeamsTileSpeakers.");
            Console.WriteLine("If the only deltas are mute/camera toggles, there is no per-tile speaking signal.");
        }
    }
}
