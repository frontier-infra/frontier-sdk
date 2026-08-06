"""Static/structural checks — the v0 evidence layer.

Each check is a pure function (RepoView) -> CheckResult. It does NOT run the
deployment; it inspects its source for the structural signature of an obligation
and cites the file:line it found. That is honest static evidence, not a claim:
"found the reversibility term at driver.py:131" or "not found." Anything that
needs a LIVE deployment is a `chaos` obligation and is declared not-run by the
runner, never faked here.

Status vocabulary:
  PASS    — the structural signature is present.
  PARTIAL — present but weaker than the obligation requires (named in evidence).
  FAIL    — confirmed absent.
  NA      — not applicable to this deployment shape.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .obligations import OBLIGATIONS

SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next"}
# Evidence comes from what a deployment DOES (code + executable config), never from
# what it SAYS about itself. Prose docs (.md/.txt) are where conformance is *claimed* —
# scoring against them would be self-assertion (the exact thing the spec forbids), so
# they are excluded from the evidence search.
TEXT_EXT = {".py", ".js", ".ts", ".mjs", ".yaml", ".yml", ".json", ".toml", ".sh", ""}


@dataclass
class CheckResult:
    status: str            # PASS | PARTIAL | FAIL | NA
    evidence: str          # cited file:line, or a reason


class RepoView:
    """Read-only view over a deployment's source. Loads small text files once."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        if not self.root.exists():
            raise FileNotFoundError(f"repo not found: {self.root}")
        self._files: dict[Path, list[str]] = {}
        for p in self._walk():
            try:
                if p.stat().st_size > 600_000:
                    continue
                self._files[p] = p.read_text(encoding="utf-8", errors="replace").splitlines()
            except (OSError, ValueError):
                continue

    def _walk(self):
        for p in self.root.rglob("*"):
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if p.is_file() and p.suffix.lower() in TEXT_EXT:
                yield p

    def grep(self, pattern: str, globs: tuple[str, ...] | None = None) -> list[tuple[str, int, str]]:
        rx = re.compile(pattern, re.IGNORECASE)
        out: list[tuple[str, int, str]] = []
        for p, lines in self._files.items():
            if p.name in _SKIP_FILES or p.suffix == ".lock":   # ignore-config + dep manifests/lockfiles — declarations, not implementation
                continue
            if globs and not any(p.match(g) or p.name.endswith(g.lstrip("*")) for g in globs):
                continue
            in_block = False                    # inside a triple-quoted docstring/string
            for i, line in enumerate(lines, 1):
                here = in_block
                if (line.count('"""') + line.count("'''")) % 2 == 1:
                    in_block = not in_block
                if here or _is_comment(line):    # docstring/comment = the code *claiming* — self-assertion
                    continue
                if rx.search(line):
                    out.append((str(p.relative_to(self.root)), i, line.strip()))
        return out


_COMMENT_PREFIXES = ("#", "//", "*", '"""', "'''", "<!--", "/*", "---")
_SKIP_FILES = {".gitignore", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"}


def _is_comment(line: str) -> bool:
    """A pure comment / docstring / frontmatter line — excluded from evidence so the
    kit scores what a deployment DOES, not what its comments claim it does."""
    t = line.strip()
    return any(t.startswith(p) for p in _COMMENT_PREFIXES)


def _cite(hit: tuple[str, int, str]) -> str:
    path, ln, line = hit
    return f"{path}:{ln}: {line[:90]}"


def _first(repo: RepoView, patterns: list[str]):
    for pat in patterns:
        hits = repo.grep(pat)
        if hits:
            return hits[0]
    return None


def _present(repo: RepoView, patterns: list[str], absent_msg: str) -> CheckResult:
    h = _first(repo, patterns)
    return CheckResult("PASS", _cite(h)) if h else CheckResult("FAIL", absent_msg)


# --------------------------------------------------------------------------- #
# One function per static obligation id.
# --------------------------------------------------------------------------- #

def box0_contract(repo: RepoView) -> CheckResult:
    has_prop = repo.grep(r"proposed_by")
    has_rat = repo.grep(r"ratified_by")
    if has_prop and has_rat and repo.grep(r"acceptance_tests"):
        return CheckResult("PASS", _cite(has_rat[0]))
    cfg = _first(repo, [r"\brubric\b", r"scope_rails", r"definition_of_done"])
    if cfg:
        return CheckResult("PARTIAL", f"config-as-contract, no proposed_by/ratified_by — {_cite(cfg)}")
    return CheckResult("FAIL", "no contract artifact found")


def box0_ratified(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"ratified_by\s*[=!]=\s*proposed_by", r"ratified_by.*proposed_by",
                      r"independently ratified"])
    if h:
        return CheckResult("PASS", _cite(h))
    return CheckResult("FAIL", "no gate on ratified_by != proposed_by")


