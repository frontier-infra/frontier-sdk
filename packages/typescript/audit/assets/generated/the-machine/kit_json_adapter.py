#!/usr/bin/env python3
"""Generated adapter for Frontier SDK audit snapshots.

This file contains no scoring semantics. It imports the canonical copied kit and
renders both its current Markdown packet and SDK-friendly JSON representation.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from kit.packet import render_packet, render_score_json
from kit.score import score_repo


def main() -> int:
    parser = argparse.ArgumentParser(prog="frontier-audit-kit-json-adapter")
    parser.add_argument("repo")
    parser.add_argument("--name", default=None)
    parser.add_argument("--shape", choices=["auto", "machine", "orchestrator"], default="auto")
    parser.add_argument("--json-out", required=True)
    parser.add_argument("--markdown-out", required=True)
    args = parser.parse_args()

    score = score_repo(args.repo, args.name, args.shape)
    Path(args.json_out).write_text(render_score_json(score) + "\n", encoding="utf-8")
    Path(args.markdown_out).write_text(render_packet(score) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
