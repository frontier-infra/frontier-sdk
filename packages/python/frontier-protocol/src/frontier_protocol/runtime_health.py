"""Deterministic reference reducer for ``frontier.machine.health.v1``."""

from datetime import datetime, timezone

PROTOCOL_PACKAGE_VERSION = "0.1.0"
RUNTIME_HEALTH_SCHEMA_VERSION = "frontier.machine.health.v1"
RUNTIME_HEALTH_LAYERS = ("process", "scheduler", "execution", "governance")
RUNTIME_HEALTH_STATUS_PRECEDENCE = ("halted", "blocked", "propose_only", "degraded", "pass")

_ALLOWED_TOP_LEVEL_FIELDS = {"schema_version", "deployment_id", "checked_at", "layers", "aggregate_policy"}
_PROPOSE_ONLY_REASONS = {"missing_verifier", "stale_verifier", "unratified_contract"}
_HALTED_REASONS = {"active_override", "no_ack_halt"}
_BLOCKED_REASONS = {"auth_failed", "credit_exhausted", "scheduler_stalled", "worker_unavailable"}
_ALLOWED_REASON_CODES = _PROPOSE_ONLY_REASONS | _HALTED_REASONS | _BLOCKED_REASONS | {"governance_gate_failed"}
_RULE = "process, scheduler, execution, and governance must all pass fresh critical checks; can_mutate is true on pass or degraded"


def _parse_timestamp(value, path, errors):
    if not isinstance(value, str):
        errors.append(f"{path} must be an ISO timestamp string")
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{path} must be a valid ISO timestamp")
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _classify_issue(buckets, critical, layer_name, message, reason_code):
    rendered = f"{layer_name}: {message}"
    if reason_code in _HALTED_REASONS:
        buckets["halted"].append(f"{rendered} ({reason_code})")
        return "fail"
    if reason_code in _BLOCKED_REASONS:
        buckets["blockers"].append(f"{rendered} ({reason_code})")
        return "fail"
    if reason_code in _PROPOSE_ONLY_REASONS:
        buckets["propose_only"].append(f"{rendered} ({reason_code})")
        return "fail"
    if critical:
        suffix = f" ({reason_code})" if reason_code else ""
        buckets["blockers"].append(f"{rendered}{suffix}")
        return "fail"
    buckets["degraded"].append(rendered)
    return "degraded"


def _empty_invalid_report(errors):
    return {
        "status": "invalid",
        "schema_version": None,
        "aggregate": "invalid",
        "can_mutate": False,
        "deployment_id": None,
        "checked_at": None,
        "layers": {},
        "errors": errors,
        "failures": [],
        "blockers": [],
        "propose_only": [],
        "halted": [],
        "degraded": [],
        "rule": _RULE,
    }


