import copy
import json
import unittest
from pathlib import Path

from frontier_protocol import evaluate_runtime_health, runtime_health_exit_code


ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "conformance" / "runtime-health"


class RuntimeHealthConformance(unittest.TestCase):
    def test_golden_fixtures(self):
        expected = {
            "healthy.json": ("pass", True, 0),
            "process-only.json": ("blocked", False, 2),
            "provider-credit-auth-failure.json": ("blocked", False, 2),
            "governance-dead.json": ("propose_only", False, 2),
            "operator-halt.json": ("halted", False, 2),
            "mixed-blocker-propose-only.json": ("blocked", False, 2),
            "degraded-optional-check.json": ("degraded", True, 0),
            "invalid-structural-evidence.json": ("invalid", False, 1),
        }
        for fixture_name, (status, can_mutate, exit_code) in expected.items():
            with self.subTest(fixture=fixture_name):
                contract = json.loads((FIXTURES / fixture_name).read_text())
                report = evaluate_runtime_health(contract)
                self.assertEqual(report["status"], status)
                self.assertEqual(report["can_mutate"], can_mutate)
                self.assertEqual(runtime_health_exit_code(report), exit_code)

    def test_malformed_and_impossible_evidence(self):
        healthy = json.loads((FIXTURES / "healthy.json").read_text())

        cases = {}
        missing_summary = copy.deepcopy(healthy)
        missing_summary["layers"]["process"]["checks"][0].pop("summary")
        cases["missing_summary"] = missing_summary

        missing_staleness = copy.deepcopy(healthy)
        missing_staleness["layers"]["scheduler"]["checks"][0].pop("stale_after_seconds")
        cases["missing_stale_after_seconds"] = missing_staleness

        invalid_reason = copy.deepcopy(healthy)
        invalid_reason["layers"]["execution"]["checks"][0]["reason_code"] = "provider_says_ok"
        cases["invalid_reason_code"] = invalid_reason

        extra_top_level = copy.deepcopy(healthy)
        extra_top_level["provider"] = "not-authoritative"
        cases["extra_top_level"] = extra_top_level

        extra_layer = copy.deepcopy(healthy)
        extra_layer["layers"]["provider"] = copy.deepcopy(extra_layer["layers"]["execution"])
        cases["extra_layer"] = extra_layer

        for name, contract in cases.items():
            with self.subTest(case=name):
                report = evaluate_runtime_health(contract)
                self.assertEqual(report["status"], "invalid")
                self.assertFalse(report["can_mutate"])

        future = copy.deepcopy(healthy)
        future["layers"]["governance"]["checks"][0]["observed_at"] = "2026-08-05T12:01:00Z"
        future_report = evaluate_runtime_health(future)
        self.assertEqual(future_report["status"], "blocked")
        self.assertFalse(future_report["can_mutate"])


if __name__ == "__main__":
    unittest.main()
