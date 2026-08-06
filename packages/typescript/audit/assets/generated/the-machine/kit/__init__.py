"""The Machine — conformance kit (v0).

An executable scoreboard: it scores a deployment against The Machine — Conformance
Spec vNext and emits a dated, evidence-cited markdown packet or deterministic JSON
for SDK orchestration. Conformance is run, not asserted. v0 does static/structural
checks; chaos/replay obligations are declared NOT-RUN (never faked). See
`python -m kit --help`.
"""

from .packet import render_packet, render_score_json, score_to_json_data
from .score import score_repo

__all__ = ["render_packet", "render_score_json", "score_repo", "score_to_json_data"]
