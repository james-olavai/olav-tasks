"""Offline contract checks for Jev routing decisions."""

import unittest
from unittest.mock import patch
from io import BytesIO, StringIO
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import route


def answer(tier="light", confidence=0.9, effort="low"):
    return {"model": "typesafe/jev-1.13", "answers": {
        "tier": {"type": "choice", "choice": tier, "confidence": confidence},
        "effort": {"type": "choice", "choice": effort, "confidence": 0.9},
    }}


class RouteTests(unittest.TestCase):
    def test_env_file_accepts_openrouter_alias(self):
        with TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("other=ignored\nopenrouter='dummy-test-key'\n", encoding="utf-8")
            self.assertEqual(route.key_from_env_file(env_file), "dummy-test-key")

    def test_bounded_implementation_can_use_light(self):
        result = route.parse_decision(answer(), "implement", False)
        self.assertEqual(result["tier"], "light")
        self.assertIsNone(result["model"])

    def test_low_confidence_does_not_downgrade_to_light(self):
        self.assertEqual(route.parse_decision(answer(confidence=0.3), "implement", False)["tier"],
                         "standard")

    def test_role_and_risk_floors(self):
        self.assertEqual(route.parse_decision(answer(), "pm", False)["tier"], "standard")
        self.assertEqual(route.parse_decision(answer(), "architecture", False)["tier"],
                         "expert")
        self.assertEqual(route.parse_decision(answer(), "implement", True)["tier"],
                         "expert")

    def test_unrecognized_choice_is_not_used(self):
        with self.assertRaisesRegex(ValueError, "jev_choice_invalid"):
            route.parse_decision(answer(tier="unknown"), "implement", False)

    def test_boolean_confidence_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "jev_confidence_invalid"):
            route.parse_decision(answer(confidence=True), "implement", False)

    def test_high_risk_raises_effort_floor(self):
        result = route.parse_decision(answer(effort="low"), "implement", True)
        self.assertEqual((result["tier"], result["reasoning_effort"]), ("expert", "high"))

    def test_high_risk_fallback_is_not_medium(self):
        result = route.fallback("implement", True, "jev_unreachable")
        self.assertEqual((result["tier"], result["reasoning_effort"]), ("expert", "high"))

    def test_missing_service_is_labeled_fallback(self):
        result = route.fallback("architecture", False, "openrouter_key_missing")
        self.assertEqual(result["status"], "static_fallback")
        self.assertEqual(result["tier"], "expert")

    def test_model_map_is_explicit_and_optional(self):
        with TemporaryDirectory() as directory:
            model_file = Path(directory) / "models.json"
            model_file.write_text(json.dumps({"light": "cheap", "standard": "regular",
                                              "expert": "strong"}), encoding="utf-8")
            mapping = route.load_model_map(model_file)
            self.assertEqual(route.parse_decision(answer(), "implement", False, mapping)["model"],
                             "cheap")

    def test_request_uses_openrouter_decisions_shape(self):
        captured = {}

        def fake_open(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return BytesIO(json.dumps(answer(tier="standard", effort="medium")).encode())

        output = StringIO()
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "dummy-test-key"}), \
             patch.object(sys, "argv", ["route.py", "--phase", "implement", "--task", "Fix x"]), \
             patch.object(route, "urlopen", fake_open), patch("sys.stdout", output):
            self.assertEqual(route.main(), 0)
        request = captured["request"]
        self.assertEqual(request.full_url, "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(json.loads(request.data)["model"], "typesafe/jev-1.13")
        self.assertEqual(json.loads(output.getvalue())["tier"], "standard")
        self.assertEqual(json.loads(output.getvalue())["status"], "jev")
        self.assertIsNone(json.loads(output.getvalue())["model"])
        self.assertNotIn("dummy-test-key", output.getvalue())


if __name__ == "__main__":
    unittest.main()
