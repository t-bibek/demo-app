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
        // as the UIA ClassName, so the speaking-indicator CSS classes used by
        // open-source bots are visible:
        //   Meet:  speaking tiles gain classes like Oaajhc/HX2H7/wEsLMd/OgVli
        //          (Vexa), participant names sit in "notranslate" spans.
        //   Teams: the voice-level ring carries the "vdi-frame-occlusion"
        //          class while a participant speaks (Vexa TeamsSpeakingDetector).
        // Class tokens rotate with releases — when detection goes quiet, run
        // the dump and refresh these constants.
        // ---------------------------------------------------------------

        static readonly string[] MeetSpeakingClasses = new string[] { "Oaajhc", "HX2H7", "wEsLMd", "OgVli" };
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

                string name = CleanName(n.Name);
                if (name.Length == 0 || !IsLikelyPersonName(name)) continue;
                if (!r.All.Contains(name)) r.All.Add(name);
            }

            // Self = the single roster member nobody can host-mute.
            List<string> candidates = new List<string>();
            for (int i = 0; i < r.All.Count; i++)
                if (!r.Remotes.Contains(r.All[i])) candidates.Add(r.All[i]);
            if (candidates.Count == 1 && r.Remotes.Count > 0) r.Self = candidates[0];
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
