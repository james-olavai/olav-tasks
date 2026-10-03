"""Offline checks for bounded workflow choices."""

from io import BytesIO, StringIO
import json
import os
import sys
import unittest
from unittest.mock import patch

import decide


class DecideTests(unittest.TestCase):
    def test_retrieval_choice(self):
        result = decide.parse_decision({"answers": {"choice": {"choice": "reader", "confidence": 0.8}}},
                                       "retrieval", "typesafe/jev-1.13")
        self.assertEqual(result["choice"], "reader")

    def test_out_of_scope_choice_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "jev_choice_invalid"):
            decide.parse_decision({"answers": {"choice": {"choice": "publish", "confidence": 1}}},
                                  "work_mode", "typesafe/jev-1.13")

    def test_malformed_answers_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "jev_answer_shape"):
            decide.parse_decision({"answers": None}, "work_mode", "typesafe/jev-1.13")

    def test_boolean_confidence_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "jev_confidence_invalid"):
            decide.parse_decision({"answers": {"choice": {"choice": "single", "confidence": True}}},
                                  "work_mode", "typesafe/jev-1.13")

    def test_fallback_does_not_approve_repair(self):
        self.assertEqual(decide.fallback("repair_cause", "jev_unreachable")["choice"],
                         "needs_review")

    def test_main_does_not_print_key(self):
        def fake_open(request, timeout):
            self.assertEqual(request.full_url, "https://openrouter.ai/api/alpha/decisions")
            return BytesIO(json.dumps({"answers": {"choice": {"choice": "single",
                                                                 "confidence": 0.9}}}).encode())

        output = StringIO()
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "dummy-test-key"}), \
             patch.object(sys, "argv", ["decide.py", "--decision", "work_mode", "--task", "One file"]), \
             patch.object(decide, "urlopen", fake_open), patch("sys.stdout", output):
            self.assertEqual(decide.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["choice"], "single")
        self.assertNotIn("dummy-test-key", output.getvalue())


if __name__ == "__main__":
    unittest.main()
