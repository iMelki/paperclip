#!/usr/bin/env python3
"""Dry-case check for the fork PR gate in pr.yml (no act, no network).
Extracts the 'Fail fork PRs' step from the verify and e2e jobs and runs it
with a fork payload, a same-repo payload and a push payload."""
import subprocess, sys, yaml, pathlib
wf = yaml.safe_load(pathlib.Path(__file__).resolve().parents[1].joinpath("workflows/pr.yml").read_text())
cases = [("fork PR", "pull_request", "someone/paperclip", 1),
         ("same-repo PR", "pull_request", "iMelki/paperclip", 0),
         ("push", "push", "", 0)]
bad = 0
for job in ("verify", "e2e"):
    j = wf["jobs"][job]
    assert j["if"].strip() == "${{ always() }}", f"{job}: job guard must not skip forks"
    assert not any("actions/checkout" in str(st.get("uses", "")) for st in j["steps"]), f"{job}: must not check out"
    step = next(st for st in j["steps"] if st["name"].startswith("Fail fork PRs"))
    for label, ev, head, want in cases:
        r = subprocess.run(["bash", "-c", step["run"]], capture_output=True, text=True,
                           env={"EVENT_NAME": ev, "HEAD_REPO": head, "BASE_REPO": "iMelki/paperclip", "PATH": "/usr/bin:/bin"})
        ok = (r.returncode != 0) == bool(want)
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'} {job:6} {label:13} exit={r.returncode} {r.stdout.strip()}")
sys.exit(1 if bad else 0)
