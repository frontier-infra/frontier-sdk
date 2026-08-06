"""The conformance kit CLI.

    python -m kit score <repo> [--out FILE]   # score a deployment, emit a markdown packet
    python -m kit score <repo> --format json  # score a deployment, emit SDK-friendly JSON
    python -m kit matrix [--out FILE]          # render the test matrix (derived view)

Static/structural only (v0). Chaos/replay obligations are declared NOT-RUN. The kit
reports a static structural candidate; it never modifies a deployment and does not
issue full conformance certificates.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .packet import render_matrix, render_packet, render_score_json
from .score import score_repo


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="kit", description="The Machine — conformance kit (v0).")
    sub = p.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("score", help="Score a deployment repo against the vNext obligations.")
    sc.add_argument("repo")
    sc.add_argument("--name", default=None)
    sc.add_argument("--out", default=None)
    sc.add_argument("--shape", choices=["auto", "machine", "orchestrator"], default="auto",
                    help="deployment shape (default: auto-detect; machine = Dumb Driver, orchestrator = model-in-loop)")
    sc.add_argument("--format", choices=["markdown", "json"], default="markdown",
                    help="score output format (default: markdown)")
    sc.add_argument("--json", action="store_true",
                    help="emit machine-readable JSON (same as --format json)")
    mx = sub.add_parser("matrix", help="Render the test matrix from obligations.py.")
    mx.add_argument("--out", default=None)
    args = p.parse_args(argv)

    if args.cmd == "matrix":
        text = render_matrix()
    else:
        if not Path(args.repo).exists():
            print(f"[FAIL] repo not found: {args.repo}", file=sys.stderr)
            return 1
        s = score_repo(args.repo, args.name, args.shape)
        fmt = "json" if args.json else args.format
        text = render_score_json(s) if fmt == "json" else render_packet(s)
        det = ""
        if s.get("detected_shape"):
            det = f"  [auto: {s['detected_shape']}" + ("; conflicting shape signals — declare --shape]" if s.get("ambiguous") else "]")
        if s.get("is_deployment", True):
            print(f"[{s['deployment']}] static structural candidate: {s['static_candidate_level_name']}  "
                  f"(blockers to {s['next_static_candidate_level_name']}: {len(s['blockers'])}; not-run: {len(s['not_run'])}){det}",
                  file=sys.stderr)
        else:
            print(f"[{s['deployment']}] {s['confirmed_level_name']} — {s['classification_reason']}{det}",
                  file=sys.stderr)

    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
