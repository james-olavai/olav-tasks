# Vela adapter

Vela's root `agent.md` is authoritative for executor permissions, architecture gates, file ownership, and acceptance. It now prefers the current host's native Codex/Claude subagent for coding and testing; external pi is a reviewed alternative when native execution is unavailable or unsuitable for required isolation, or the user explicitly selects pi. The project-owned pi implementation remains at `skills/parallel-dev-vela/`; do not fork its runner scripts into this user-level skill. The former `parallel-dev-vela` skill is no longer needed as a separate global discovery entry: `loop-dev` is the orchestrator, and the in-repo directory is an execution adapter plus project templates.

For Vela, read the relevant release and architecture decisions, then the target code path. Before a new milestone's first production package (once per milestone, not per package), use the parent delivery contract and reverse architecture check in `skills/parallel-dev-vela/references/product-architecture-gate.md`. Every implementation package needs its parent acceptance ID, `vertical|seam|repair|audit` type, a real user-visible proof, a file owner, and affected checks. A seam cannot close a parent outcome; after three consecutive seams, stop expansion and check the parent vertical path. Follow `agent.md` for money, permissions, concurrency, browser evidence, and repair limits.

For a native subagent, give a concise factual brief with the current decision and parent contract, `vertical|seam|repair|audit` type, actor/job and start→done, editable-domain-data versus internal IR, lifecycle and anti-goals, consumer/config trace, unresolved questions, source revision and dirty-file hashes, exact file owners and approved checks, observable acceptance and stop condition. The coordinator checks these facts before dispatch and reviews the final diff and raw test/browser evidence; a native brief is not a `VELA_TASK_CONTRACT_V1` hard-gate PASS. Native writers should not receive real `.env` contents. Shared files have one owner; default at most two concurrent writing workers.

Since 2026-10-02 Vela uses an executor-self-test plus post-hoc QA model: workers write and run their own tests without pre-approval; a different agent does one QA pass (tests, actual diff, a real browser run for journeys) and the package is committed on pass. No pre-execution freeze hashes, launcher reviews or per-stage approvals; a pi manifest applies only when pi is chosen. Red-green regressions are required only for money, permission and concurrency fixes, and the reverse architecture check runs once per milestone. The coordinator still checks the brief before dispatch.

Vela's model matrix in `agent.md` overrides Jev and lists both Codex and Claude model IDs. Vela's high-risk floor is `xhigh`; apply it after routing.

When the selected executor is pi, read only the mode-specific material needed for that package:

- `skills/parallel-dev-vela/references/task-brief.md` for the exact injected brief;
- `skills/parallel-dev-vela/references/task-contract-v1.md` for `VELA_TASK_CONTRACT_V1` and manifest limits;
- `skills/parallel-dev-vela/scripts/pi_execute.py` and its tool implementation before using controlled read/edit/check;
- `skills/parallel-dev-vela/references/agent-calibration-rollout.md` only for calibrator/verifier rollout;
- `skills/parallel-dev-vela/references/agent-self-improvement.md` only for a separately authorized learning change.

The controlled pi path is `python3 skills/parallel-dev-vela/scripts/pi_execute.py --env-file <authorized-env> --manifest <reviewed-manifest> --brief <filled-brief> --output-dir <new-private-dir> --timeout <seconds>`. Use actual task paths, not placeholders. Its contract lint is a structural gate, not product acceptance. Check `execution_ok`, tool events, actual diff, raw check exits/logs, and final-tree evidence; `acceptance_verified` stays false until independent review. Do not bypass its manifest by calling a less restricted mode. The older `pi_worker.py` is candidate-only and cannot stand in for applied or tested work.

The pi manifest gate does not exist in a native session: use its actual host permissions and isolation rather than claiming the same hard enforcement. Do not call a native candidate 'verified' until the final Vela worktree and user-visible acceptance gate are checked. The coordinator remains responsible for product and architecture decisions; changing executor does not authorize a worker to commit, push, deploy, migrate production data, or use real payment/model credentials.