def box1_state(repo: RepoView) -> CheckResult:
    # atomic rename incl. os.replace(var) + pathlib tmp.replace(dst); excludes x.replace(/regex/)
    # (for example, route-trim `x.replace(/.../)`). ponytail: can't tell Path.replace from
    # str.replace(ident) without types — residual str-replace(ident) FPs are parser territory.
    atomic = _first(repo, [r"\.replace\((?!/)", r"\brename(?:Sync)?\(", r"checkpoint"])
    store = _first(repo, [r"kanban_store", r"item_vault", r"goal\.json", r"\.tmp"])
    if atomic:
        return CheckResult("PASS", _cite(atomic))
    if store:
        return CheckResult("PARTIAL", f"state store, atomicity unconfirmed — {_cite(store)}")
    return CheckResult("FAIL", "no durable state store / atomic write")


def box2_driver(repo: RepoView) -> CheckResult:
    return _present(repo, [r"the dumb.*driver", r"deterministic control", r"class TriageEngine",
                           r"def main\(.*driver", r"while True:"],
                    "no deterministic driver loop / engine")


def box3_workers(repo: RepoView) -> CheckResult:
    return _present(repo, [r"worker_cmd", r"fresh process", r"research_specs", r"fulfillment_specs",
                           r"one fresh"],
                    "no per-task fresh worker spawn")


def box4_verify(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"verify_cmd", r"verifier", r"proposal_actions", r"awaiting_approval",
                      r"verifier_id"])
    if not h:
        return CheckResult("FAIL", "no independent verifier")
    failclosed = _first(repo, [r"trust 0", r"trust\s*=\s*0", r"fail-closed", r"cannot verify",
                               r"refus", r"hard-den"])
    if failclosed:
        return CheckResult("PASS", _cite(failclosed))
    return CheckResult("PARTIAL", f"verifier present, fail-closed unconfirmed — {_cite(h)}")


def box5_dial(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"effective_mode", r"effective_autonomy", r"min\(.*ceiling", r"min\(.*trust",
                      r"autonomy.*=.*min"])
    if h:
        return CheckResult("PASS", _cite(h))
    pby = _first(repo, [r"propose.by.default", r"propose-only", r"dry-run"])
    if pby:
        return CheckResult("PARTIAL", f"propose-by-default, no explicit min(dial,ceiling,trust) — {_cite(pby)}")
    return CheckResult("FAIL", "no autonomy gate")


def delta1_reversibility(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"reversib", r"rollback_ref", r"IRREVERSIBLE", r"irreversible"])
    if h:
        return CheckResult("PASS", _cite(h))
    return CheckResult("FAIL", "Δ1: no reversibility term in the gate (pre-vNext)")


def gov_ceiling(repo: RepoView) -> CheckResult:
    return _present(repo, [r"autonomy_ceiling", r"ceiling"], "no autonomy ceiling enforcement")


def gov_verifier_trust(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"no verifier", r"trust\s*=\s*0", r"trust 0", r"verifier.*trust"])
    if h:
        return CheckResult("PASS", _cite(h))
    g = _first(repo, [r"awaiting_approval", r"human gate", r"proposal_actions"])
    if g:
        return CheckResult("PARTIAL", f"human gate present; binary verifier-trust rule not explicit — {_cite(g)}")
    return CheckResult("FAIL", "no verifier-trust requirement")


def gov_contract_enforce(repo: RepoView) -> CheckResult:
    hard = _first(repo, [r"hard-den", r"refus.*unratified", r"status\s*==\s*.?RATIFIED"])
    if hard:
        return CheckResult("PASS", _cite(hard))
    soft = _first(repo, [r"propose-only until", r"forced propose", r"require_status", r"not contract"])
    if soft:
        return CheckResult("PARTIAL", f"enforced as downgrade-to-propose, not hard-deny-at-driver — {_cite(soft)}")
    return CheckResult("FAIL", "Δ2: no contract enforcement")


def gov_override(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"operator.?override", r"override_effect_slo", r"non-bypassab"])
    if h:
        return CheckResult("PASS", _cite(h))
    return CheckResult("FAIL", "Δ2: no non-bypassable operator override with a bound SLO")


def gov_audit_hooks(repo: RepoView) -> CheckResult:
    chained = _first(repo, [r"prev_hash", r"hash-chain", r"append-only", r"signature-chain"])
    if chained:
        return CheckResult("PASS", _cite(chained))
    return CheckResult("FAIL", "no append-only/chained governance receipts")


def svc_aar(repo: RepoView) -> CheckResult:
    signed = _first(repo, [r"ed25519", r"\bnacl\b", r"signing_key", r"\.sign\(", r"did:web"])
    if signed:
        return CheckResult("PASS", _cite(signed))
    receipt = _first(repo, [r"aar\.jsonl", r"aar_append", r"AAR"])
    if receipt:
        return CheckResult("PARTIAL", f"receipts emitted but UNSIGNED — the L3→L4 line — {_cite(receipt)}")
    return CheckResult("FAIL", "no AAR receipts")


