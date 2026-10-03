#!/usr/bin/env python3
"""Ask Jev for one bounded workflow choice; never grant authority or accept work."""

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import route


DECISIONS = {
    "retrieval": {
        "instructions": "Choose whether bounded direct search or one read-only reader agent is likely to use fewer total tokens for this task.",
        "criteria": {
            "direct": "Known target files, narrow search, or one worker; avoid another agent handoff.",
            "reader": "Uncertain files, conflicting documents, or several workers likely to repeat the same exploration.",
        },
    },
    "work_mode": {
        "instructions": "Choose the lower-overhead mode for independent work packages; execution policy will separately enforce ownership and permissions.",
        "criteria": {
            "single": "One bounded task, unsettled interface, or overlapping writable files.",
            "parallel": "At least two independent, verifiable packages with settled interfaces and disjoint writable files.",
        },
    },
    "repair_cause": {
        "instructions": "Classify the most likely cause of a failed acceptance gate; this label is advisory and cannot approve a repair.",
        "criteria": {
            "context": "The worker lacked relevant source, version, or interface evidence.",
            "contract": "The requested behavior or acceptance contract is wrong, missing, or contradictory.",
            "implementation": "The contract is clear but the implementation violates it.",
            "harness": "The check or test environment itself is broken or misleading.",
        },
    },
}


def request_body(decision, task, context, jev_model):
    rule = DECISIONS[decision]
    return {"model": jev_model, "state": {"decision": decision, "task": task, "context": context},
            "questions": {"choice": {"type": "choice", **rule}}}


def parse_decision(response, decision, jev_model):
    if not isinstance(response, dict) or not isinstance(response.get("answers"), dict):
        raise ValueError("jev_answer_shape")
    answer = response["answers"].get("choice")
    if not isinstance(answer, dict):
        raise ValueError("jev_answer_shape")
    choice = answer.get("choice")
    confidence = answer.get("confidence")
    if choice not in DECISIONS[decision]["criteria"]:
        raise ValueError("jev_choice_invalid")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        raise ValueError("jev_confidence_invalid")
    return {"status": "jev", "decision": decision, "choice": choice,
            "confidence": confidence, "jev_model": response.get("model", jev_model),
            "usage": response.get("usage", {})}


def fallback(decision, reason):
    return {"status": "static_fallback", "decision": decision,
            "choice": {"retrieval": "direct", "work_mode": "single",
                       "repair_cause": "needs_review"}[decision], "reason": reason}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--decision", required=True, choices=DECISIONS)
    parser.add_argument("--task", required=True)
    parser.add_argument("--context", default="")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--jev-model", default=os.environ.get("LOOP_DEV_JEV_MODEL", route.DEFAULT_JEV_MODEL))
    parser.add_argument("--require-jev", action="store_true")
    args = parser.parse_args()
    if not args.task.strip() or len(args.task) > route.MAX_TASK or len(args.context) > route.MAX_CONTEXT:
        parser.error("task/context is empty or exceeds the bounded Jev dossier")
    try:
        key = os.environ.get("OPENROUTER_API_KEY") or route.key_from_env_file(args.env_file)
        if not key:
            raise ValueError("openrouter_key_missing")
        body = json.dumps(request_body(args.decision, args.task, args.context, args.jev_model),
                          ensure_ascii=False).encode("utf-8")
        request = Request(route.ENDPOINT, data=body, method="POST", headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urlopen(request, timeout=12) as result:
            response = json.load(result)
        result = parse_decision(response, args.decision, args.jev_model)
    except HTTPError as exc:
        result = fallback(args.decision, "jev_http_" + str(exc.code))
    except (URLError, TimeoutError):
        result = fallback(args.decision, "jev_unreachable")
    except (ValueError, json.JSONDecodeError) as exc:
        reason = str(exc)
        result = fallback(args.decision,
                          reason if reason in {"env_file_missing", "openrouter_key_missing",
                                               "jev_answer_shape", "jev_choice_invalid",
                                               "jev_confidence_invalid"} else "jev_invalid_response")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 2 if args.require_jev and result["status"] != "jev" else 0


if __name__ == "__main__":
    sys.exit(main())
