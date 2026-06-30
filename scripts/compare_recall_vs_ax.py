#!/usr/bin/env python3
"""
Compare Recall's speaker ground-truth against our MeetProbe AX detection.

Recall's desktop-SDK debug log (RECALLAI_DESKTOP_SDK_DEV=1 npm run start:debug)
prints lines like:

    👤 [participant-hint] participant_events.speech_on → { ...json... }
    👤 [participant-hint] participant_events.speech_off → { ...json... }

each carrying {action, participant:{id,name,is_host}, timestamp:{absolute,relative}}.
Participant ids split into AX roster ids (>=1000, e.g. 32766) and VAD audio-stream
ids (0,1,2…) — speaking is tracked on the VAD stream, names from the AX roster.

This script turns those events into per-participant speaking INTERVALS (the ground
truth) and scores our MeetProbe timeline.jsonl (the AX signal: kssMZb) against them,
aligned on the absolute wall clock (MeetProbe now logs "wall" = epoch seconds).

Usage:
  python3 compare_recall_vs_ax.py RECALL_DEBUG.log OUR_timeline.jsonl
  python3 compare_recall_vs_ax.py RECALL_DEBUG.log OUR_timeline.jsonl --map Host=Bibek
  python3 compare_recall_vs_ax.py RECALL_DEBUG.log --oracle   # just print recall intervals
Both tools must run in the SAME meeting (overlapping wall-clock) to compare.
"""
import sys, os, re, json, argparse
from datetime import datetime


def iso_epoch(s):
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def norm(name):
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def parse_recall_log(path):
    """Extract speech_on/off events from the debug log (multi-line JSON aware)."""
    text = open(path, encoding="utf-8", errors="replace").read()
    dec = json.JSONDecoder()
    events = []
    for m in re.finditer(r"participant_events\.(speech_on|speech_off)\s*(?:→|->)", text):
        b = text.find("{", m.end())
        if b < 0:
            continue
        try:
            obj, _ = dec.raw_decode(text, b)
        except json.JSONDecodeError:
            continue
        d = obj.get("data", obj)
        if not isinstance(d, dict):
            continue
        action = d.get("action")
        p = d.get("participant", {}) or {}
        ts = iso_epoch((d.get("timestamp") or {}).get("absolute"))
        if action in ("speech_on", "speech_off") and ts is not None:
            events.append((ts, action, p.get("id"), p.get("name")))
    events.sort(key=lambda e: e[0])
    return events


def build_intervals(events):
    """speech_on→speech_off per participant NAME (union over AX+VAD ids)."""
    open_on, intervals = {}, []
    id_kinds = {}
    for ts, action, pid, name in events:
        n = norm(name)
        id_kinds.setdefault(n, set()).add("AX-roster" if isinstance(pid, int) and pid >= 1000 else "VAD-audio")
        if action == "speech_on":
            open_on.setdefault(n, ts)
        elif action == "speech_off" and n in open_on:
            intervals.append((n, open_on.pop(n), ts))
    # close any dangling on-intervals at the last event time
    if events:
        last = events[-1][0]
        for n, t0 in open_on.items():
            intervals.append((n, t0, last))
    return intervals, id_kinds


def speaking_at(intervals, epoch):
    return {n for (n, a, b) in intervals if a <= epoch <= b}


def parse_speaker_timeline(data):
    """The downloaded speaker_timeline.json: [{participant, start_timestamp, end_timestamp}]."""
    intervals, id_kinds = [], {}
    for seg in data:
        p = seg.get("participant", {}) or {}
        n = norm(p.get("name"))
        a = iso_epoch((seg.get("start_timestamp") or {}).get("absolute"))
        b = iso_epoch((seg.get("end_timestamp") or {}).get("absolute"))
        if a is None or b is None:
            continue
        intervals.append((n, a, b))
        pid = p.get("id")
        id_kinds.setdefault(n, set()).add(
            "AX-roster" if isinstance(pid, int) and pid >= 1000 else "VAD-audio")
    return intervals, id_kinds


def load_recall(path):
    """Auto-detect: speaker_timeline.json (array) or a raw start:debug log (text)."""
    head = open(path, encoding="utf-8", errors="replace").read(256).lstrip()
    if head.startswith("["):
        try:
            data = json.load(open(path, encoding="utf-8", errors="replace"))
            if isinstance(data, list) and data and "start_timestamp" in data[0]:
                return parse_speaker_timeline(data)
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            pass
    return build_intervals(parse_recall_log(path))


def parse_our_log(path):
    """ticks: [(wall_epoch, t_rel, {name_norm: speaking_bool})]"""
    out = []
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        wall = r.get("wall")
        if wall is None:
            continue
        pred = {}
        for t in r.get("tiles", []):
            pred[norm(t.get("name"))] = bool(t.get("speaking"))
        out.append((wall, r.get("t"), pred))
    return out