def svc_frontier_id(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"deployment_id", r"scope_id"])
    if h:
        return CheckResult("PASS", _cite(h))
    return CheckResult("FAIL", "receipts carry no stable deployment_id/scope_id")


def svc_contracts(repo: RepoView) -> CheckResult:
    return _present(repo, [r"max_worker_runs", r"max_wall_seconds", r"cost_gate", r"budget",
                           r"max_attempts"],
                    "no pre-mutation caps (retry/cost/concurrency)")


def svc_observability(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"def alert\(", r"telegram", r"hermes send", r"sendMessage", r"\balert\b"])
    if not h:
        return CheckResult("FAIL", "no alerting path")
    ack = _first(repo, [r"\back\b", r"acknowledg", r"escalat"])
    if ack:
        return CheckResult("PASS", _cite(ack))
    return CheckResult("PARTIAL", f"alerting present, no alert-with-ACK — {_cite(h)}")


def ops_idempotency(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"idempotency", r"idem_key", r"dedup", r"duplicate_threshold"])
    if h:
        enforce = _first(repo, [r"reject.*duplicate", r"second ACTIVE", r"already exists"])
        if enforce:
            return CheckResult("PASS", _cite(enforce))
        return CheckResult("PARTIAL", f"key/similarity present; cross-store duplicate-rejection not shown — {_cite(h)}")
    return CheckResult("FAIL", "no idempotency key")


def ops_quarantine(repo: RepoView) -> CheckResult:
    return _present(repo, [r"quarantin", r"\bblocked\b", r"shelve", r"max_attempts"],
                    "no terminal quarantine")


def ops_governor(repo: RepoView) -> CheckResult:
    halt = _first(repo, [r"BUDGET HALT", r"budget_halt", r"throttle", r"\bhalt\b"])
    if halt:
        return CheckResult("PASS", _cite(halt))
    env = _first(repo, [r"cost_gate", r"budget", r"max_wall"])
    if env:
        return CheckResult("PARTIAL", f"cost envelope declared; breach-halt not shown — {_cite(env)}")
    return CheckResult("FAIL", "no budget/resource governor")


def ops_nonbypass(repo: RepoView) -> CheckResult:
    gate = _first(repo, [r"def apply_mutation\(", r"class MutationGate", r"mutation.*chokepoint"])
    deny = _first(repo, [r"commit_denied", r"gate_denied", r"refus.*mutation"])
    if gate and deny:
        return CheckResult("PARTIAL", f"static chokepoint + denial path present; needs a chaos bypass probe to confirm — {_cite(gate)}")
    h = _first(repo, [r"only path", r"non-bypassab", r"the gate", r"single.*gate"])
    if h:
        return CheckResult("PARTIAL", f"single-gate intent present; needs a chaos bypass probe to confirm — {_cite(h)}")
    return CheckResult("FAIL", "no single-gate routing for mutations")


def delta3_heartbeat(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"last_success_at"])
    if not h:
        return CheckResult("FAIL", "Δ3: no last_success_at heartbeat")
    monitor = _first(repo, [r"staleness", r"independent monitor", r"ack_slo", r"manifest"])
    if monitor:
        return CheckResult("PASS", _cite(monitor))
    return CheckResult("PARTIAL", f"heartbeat field present; no independent staleness monitor — {_cite(h)}")


def orch_keystone(repo: RepoView) -> CheckResult:
    # The orchestrator's Box-2 replacement: closed/typed transition set + write-ahead decision
    # persistence are the load-bearing pair (replay-zero-token is the chaos consequence). ponytail:
    # structural grep — honest for Python; TS-accurate recognition is the deferred parser work.
    transitions = _first(repo, [r"class \w*State\w*\(.*Enum", r"\bTRANSITIONS\b", r"transition_table",
                                r"allowed_transitions", r"\bStateMachine\b", r"next_state"])
    persist = _first(repo, [r"decision_log", r"write.?ahead", r"persist.*decision", r"\bjournal\b",
                            r"append.*decision", r"record.*choice"])
    if transitions and persist:
        return CheckResult("PASS", _cite(persist))
    half = transitions or persist
    if half:
        return CheckResult("PARTIAL", f"partial keystone — need closed transitions + write-ahead persist — {_cite(half)}")
    return CheckResult("FAIL", "no orchestrator keystone (closed typed transitions + persist-before-effect)")


def delta3_anomaly(repo: RepoView) -> CheckResult:
    h = _first(repo, [r"anomaly", r"rate.?spike", r"duplicate surge", r"detector", r"thermal"])
    if h:
        return CheckResult("PASS", _cite(h))
    return CheckResult("FAIL", "Δ3: no registered anomaly detectors")


CHECKS = {o.id: globals()[o.id] for o in OBLIGATIONS if o.kind == "static"}


if __name__ == "__main__":   # ponytail: smallest check that the registry stays complete
    assert set(CHECKS) == {o.id for o in OBLIGATIONS if o.kind == "static"}
    print("checks self-check OK")
