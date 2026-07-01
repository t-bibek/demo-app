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

        public static List<string> DetectTeamsTileSpeakers(List<UiNode> nodes)
        {
            List<string> speakers = new List<string>();
            for (int i = 0; i < nodes.Count; i++)
            {
                if (!ClassNameHasToken(nodes[i].ClassName, TeamsSpeakingClass) &&
                    nodes[i].ClassName.IndexOf(TeamsSpeakingClass, StringComparison.Ordinal) < 0) continue;
                string name = NearbyPersonName(nodes, i, null);
                if (name != null && !speakers.Contains(name)) speakers.Add(name);
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

        // Teams video tiles (verified on Teams web, teams.cloud.microsoft):
        // tile accessible names are comma-separated, e.g.
        //   "Myself video, BIDHEYAK THAPA, Unmuted, Has context menu"
        // A "Muted"/"Unmuted" token marks a participant tile; the name is the
        // token right before it (with any trailing " video" stripped), and
        // "Myself ..." in the first token marks the local user.
        public class TeamsTile
        {
            public string Name = "";
            public bool IsSelf;
            public bool Unmuted;
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
                int muteIdx = -1;
                bool hasContextMenu = false;
                for (int t = 1; t < tokens.Length; t++)
                {
                    string tok = tokens[t].Trim();
                    if (muteIdx < 0 &&
                        (tok.Equals("Muted", StringComparison.OrdinalIgnoreCase) ||
                         tok.Equals("Unmuted", StringComparison.OrdinalIgnoreCase))) muteIdx = t;
                    if (tok.StartsWith("Context menu", StringComparison.OrdinalIgnoreCase) ||
                        tok.StartsWith("Has context menu", StringComparison.OrdinalIgnoreCase))
                        hasContextMenu = true;
                }
                // Two observed grammars:
                //  self tile:   "Myself video, NAME, Unmuted, Has context menu"
                //  remote item: "NAME, Context menu is available"          (live)
                //               "NAME, muted, Context menu is available"  (muted)
                // i.e. an UNMUTED remote has NO mute token, so "context menu"
                // items count as participants even without one.
                if (muteIdx < 1 && !hasContextMenu) continue;

                string nameTok = (muteIdx >= 1 ? tokens[muteIdx - 1] : tokens[0]).Trim();
                if (nameTok.EndsWith(" video", StringComparison.OrdinalIgnoreCase))
                    nameTok = nameTok.Substring(0, nameTok.Length - 6).Trim();
                if (nameTok.Equals("Myself", StringComparison.OrdinalIgnoreCase)) continue;
                string name = CleanName(nameTok);
                if (name.Length == 0 || !IsLikelyPersonName(name)) continue;

                TeamsTile tile = new TeamsTile();
                tile.Name = name;
                tile.IsSelf = tokens[0].Trim().StartsWith("Myself", StringComparison.OrdinalIgnoreCase);
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
    }
}