def evaluate_runtime_health(contract):
    """Reduce one runtime health contract into fail-closed status and authority."""

    if not isinstance(contract, dict):
        return _empty_invalid_report(["contract must be a JSON object"])

    errors = []
    failures = []
    buckets = {"blockers": [], "propose_only": [], "halted": [], "degraded": []}
    checked_at = _parse_timestamp(contract.get("checked_at"), "checked_at", errors)

    for field in contract:
        if field not in _ALLOWED_TOP_LEVEL_FIELDS:
            errors.append(f"unexpected top-level field {field}")
    deployment_id = contract.get("deployment_id")
    if not isinstance(deployment_id, str) or not deployment_id.strip():
        errors.append("deployment_id must be a non-empty string")
    if contract.get("schema_version") != RUNTIME_HEALTH_SCHEMA_VERSION:
        errors.append(f"schema_version must be {RUNTIME_HEALTH_SCHEMA_VERSION}")

    contract_layers = contract.get("layers")
    if not isinstance(contract_layers, dict):
        errors.append("layers must be an object")
        contract_layers = {}
    else:
        for layer_name in contract_layers:
            if layer_name not in RUNTIME_HEALTH_LAYERS:
                errors.append(f"unexpected layer {layer_name}")

    if "aggregate_policy" in contract:
        aggregate_policy = contract.get("aggregate_policy")
        if not isinstance(aggregate_policy, dict):
            errors.append("aggregate_policy must be an object")
        else:
            if aggregate_policy.get("status") is not None and aggregate_policy.get("status") != "fail_closed":
                errors.append("aggregate_policy.status must be fail_closed")
            for field in ("rule", "warning"):
                if field in aggregate_policy and not isinstance(aggregate_policy.get(field), str):
                    errors.append(f"aggregate_policy.{field} must be a string")

    layer_results = {}
    for layer_name in RUNTIME_HEALTH_LAYERS:
        layer = contract_layers.get(layer_name)
        layer_failures = []
        layer_hard_failure = False
        layer_degraded = False

        if not isinstance(layer, dict):
            layer_failures.append("missing layer")
            buckets["blockers"].append(f"{layer_name}: missing layer")
            layer_results[layer_name] = {"status": "fail", "failures": layer_failures}
            continue
        checks = layer.get("checks")
        if not isinstance(checks, list) or not checks:
            layer_failures.append("no checks")
            buckets["blockers"].append(f"{layer_name}: no checks")
            layer_results[layer_name] = {"status": "fail", "failures": layer_failures}
            continue

        for index, check in enumerate(checks):
            prefix = f"{layer_name}.checks[{index}]"

            def structural_failure(message):
                layer_failures.append(message)
                errors.append(message)

            if not isinstance(check, dict):
                structural_failure(f"{prefix} must be an object")
                continue
            check_id = check.get("id")
            if not isinstance(check_id, str) or not check_id.strip():
                structural_failure(f"{prefix}.id missing")
            check_status = check.get("status")
            if check_status not in ("pass", "fail", "unknown"):
                structural_failure(f"{prefix}.status must be pass, fail, or unknown")
            if "critical" in check and not isinstance(check.get("critical"), bool):
                structural_failure(f"{prefix}.critical must be a boolean")
            critical = check.get("critical") is not False
            reason_code = check.get("reason_code") if isinstance(check.get("reason_code"), str) else None
            if "reason_code" in check and (reason_code is None or reason_code not in _ALLOWED_REASON_CODES):
                structural_failure(f"{prefix}.reason_code is not recognized")
            if "degradation_code" in check and not isinstance(check.get("degradation_code"), str):
                structural_failure(f"{prefix}.degradation_code must be a string")
            if "evidence" in check and not isinstance(check.get("evidence"), str):
                structural_failure(f"{prefix}.evidence must be a string")

            def classify(message):
                nonlocal layer_hard_failure, layer_degraded
                classification = _classify_issue(buckets, critical, layer_name, message, reason_code)
                layer_hard_failure = layer_hard_failure or classification == "fail"
                layer_degraded = layer_degraded or classification == "degraded"

            if check_status in ("fail", "unknown"):
                message = f"{check_id or prefix} status {check_status}"
                layer_failures.append(message)
                classify(message)

            observed_at = _parse_timestamp(check.get("observed_at"), f"{prefix}.observed_at", errors)
            stale_after = check.get("stale_after_seconds")
            if not isinstance(stale_after, int) or isinstance(stale_after, bool) or stale_after < 1:
                structural_failure(f"{prefix}.stale_after_seconds must be a positive integer")
            elif checked_at is not None and observed_at is not None:
                age_seconds = int((checked_at - observed_at).total_seconds() // 1)
                if age_seconds < 0:
                    message = f"{check_id or prefix} observed_at is after checked_at"
                    layer_failures.append(message)
                    classify(message)
                if age_seconds > stale_after:
                    message = f"{check_id or prefix} stale by {age_seconds - stale_after}s"
                    layer_failures.append(message)
                    classify(message)
            summary = check.get("summary")
            if not isinstance(summary, str) or not summary.strip():
                structural_failure(f"{prefix}.summary missing")

        failures.extend(f"{layer_name}: {failure}" for failure in layer_failures)
        layer_results[layer_name] = {
            "status": (
                "fail" if layer_hard_failure else
                "degraded" if layer_degraded else
                "pass" if not layer_failures else
                "fail"
            ),
            "failures": layer_failures,
        }

    status = (
        "invalid" if errors else
        "halted" if buckets["halted"] else
        "blocked" if buckets["blockers"] else
        "propose_only" if buckets["propose_only"] else
        "degraded" if buckets["degraded"] else
        "pass"
    )
    return {
        "status": status,
        "schema_version": contract.get("schema_version"),
        "aggregate": "pass" if status == "pass" else status,
        "can_mutate": status in ("pass", "degraded"),
        "deployment_id": deployment_id,
        "checked_at": contract.get("checked_at"),
        "layers": layer_results,
        "errors": errors,
        "failures": failures,
        "blockers": buckets["blockers"],
        "propose_only": buckets["propose_only"],
        "halted": buckets["halted"],
        "degraded": buckets["degraded"],
        "rule": _RULE,
    }


def runtime_health_exit_code(report):
    if report.get("status") in ("pass", "degraded"):
        return 0
    if report.get("status") in ("blocked", "propose_only", "halted"):
        return 2
    return 1
