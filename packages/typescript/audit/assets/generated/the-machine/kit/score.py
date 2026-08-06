"""Scoring — run every obligation against a deployment, aggregate to a static candidate.

The SCORE is a deterministic function of repo content (static checks), so a re-run
yields the same static candidate level and per-obligation statuses. Only the packet's
timestamp moves.

The candidate level is strict and honest: the highest conformance level L at which
EVERY static obligation with level <= L is a clean PASS. A PARTIAL or FAIL at level L
caps the deployment below L, and is reported as a blocker, not hidden. Chaos
obligations are NOT_RUN in v0 and never count toward the static candidate; they are
listed so the gap is visible, never silently assumed covered.
"""
from __future__ import annotations

from .checks import CHECKS, CheckResult, RepoView
from .obligations import OBLIGATIONS

LEVEL_NAMES = {0: "L0 Look-Alike", 1: "L1 Declared", 2: "L2 Instrumented",
               3: "L3 Enforced", 4: "L4 Receipted", 5: "L5 Trusted Autonomy"}

SHAPE_LABEL = {"machine": "Machine", "orchestrator": "Orchestrator"}
KEYSTONE = {"machine": "box2_driver", "orchestrator": "orch_keystone"}  # the shape's "is this a deployment?" check
ORCH_CEILING = 4   # an orchestrator may reach L4 (Receipted); L5 (Trusted Autonomy) is barred (vNext Δ7)


def _run_rows(repo: RepoView, shape: str):
    rows = []
    for o in OBLIGATIONS:
        if o.shape not in ("any", shape):      # skip the other shape's obligations
            continue
        if o.kind == "chaos":
            res = CheckResult("NOT_RUN", o.evidence)
        else:
            res = CHECKS[o.id](repo)
        rows.append((o, res))
    return rows


def _confirmed_level(rows) -> int:
    level = 0
    for L in (1, 2, 3, 4, 5):
        at = [(o, r) for (o, r) in rows if o.kind == "static" and o.level <= L]
        if at and all(r.status == "PASS" for (_, r) in at):
            level = L
    if level == 0 and any(o.plane == "box" and r.status in ("PASS", "PARTIAL") for (o, r) in rows):
        level = 1
    return level


def _classify(rows, shape: str) -> tuple[bool, str]:
    """Is this repo a deployment of the requested shape?

    Each shape has one keystone check: `machine` → Box 2 (the dumb driver), `orchestrator`
    → the Orchestrator Keystone. Keystone absent ⇒ not a deployment of that shape, and the
    kit declines a level (refuses the L1 floor-bump) instead of reporting a meaningless level.
    A signing library / web spec / the standard itself has no keystone for either shape.
    """
    keystone = KEYSTONE[shape]
    for o, r in rows:
        if o.id == keystone:
            if r.status in ("PASS", "PARTIAL"):
                return True, ""
            noun = "deterministic driver loop" if shape == "machine" else "orchestrator keystone"
            return False, f"no {noun} — {o.title.split('(')[0].strip()} {r.status} ({r.evidence})"
    return True, ""  # keystone obligation absent from the set → don't misclassify


def _declared_shape(repo: RepoView) -> str | None:
    """Return an explicit shape declaration from executable config, if present.

    This is only a shape selector, not conformance evidence. The selected shape's
    keystone still has to pass before a level is assigned.
    """
    h = _first_shape(repo, "orchestrator")
    if h:
        return "orchestrator"
    h = _first_shape(repo, "machine")
    if h:
        return "machine"
    return None


def _first_shape(repo: RepoView, shape: str):
    return repo.grep(rf"\b(?:conformance_shape|deployment_shape)\s*:\s*['\"]?{shape}\b")


def _detect_shape(repo: RepoView) -> tuple[str, bool]:
    """Auto-pick the shape from structural signals (stdlib).

    An explicit executable-config declaration (`conformance_shape: ...` or
    `deployment_shape: ...`) selects the shape, then normal scoring verifies the
    keystone. Without a declaration, mixed Machine + Orchestrator signals are
    ambiguous and the caller must choose a shape explicitly; the kit must not
    silently stamp a Machine level for a model-in-loop template.
    """
    declared = _declared_shape(repo)
    if declared:
        return declared, False
    m = CHECKS["box2_driver"](repo).status in ("PASS", "PARTIAL")
    o = CHECKS["orch_keystone"](repo).status in ("PASS", "PARTIAL")
    if m and o:
        return "machine", True
    if o:
        return "orchestrator", False
    return "machine", False


def score_repo(root: str, name: str | None = None, shape: str = "machine") -> dict:
    repo = RepoView(root)
    detected, ambiguous = None, False
    if shape == "auto":
        shape, ambiguous = _detect_shape(repo)
        detected = shape
    rows = _run_rows(repo, shape)
    is_deployment, classification_reason = _classify(rows, shape)
    if ambiguous:
        is_deployment = False
        classification_reason = (
            "both Machine and Orchestrator keystone signals are present; declare --shape "
            "or add conformance_shape/deployment_shape to executable config"
        )
    level = _confirmed_level(rows) if is_deployment else None
    if level is not None and shape == "orchestrator":
        level = min(level, ORCH_CEILING)        # L5 Trusted Autonomy barred for orchestrators

    tally = {L: {"PASS": 0, "PARTIAL": 0, "FAIL": 0, "NOT_RUN": 0} for L in (2, 3, 4, 5)}
    for o, r in rows:
        tally.setdefault(o.level, {"PASS": 0, "PARTIAL": 0, "FAIL": 0, "NOT_RUN": 0})
        tally[o.level][r.status] = tally[o.level].get(r.status, 0) + 1

    label = SHAPE_LABEL[shape]
    if is_deployment:
        level_name = f"{label}-{LEVEL_NAMES[level]}"
        if shape == "orchestrator" and level >= ORCH_CEILING:
            next_name = "— (L5 Trusted Autonomy barred for orchestrators)"
        else:
            next_name = f"{label}-{LEVEL_NAMES[level + 1]}" if (level + 1) in LEVEL_NAMES else "—"
        blockers = [(o, r) for (o, r) in rows
                    if o.kind == "static" and o.level == level + 1 and r.status != "PASS"]
    else:
        level_name = "AMBIGUOUS DEPLOYMENT SHAPE" if ambiguous else (
            "NOT A MACHINE DEPLOYMENT" if shape == "machine" else "NOT AN ORCHESTRATOR"
        )
        next_name = "—"
        blockers = []
    vnext = {o.id: (o, r) for (o, r) in rows if o.vnext}
    not_run = [(o, r) for (o, r) in rows if r.status == "NOT_RUN"]

    return {
        "deployment": name or root.rstrip("/").split("/")[-1],
        "root": str(repo.root),
        "kit_version": "v0",
        "spec": "The Machine — Conformance Spec vNext (ratified 2026-06-14)",
        "assessment_kind": "static_structural_candidate" if is_deployment else "classification_refused",
        "shape": shape,
        "detected_shape": detected,
        "ambiguous": ambiguous,
        "is_deployment": is_deployment,
        "classification_reason": classification_reason,
        "static_candidate_level": level,
        "static_candidate_level_name": level_name,
        "next_static_candidate_level_name": next_name,
        # Backward-compatible aliases for existing callers. These are static-only
        # candidates, not full conformance certificates.
        "confirmed_level": level,
        "confirmed_level_name": level_name,
        "next_level_name": next_name,
        "tally": tally,
        "rows": rows,
        "vnext": vnext,
        "blockers": blockers,
        "not_run": not_run,
    }
