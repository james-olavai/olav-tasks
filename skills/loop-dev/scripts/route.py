#!/usr/bin/env python3
"""Choose a model for one bounded development role using OpenRouter Jev."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_JEV_MODEL = "typesafe/jev-1.13"
TIERS = ("light", "standard", "expert")
ORDER = {tier: index for index, tier in enumerate(TIERS)}
FLOORS = {"scout": "light", "pm": "standard", "architecture": "expert",
          "implement": "light", "verify": "standard", "repair": "standard"}
MAX_TASK = 4000
MAX_CONTEXT = 1500


def key_from_env_file(path):
    if path is None:
        return None
    if not path.is_file():
        raise ValueError("env_file_missing")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*(?:export\s+)?(?:OPENROUTER_API_KEY|openrouter)\s*=\s*(.*?)\s*", line)
        if match:
            value = match.group(1).split(" #", 1)[0].strip().strip("'\"")
            if value and not any(c in value for c in "`$\\\r\n"):
                return value
    return None


def request_body(phase, task, context, jev_model=DEFAULT_JEV_MODEL):
    return {
        "model": jev_model,
        "state": {"phase": phase, "task": task, "context": context},
        "questions": {
            "tier": {
                "type": "choice",
                "instructions": "Choose the least capable model sufficient to complete this bounded role correctly, including likely correction work.",
                "criteria": {
                    "light": "Mechanical lookup, bounded edit, or explicit test with settled behavior and no cross-file judgment.",
                    "standard": "Ordinary coding, PM planning, debugging, or review requiring judgment across files.",
                    "expert": "New architecture, unsettled domain model, complex cross-system reasoning, or high-consequence review.",
                },
            },
            "effort": {
                "type": "choice",
                "instructions": "Choose the minimum reasoning effort sufficient for this bounded role.",
                "criteria": {
                    "low": "Direct lookup or mechanical operation with clear instructions.",
                    "medium": "Normal implementation or verification with a few dependencies.",
                    "high": "Ambiguous design, complicated debugging, or difficult risk analysis.",
                },
            },
        },
    }


def parse_decision(response, phase, high_risk, model_map=None, jev_model=DEFAULT_JEV_MODEL):
    if not isinstance(response, dict):
        raise ValueError("jev_answers_missing")
    answers = response.get("answers")
    if not isinstance(answers, dict):
        raise ValueError("jev_answers_missing")
    tier_answer = answers.get("tier")
    effort_answer = answers.get("effort")
    if not isinstance(tier_answer, dict) or not isinstance(effort_answer, dict):
        raise ValueError("jev_answer_shape")
    tier = tier_answer.get("choice")
    effort = effort_answer.get("choice")
    confidence = tier_answer.get("confidence")
    if tier not in TIERS or effort not in {"low", "medium", "high"}:
        raise ValueError("jev_choice_invalid")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise ValueError("jev_confidence_invalid")
    floor = "expert" if high_risk else FLOORS[phase]
    if ORDER[tier] < ORDER[floor]:
        tier = floor
    # Until task-outcome calibration exists, an uncertain light choice gets standard.
    if tier == "light" and confidence < 0.5:
        tier = "standard"
    if tier == "expert" and effort == "low":
        effort = "medium"
    # High-risk work (money, permissions, concurrency) never runs below high
    # effort; repositories may raise it further (for example to xhigh).
    if high_risk and effort != "high":
        effort = "high"
    return {"status": "jev", "tier": tier, "model": (model_map or {}).get(tier),
            "reasoning_effort": effort, "confidence": confidence,
            "jev_model": response.get("model", jev_model),
            "usage": response.get("usage", {})}


def fallback(phase, high_risk, reason, model_map=None):
    tier = "expert" if high_risk or phase == "architecture" else "standard"
    return {"status": "static_fallback", "tier": tier, "model": (model_map or {}).get(tier),
            "reasoning_effort": "high" if high_risk else "medium", "reason": reason}


def load_model_map(path):
    if path is None:
        return {}
    if not path.is_file():
        raise ValueError("models_file_missing")
    model_map = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(model_map, dict) or set(model_map) != set(TIERS) or not all(
            isinstance(value, str) and value.strip() for value in model_map.values()):
        raise ValueError("models_file_invalid")
    return model_map


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", required=True, choices=FLOORS)
    parser.add_argument("--task", required=True)
    parser.add_argument("--context", default="")
    parser.add_argument("--high-risk", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--models-file", type=Path, help="JSON map of light, standard, expert to runtime model IDs")
    parser.add_argument("--jev-model", default=os.environ.get("LOOP_DEV_JEV_MODEL", DEFAULT_JEV_MODEL))
    parser.add_argument("--require-jev", action="store_true")
    args = parser.parse_args()
    if not args.task.strip() or len(args.task) > MAX_TASK or len(args.context) > MAX_CONTEXT:
        parser.error("task/context is empty or exceeds the bounded Jev dossier")

    model_map = {}
    try:
        model_map = load_model_map(args.models_file)
        key = os.environ.get("OPENROUTER_API_KEY") or key_from_env_file(args.env_file)
        if not key:
            raise ValueError("openrouter_key_missing")
        body = json.dumps(request_body(args.phase, args.task, args.context, args.jev_model),
                          ensure_ascii=False).encode("utf-8")
        request = Request(ENDPOINT, data=body, method="POST", headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        })
        with urlopen(request, timeout=12) as result:
            response = json.load(result)
        decision = parse_decision(response, args.phase, args.high_risk, model_map, args.jev_model)
    except HTTPError as exc:
        decision = fallback(args.phase, args.high_risk, "jev_http_" + str(exc.code), model_map)
    except (URLError, TimeoutError):
        decision = fallback(args.phase, args.high_risk, "jev_unreachable", model_map)
    except (ValueError, json.JSONDecodeError) as exc:
        reason = str(exc)
        decision = fallback(args.phase, args.high_risk,
                            reason if reason in {"env_file_missing", "openrouter_key_missing",
                                                 "jev_answers_missing", "jev_answer_shape",
                                                 "jev_choice_invalid", "jev_confidence_invalid",
                                                 "models_file_missing", "models_file_invalid"}
                            else "jev_invalid_response", model_map)
    print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    return 2 if args.require_jev and decision["status"] != "jev" else 0


if __name__ == "__main__":
    sys.exit(main())
