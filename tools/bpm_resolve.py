"""BPM voting, the Python twin of src/bpm.js (keep the two in step; both are tested with the same cases).

Several sources each cast a vote {value, source, confidence, doubt?}. The highest-priority vote is the tempo; the others
only decide the flag ('agree' or 'check'). A high-energy song detected slow is probably double-time, a low-energy song
detected fast is probably half-time. Your own edit always wins and is never adjusted.
"""
PRIORITY = ["override", "local", "preview", "acousticbrainz", "getsongbpm"]
LABEL = {"override": "edited", "local": "detected", "preview": "itunes-preview",
         "acousticbrainz": "acousticbrainz", "getsongbpm": "getsongbpm"}
DEFAULTS = dict(energyHi=0.7, bpmLow=100, energyLo=0.3, bpmHigh=150, tol=0.04, minBpm=50, maxBpm=220)


def relation(a, b, tol=DEFAULTS["tol"]):
    """How b relates to a: 'same', 'double' (2x), 'half' (a/2) or None."""
    for k, m in (("same", 1), ("double", 2), ("half", 0.5)):
        if abs(b - a * m) / (a * m) <= tol:
            return k
    return None


def _valid(v):
    try:
        return v.get("source") in PRIORITY and 40 <= float(v["value"]) <= 250
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def sort_votes(votes):
    out = []
    for v in votes or []:
        if _valid(v):
            c = v.get("confidence")
            out.append(dict(v, value=float(v["value"]), confidence=0.5 if c is None else min(1.0, max(0.0, float(c)))))
    return sorted(out, key=lambda v: (PRIORITY.index(v["source"]), -v["confidence"]))


def resolve_bpm(votes, energy=None, settings=None):
    """dict(bpm, detected, source, feel, flag, why, votes) or None without usable votes."""
    S = dict(DEFAULTS, **(settings or {}))
    vs = sort_votes(votes)
    if not vs:
        return None
    top = vs[0]
    if top["source"] == "override":
        return dict(bpm=top["value"], detected=top["value"], source="override", feel="normal", flag="agree",
                    why="set by you", votes=vs)
    bpm, feel, fixed, why = top["value"], "normal", False, []
    if energy is not None:
        if energy >= S["energyHi"] and bpm < S["bpmLow"] and bpm * 2 <= S["maxBpm"]:
            bpm, feel, fixed = round(bpm * 2, 1), "double", True
        elif energy <= S["energyLo"] and bpm > S["bpmHigh"] and bpm / 2 >= S["minBpm"]:
            bpm, feel, fixed = round(bpm / 2, 1), "half", True
    others = vs[1:]
    conflicts = [o for o in others if relation(bpm, o["value"], S["tol"]) != "same"]
    backers = [o for o in others if relation(bpm, o["value"], S["tol"]) == "same"]
    check = False
    if fixed:
        note = f"high/low energy suggests {feel}-time ({round(top['value'], 1):g} -> {bpm:g})"
        if backers:
            why.append(f"{note}, backed by {' + '.join(b['source'] for b in backers)}")
        else:
            check = True
            why.append(f"{note}: energy is the only evidence")
    if conflicts:
        check = True
        why.append("disagrees: " + ", ".join(
            f"{o['source']} {round(o['value'], 1):g}" + (f" ({relation(bpm, o['value'], S['tol'])} time)" if relation(bpm, o["value"], S["tol"]) else "")
            for o in conflicts))
    if top.get("doubt"):
        check = True
        why.append(top["doubt"])
    if not why:
        why.append(f"{len(vs)} sources agree" if others else f"only {top['source']} had a tempo")
    return dict(bpm=bpm, detected=top["value"], source=top["source"], feel=feel, flag="check" if check else "agree",
                why="; ".join(why), votes=vs)


def votes_text(votes):
    return " | ".join(f"{v['source']} {round(v['value'], 1):g} ({v['confidence']:.1f})" for v in sort_votes(votes))