def fmt_intervals(intervals, t0):
    return ", ".join(f"{n}:{a-t0:.1f}-{b-t0:.1f}" for (n, a, b) in intervals)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recall_log")
    ap.add_argument("our_jsonl", nargs="?")
    ap.add_argument("--map", action="append", default=[],
                    help="rename Recall→ours, e.g. --map Host=Bibek Thapa")
    ap.add_argument("--oracle", action="store_true",
                    help="just print Recall intervals (+ an oracle= string)")
    args = ap.parse_args()

    intervals, id_kinds = load_recall(args.recall_log)
    if not intervals:
        print("No speaking intervals parsed from the Recall input. Check the file/format.")
        return
    rmap = {}
    for kv in args.map:
        if "=" in kv:
            k, v = kv.split("=", 1)
            rmap[norm(k)] = norm(v)
    intervals = [(rmap.get(n, n), a, b) for (n, a, b) in intervals]

    rt0 = min(a for (_, a, _) in intervals)
    rt1 = max(b for (_, _, b) in intervals)
    print(f"== Recall ground truth ==  {len(intervals)} speaking intervals")
    for n in sorted(set(i[0] for i in intervals)):
        kinds = ",".join(sorted(id_kinds.get(n, set()) | id_kinds.get(n, set())))
        segs = [(a, b) for (m, a, b) in intervals if m == n]
        tot = sum(b - a for a, b in segs)
        print(f"   {n:20} {len(segs):2} segs, {tot:5.1f}s speaking   ids: {kinds}")
    if args.oracle or not args.our_jsonl:
        print("\noracle= (relative to Recall start, paste into MeetProbe if co-timed):")
        print("  oracle=" + ",".join(f"{n.split()[0]}:{a-rt0:.0f}-{b-rt0:.0f}"
                                      for (n, a, b) in intervals))
        return

    ticks = parse_our_log(args.our_jsonl)
    if not ticks:
        print("\nOur log has no 'wall' timestamps — rebuild MeetProbe and re-run.")
        return
    ot0, ot1 = ticks[0][0], ticks[-1][0]
    lo, hi = max(rt0, ot0), min(rt1, ot1)
    print(f"\n== Our MeetProbe AX log ==  {len(ticks)} ticks")
    print(f"Recall window  {datetime.fromtimestamp(rt0):%H:%M:%S}–{datetime.fromtimestamp(rt1):%H:%M:%S}")
    print(f"Our    window  {datetime.fromtimestamp(ot0):%H:%M:%S}–{datetime.fromtimestamp(ot1):%H:%M:%S}")
    if lo >= hi:
        print("\n⚠️  NO TIME OVERLAP — the two runs weren't simultaneous. Do one co-run:")
        print("    start the Recall demo (start:debug) AND MeetProbe in the SAME call.")
        return

    # Score our 'speaking' (kssMZb) per (name × tick) against Recall truth, in overlap.
    names = sorted({n for (n, _, _) in intervals} |
                   {nm for (_, _, pred) in ticks for nm in pred})
    per = {n: {"tp": 0, "fp": 0, "fn": 0} for n in names}
    any_tp = any_fp = any_fn = compared = 0
    for wall, _, pred in ticks:
        if not (lo <= wall <= hi):
            continue
        compared += 1
        truth = speaking_at(intervals, wall)
        pred_set = {n for n, sp in pred.items() if sp}
        for n in names:
            p, t = n in pred_set, n in truth
            if p and t: per[n]["tp"] += 1
            elif p and not t: per[n]["fp"] += 1
            elif t and not p: per[n]["fn"] += 1
        # "anyone speaking" agreement
        if pred_set and truth: any_tp += 1
        elif pred_set and not truth: any_fp += 1
        elif truth and not pred_set: any_fn += 1

    print(f"\nCompared {compared} ticks in the {hi-lo:.0f}s overlap.\n")
    print(f"{'participant':20} {'prec':>6} {'recall':>7} {'tp':>4} {'fp':>4} {'fn':>4}")
    for n in names:
        d = per[n]
        pr = 100 * d["tp"] / (d["tp"] + d["fp"]) if d["tp"] + d["fp"] else 0
        rc = 100 * d["tp"] / (d["tp"] + d["fn"]) if d["tp"] + d["fn"] else 0
        if d["tp"] + d["fp"] + d["fn"] == 0:
            continue
        print(f"{n:20} {pr:5.0f}% {rc:6.0f}% {d['tp']:4} {d['fp']:4} {d['fn']:4}")
    apr = 100 * any_tp / (any_tp + any_fp) if any_tp + any_fp else 0
    arc = 100 * any_tp / (any_tp + any_fn) if any_tp + any_fn else 0
    print(f"\nANYONE-speaking agreement: precision {apr:.0f}%  recall {arc:.0f}%"
          f"  (tp={any_tp} fp={any_fp} fn={any_fn})")
    print("→ our AX 'speaking' = kssMZb. High fp/fn vs Recall's VAD ground truth"
          " quantifies how unreliable the AX class is.")


if __name__ == "__main__":
    main()
