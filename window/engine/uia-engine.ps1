<#
.SYNOPSIS
  UIA speaker-detection engine for meeting-speaker-logger.

  Hosts a C# engine (compiled in-process via Add-Type, no SDK required) that
  polls the Windows UI Automation trees of Google Meet (browser), Zoom and
  Microsoft Teams meeting windows and emits NDJSON events on stdout:

    {"type":"pulse","platform":"zoom","speakers":["Alice"],"ts":...}
    {"type":"windows","windows":[{"platform":"zoom","title":"...","nodeCount":1234}],"ts":...}
    {"type":"status","level":"info","message":"...","ts":...}

  This is the Windows analogue of the macOS AX-tree approach Recall.ai's
  desktop SDK uses for active-speaker detection ("uses the operating system's
  accessibility APIs to ... detect ... who's speaking" — Recall.ai docs).

  Detection is a HYBRID of audio metering and accessibility-tree reading:

  - WASAPI audio meters (work with the meeting in the BACKGROUND, no settings
    changes needed): per-process output peaks say when meeting audio is
    flowing (a remote participant is speaking); the microphone peak says when
    the local user is speaking.
  - UIA supplies the NAME when the platform exposes one:
     * Zoom desktop: video tile accessible names carry the participant name,
       mute state and an ", Active speaker" suffix (verified on Zoom 7.x).
       Audio gates it so the lingering badge does not extend sessions.
     * Google Meet / Teams: the speaking-indicator CSS classes on participant
       tiles (Chromium exposes HTML class attributes as UIA ClassName), plus
       caption rows as a secondary signal when captions happen to be on.
  - When audio says someone is speaking but no name is available, the speaker
    is logged as "Someone" (remote) or "You" (microphone) so speaking time is
    never missed.

.PARAMETER PollMs            Poll interval in milliseconds (default 500).
.PARAMETER MaxNodes          Max accessibility nodes scanned per window per poll.
.PARAMETER RemoteAudioThreshold  Output peak (0..1) above which a meeting app counts
                             as playing voice (default 0.02).
.PARAMETER MicAudioThreshold Mic peak (0..1) above which the local user counts as
                             speaking (default 0.04).
.PARAMETER ZoomProbe         Optional legacy probe: send Ctrl+2 ("Read active speaker
                             name") to a foreground Zoom meeting window. Not needed on
                             Zoom 7.x where tiles expose the active speaker.
.PARAMETER ZoomProbeMs       Interval between Ctrl+2 probes (default 1500 ms).
.PARAMETER ZoomGlobalHotkey  Send Ctrl+2 even when Zoom is in the background. Only enable
                             this after making Ctrl+2 a GLOBAL shortcut in Zoom Settings >
                             Keyboard Shortcuts, otherwise the keystroke goes to whatever
                             app is focused.
.PARAMETER Simulate          Emit synthetic speaker events (pipeline testing, no meeting needed).
.PARAMETER Dump              Write the UIA tree of every detected meeting window to logs\ and exit.
.PARAMETER SelfTest          Run built-in detector/classifier tests and exit (0 = pass).
.PARAMETER Once              Do a single real poll, emit results, and exit (diagnostics).
#>
[CmdletBinding()]
param(
  [int]$PollMs = 500,
  [int]$MaxNodes = 8000,
  [double]$RemoteAudioThreshold = 0.02,
  [double]$MicAudioThreshold = 0.04,
  # [switch] rather than [bool]: -File invocation cannot bind [bool] params.
  [switch]$ZoomProbe,
  [int]$ZoomProbeMs = 1500,
  [switch]$ZoomGlobalHotkey,
  [switch]$Simulate,
  [switch]$Dump,
  [switch]$SelfTest,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# NOTE: compiled by Windows PowerShell 5.1 => C# 5 syntax only
# (no string interpolation, no ?. operator, no expression-bodied members).
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace MeetingSpeakerEngine
{
    // -------------------------------------------------------------------
    // Minimal WASAPI COM interop (NAudio-style): per-process output audio
    // peaks + microphone peak. Method order in each interface MUST match
    // the COM vtable exactly.
    // -------------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(uint access, out IntPtr properties);
        int GetId(out IntPtr id);
        int GetState(out uint state);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        // IAudioSessionManager
        int GetAudioSessionControl(ref Guid sessionGuid, uint flags, out IntPtr sessionControl);
        int GetSimpleAudioVolume(ref Guid sessionGuid, uint streamFlags, out IntPtr audioVolume);
        // IAudioSessionManager2
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        // IAudioSessionControl
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath(out IntPtr path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr notifications);
        int UnregisterAudioSessionNotification(IntPtr notifications);
        // IAudioSessionControl2
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out uint count);
        int GetChannelsPeakValues(uint count, IntPtr values);
        int QueryHardwareSupport(out uint support);
    }

    public class UiNode
    {
        public string Name;
        public string ClassName;
        public string AutomationId;
        public string ControlType;

        public UiNode()
        {
            Name = ""; ClassName = ""; AutomationId = ""; ControlType = "";
        }

        public UiNode(string name, string controlType)
        {
            Name = name; ControlType = controlType; ClassName = ""; AutomationId = "";
        }

        public UiNode(string name, string controlType, string className)
        {
            Name = name; ControlType = controlType; ClassName = className; AutomationId = "";
        }
    }

    public class MeetingWindow
    {
        public AutomationElement Element;
        public string Platform;   // meet | zoom | teams
        public string Title;
        public int Pid;
        public int Hwnd;
        public string ProcName = "";
        /// Browser-hosted (Meet, Zoom web) — scan the web Document, expect a big tree.
        public bool IsBrowser;
    }

    public class Detection
    {
        public List<string> Speakers = new List<string>();
        public List<string> Participants = new List<string>();
        public string Source = "";
        /// The local user's display name, when the platform reveals it
        /// (e.g. Zoom's "(me)" tile) — used to label self-audio fallbacks.
        public string SelfName = "";
        /// Microphone state read from the UI: 0 unknown, 1 muted, 2 unmuted
        /// (see the Mic class). The self-audio fallback fires only when this is
        /// UNMUTED, because the meeting app keeps capturing the mic stream even
        /// when app-muted, so mic audio alone cannot tell "speaking" from
        /// "speaking while muted". Defaults to 0 (Unknown).
        public int MicState;
        /// Remote participant names (everyone but self), when known — lets a
        /// remote audio pulse with no per-speaker name be attributed in a
        /// 1-remote call instead of logging the generic "Someone".
        public List<string> RemoteNames = new List<string>();
        /// True when the local user's microphone is known to be muted (kept for
        /// convenience; MicState is authoritative).
        public bool SelfMuted { get { return MicState == Mic.Muted; } }
    }

    public static class Mic
    {
        public const int Unknown = 0;
        public const int Muted = 1;
        public const int Unmuted = 2;
    }

    class CaptionState
    {
        public string Speaker = "";
        public string Text = "";
        public bool Init;
    }

    /// Sticky per-meeting roster. Names resolve only on polls where the tree is
    /// fully populated; this remembers them so a momentarily thin tree does not
    /// flip a named speaker back to "You"/"Someone".
    class RosterMem
    {
        public string SelfName = "";
        public List<string> All = new List<string>();
    }

    /// Per-window detection outcome of one poll, used to aggregate audio
    /// fallbacks PER PLATFORM (the same meeting can be open in two windows —
    /// e.g. joined from Chrome and Edge at once — and the same physical mic
    /// feeds both, so per-window fallbacks would double-log one voice).
    class WinResult
    {
        public string Platform = "";
        public string Title = "";
        public bool SelfActive;
        public bool RemoteActive;
        public int MicState;
        public string SelfName = "";
        public List<string> Remotes = new List<string>();
        public int NamedSpeakers;
        public bool SelfNamedInDet;
    }

    public static class Engine
    {
        static JavaScriptSerializer Json = CreateSerializer();
        static Dictionary<int, string> ProcNameCache = new Dictionary<int, string>();
        static Dictionary<string, CaptionState> CaptionStates = new Dictionary<string, CaptionState>();
        static Dictionary<int, AutomationElement> DocCache = new Dictionary<int, AutomationElement>();
        static Dictionary<string, int> TreeHintPolls = new Dictionary<string, int>();
        static Dictionary<string, RosterMem> Rosters = new Dictionary<string, RosterMem>();
        static bool WarnedSlowScan;
        static bool WarnedTruncation;
        static bool HintedZoomBackground;
        static long LastZoomProbe;

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        const byte VK_CONTROL = 0x11;
        const byte VK_2 = 0x32;
        const uint KEYEVENTF_KEYUP = 0x0002;
        const int VK_SHIFT = 0x10;
        const int VK_MENU = 0x12;     // Alt
        const int VK_LWIN = 0x5B;
        const int VK_RWIN = 0x5C;

        static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = 64 * 1024 * 1024;
            return s;
        }

        // ---------------------------------------------------------------
        // Audio metering (WASAPI). Two independent per-application signals:
        //   RenderPeaks[proc]  = audio that app is PLAYING  -> a REMOTE
        //                        participant in that app is speaking.
        //   CapturePeaks[proc] = mic audio that app is RECEIVING -> the LOCAL
        //                        user is speaking INTO that app.
        // Per-application capture is what makes "you are speaking" reliable: it
        // measures the exact stream Zoom/Teams/Chrome pulls from the mic, so it
        // doesn't depend on which device is the system default and is not
        // confused by the remote participant's audio.
        // ---------------------------------------------------------------

        static IAudioSessionManager2 RenderManager;
        static IAudioSessionManager2 CaptureManager;
        static int AudioReinitCountdown;
        static bool WarnedAudioFailure;

        public static Dictionary<string, float> RenderPeaks = new Dictionary<string, float>();
        public static Dictionary<string, float> CapturePeaks = new Dictionary<string, float>();

        static IAudioSessionManager2 ActivateManager(IMMDeviceEnumerator en, EDataFlow flow)
        {
            IMMDevice dev;
            int hr = en.GetDefaultAudioEndpoint(flow, ERole.eMultimedia, out dev);
            if (hr != 0 || dev == null) return null; // e.g. no microphone present
            Guid iid = typeof(IAudioSessionManager2).GUID;
            object obj;
            dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out obj);
            return (IAudioSessionManager2)obj;
        }

        static void InitAudio()
        {
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            RenderManager = ActivateManager(en, EDataFlow.eRender);
            CaptureManager = ActivateManager(en, EDataFlow.eCapture);
        }

        static void FillPeaks(IAudioSessionManager2 manager, Dictionary<string, float> peaks)
        {
            peaks.Clear();
            if (manager == null) return;
            IAudioSessionEnumerator sessions;
            manager.GetSessionEnumerator(out sessions);
            int count;
            sessions.GetCount(out count);
            for (int i = 0; i < count; i++)
            {
                object sessionObj = null;
                try
                {
                    sessions.GetSession(i, out sessionObj);
                    IAudioSessionControl2 session = (IAudioSessionControl2)sessionObj;
                    if (session.IsSystemSoundsSession() == 0) continue; // S_OK = system sounds
                    uint pid;
                    session.GetProcessId(out pid);
                    if (pid == 0) continue;
                    IAudioMeterInformation meter = sessionObj as IAudioMeterInformation;
                    if (meter == null) continue;
                    float peak;
                    meter.GetPeakValue(out peak);
                    if (peak <= 0) continue;
                    string proc = GetProcName((int)pid).ToLowerInvariant();
                    if (proc.Length == 0) continue;
                    float existing;
                    if (!peaks.TryGetValue(proc, out existing) || peak > existing)
                        peaks[proc] = peak;
                }
                catch (Exception) { }
                finally
                {
                    if (sessionObj != null) Marshal.ReleaseComObject(sessionObj);
                }
            }
        }

        /// Refresh RenderPeaks and CapturePeaks. Degrades gracefully: any
        /// failure zeroes the readings and detection falls back to UI signals.
        public static void SampleAudio()
        {
            try
            {
                if (RenderManager == null || AudioReinitCountdown <= 0)
                {
                    InitAudio();
                    AudioReinitCountdown = 120;
                }
                AudioReinitCountdown--;
                FillPeaks(RenderManager, RenderPeaks);
                FillPeaks(CaptureManager, CapturePeaks);
            }
            catch (Exception ex)
            {
                RenderManager = null;
                CaptureManager = null;
                RenderPeaks.Clear();
                CapturePeaks.Clear();
                if (!WarnedAudioFailure)
                {
                    WarnedAudioFailure = true;
                    EmitStatus("warn", string.Format(
                        "Audio metering unavailable ({0}) — falling back to UI signals only.", ex.Message));
                }
            }
        }

        static float PeakOf(Dictionary<string, float> peaks, string procNameLower)
        {
            float peak;
            if (peaks.TryGetValue(procNameLower, out peak)) return peak;
            return 0f;
        }

        public static float GetRenderPeak(string procNameLower) { return PeakOf(RenderPeaks, procNameLower); }
        public static float GetCapturePeak(string procNameLower) { return PeakOf(CapturePeaks, procNameLower); }

        // Audio-activity hangover: once an app's stream crosses the threshold,
        // it stays "active" for HangoverMs afterwards, bridging the natural
        // gaps between words/sentences so one utterance is not split into many
        // tiny sessions. Kept modest so it doesn't inflate durations much.
        const long HangoverMs = 800;
        static Dictionary<string, long> RenderActiveUntil = new Dictionary<string, long>();
        static Dictionary<string, long> CaptureActiveUntil = new Dictionary<string, long>();

        static void Bump(Dictionary<string, long> until, Dictionary<string, float> peaks, float thr, long ts)
        {
            foreach (KeyValuePair<string, float> kv in peaks)
                if (kv.Value > thr) until[kv.Key] = ts + HangoverMs;
        }

        static bool ActiveWithin(Dictionary<string, long> until, string proc, long ts)
        {
            long t;
            if (until.TryGetValue(proc, out t)) return t >= ts;
            return false;
        }

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        static void Emit(Dictionary<string, object> obj)
        {
            Console.WriteLine(Json.Serialize(obj));
            Console.Out.Flush();
        }

        public static void EmitStatus(string level, string message)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["type"] = "status";
            d["level"] = level;
            d["message"] = message;
            d["ts"] = NowMs();
            Emit(d);
        }

        // ---------------------------------------------------------------
        // Window discovery
        // ---------------------------------------------------------------

        static string GetProcName(int pid)
        {
            string name;
            if (ProcNameCache.TryGetValue(pid, out name)) return name;
            try
            {
                name = Process.GetProcessById(pid).ProcessName;
            }
            catch (Exception)
            {
                name = "";
            }
            if (ProcNameCache.Count > 512) ProcNameCache.Clear();
            ProcNameCache[pid] = name;
            return name;
        }

        static readonly string[] BrowserProcs = new string[] {
            "chrome", "msedge", "firefox", "brave", "opera", "opera_gx", "vivaldi", "arc"
        };

        public static bool IsBrowserProc(string processName)
        {
            string p = (processName == null ? "" : processName).ToLowerInvariant();
            for (int i = 0; i < BrowserProcs.Length; i++)
                if (p == BrowserProcs[i]) return true;
            return false;
        }

        /// Classify a top-level window as "meet" / "zoom" / "teams" or null.
        public static string ClassifyWindow(string title, string processName, string className)
        {
            string t = title == null ? "" : title;
            string p = (processName == null ? "" : processName).ToLowerInvariant();
            string c = className == null ? "" : className;

            if (p.StartsWith("zoom"))
            {
                // ZPContentViewWndClass = the in-meeting content window.
                if (c == "ZPContentViewWndClass" ||
                    t.IndexOf("Zoom Meeting", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    t.IndexOf("Zoom Webinar", StringComparison.OrdinalIgnoreCase) >= 0)
                    return "zoom";
                return null;
            }

            if (p == "ms-teams" || p == "msteams" || p == "teams")
            {
                return "teams";
            }

            if (IsBrowserProc(p))
            {
                // Teams web (teams.cloud.microsoft / teams.live.com) FIRST: its
                // meeting tab can be titled "Meet App | ... | Microsoft Teams",
                // which the Meet patterns below would otherwise claim.
                if (t.IndexOf("Microsoft Teams", StringComparison.OrdinalIgnoreCase) >= 0) return "teams";

                if (t.IndexOf("Google Meet", StringComparison.OrdinalIgnoreCase) >= 0) return "meet";
                // Active tab titled "Meet" or "Meet – abc-defg-hij"
                if (Regex.IsMatch(t, "^Meet\\b")) return "meet";
                // A meeting code plus the word Meet anywhere in the title.
                if (Regex.IsMatch(t, "\\b[a-z]{3}-[a-z]{4,5}-[a-z]{3}\\b") &&
                    Regex.IsMatch(t, "\\bMeet\\b", RegexOptions.IgnoreCase)) return "meet";
                // Zoom WEB client tab (app.zoom.us/wc). Observed titles include
                // "Zoom Meeting", "Zoom Workplace", "<topic> - Zoom", and the
                // launcher "Launch Meeting - Zoom". Kept narrow enough to skip
                // marketing pages (zoom.us/pricing etc. don't contain these).
                if (Regex.IsMatch(t, "Zoom (Meeting|Webinar)\\b", RegexOptions.IgnoreCase) ||
                    Regex.IsMatch(t, "(^|[-–|]\\s*)Zoom Workplace\\b", RegexOptions.IgnoreCase) ||
                    Regex.IsMatch(t, "[-–]\\s*Zoom\\s*([-–]|$)") ||
                    Regex.IsMatch(t, "^(Launch|Join) Meeting\\b", RegexOptions.IgnoreCase)) return "zoom";
            }

            return null;
        }

        class TopWindows
        {
            public List<MeetingWindow> Meetings = new List<MeetingWindow>();
            public List<AutomationElement> ZoomBubbles = new List<AutomationElement>();
            public List<AutomationElement> ZoomPanels = new List<AutomationElement>();
        }

        static TopWindows FindTopWindows()
        {
            TopWindows result = new TopWindows();
            CacheRequest cr = new CacheRequest();
            cr.Add(AutomationElement.NameProperty);
            cr.Add(AutomationElement.ClassNameProperty);
            cr.Add(AutomationElement.ProcessIdProperty);
            cr.Add(AutomationElement.NativeWindowHandleProperty);

            AutomationElementCollection tops;
            using (cr.Activate())
            {
                tops = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            }

            foreach (AutomationElement el in tops)
            {
                string title, className;
                int pid, hwnd;
                try
                {
                    title = el.Cached.Name;
                    className = el.Cached.ClassName;
                    pid = el.Cached.ProcessId;
                    hwnd = el.Cached.NativeWindowHandle;
                }
                catch (Exception) { continue; }
                if (className == null) className = "";

                string proc = GetProcName(pid);
                bool isZoomProc = proc.ToLowerInvariant().StartsWith("zoom");

                // Zoom announces alerts (incl. the Ctrl+2 active-speaker response)
                // via hidden static text inside zBubbleBaseClass windows.
                if (isZoomProc && className == "zBubbleBaseClass")
                {
                    result.ZoomBubbles.Add(el);
                    continue;
                }
                // Popped-out participants panel ("Participants (N)").
                if (isZoomProc && className == "zPlistWndClass")
                {
                    result.ZoomPanels.Add(el);
                    continue;
                }

                string platform = ClassifyWindow(title, proc, className);
                if (platform == null) continue;

                if (result.Meetings.Count >= 4) continue; // cap meetings; keep collecting bubbles/panels
                MeetingWindow w = new MeetingWindow();
                w.Element = el;
                w.Platform = platform;
                w.Title = title == null ? "" : title;
                w.Pid = pid;
                w.Hwnd = hwnd;
                w.ProcName = proc.ToLowerInvariant();
                w.IsBrowser = IsBrowserProc(proc);
                result.Meetings.Add(w);
            }
            return result;
        }

        /// Evict per-window state for windows that no longer exist (also resets
        /// caption baselines on HWND reuse / meeting rejoin).
        static void PruneWindowState(List<MeetingWindow> meetings)
        {
            HashSet<int> liveHwnds = new HashSet<int>();
            HashSet<string> liveKeys = new HashSet<string>();
            foreach (MeetingWindow w in meetings)
            {
                liveHwnds.Add(w.Hwnd);
                liveKeys.Add(w.Platform + "#" + w.Hwnd);
            }
            List<int> deadDocs = new List<int>();
            foreach (int hwnd in DocCache.Keys)
                if (!liveHwnds.Contains(hwnd)) deadDocs.Add(hwnd);
            foreach (int hwnd in deadDocs) DocCache.Remove(hwnd);

            List<string> deadStates = new List<string>();
            foreach (string key in CaptionStates.Keys)
                if (!liveKeys.Contains(key)) deadStates.Add(key);
            foreach (string key in deadStates) CaptionStates.Remove(key);

            List<string> deadHints = new List<string>();
            foreach (string key in TreeHintPolls.Keys)
                if (!liveKeys.Contains(key)) deadHints.Add(key);
            foreach (string key in deadHints) TreeHintPolls.Remove(key);

            List<string> deadRosters = new List<string>();
            foreach (string key in Rosters.Keys)
                if (!liveKeys.Contains(key)) deadRosters.Add(key);
            foreach (string key in deadRosters) Rosters.Remove(key);
        }

        // ---------------------------------------------------------------
        // Accessibility-tree scan
        // ---------------------------------------------------------------

        /// For Chromium-based windows (Meet in a browser, new Teams = WebView2),
        /// scope the scan to the web Document — far smaller than the whole window
        /// and excludes browser chrome. Must be acquired OUTSIDE any active
        /// AutomationElementMode.None cache scope (null-SafeHandle gotcha).
        static AutomationElement GetDocument(MeetingWindow w)
        {
            AutomationElement doc;
            if (DocCache.TryGetValue(w.Hwnd, out doc)) return doc;
            try
            {
                PropertyCondition cond = new PropertyCondition(
                    AutomationElement.ControlTypeProperty, ControlType.Document);
                doc = w.Element.FindFirst(TreeScope.Descendants, cond);
            }
            catch (Exception)
            {
                doc = null;
            }
            if (doc != null) DocCache[w.Hwnd] = doc;
            return doc;
        }

        static List<UiNode> ScanNodes(AutomationElement scope, int maxNodes)
        {
            List<UiNode> list = new List<UiNode>();
            CacheRequest cr = new CacheRequest();
            cr.Add(AutomationElement.NameProperty);
            cr.Add(AutomationElement.ClassNameProperty);
            cr.Add(AutomationElement.AutomationIdProperty);
            cr.Add(AutomationElement.ControlTypeProperty);
            cr.AutomationElementMode = AutomationElementMode.None;

            Stopwatch sw = Stopwatch.StartNew();
            AutomationElementCollection found;
            using (cr.Activate())
            {
                found = scope.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            }

            if (found.Count > maxNodes && !WarnedTruncation)
            {
                WarnedTruncation = true;
                EmitStatus("warn", string.Format(
                    "UIA tree has {0} nodes, scanning only the first {1}; detection may miss elements. " +
                    "Raise -MaxNodes if captions are not picked up.", found.Count, maxNodes));
            }
            int n = Math.Min(found.Count, maxNodes);
            for (int i = 0; i < n; i++)
            {
                AutomationElement el = found[i];
                UiNode node = new UiNode();
                try
                {
                    node.Name = el.Cached.Name;
                    node.ClassName = el.Cached.ClassName;
                    node.AutomationId = el.Cached.AutomationId;
                    ControlType ct = el.Cached.ControlType;
                    node.ControlType = ct == null ? "" : ct.ProgrammaticName.Replace("ControlType.", "");
                }
                catch (Exception) { continue; }
                if (node.Name == null) node.Name = "";
                if (node.ClassName == null) node.ClassName = "";
                if (node.AutomationId == null) node.AutomationId = "";
                if (node.ControlType == null) node.ControlType = "";
                list.Add(node);
            }

            sw.Stop();
            if (sw.ElapsedMilliseconds > 1500 && !WarnedSlowScan)
            {
                WarnedSlowScan = true;
                EmitStatus("warn", string.Format(
                    "UIA scan took {0} ms for {1} nodes; consider increasing -PollMs.",
                    sw.ElapsedMilliseconds, list.Count));
            }
            return list;
        }

        /// Scan a meeting window: Document subtree for browser/WebView2-hosted
        /// platforms (with first-contact warm-up — the first UIA query is what
        /// switches Chromium accessibility on), whole window for Zoom desktop.
        static List<UiNode> ScanMeetingWindow(MeetingWindow w, int maxNodes)
        {
            if (w.Platform == "zoom" && !w.IsBrowser)
            {
                return ScanNodes(w.Element, maxNodes);
            }
            AutomationElement doc = GetDocument(w);
            if (doc == null)
            {
                // Accessibility tree not materialized yet; querying the window
                // is itself the trigger that enables it for the next poll.
                return ScanNodes(w.Element, maxNodes);
            }
            try
            {
                return ScanNodes(doc, maxNodes);
            }
            catch (ElementNotAvailableException)
            {
                DocCache.Remove(w.Hwnd);
                return new List<UiNode>();
            }
        }

        // ---------------------------------------------------------------
        // Name hygiene
        // ---------------------------------------------------------------

        /// Strip role suffixes meeting apps append to display names.
        public static string CleanName(string raw)
        {
            if (raw == null) return "";
            string s = raw.Trim();
            s = Regex.Replace(s,
                "\\s*\\((you|me|host|co-host|cohost|guest|external|presenting|presenter|organizer|unverified|host,\\s*me|me,\\s*host|co-host,\\s*me)\\)\\s*$",
                "", RegexOptions.IgnoreCase);
            s = Regex.Replace(s, "\\s+", " ").Trim().TrimEnd(',').Trim();
            if (s.Length > 80) s = s.Substring(0, 80).Trim();
            return s;
        }

        // UI words that are not people (Recall.ai's changelog shows even they
        // shipped bugs where "HOST"/"GUEST" badges leaked in as speaker names).
        static readonly string[] NotNames = new string[] {
            "you are muted", "muted", "unmute", "mute", "leave", "chat", "share screen",
            "participants", "people", "more", "host", "guest", "co-host", "speaking",
            "live captions", "captions", "turn on captions", "turn off captions",
            "raise hand", "react", "view", "mic", "camera", "audio", "video"
        };

        /// Heuristic: does this bubble/caption text look like a person's display name?
        public static bool IsLikelyPersonName(string s)
        {
            if (s == null) return false;
            s = s.Trim();
            if (s.Length < 1 || s.Length > 60) return false;
            if (s.IndexOf('\n') >= 0 || s.IndexOf(':') >= 0) return false;
            if (Regex.IsMatch(s, "[.!?]$")) return false;          // sentences end captions, not names
            string[] words = s.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0 || words.Length > 6) return false;
            string lower = s.ToLowerInvariant();
            for (int i = 0; i < NotNames.Length; i++)
                if (lower == NotNames[i]) return false;
            // All-caps single tokens like "HOST"/"GUEST" are UI badges.
            if (words.Length == 1 && s.Length > 1 && s == s.ToUpperInvariant() && Regex.IsMatch(s, "^[A-Z]+$"))
                return false;
            return true;
        }

        static void AddSpeaker(Detection det, string rawName)
        {
            string name = CleanName(rawName);
            if (name.Length == 0) return;
            if (!det.Speakers.Contains(name)) det.Speakers.Add(name);
        }

        static void AddParticipant(Detection det, string rawName)
        {
            string name = CleanName(rawName);
            if (name.Length == 0) return;
            if (!det.Participants.Contains(name)) det.Participants.Add(name);
        }

        // ---------------------------------------------------------------
        // Generic detector: accessible names that literally announce a speaker.
        // ---------------------------------------------------------------

        static readonly Regex[] GenericSpeakingPatterns = new Regex[] {
            // "Alice Smith is speaking" / "Alice is now talking"
            new Regex("^(.{1,80}?)\\s+is\\s+(?:now\\s+)?(?:speaking|talking)\\b", RegexOptions.IgnoreCase),
            // "Alice Smith, speaking" (state appended to a tile/roster label)
            new Regex("^(.{1,80}?),\\s*(?:speaking|talking)(?:\\b|$)", RegexOptions.IgnoreCase),
            // "Speaking: Alice Smith"
            new Regex("^(?:speaking|talking)\\s*:\\s*(.{1,80})$", RegexOptions.IgnoreCase),
        };

        public static Detection DetectGeneric(List<UiNode> nodes)
        {
            Detection det = new Detection();
            det.Source = "generic";
            for (int i = 0; i < nodes.Count; i++)
            {
                string name = nodes[i].Name;
                if (name.Length == 0 || name.Length > 200) continue;
                for (int p = 0; p < GenericSpeakingPatterns.Length; p++)
                {
                    Match m = GenericSpeakingPatterns[p].Match(name);
                    if (m.Success)
                    {
                        AddSpeaker(det, m.Groups[1].Value);
                        break;
                    }
                }
            }
            return det;
        }

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

        /// Compare the newest caption block against the previous poll's; the
        /// author is "speaking now" only when the block changed. The first
        /// observation only sets the baseline (stale captions from earlier in
        /// the meeting must not produce a phantom speaker on engine start).
        public static List<string> CaptionSpeakers(List<string[]> blocks, string stateKey)
        {
            List<string> speakers = new List<string>();
            CaptionState st;
            if (!CaptionStates.TryGetValue(stateKey, out st))
            {
                st = new CaptionState();
                CaptionStates[stateKey] = st;
            }
            if (blocks.Count == 0) return speakers;

            string[] last = blocks[blocks.Count - 1];
            bool changed = last[0] != st.Speaker || last[1] != st.Text;
            bool wasInit = st.Init;
            st.Speaker = last[0];
            st.Text = last[1];
            st.Init = true;
            if (changed && wasInit) speakers.Add(last[0]);
            return speakers;
        }

        /// Test hook: clear caption baselines between self-test cases.
        public static void ResetCaptionState()
        {
            CaptionStates.Clear();
            TreeHintPolls.Clear();
            Rosters.Clear();
        }

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
        const string TeamsSpeakingClass = "vdi-frame-occlusion";

        static bool ClassNameHasToken(string className, string token)
        {
            if (className.Length == 0) return false;
            int idx = className.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return false;
            bool startOk = idx == 0 || className[idx - 1] == ' ';
            int end = idx + token.Length;
            bool endOk = end == className.Length || className[end] == ' ' || className[end] == '_' || className[end] == '-';
            return startOk && endOk;
        }

        /// Find the participant name nearest to a speaking-indicator node.
        static string NearbyPersonName(List<UiNode> nodes, int center, string[] nameClasses)
        {
            for (int radius = 0; radius <= 14; radius++)
            {
                for (int dir = 0; dir < 2; dir++)
                {
                    int idx = dir == 0 ? center + radius : center - radius;
                    if (idx < 0 || idx >= nodes.Count) continue;
                    UiNode n = nodes[idx];
                    if (n.Name.Length == 0) continue;
                    bool classMatch = false;
                    if (nameClasses != null)
                        for (int c = 0; c < nameClasses.Length; c++)
                            if (ClassNameHasToken(n.ClassName, nameClasses[c])) { classMatch = true; break; }
                    if (classMatch && (n.Name == "You" || IsLikelyPersonName(n.Name)))
                        return n.Name;
                    if (n.ControlType == "Text" && (n.Name == "You" || IsLikelyPersonName(n.Name)))
                        return n.Name;
                }
            }
            return null;
        }

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

        /// Detect speakers in one meeting window's node list.
        ///   remoteActive = this app is currently playing voice (a REMOTE
        ///                  participant is talking).
        ///   selfActive   = this app is currently capturing mic audio (the
        ///                  LOCAL user is talking).
        /// These gate Zoom's tile badge, which lingers on the last active
        /// speaker during silence. Meet/Teams tile-class and caption signals
        /// are already presence-of-activity indicators, so they are not gated.
        public static Detection Detect(string platform, List<UiNode> nodes, string stateKey,
                                       bool remoteActive, bool selfActive)
        {
            Detection det = new Detection();
            if (platform == "meet")
            {
                det.Source = "meet-tiles";
                if (!HasMeetCallMarkers(nodes)) return det;

                det.MicState = DetectMeetMicState(nodes);
                MeetRoster roster = ParseMeetRoster(nodes);
                foreach (string nm in roster.All) AddParticipant(det, nm);
                det.SelfName = roster.Self;
                foreach (string nm in roster.All)
                    if (nm != roster.Self) det.RemoteNames.Add(nm);

                // Speaking name signals: tile speaking-class, then captions.
                foreach (string s in DetectMeetTileSpeakers(nodes)) AddSpeaker(det, s);
                if (det.Speakers.Count == 0)
                {
                    foreach (string s in CaptionSpeakers(ExtractMeetCaptionBlocks(nodes), stateKey))
                        AddSpeaker(det, s);
                    if (det.Speakers.Count > 0) det.Source = "meet-captions";
                }
            }
            else if (platform == "teams")
            {
                det.Source = "teams-tiles";
                if (!HasTeamsCallMarkers(nodes)) return det;

                // Video tiles: names, the "Myself" self marker and per-tile
                // mute state ("Myself video, NAME, Unmuted, ...").
                List<TeamsTile> tTiles = ParseTeamsTiles(nodes);
                foreach (TeamsTile tile in tTiles)
                {
                    AddParticipant(det, tile.Name);
                    if (tile.IsSelf)
                    {
                        if (det.SelfName.Length == 0) det.SelfName = tile.Name;
                        det.MicState = tile.Unmuted ? Mic.Unmuted : Mic.Muted;
                    }
                    else if (!det.RemoteNames.Contains(tile.Name))
                    {
                        det.RemoteNames.Add(tile.Name);
                    }
                }
                if (det.MicState == Mic.Unknown) det.MicState = DetectTeamsMicState(nodes);

                foreach (string s in DetectTeamsTileSpeakers(nodes)) AddSpeaker(det, s);
                if (det.Speakers.Count == 0)
                {
                    foreach (string s in CaptionSpeakers(ExtractTeamsCaptionBlocks(nodes), stateKey))
                        AddSpeaker(det, s);
                    if (det.Speakers.Count > 0) det.Source = "teams-captions";
                }
                // Roster (People pane) tree items, when open: best-effort participants.
                for (int i = 0; i < nodes.Count; i++)
                {
                    UiNode n = nodes[i];
                    if (n.ControlType == "TreeItem" && IsLikelyPersonName(n.Name))
                        AddParticipant(det, n.Name);
                }
            }
            else if (platform == "zoom")
            {
                det.Source = "zoom-tiles";

                // Desktop client: video tile names carry mute state, the "(me)"
                // self marker and the ", Active speaker" badge. Gate the badge
                // by the RIGHT audio stream: the self tile by mic-capture, a
                // remote tile by playback.
                List<ZoomTile> tiles = ParseZoomVideoTiles(nodes);
                foreach (ZoomTile tile in tiles)
                {
                    AddParticipant(det, tile.Name);
                    if (tile.IsSelf)
                    {
                        if (det.SelfName.Length == 0) det.SelfName = tile.Name;
                        det.MicState = tile.Unmuted ? Mic.Unmuted : Mic.Muted;
                    }
                    else if (!det.RemoteNames.Contains(tile.Name))
                    {
                        det.RemoteNames.Add(tile.Name);
                    }
                    if (!tile.ActiveSpeaker) continue;
                    if (tile.IsSelf) { if (selfActive) AddSpeaker(det, tile.Name); }
                    else { if (remoteActive) AddSpeaker(det, tile.Name); }
                }

                // Desktop roster (participants list pane).
                foreach (string r in ParseZoomRoster(nodes)) AddParticipant(det, r);

                // WEB client (thin tree, no per-tile speaking badge): names +
                // mute state. In a solo / known-size call the single tile name
                // is the local user, so self-audio is labeled by real name.
                ZoomWeb web = ParseZoomWeb(nodes);
                if (web.InMeeting)
                {
                    foreach (string nm in web.Names) AddParticipant(det, nm);
                    if (det.MicState == Mic.Unknown)
                        det.MicState = web.SelfMuted ? Mic.Muted : Mic.Unmuted;
                    if (det.SelfName.Length == 0 && web.Names.Count == 1 &&
                        (web.Count <= 1 || web.Count == -1))
                        det.SelfName = web.Names[0];
                    if (det.Source == "zoom-tiles") det.Source = "zoom-web";
                }

                // Generic "X is speaking" labels (zoom only — on Meet/Teams these
                // patterns can occur inside caption/chat TEXT and would phantom-pulse).
                if (remoteActive || selfActive)
                {
                    Detection generic = DetectGeneric(nodes);
                    foreach (string g in generic.Speakers)
                        if (IsLikelyPersonName(g)) AddSpeaker(det, g);
                }
            }
            return det;
        }

        // ---------------------------------------------------------------
        // Main loop
        // ---------------------------------------------------------------

        public static void Run(int pollMs, int maxNodes, bool once,
                               bool zoomProbe, int zoomProbeMs, bool zoomGlobalHotkey,
                               float remoteThr, float micThr)
        {
            EmitStatus("info", string.Format(
                "Engine started (poll {0} ms): audio metering + UIA name detection. Works with meeting " +
                "windows in the background; no captions required. Speakers without a detectable name are " +
                "logged as 'Someone' (remote audio) or 'You' (microphone).",
                pollMs));

            string lastWindowsKey = null;
            int tick = 0;
            int periodEvery = Math.Max(1, 5000 / Math.Max(pollMs, 1));

            while (true)
            {
                long ts = NowMs();
                try
                {
                    TopWindows tops = FindTopWindows();
                    PruneWindowState(tops.Meetings);
                    // PIDs get reused by Windows; refresh the name cache periodically.
                    if (tick > 0 && tick % 240 == 0) ProcNameCache.Clear();
                    SampleAudio();
                    // Refresh the hangover windows from this poll's peaks.
                    Bump(RenderActiveUntil, RenderPeaks, remoteThr, ts);
                    Bump(CaptureActiveUntil, CapturePeaks, micThr, ts);

                    List<Dictionary<string, object>> windowInfos = new List<Dictionary<string, object>>();
                    bool hasZoomDesktop = false;
                    List<WinResult> winResults = new List<WinResult>();

                    foreach (MeetingWindow w in tops.Meetings)
                    {
                        if (w.Platform == "zoom" && !w.IsBrowser) hasZoomDesktop = true;

                        List<UiNode> nodes;
                        try
                        {
                            nodes = ScanMeetingWindow(w, maxNodes);
                        }
                        catch (Exception ex)
                        {
                            DocCache.Remove(w.Hwnd);
                            EmitStatus("warn", string.Format(
                                "Scan failed for {0} window '{1}': {2}", w.Platform, w.Title, ex.Message));
                            continue;
                        }

                        // Two independent audio signals for THIS app (with hangover):
                        bool remoteActive = ActiveWithin(RenderActiveUntil, w.ProcName, ts);  // app playing voice
                        bool selfActive = ActiveWithin(CaptureActiveUntil, w.ProcName, ts);    // app capturing mic
                        float renderPeak = GetRenderPeak(w.ProcName);
                        float capturePeak = GetCapturePeak(w.ProcName);

                        string stateKey = w.Platform + "#" + w.Hwnd;
                        Detection det = Detect(w.Platform, nodes, stateKey, remoteActive, selfActive);

                        // Resolve self + roster with sticky memory so a thin
                        // poll doesn't drop a name back to "You"/"Someone".
                        RosterMem mem;
                        if (!Rosters.TryGetValue(stateKey, out mem)) { mem = new RosterMem(); Rosters[stateKey] = mem; }

                        string selfName = det.SelfName;
                        // Zoom: you usually host your own meeting, so the "<Name>'s
                        // Zoom Meeting" title names self when that name is present.
                        if (selfName.Length == 0 && w.Platform == "zoom")
                        {
                            string host = ZoomHostName(w.Title);
                            if (host.Length > 0 && det.Participants.Contains(host)) selfName = host;
                        }
                        if (selfName.Length == 0) selfName = mem.SelfName; // sticky

                        foreach (string p in det.Participants)
                            if (!mem.All.Contains(p)) mem.All.Add(p);
                        if (selfName.Length > 0) mem.SelfName = selfName;

                        // Everyone known but self = remote candidates.
                        List<string> remotes = new List<string>();
                        List<string> nameSrc = det.Participants.Count > 0 ? det.Participants : mem.All;
                        for (int ni = 0; ni < nameSrc.Count; ni++)
                            if (nameSrc[ni] != selfName && !remotes.Contains(nameSrc[ni])) remotes.Add(nameSrc[ni]);
                        for (int ni = 0; ni < det.RemoteNames.Count; ni++)
                            if (det.RemoteNames[ni] != selfName && !remotes.Contains(det.RemoteNames[ni]))
                                remotes.Add(det.RemoteNames[ni]);

                        EmitPulse(det, w.Platform, w.Title, ts);

                        // "Names available" = detection actually read content
                        // (participants, a name, or the mic button). A browser
                        // window whose web tree never materialized yields none of
                        // these, which is when we hint the user. Zoom desktop's
                        // small native tree is fine and reports usable.
                        bool bigTreeExpected = w.IsBrowser || w.Platform == "teams";
                        bool contentFound = det.Participants.Count > 0 || det.Speakers.Count > 0 ||
                            det.SelfName.Length > 0 || det.MicState != Mic.Unknown;
                        bool treeOk = !bigTreeExpected || contentFound;

                        Dictionary<string, object> wi = new Dictionary<string, object>();
                        wi["platform"] = w.Platform;
                        wi["title"] = w.Title;
                        wi["nodeCount"] = nodes.Count;
                        wi["treeOk"] = treeOk;
                        wi["audioPeak"] = Math.Round(Math.Max(renderPeak, capturePeak), 3);
                        windowInfos.Add(wi);

                        if (!treeOk)
                        {
                            int polls;
                            TreeHintPolls.TryGetValue(stateKey, out polls);
                            if (polls != int.MinValue)
                            {
                                polls++;
                                TreeHintPolls[stateKey] = polls;
                                if (polls == 8)
                                {
                                    TreeHintPolls[stateKey] = int.MinValue;
                                    EmitStatus("warn", string.Format(
                                        "'{0}': browser accessibility tree is empty ({1} nodes), so speaker NAMES " +
                                        "are unavailable — speaking is still logged by audio. For names: keep this " +
                                        "the ACTIVE tab (un-minimized), or open the meeting in Microsoft Edge, or " +
                                        "launch the browser with --force-renderer-accessibility.",
                                        w.Title, nodes.Count));
                                }
                            }
                        }

                        // Record for the per-platform fallback pass below.
                        WinResult wr = new WinResult();
                        wr.Platform = w.Platform;
                        wr.Title = w.Title;
                        wr.SelfActive = selfActive;
                        wr.RemoteActive = remoteActive;
                        wr.MicState = det.MicState;
                        wr.SelfName = selfName;
                        wr.Remotes = remotes;
                        wr.NamedSpeakers = det.Speakers.Count;
                        for (int s = 0; s < det.Speakers.Count; s++)
                            if (selfName.Length > 0 && det.Speakers[s] == selfName) wr.SelfNamedInDet = true;
                        winResults.Add(wr);
                    }

                    // ---- Audio fallbacks, aggregated PER PLATFORM ----
                    // At most ONE self pulse and ONE remote pulse per platform
                    // per poll, choosing the window with the best name info —
                    // otherwise a meeting joined from two browsers logs the
                    // same voice as both "NAME" and "You" (and "Someone").
                    string[] fallbackPlatforms = new string[] { "meet", "zoom", "teams" };
                    for (int pi = 0; pi < fallbackPlatforms.Length; pi++)
                    {
                        string plat = fallbackPlatforms[pi];
                        bool anyDetNamed = false;
                        bool selfNamedInDet = false;
                        WinResult bestSelf = null;
                        WinResult bestRemote = null;
                        for (int ri = 0; ri < winResults.Count; ri++)
                        {
                            WinResult r = winResults[ri];
                            if (r.Platform != plat) continue;
                            if (r.NamedSpeakers > 0) anyDetNamed = true;
                            if (r.SelfNamedInDet) selfNamedInDet = true;

                            // SELF candidate: this window's app is capturing mic
                            // audio AND its UI confirms the mic is UNMUTED (the
                            // capture stream stays open while app-muted, so audio
                            // alone cannot tell speaking from muted-speaking).
                            if (r.SelfActive && r.MicState == Mic.Unmuted)
                            {
                                if (bestSelf == null ||
                                    (bestSelf.SelfName.Length == 0 && r.SelfName.Length > 0)) bestSelf = r;
                            }
                            if (r.RemoteActive)
                            {
                                if (bestRemote == null ||
                                    (bestRemote.Remotes.Count != 1 && r.Remotes.Count == 1)) bestRemote = r;
                            }
                        }

                        if (bestSelf != null && !selfNamedInDet)
                        {
                            Detection self = new Detection();
                            self.Source = "mic-audio";
                            self.Speakers.Add(bestSelf.SelfName.Length > 0 ? bestSelf.SelfName : "You");
                            EmitPulse(self, plat, bestSelf.Title, ts);
                        }

                        // REMOTE: playback audio with no per-speaker name from the
                        // UI. With exactly one known remote, name them.
                        if (bestRemote != null && !anyDetNamed)
                        {
                            Detection fallback = new Detection();
                            fallback.Source = bestRemote.Remotes.Count == 1 ? "audio-roster" : "audio";
                            fallback.Speakers.Add(bestRemote.Remotes.Count == 1 ? bestRemote.Remotes[0] : "Someone");
                            EmitPulse(fallback, plat, bestRemote.Title, ts);
                        }
                    }

                    // Zoom popped-out participants panel contributes the roster.
                    foreach (AutomationElement panel in tops.ZoomPanels)
                    {
                        try
                        {
                            List<UiNode> nodes = ScanNodes(panel, 2000);
                            List<string> roster = ParseZoomRoster(nodes);
                            if (roster.Count > 0 && hasZoomDesktop)
                            {
                                Detection det = new Detection();
                                det.Source = "zoom-roster-panel";
                                foreach (string r in roster) AddParticipant(det, r);
                                EmitPulse(det, "zoom", "Participants panel", ts);
                            }
                        }
                        catch (Exception) { }
                    }

                    // Zoom alert bubbles: where the Ctrl+2 active-speaker
                    // announcement (and other alerts) appear. Only consulted
                    // while a Zoom MEETING window exists, and — when the probe
                    // drives detection — only shortly after a probe was sent,
                    // so unrelated alert toasts cannot leak in as speakers
                    // (the blocklist alone fails open on unknown alert texts).
                    bool bubbleWindowOpen = !zoomProbe || (ts - LastZoomProbe <= zoomProbeMs + 2500);
                    if (hasZoomDesktop && bubbleWindowOpen)
                    {
                        foreach (AutomationElement bubble in tops.ZoomBubbles)
                        {
                            try
                            {
                                List<UiNode> nodes = ScanNodes(bubble, 200);
                                Detection det = new Detection();
                                det.Source = "zoom-bubble";
                                for (int i = 0; i < nodes.Count; i++)
                                {
                                    if (nodes[i].ControlType != "Text" && nodes[i].ControlType != "Pane") continue;
                                    string speaker = ZoomBubbleSpeaker(nodes[i].Name);
                                    if (speaker != null) AddSpeaker(det, speaker);
                                }
                                EmitPulse(det, "zoom", "Zoom alert bubble", ts);
                            }
                            catch (Exception) { }
                        }
                    }

                    // Optional legacy Ctrl+2 probe ("Read active speaker name").
                    if (hasZoomDesktop && zoomProbe && ts - LastZoomProbe >= zoomProbeMs)
                    {
                        bool foreground = IsZoomMeetingForeground(tops.Meetings);
                        if (foreground || zoomGlobalHotkey)
                        {
                            if (SendCtrl2()) LastZoomProbe = ts;
                        }
                        else if (!HintedZoomBackground)
                        {
                            HintedZoomBackground = true;
                            EmitStatus("info",
                                "Zoom meeting detected but its window is in the background. Bring it to the " +
                                "foreground, or set 'Read active speaker name' (Ctrl+2) as a GLOBAL shortcut in " +
                                "Zoom Settings > Keyboard Shortcuts and restart with -ZoomGlobalHotkey.");
                        }
                    }

                    // Emit a windows snapshot when the set changes and every ~5s.
                    StringBuilder kb = new StringBuilder();
                    foreach (Dictionary<string, object> wi in windowInfos)
                    {
                        kb.Append((string)wi["platform"]).Append('|').Append((string)wi["title"]).Append('|');
                        kb.Append(((bool)wi["treeOk"]) ? "ok" : "low").Append(';');
                    }
                    string windowsKey = kb.ToString();
                    bool periodic = tick % periodEvery == 0;
                    if (windowsKey != lastWindowsKey || periodic || once)
                    {
                        lastWindowsKey = windowsKey;
                        Dictionary<string, object> snap = new Dictionary<string, object>();
                        snap["type"] = "windows";
                        snap["windows"] = windowInfos;
                        snap["ts"] = ts;
                        Emit(snap);
                    }
                }
                catch (Exception ex)
                {
                    EmitStatus("error", string.Format("Poll failed: {0}", ex.Message));
                }

                tick++;
                if (once) break;
                Thread.Sleep(pollMs);
            }
        }

        static void EmitPulse(Detection det, string platform, string title, long ts)
        {
            if (det.Speakers.Count == 0 && det.Participants.Count == 0) return;
            Dictionary<string, object> pulse = new Dictionary<string, object>();
            pulse["type"] = "pulse";
            pulse["platform"] = platform;
            pulse["speakers"] = det.Speakers;
            if (det.Participants.Count > 0) pulse["participants"] = det.Participants;
            pulse["windowTitle"] = title;
            pulse["source"] = det.Source;
            pulse["ts"] = ts;
            Emit(pulse);
        }

        // ---------------------------------------------------------------
        // Simulate mode: synthetic speakers to exercise the full pipeline.
        // ---------------------------------------------------------------

        public static void Simulate(int pollMs)
        {
            EmitStatus("info", "Simulate mode: emitting synthetic speaker activity (no real meeting).");

            string[][] phaseNames = new string[][] {
                new string[] { "Alice Johnson" },
                new string[] { },
                new string[] { "Bob Martinez" },
                new string[] { "Bob Martinez", "Carol Nguyen" },
                new string[] { },
                new string[] { "Carol Nguyen" },
                new string[] { },
            };
            int[] phaseDurations = new int[] { 4000, 1500, 6000, 2500, 1200, 3000, 2000 };

            int phase = 0;
            int sinceSnapshot = 0;
            long phaseStart = NowMs();
            while (true)
            {
                long now = NowMs();
                if (now - phaseStart >= phaseDurations[phase])
                {
                    phase = (phase + 1) % phaseNames.Length;
                    phaseStart = now;
                }

                if (sinceSnapshot == 0)
                {
                    Dictionary<string, object> snap = new Dictionary<string, object>();
                    List<Dictionary<string, object>> wins = new List<Dictionary<string, object>>();
                    Dictionary<string, object> wi = new Dictionary<string, object>();
                    wi["platform"] = "meet";
                    wi["title"] = "Simulated standup – Google Meet";
                    wi["nodeCount"] = 999;
                    wins.Add(wi);
                    snap["type"] = "windows";
                    snap["windows"] = wins;
                    snap["ts"] = now;
                    Emit(snap);
                }
                sinceSnapshot = (sinceSnapshot + 1) % 10;

                string[] speakers = phaseNames[phase];
                if (speakers.Length > 0)
                {
                    Dictionary<string, object> pulse = new Dictionary<string, object>();
                    pulse["type"] = "pulse";
                    pulse["platform"] = "meet";
                    pulse["speakers"] = new List<string>(speakers);
                    pulse["participants"] = new List<string>(new string[] {
                        "Alice Johnson", "Bob Martinez", "Carol Nguyen" });
                    pulse["windowTitle"] = "Simulated standup – Google Meet";
                    pulse["source"] = "simulate";
                    pulse["ts"] = now;
                    Emit(pulse);
                }

                Thread.Sleep(pollMs);
            }
        }

        // ---------------------------------------------------------------
        // Dump mode: write each meeting window's UIA tree to a file for
        // tuning detection heuristics against the real apps.
        // ---------------------------------------------------------------

        public static void Dump(int maxNodes)
        {
            TopWindows tops = FindTopWindows();
            List<KeyValuePair<string, AutomationElement>> targets =
                new List<KeyValuePair<string, AutomationElement>>();
            foreach (MeetingWindow w in tops.Meetings)
            {
                AutomationElement scope = (w.Platform == "zoom" && !w.IsBrowser)
                    ? w.Element : GetDocument(w);
                if (scope == null) scope = w.Element;
                targets.Add(new KeyValuePair<string, AutomationElement>(
                    w.Platform + " '" + w.Title + "'", scope));
            }

            // Snapshot audio peaks too — lets you verify metering in one shot.
            SampleAudio();
            StringBuilder peaks = new StringBuilder();
            peaks.Append("playback[");
            foreach (KeyValuePair<string, float> kv in RenderPeaks)
                peaks.AppendFormat(" {0}={1:0.000}", kv.Key, kv.Value);
            peaks.Append(" ] mic-capture[");
            foreach (KeyValuePair<string, float> kv in CapturePeaks)
                peaks.AppendFormat(" {0}={1:0.000}", kv.Key, kv.Value);
            peaks.Append(" ]");
            EmitStatus("info", "Audio peaks now: " + peaks.ToString());
            foreach (AutomationElement p in tops.ZoomPanels)
                targets.Add(new KeyValuePair<string, AutomationElement>("zoom-participants-panel", p));
            foreach (AutomationElement b in tops.ZoomBubbles)
                targets.Add(new KeyValuePair<string, AutomationElement>("zoom-bubble", b));

            // Always list every titled top-level window: this is how you spot a
            // meeting tab the classifier missed (wrong title pattern etc.).
            EmitStatus("info", "Top-level windows visible to UIA:");
            CacheRequest crAll = new CacheRequest();
            crAll.Add(AutomationElement.NameProperty);
            crAll.Add(AutomationElement.ClassNameProperty);
            crAll.Add(AutomationElement.ProcessIdProperty);
            AutomationElementCollection all;
            using (crAll.Activate())
            {
                all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            }
            foreach (AutomationElement el in all)
            {
                try
                {
                    if (string.IsNullOrEmpty(el.Cached.Name)) continue;
                    EmitStatus("info", string.Format("window: '{0}' class={1} proc={2}",
                        el.Cached.Name, el.Cached.ClassName, GetProcName(el.Cached.ProcessId)));
                }
                catch (Exception) { }
            }

            if (targets.Count == 0)
            {
                EmitStatus("warn", "No meeting windows classified — nothing to dump. " +
                    "Check the window list above for your meeting window's exact title.");
                return;
            }

            Directory.CreateDirectory("logs");
            int idx = 0;
            foreach (KeyValuePair<string, AutomationElement> target in targets)
            {
                idx++;
                List<UiNode> nodes;
                try
                {
                    nodes = ScanNodes(target.Value, maxNodes);
                    // Chromium first-contact warm-up: tiny tree means a11y was
                    // just switched on by our query; rescan once after a pause.
                    if (nodes.Count < 50)
                    {
                        Thread.Sleep(800);
                        nodes = ScanNodes(target.Value, maxNodes);
                    }
                }
                catch (Exception ex)
                {
                    EmitStatus("warn", string.Format("Dump failed for {0}: {1}", target.Key, ex.Message));
                    continue;
                }
                string fileName = Path.Combine("logs", string.Format(
                    "uia-dump-{0}-{1:yyyyMMdd-HHmmss}.ndjson", idx, DateTime.Now));
                using (StreamWriter sw = new StreamWriter(fileName, false, new UTF8Encoding(false)))
                {
                    Dictionary<string, object> header = new Dictionary<string, object>();
                    header["window"] = target.Key;
                    header["nodeCount"] = nodes.Count;
                    sw.WriteLine(Json.Serialize(header));
                    foreach (UiNode n in nodes)
                    {
                        Dictionary<string, object> row = new Dictionary<string, object>();
                        row["n"] = n.Name;
                        row["t"] = n.ControlType;
                        row["c"] = n.ClassName;
                        row["a"] = n.AutomationId;
                        sw.WriteLine(Json.Serialize(row));
                    }
                }
                EmitStatus("info", string.Format("Dumped {0} nodes for {1} to {2}",
                    nodes.Count, target.Key, fileName));
            }
        }

        // ---------------------------------------------------------------
        // Self-test: fixture-based tests for classifiers and detectors.
        // ---------------------------------------------------------------

        static int Failures;

        static void Check(string testName, bool condition, string detail)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["type"] = "selftest";
            d["name"] = testName;
            d["pass"] = condition;
            if (!condition) d["detail"] = detail;
            d["ts"] = NowMs();
            Emit(d);
            if (!condition) Failures++;
        }

        static void CheckList(string testName, List<string> actual, string[] expected)
        {
            string a = string.Join("|", actual.ToArray());
            string w = string.Join("|", expected);
            Check(testName, a == w, string.Format("expected [{0}] got [{1}]", w, a));
        }

        public static int SelfTest()
        {
            Failures = 0;

            // --- window classification ---
            Check("classify meet by tab title",
                ClassifyWindow("Meet – abc-defg-hij – Google Chrome", "chrome", "Chrome_WidgetWin_1") == "meet", "");
            Check("classify meet by product name",
                ClassifyWindow("Weekly sync - Google Meet - Microsoft Edge", "msedge", "Chrome_WidgetWin_1") == "meet", "");
            Check("classify rejects google docs",
                ClassifyWindow("Meeting notes - Google Docs - Google Chrome", "chrome", "Chrome_WidgetWin_1") == null, "");
            Check("classify rejects non-browser meet title",
                ClassifyWindow("Meet – abc-defg-hij", "notepad", "Notepad") == null, "");
            Check("classify zoom meeting window",
                ClassifyWindow("Zoom Meeting", "Zoom", "ZPContentViewWndClass") == "zoom", "");
            Check("classify zoom by class with topic title",
                ClassifyWindow("Quarterly planning", "Zoom", "ZPContentViewWndClass") == "zoom", "");
            Check("classify rejects zoom home window",
                ClassifyWindow("Zoom Workplace", "Zoom", "ZPPTMainFrmWndClassEx") == null, "");
            Check("classify teams",
                ClassifyWindow("Standup | Microsoft Teams", "ms-teams", "TeamsWebView") == "teams", "");

            // --- name cleaning ---
            Check("clean name strips (You)", CleanName("Alice Johnson (You)") == "Alice Johnson", CleanName("Alice Johnson (You)"));
            Check("clean name strips (Host, me)", CleanName("Bob (Host, me)") == "Bob", CleanName("Bob (Host, me)"));
            Check("clean name collapses spaces", CleanName("  Carol   Nguyen ") == "Carol Nguyen", "");

            // --- person-name heuristic ---
            Check("name: plain name ok", IsLikelyPersonName("Alice Johnson"), "");
            Check("name: rejects HOST badge", !IsLikelyPersonName("HOST"), "");
            Check("name: rejects sentence", !IsLikelyPersonName("Please join the meeting now."), "");
            Check("name: rejects chat text", !IsLikelyPersonName("From Alice to everyone: hi"), "");
            Check("name: rejects UI label", !IsLikelyPersonName("Turn on captions"), "");

            // --- generic detector ---
            List<UiNode> generic = new List<UiNode>();
            generic.Add(new UiNode("Mute", "Button"));
            generic.Add(new UiNode("Alice Johnson is speaking", "Image"));
            generic.Add(new UiNode("Bob Martinez, talking", "ListItem"));
            generic.Add(new UiNode("Chat", "Button"));
            CheckList("generic detector finds speaking labels",
                DetectGeneric(generic).Speakers, new string[] { "Alice Johnson", "Bob Martinez" });

            List<UiNode> quiet = new List<UiNode>();
            quiet.Add(new UiNode("Mute", "Button"));
            quiet.Add(new UiNode("Alice Johnson", "Text"));
            CheckList("generic detector finds nothing in quiet tree",
                DetectGeneric(quiet).Speakers, new string[] { });

            // --- Meet caption extraction (class-anchored) ---
            List<UiNode> meet1 = new List<UiNode>();
            meet1.Add(new UiNode("Mute", "Button"));
            meet1.Add(new UiNode("Captions", "Group"));
            meet1.Add(new UiNode("", "Image"));
            meet1.Add(new UiNode("Alice Johnson", "Text", "KcIKyf jxFHg"));
            meet1.Add(new UiNode("Hello everyone, let's get started", "Text", "bh44bd VbkSUe"));
            List<string[]> meetBlocks = ExtractMeetCaptionBlocks(meet1);
            Check("meet captions: one block extracted", meetBlocks.Count == 1,
                string.Format("got {0}", meetBlocks.Count));
            Check("meet captions: speaker name", meetBlocks.Count == 1 && meetBlocks[0][0] == "Alice Johnson",
                meetBlocks.Count == 1 ? meetBlocks[0][0] : "(none)");

            // --- Meet caption extraction (structural fallback: Image then Text) ---
            List<UiNode> meet2 = new List<UiNode>();
            meet2.Add(new UiNode("Captions", "Group"));
            meet2.Add(new UiNode("", "Image"));
            meet2.Add(new UiNode("Bob Martinez", "Text"));
            meet2.Add(new UiNode("I can share my screen", "Text"));
            List<string[]> meetBlocks2 = ExtractMeetCaptionBlocks(meet2);
            Check("meet captions: structural fallback", meetBlocks2.Count == 1 && meetBlocks2[0][0] == "Bob Martinez",
                meetBlocks2.Count > 0 ? meetBlocks2[0][0] : "(none)");

            // --- caption change semantics ---
            ResetCaptionState();
            CheckList("captions: first sight sets baseline, no speaker",
                CaptionSpeakers(meetBlocks, "t1"), new string[] { });
            CheckList("captions: unchanged text -> no speaker",
                CaptionSpeakers(meetBlocks, "t1"), new string[] { });
            List<string[]> grown = new List<string[]>();
            grown.Add(new string[] { "Alice Johnson", "Hello everyone, let's get started with the roadmap" });
            CheckList("captions: grown text -> speaker pulse",
                CaptionSpeakers(grown, "t1"), new string[] { "Alice Johnson" });
            List<string[]> switched = new List<string[]>();
            switched.Add(new string[] { "Bob Martinez", "Thanks Alice" });
            CheckList("captions: new author -> new speaker",
                CaptionSpeakers(switched, "t1"), new string[] { "Bob Martinez" });

            // --- Teams caption extraction ---
            List<UiNode> teams1 = new List<UiNode>();
            teams1.Add(new UiNode("Leave", "Button"));
            teams1.Add(new UiNode("", "Group", "fui-ChatMessageCompact r1abcdef"));
            teams1.Add(new UiNode("Carol Nguyen", "Text", "fui-ChatMessageCompact__author x1"));
            teams1.Add(new UiNode("the deadline is on friday", "Text", "fui-ChatMessageCompact__body x2"));
            List<string[]> teamsBlocks = ExtractTeamsCaptionBlocks(teams1);
            Check("teams captions: block extracted", teamsBlocks.Count == 1 && teamsBlocks[0][0] == "Carol Nguyen",
                teamsBlocks.Count > 0 ? teamsBlocks[0][0] + " / " + teamsBlocks[0][1] : "(none)");

            // --- Zoom roster parsing ---
            List<UiNode> zoomList = new List<UiNode>();
            zoomList.Add(new UiNode("In the Meeting (3), expanded", "ListItem"));
            zoomList.Add(new UiNode("Crispy Chris,(Co-host, me), Computer audio unmuted,Video on", "ListItem"));
            zoomList.Add(new UiNode("UsherBot,(Host), No Audio Connected,Video on", "ListItem"));
            zoomList.Add(new UiNode("Terri H, Computer audio unmuted,Video on", "ListItem"));
            CheckList("zoom roster parse",
                ParseZoomRoster(zoomList), new string[] { "Crispy Chris", "UsherBot", "Terri H" });

            // --- Zoom video tiles (exact strings from a live Zoom 7.x dump) ---
            List<UiNode> zoomTiles = new List<UiNode>();
            zoomTiles.Add(new UiNode("Speaker Video renders, use arrow key to navigate, and press tab for more options", "Pane"));
            zoomTiles.Add(new UiNode("Bidheyak Thapa(Host, me), Computer audio unmuted,Video off, Active speaker", "Pane"));
            zoomTiles.Add(new UiNode("Video content Sabitri, Computer audio unmuted,Video off", "Pane"));
            zoomTiles.Add(new UiNode("Zoom Video Container", "Pane"));
            List<ZoomTile> tiles = ParseZoomVideoTiles(zoomTiles);
            Check("zoom tiles: two tiles parsed", tiles.Count == 2, string.Format("{0}", tiles.Count));
            Check("zoom tiles: active speaker + self marker found",
                tiles.Count == 2 && tiles[0].Name == "Bidheyak Thapa" && tiles[0].ActiveSpeaker && tiles[0].IsSelf,
                tiles.Count > 0 ? tiles[0].Name + "/" + tiles[0].ActiveSpeaker + "/" + tiles[0].IsSelf : "(none)");
            Check("zoom tiles: silent remote participant parsed",
                tiles.Count == 2 && tiles[1].Name == "Sabitri" && !tiles[1].ActiveSpeaker && !tiles[1].IsSelf,
                tiles.Count > 1 ? tiles[1].Name + "/" + tiles[1].ActiveSpeaker : "(none)");

            // Self (me) tile is active speaker: gated by MIC-CAPTURE, not playback.
            Detection zoomSelf = Detect("zoom", zoomTiles, "zg1", false, true);
            CheckList("zoom: self badge + mic-capture -> self speaker",
                zoomSelf.Speakers, new string[] { "Bidheyak Thapa" });
            Check("zoom: self name captured", zoomSelf.SelfName == "Bidheyak Thapa", zoomSelf.SelfName);
            CheckList("zoom: participants from tiles", zoomSelf.Participants,
                new string[] { "Bidheyak Thapa", "Sabitri" });
            Detection zoomSelfNoMic = Detect("zoom", zoomTiles, "zg1b", true, false);
            Check("zoom: self badge but only playback audio -> no speaker",
                zoomSelfNoMic.Speakers.Count == 0, string.Format("{0}", zoomSelfNoMic.Speakers.Count));

            // Remote tile is active speaker: gated by PLAYBACK, not mic-capture.
            List<UiNode> zoomRemoteTiles = new List<UiNode>();
            zoomRemoteTiles.Add(new UiNode("Bidheyak Thapa(Host, me), Computer audio unmuted,Video off", "Pane"));
            zoomRemoteTiles.Add(new UiNode("Video content Sabitri, Computer audio unmuted,Video off, Active speaker", "Pane"));
            Detection zoomRemote = Detect("zoom", zoomRemoteTiles, "zg2", true, false);
            CheckList("zoom: remote badge + playback -> remote speaker",
                zoomRemote.Speakers, new string[] { "Sabitri" });
            Detection zoomRemoteNoAudio = Detect("zoom", zoomRemoteTiles, "zg2b", false, false);
            Check("zoom: lingering remote badge without audio -> no speaker",
                zoomRemoteNoAudio.Speakers.Count == 0, string.Format("{0}", zoomRemoteNoAudio.Speakers.Count));

            // --- zoom web classification (exact title from a live dump) ---
            Check("classify zoom web tab",
                ClassifyWindow("Bidheyak Thapa's Zoom Meeting - Google Chrome", "chrome", "Chrome_WidgetWin_1") == "zoom", "");
            Check("classify rejects zoom marketing tab",
                ClassifyWindow("Zoom pricing plans - Google Chrome", "chrome", "Chrome_WidgetWin_1") == null, "");

            // --- zoom WEB tree parsing (exact nodes from a live dump) ---
            List<UiNode> zoomWeb = new List<UiNode>();
            zoomWeb.Add(new UiNode("You are muted now.", "Text"));
            zoomWeb.Add(new UiNode("unmute my microphone", "Button", "footer-button-base__button join-audio-container__btn"));
            zoomWeb.Add(new UiNode("open the manage participants list pane,1 particpants", "Button", "footer-button__button"));
            zoomWeb.Add(new UiNode("Bidheyak Thapa", "Image", "video-avatar__avatar-img"));
            zoomWeb.Add(new UiNode("Bidheyak Thapa", "Text", ""));
            ZoomWeb zw = ParseZoomWeb(zoomWeb);
            Check("zoom web: in-meeting detected", zw.InMeeting, "");
            Check("zoom web: self muted detected", zw.SelfMuted, "");
            Check("zoom web: participant count parsed", zw.Count == 1, string.Format("{0}", zw.Count));
            CheckList("zoom web: name extracted", zw.Names, new string[] { "Bidheyak Thapa" });

            Detection zwDet = Detect("zoom", zoomWeb, "zw1", false, true);
            Check("zoom web: self name resolved", zwDet.SelfName == "Bidheyak Thapa", zwDet.SelfName);
            Check("zoom web: self muted propagated (no false self-speaker)",
                zwDet.SelfMuted && zwDet.Speakers.Count == 0,
                string.Format("muted={0} speakers={1}", zwDet.SelfMuted, zwDet.Speakers.Count));

            // unmuted web variant -> mic audio attributes to the real name
            List<UiNode> zoomWebLive = new List<UiNode>();
            zoomWebLive.Add(new UiNode("mute my microphone", "Button", "footer-button-base__button"));
            zoomWebLive.Add(new UiNode("open the manage participants list pane,1 particpants", "Button", "footer-button__button"));
            zoomWebLive.Add(new UiNode("Bidheyak Thapa", "Image", "video-avatar__avatar-img"));
            Detection zwLive = Detect("zoom", zoomWebLive, "zw2", false, true);
            Check("zoom web live: not muted", !zwLive.SelfMuted, "");
            Check("zoom web live: self name resolved", zwLive.SelfName == "Bidheyak Thapa", zwLive.SelfName);

            // 2-person web call (exact dump shape): one tile has the avatar-img
            // class, the other exposes its name only as plain Text leaves.
            List<UiNode> zoomWeb2 = new List<UiNode>();
            zoomWeb2.Add(new UiNode("Press (Alt+A) to unmute your microphone", "Text"));
            zoomWeb2.Add(new UiNode("Home", "Text"));   // header label before footer -> must NOT be a name
            zoomWeb2.Add(new UiNode("unmute my microphone", "Button", "footer-button-base__button join-audio-container__btn"));
            zoomWeb2.Add(new UiNode("open the manage participants list pane,2 particpants", "Button", "footer-button__button"));
            zoomWeb2.Add(new UiNode("End", "Button", "footer-button__button"));
            zoomWeb2.Add(new UiNode("Bidheyak Thapa", "Image", "video-avatar__avatar-img"));
            zoomWeb2.Add(new UiNode("Bidheyak Thapa", "Text", ""));
            zoomWeb2.Add(new UiNode("Sabitri", "Text", ""));
            zoomWeb2.Add(new UiNode("Sabitri", "Text", ""));
            ZoomWeb zw2 = ParseZoomWeb(zoomWeb2);
            Check("zoom web 2p: count parsed", zw2.Count == 2, string.Format("{0}", zw2.Count));
            CheckList("zoom web 2p: both names, header excluded", zw2.Names,
                new string[] { "Bidheyak Thapa", "Sabitri" });

            Check("zoom host name from title",
                ZoomHostName("Bidheyak Thapa's Zoom Meeting - Google Chrome") == "Bidheyak Thapa",
                ZoomHostName("Bidheyak Thapa's Zoom Meeting - Google Chrome"));
            Check("zoom host name: none for plain title",
                ZoomHostName("Zoom Workplace") == "", ZoomHostName("Zoom Workplace"));

            // --- Meet tile-class speaking detection (captionless) ---
            List<UiNode> meetTiles = new List<UiNode>();
            meetTiles.Add(new UiNode("Leave call", "Button"));
            meetTiles.Add(new UiNode("", "Group", "oZRSLe Oaajhc"));        // speaking indicator class
            meetTiles.Add(new UiNode("Alice Johnson", "Text", "notranslate zWGUib"));
            Detection meetTileDet = Detect("meet", meetTiles, "mt1", false, false);
            CheckList("meet tile-class speaker detected (no captions, no audio gate)",
                meetTileDet.Speakers, new string[] { "Alice Johnson" });

            List<UiNode> meetQuietTiles = new List<UiNode>();
            meetQuietTiles.Add(new UiNode("Leave call", "Button"));
            meetQuietTiles.Add(new UiNode("", "Group", "oZRSLe gjg47c")); // silent class only
            meetQuietTiles.Add(new UiNode("Alice Johnson", "Text", "notranslate zWGUib"));
            Detection meetQuietDet = Detect("meet", meetQuietTiles, "mt2", false, false);
            Check("meet quiet tile -> no speaker", meetQuietDet.Speakers.Count == 0,
                string.Format("{0}", meetQuietDet.Speakers.Count));

            // --- Meet mic state + roster + self/remote (exact dump strings) ---
            List<UiNode> meetFull = new List<UiNode>();
            meetFull.Add(new UiNode("", "Group", "oZRSLe"));
            meetFull.Add(new UiNode("Sabitri Thapa", "Text", ""));
            meetFull.Add(new UiNode("", "Group", "oZRSLe"));
            meetFull.Add(new UiNode("Bidheyak Thapa", "Text", ""));
            meetFull.Add(new UiNode("Bidheyak Thapa", "ListItem", "cxdMu KV1GEc"));
            meetFull.Add(new UiNode("Meeting host", "Text", ""));
            meetFull.Add(new UiNode("Sabitri Thapa", "ListItem", "cxdMu KV1GEc"));
            meetFull.Add(new UiNode("Mute Sabitri Thapa's microphone", "Button", ""));
            meetFull.Add(new UiNode("Turn off microphone", "Button", "")); // action => mic is ON
            meetFull.Add(new UiNode("Leave call", "Button", ""));
            meetFull.Add(new UiNode("Your microphone is turned on.", "Text", ""));

            Check("meet mic state: unmuted from 'Turn off microphone'",
                DetectMeetMicState(meetFull) == Mic.Unmuted, string.Format("{0}", DetectMeetMicState(meetFull)));
            MeetRoster mr = ParseMeetRoster(meetFull);
            Check("meet roster: self = host (not host-mutable)", mr.Self == "Bidheyak Thapa", mr.Self);
            Check("meet roster: Sabitri is remote", mr.Remotes.Contains("Sabitri Thapa"),
                string.Join(",", mr.Remotes.ToArray()));
            Detection meetF = Detect("meet", meetFull, "mf1", false, false);
            Check("meet: SelfName resolved", meetF.SelfName == "Bidheyak Thapa", meetF.SelfName);
            Check("meet: MicState unmuted", meetF.MicState == Mic.Unmuted, string.Format("{0}", meetF.MicState));
            CheckList("meet: RemoteNames = [Sabitri]", meetF.RemoteNames, new string[] { "Sabitri Thapa" });
            CheckList("meet: participants from roster", meetF.Participants,
                new string[] { "Sabitri Thapa", "Bidheyak Thapa" });

            List<UiNode> meetMuted = new List<UiNode>();
            meetMuted.Add(new UiNode("Turn on microphone", "Button", "")); // action => mic is OFF
            meetMuted.Add(new UiNode("Leave call", "Button", ""));
            meetMuted.Add(new UiNode("Your microphone is turned off.", "Text", ""));
            Check("meet mic state: muted from 'Turn on microphone'",
                DetectMeetMicState(meetMuted) == Mic.Muted, string.Format("{0}", DetectMeetMicState(meetMuted)));
            Detection meetM = Detect("meet", meetMuted, "mf2", false, true); // self mic-capture hot
            Check("meet: muted self not emitted by Detect", meetM.Speakers.Count == 0,
                string.Format("{0}", meetM.Speakers.Count));
            Check("meet: MicState muted blocks self fallback", meetM.MicState == Mic.Muted, "");

            // --- Zoom desktop: muted self must not be logged ---
            List<UiNode> zoomMutedSelf = new List<UiNode>();
            zoomMutedSelf.Add(new UiNode("Bidheyak Thapa(Host, me), Computer audio muted,Video off", "Pane"));
            zoomMutedSelf.Add(new UiNode("Video content Sabitri, Computer audio unmuted,Video off, Active speaker", "Pane"));
            Detection zMute = Detect("zoom", zoomMutedSelf, "zm1", false, true); // self capturing (talking while muted)
            Check("zoom desktop: self tile muted -> MicState muted", zMute.MicState == Mic.Muted,
                string.Format("{0}", zMute.MicState));
            Check("zoom desktop: muted self not added as speaker",
                !zMute.Speakers.Contains("Bidheyak Thapa"), string.Join(",", zMute.Speakers.ToArray()));

            // --- Teams mic state ---
            List<UiNode> teamsLive = new List<UiNode>();
            teamsLive.Add(new UiNode("Mute", "Button", ""));
            Check("teams mic state: 'Mute' action => unmuted",
                DetectTeamsMicState(teamsLive) == Mic.Unmuted, "");
            List<UiNode> teamsMutedMic = new List<UiNode>();
            teamsMutedMic.Add(new UiNode("Unmute", "Button", ""));
            Check("teams mic state: 'Unmute' action => muted",
                DetectTeamsMicState(teamsMutedMic) == Mic.Muted, "");

            // --- Teams WEB (exact strings from a live dump) ---
            Check("classify teams web tab (not meet!)",
                ClassifyWindow("Meet App | BIDHEYAK THAPA | Microsoft Teams - Google Chrome", "chrome", "Chrome_WidgetWin_1") == "teams",
                "" + ClassifyWindow("Meet App | BIDHEYAK THAPA | Microsoft Teams - Google Chrome", "chrome", "Chrome_WidgetWin_1"));
            Check("classify teams.live.com tab",
                ClassifyWindow("Meeting | Microsoft Teams - Google Chrome", "chrome", "Chrome_WidgetWin_1") == "teams", "");

            List<UiNode> teamsWeb = new List<UiNode>();
            UiNode twHangup = new UiNode("Leave", "Button");
            twHangup.AutomationId = "hangup-button";
            teamsWeb.Add(new UiNode("Elapsed time 02:14", "Text", "fui-Primitive"));
            teamsWeb.Add(new UiNode("Mute mic", "Button", "fui-Button r1f29ykk"));
            teamsWeb.Add(twHangup);
            teamsWeb.Add(new UiNode("Myself video, BIDHEYAK THAPA, Unmuted, Has context menu", "Image",
                "fui-Primitive vdi-dynamic-occlusion ___12xuzcr"));
            teamsWeb.Add(new UiNode("Test Unverified, Context menu is available", "MenuItem", "fui-Flex"));

            List<TeamsTile> twTiles = ParseTeamsTiles(teamsWeb);
            Check("teams web: self tile + remote item parsed", twTiles.Count == 2,
                string.Format("{0}", twTiles.Count));
            Check("teams web: self tile name + unmuted",
                twTiles.Count > 0 && twTiles[0].Name == "BIDHEYAK THAPA" && twTiles[0].IsSelf && twTiles[0].Unmuted,
                twTiles.Count > 0 ? twTiles[0].Name + "/" + twTiles[0].IsSelf + "/" + twTiles[0].Unmuted : "(none)");

            Detection twDet = Detect("teams", teamsWeb, "tw1", false, true);
            Check("teams web: SelfName resolved", twDet.SelfName == "BIDHEYAK THAPA", twDet.SelfName);
            Check("teams web: MicState unmuted from tile", twDet.MicState == Mic.Unmuted,
                string.Format("{0}", twDet.MicState));
            CheckList("teams web: participants incl. remote", twDet.Participants,
                new string[] { "BIDHEYAK THAPA", "Test Unverified" });
            CheckList("teams web: remote names", twDet.RemoteNames, new string[] { "Test Unverified" });

            // Muted self tile variant.
            List<UiNode> teamsWebMuted = new List<UiNode>();
            teamsWebMuted.Add(twHangup);
            teamsWebMuted.Add(new UiNode("Myself video, BIDHEYAK THAPA, Muted, Has context menu", "Image",
                "fui-Primitive vdi-dynamic-occlusion"));
            Detection twMuted = Detect("teams", teamsWebMuted, "tw2", false, true);
            Check("teams web: muted tile -> MicState muted", twMuted.MicState == Mic.Muted,
                string.Format("{0}", twMuted.MicState));

            // Remote tile variant ("NAME, Muted, ..." without Myself prefix).
            List<UiNode> teamsWebRemote = new List<UiNode>();
            teamsWebRemote.Add(twHangup);
            teamsWebRemote.Add(new UiNode("Sabitri Thapa, Unmuted, Has context menu", "Image", "fui-Primitive"));
            Detection twRemote = Detect("teams", teamsWebRemote, "tw3", false, false);
            CheckList("teams web: remote tile -> RemoteNames", twRemote.RemoteNames, new string[] { "Sabitri Thapa" });
            Check("teams web: remote tile does not set self", twRemote.SelfName == "", twRemote.SelfName);

            // Remote roster items (exact dump strings): an UNMUTED remote has NO
            // mute token at all — "NAME, Context menu is available"; muted adds
            // a lowercase "muted" token.
            List<UiNode> teamsWebRemote2 = new List<UiNode>();
            teamsWebRemote2.Add(twHangup);
            teamsWebRemote2.Add(new UiNode("Test Unverified, Context menu is available", "MenuItem", "fui-Flex"));
            Detection twR2 = Detect("teams", teamsWebRemote2, "tw4", false, false);
            CheckList("teams web: unmuted remote (no mute token) -> RemoteNames",
                twR2.RemoteNames, new string[] { "Test Unverified" });

            List<TeamsTile> mutedRemote = ParseTeamsTiles(new List<UiNode> {
                new UiNode("Test Unverified, muted, Context menu is available", "MenuItem", "fui-Flex") });
            Check("teams web: muted remote parsed with lowercase token",
                mutedRemote.Count == 1 && !mutedRemote[0].Unmuted && !mutedRemote[0].IsSelf,
                mutedRemote.Count > 0 ? mutedRemote[0].Name + "/" + mutedRemote[0].Unmuted : "(none)");

            // --- Teams ring detection ---
            List<UiNode> teamsRing = new List<UiNode>();
            UiNode hangup = new UiNode("Leave", "Button");
            hangup.AutomationId = "hangup-button";
            teamsRing.Add(hangup);
            teamsRing.Add(new UiNode("", "Group", "fui-Primitive vdi-frame-occlusion"));
            teamsRing.Add(new UiNode("Carol Nguyen", "Text", "ui-text"));
            Detection teamsRingDet = Detect("teams", teamsRing, "tr1", false, false);
            CheckList("teams ring speaker detected", teamsRingDet.Speakers, new string[] { "Carol Nguyen" });

            // --- call-marker gating ---
            ResetCaptionState();
            List<UiNode> teamsChat = new List<UiNode>();   // a Teams CHAT window: rows but no call controls
            teamsChat.Add(new UiNode("", "Group", "fui-ChatMessageCompact r1"));
            teamsChat.Add(new UiNode("Carol Nguyen", "Text", "fui-ChatMessageCompact__author x1"));
            teamsChat.Add(new UiNode("lunch at noon?", "Text", "fui-ChatMessageCompact__body x2"));
            Detection chatDet1 = Detect("teams", teamsChat, "gate1", false, false);
            teamsChat[2] = new UiNode("lunch at noon? or one?", "Text", "fui-ChatMessageCompact__body x2");
            Detection chatDet2 = Detect("teams", teamsChat, "gate1", false, false);
            Check("teams chat window produces no speakers (no call markers)",
                chatDet1.Speakers.Count == 0 && chatDet2.Speakers.Count == 0,
                string.Format("{0}/{1}", chatDet1.Speakers.Count, chatDet2.Speakers.Count));

            ResetCaptionState();
            List<UiNode> teamsMeeting = new List<UiNode>(teamsChat);
            teamsMeeting.Insert(0, hangup);
            Detect("teams", teamsMeeting, "gate2", false, false); // baseline
            teamsMeeting[3] = new UiNode("lunch at noon? or maybe one thirty", "Text", "fui-ChatMessageCompact__body x2");
            Detection meetDet = Detect("teams", teamsMeeting, "gate2", false, false);
            CheckList("teams meeting window detects caption speaker",
                meetDet.Speakers, new string[] { "Carol Nguyen" });

            ResetCaptionState();
            List<UiNode> meetNoCall = new List<UiNode>();  // browser tab mentioning Meet, not in a call
            meetNoCall.Add(new UiNode("Captions", "Group"));
            meetNoCall.Add(new UiNode("", "Image"));
            meetNoCall.Add(new UiNode("Alice Johnson", "Text", "KcIKyf jxFHg"));
            meetNoCall.Add(new UiNode("some article text", "Text"));
            Detect("meet", meetNoCall, "gate3", false, false);
            meetNoCall[3] = new UiNode("some article text changed", "Text");
            Detection noCallDet = Detect("meet", meetNoCall, "gate3", false, false);
            Check("meet without call controls produces no speakers",
                noCallDet.Speakers.Count == 0, string.Format("{0}", noCallDet.Speakers.Count));

            ResetCaptionState();
            List<UiNode> meetInCall = new List<UiNode>(meetNoCall);
            meetInCall.Insert(0, new UiNode("Leave call", "Button"));
            Detect("meet", meetInCall, "gate4", false, false); // baseline
            meetInCall[4] = new UiNode("hello team, quick update from me", "Text");
            Detection inCallDet = Detect("meet", meetInCall, "gate4", false, false);
            CheckList("meet in-call detects caption speaker",
                inCallDet.Speakers, new string[] { "Alice Johnson" });

            // --- generic detector restricted to zoom + audio-gated ---
            ResetCaptionState();
            List<UiNode> meetPhantom = new List<UiNode>();
            meetPhantom.Add(new UiNode("Leave call", "Button"));
            meetPhantom.Add(new UiNode("Dana Fox is speaking to the press today", "Text"));
            Detection phantomDet = Detect("meet", meetPhantom, "gate5", true, true);
            Check("caption text 'X is speaking' does not leak on meet",
                phantomDet.Speakers.Count == 0, string.Format("{0}", phantomDet.Speakers.Count));

            // --- Zoom bubble speaker extraction ---
            Check("zoom bubble: plain name accepted",
                ZoomBubbleSpeaker("Alice Johnson") == "Alice Johnson",
                "" + ZoomBubbleSpeaker("Alice Johnson"));
            Check("zoom bubble: join alert rejected",
                ZoomBubbleSpeaker("Bob Martinez has joined the meeting") == null, "");
            Check("zoom bubble: chat alert rejected",
                ZoomBubbleSpeaker("From Carol to everyone: hello") == null, "");
            Check("zoom bubble: host-muted alert rejected",
                ZoomBubbleSpeaker("The host muted you") == null, "");
            Check("zoom bubble: speaking prefix stripped",
                ZoomBubbleSpeaker("Speaking: Dave Lee") == "Dave Lee",
                "" + ZoomBubbleSpeaker("Speaking: Dave Lee"));
            Check("zoom bubble: recording alert rejected",
                ZoomBubbleSpeaker("Recording in progress") == null,
                "" + ZoomBubbleSpeaker("Recording in progress"));
            Check("zoom bubble: transcription alert rejected",
                ZoomBubbleSpeaker("Live transcription enabled") == null,
                "" + ZoomBubbleSpeaker("Live transcription enabled"));
            Check("zoom bubble: name containing Recording still accepted",
                ZoomBubbleSpeaker("Alice Recording") == "Alice Recording",
                "" + ZoomBubbleSpeaker("Alice Recording"));

            ResetCaptionState();

            Dictionary<string, object> summary = new Dictionary<string, object>();
            summary["type"] = "selftest-summary";
            summary["failures"] = Failures;
            summary["ts"] = NowMs();
            Emit(summary);
            return Failures == 0 ? 0 : 1;
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies @(
  'UIAutomationClient', 'UIAutomationTypes', 'System.Web.Extensions'
) -ErrorAction Stop

if ($SelfTest) {
  exit [MeetingSpeakerEngine.Engine]::SelfTest()
}
if ($Dump) {
  [MeetingSpeakerEngine.Engine]::Dump($MaxNodes)
  exit 0
}
if ($Simulate) {
  [MeetingSpeakerEngine.Engine]::Simulate($PollMs)
  exit 0
}
[MeetingSpeakerEngine.Engine]::Run($PollMs, $MaxNodes, [bool]$Once, [bool]$ZoomProbe, $ZoomProbeMs, [bool]$ZoomGlobalHotkey, [float]$RemoteAudioThreshold, [float]$MicAudioThreshold)
