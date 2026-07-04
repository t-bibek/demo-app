# Native-Zoom live QA evidence — Zoom 7.0.5, 2026-07-04

Captured live against a real 2-participant native-Zoom call (host = David Thapa
self, remote = Guest Alpha joined via the Zoom web client in headful Chrome with
a fake-device audio tone, admitted from the waiting room). Detector run with
`MSD_AUTOSTART=1 MSD_RUN_SECONDS=…`. Raw `[event]` lines, trimmed to the fields
that matter.

## Detection + roster + self (panel OPEN)
```
meeting_initialized  {platform:zoom, meeting_id:zoom::meeting, participant_count:2, title:"Zoom Meeting"}
participant_joined   {name:"David Thapa", is_local:true,  is_muted:false}   # self via "(Host, me)"
participant_joined   {name:"Guest Alpha", is_local:false, is_muted:false}
speech_on            {name:"Guest Alpha", source:"zoom.mute_gate"}          # single unmuted remote -> NAMED
```

## Honest fallback (panel CLOSED)
With the Participants panel closed, native Zoom still exposes name + mute in the
GRID TILE OVERLAYS ("Guest Alpha, Computer audio unmuted") — but NOT the "(me)"
self marker, which lives only in the panel rows. So self can't be identified and
both unmuted names count as remote-eligible → honest anonymous floor:
```
speech_on            {name:"Someone", source:"audio.someone"}
```
This refines docs/zoom-native-detection.md §7: panel-closed does not zero the
roster on 7.0.5 (tile overlays persist), but it DOES drop self-identification,
which is what forces "Someone" for a 2-unmuted call.

## Mute state flips with the mic, not with speech (no-covariance)
Driving Guest Alpha's mic from the web side flipped ONLY the mute clause, with
no speaking token appearing anywhere in the AX tree — the fixture pair
native-grid-2p-panelopen-{talk,silent}.json captures exactly this (talk =
"Guest Alpha, Computer audio unmuted", silent = "…muted"; everything else
identical). Confirms the documented ceiling: native Zoom has no AX speaking
signal; attribution is audio-VAD + mute-gate only.
