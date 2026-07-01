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
.PARAMETER Watch             Live-sample Google Meet tiles + audio to logs\ for WatchSeconds (signal discovery).
.PARAMETER ZoomWatch         Live-observe Zoom's active speaker for WatchSeconds: prints who is speaking each
                             tick (raw ", Active speaker" badge + the audio-gated verdict the engine logs) and
                             writes an NDJSON timeline + per-speaker talk-window summary. The Windows analog of
                             the macOS ZoomProbe command.
.PARAMETER WatchSeconds      Duration in seconds for -Watch / -ZoomWatch (default 25).
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
  [switch]$Deep,
  [switch]$Watch,
  [switch]$ZoomWatch,
  [switch]$TeamsWatch,
  [int]$WatchSeconds = 25,
  [switch]$SelfTest,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# NOTE: compiled by Windows PowerShell 5.1 => C# 5 syntax only
# (no string interpolation, no ?. operator, no expression-bodied members).
# The C# engine is split into per-platform partial-class files under cs/
# (core + meet + zoom + teams). They are concatenated and compiled as ONE
# unit via Add-Type below: the `using`s and namespace-level types live in
# core.cs and apply to the whole compilation, and `partial class Engine`
# merges the platform members — behaviour is identical to the former single
# blob, just organised per platform. Order matters only in that core.cs
# (with the usings) must come first.
$csDir = Join-Path $PSScriptRoot 'cs'
$source = (
  (Get-Content -LiteralPath (Join-Path $csDir 'core.cs')  -Raw),
  (Get-Content -LiteralPath (Join-Path $csDir 'meet.cs')  -Raw),
  (Get-Content -LiteralPath (Join-Path $csDir 'zoom.cs')  -Raw),
  (Get-Content -LiteralPath (Join-Path $csDir 'teams.cs') -Raw)
) -join "`n"

Add-Type -TypeDefinition $source -ReferencedAssemblies @(
  'UIAutomationClient', 'UIAutomationTypes', 'System.Web.Extensions', 'WindowsBase'
) -ErrorAction Stop

if ($SelfTest) {
  exit [MeetingSpeakerEngine.Engine]::SelfTest()
}
if ($Dump) {
  [MeetingSpeakerEngine.Engine]::Dump($MaxNodes, [bool]$Deep)
  exit 0
}
if ($Watch) {
  [MeetingSpeakerEngine.Engine]::Watch($WatchSeconds, $MaxNodes)
  exit 0
}
if ($ZoomWatch) {
  [MeetingSpeakerEngine.Engine]::ZoomWatch($WatchSeconds, $MaxNodes, [float]$RemoteAudioThreshold, [float]$MicAudioThreshold)
  exit 0
}
if ($TeamsWatch) {
  [MeetingSpeakerEngine.Engine]::TeamsWatch($WatchSeconds, $MaxNodes, [float]$RemoteAudioThreshold, [float]$MicAudioThreshold)
  exit 0
}
if ($Simulate) {
  [MeetingSpeakerEngine.Engine]::Simulate($PollMs)
  exit 0
}
[MeetingSpeakerEngine.Engine]::Run($PollMs, $MaxNodes, [bool]$Once, [bool]$ZoomProbe, $ZoomProbeMs, [bool]$ZoomGlobalHotkey, [float]$RemoteAudioThreshold, [float]$MicAudioThreshold)
