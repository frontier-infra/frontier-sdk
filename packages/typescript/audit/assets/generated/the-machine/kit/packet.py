"""Render — the dated conformance packet, and the test matrix (a derived view).

The packet separates what v0 actually verified (static) from what it declared
not-run (chaos), so a reader can never mistake "not measured" for "passed."
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .obligations import OBLIGATIONS

MARK = {"PASS": "✓ PASS", "PARTIAL": "~ PARTIAL", "FAIL": "✗ FAIL", "NOT_RUN": "· NOT-RUN", "NA": "– NA"}


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _row_to_json(o, r) -> dict:
    return {
        "evidence": r.evidence,
        "obligation": {
            "id": o.id,
            "kind": o.kind,
            "level": o.level,
            "plane": o.plane,
            "shape": o.shape,
            "title": o.title,
            "vnext": o.vnext,
        },
        "status": r.status,
    }


def score_to_json_data(s: dict) -> dict:
    """Normalize a score result into deterministic, SDK-friendly JSON data.

    The JSON shape intentionally carries no timestamp. The score is a static structural
    candidate from repo content; dates belong to human markdown packets, not orchestration
    payloads that SDKs may hash, diff, or replay.
    """
    rows = [_row_to_json(o, r) for o, r in s["rows"]]
    return {
        "ambiguous": s["ambiguous"],
        "assessment_kind": s["assessment_kind"],
        "blockers": [_row_to_json(o, r) for o, r in s["blockers"]],
        "classification_reason": s["classification_reason"],
        "deployment": s["deployment"],
        "detected_shape": s["detected_shape"],
        "full_conformance_claimed": False,
        "is_deployment": s["is_deployment"],
        "kit_version": s["kit_version"],
        "live_checks_executed": False,
        "next_level_name": s["next_level_name"],
        "next_static_candidate_level_name": s["next_static_candidate_level_name"],
        "notices": [
            "Static structural candidate only; this is not full conformance.",
            "Chaos/replay obligations are declared NOT_RUN in v0 and must be executed before claiming conformance.",
        ],
        "not_run": [_row_to_json(o, r) for o, r in s["not_run"]],
        "root": s["root"],
        "rows": rows,
        "schema_version": "the-machine.conformance.score.v1",
        "shape": s["shape"],
        "spec": s["spec"],
        "static_candidate_level": s["static_candidate_level"],
        "static_candidate_level_name": s["static_candidate_level_name"],
        "tally": {f"L{level}": s["tally"][level] for level in sorted(s["tally"])},
        "vnext": [_row_to_json(o, r) for o, r in s["vnext"].values()],
    }


def render_score_json(s: dict) -> str:
    return json.dumps(score_to_json_data(s), indent=2, sort_keys=True)


def _render_non_deployment(s: dict) -> str:
    """Render a refused classification — no level, cited evidence.

    Refusal covers both non-deployments and ambiguous auto-shape results. Honest:
    show WHAT the kit looked for and why the requested ladder cannot be applied,
    instead of floor-bumping to a meaningless or mislabeled level.
    """
    out: list[str] = []
    out.append(f"# Conformance packet — {s['deployment']}")
    out.append(f"_Kit {s['kit_version']} · static/structural · {_today()} · shape: {s.get('shape', 'machine')} · against {s['spec']}_\n")
    out.append(f"## {s['confirmed_level_name']}")
    out.append(f"> {s['classification_reason']}.")
    if s["confirmed_level_name"] == "AMBIGUOUS DEPLOYMENT SHAPE":
        out.append("> Auto-detect found evidence for more than one shape. The kit declines to choose "
                   "the more flattering label; declare the intended shape and re-run so Machine-L* "
                   "and Orchestrator-L* stamps cannot be laundered across shapes.\n")
    else:
        out.append("> The six-box ladder describes a long-running agent: durable state · a deterministic "
                   "driver loop · fresh workers · verify-at-a-gate. A signing library, a web-protocol "
                   "spec, or the standard itself is not a deployment, so the kit declines to assign it a "
                   "level rather than report a meaningless 'Machine L1'. Score a *wiring* of The Machine.\n")
    out.append("### What the kit looked for (evidence-cited)")
    out.append("| Status | L | Obligation | Evidence |")
    out.append("|---|---|---|---|")
    for o, r in s["rows"]:
        if r.status == "NOT_RUN":
            continue
        ev = r.evidence.replace("|", "\\|")
        out.append(f"| {MARK[r.status]} | L{o.level} | {o.title} | {ev} |")
    out.append("")
    out.append("_Classification is deterministic from repo content; re-running yields the same verdict._")
    return "\n".join(out)


def render_packet(s: dict) -> str:
    if not s.get("is_deployment", True):
        return _render_non_deployment(s)
    L = s["static_candidate_level"]
    level_name = s.get("static_candidate_level_name", s["confirmed_level_name"])
    next_name = s.get("next_static_candidate_level_name", s["next_level_name"])
    out: list[str] = []
    out.append(f"# Conformance packet — {s['deployment']}")
    out.append(f"_Kit {s['kit_version']} · static/structural · {_today()} · against {s['spec']}_\n")
    out.append(f"## Static structural candidate: **{level_name}**")
    out.append("> This is not full conformance. It is the highest level at which every *static* "
               "obligation <= that level is a clean PASS. PARTIAL/FAIL cap the static candidate "
               "and are listed as blockers. Chaos/replay checks are NOT-RUN in v0 and remain "
               "required before claiming executed conformance.\n")

    # vNext deltas headline
    out.append("**vNext deltas (the obligations the 2026-06-14 ratification added):**")
    for oid in ("delta1_reversibility", "gov_override", "gov_contract_enforce", "delta3_heartbeat", "delta3_anomaly"):
        if oid in s["vnext"]:
            o, r = s["vnext"][oid]
            out.append(f"- {MARK[r.status]} — {o.title}")
    out.append("")

    # per-level tally
    out.append("| Level | PASS | PARTIAL | FAIL | NOT-RUN |")
    out.append("|---|---|---|---|---|")
    for lvl in sorted(s["tally"]):
        t = s["tally"][lvl]
        out.append(f"| L{lvl} | {t['PASS']} | {t['PARTIAL']} | {t['FAIL']} | {t['NOT_RUN']} |")
    out.append("")

    # blockers to next level
    if s["blockers"]:
        out.append(f"### To raise the static candidate to {next_name} — clear these")
        for o, r in s["blockers"]:
            out.append(f"- {MARK[r.status]} **{o.title}** — {r.evidence}")
        out.append("")

    # full evidence table
    out.append("### Full obligation results (evidence-cited)")
    out.append("| Status | L | Obligation | Evidence |")
    out.append("|---|---|---|---|")
    for o, r in s["rows"]:
        if r.status == "NOT_RUN":
            continue
        ev = r.evidence.replace("|", "\\|")
        tag = " ·Δ" if o.vnext else ""
        out.append(f"| {MARK[r.status]} | L{o.level} | {o.title}{tag} | {ev} |")
    out.append("")

    # not-run (no silent gaps)
    out.append("### Declared NOT-RUN in v0 (need a live deployment — chaos/replay)")
    for o, r in s["not_run"]:
        out.append(f"- · **{o.title}** — {r.evidence}")
    out.append("")
    out.append("_Static score is deterministic from repo content; re-running yields the same "
               "candidate level. Only this packet's date moves. Full conformance still requires "
               "executed chaos/replay evidence._")
    return "\n".join(out)


def render_matrix() -> str:
    out = ["# The Machine — Conformance Test Matrix",
           "_Derived view of `kit/obligations.py` (single source of truth). "
           "Regenerate: `python -m kit matrix`._\n",
           "| ID | Obligation | Plane | Level | Kind | Δ | What passing looks like |",
           "|---|---|---|---|---|---|---|"]
    for o in OBLIGATIONS:
        d = "Δ" if o.vnext else ""
        ev = o.evidence.replace("|", "\\|")
        out.append(f"| `{o.id}` | {o.title} | {o.plane} | L{o.level} | {o.kind} | {d} | {ev} |")
    out.append("\n**Kind:** `static` = the v0 runner checks it now · `chaos` = needs a live "
               "deployment, declared NOT-RUN in v0 (never faked).")
    return "\n".join(out)
