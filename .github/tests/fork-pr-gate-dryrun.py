#!/usr/bin/env python3
"""Dry-case check for the fork PR gate in pr.yml (no act, no network).
Extracts the 'Fail fork PRs' step from the verify and e2e jobs and runs it
with a fork payload, a same-repo payload and a push payload.
Standard library only: the job blocks are read by indentation, so no PyYAML."""
import pathlib, subprocess, sys

lines = pathlib.Path(__file__).resolve().parents[1].joinpath("workflows/pr.yml").read_text().splitlines()

def job_block(name):
    start = lines.index(f"  {name}:")
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].startswith("  ") and not lines[i].startswith("   ") and lines[i].strip()), len(lines))
    return lines[start + 1:end]

def job_if(block):
    return next(l.split("if:", 1)[1].strip() for l in block if l.startswith("    if:"))

def steps(block):
    out, cur = [], None
    for l in block:
        if l.startswith("      - "):
            cur = [l]; out.append(cur)
        elif cur is not None and (l.startswith("        ") or not l.strip()):
            cur.append(l)
        elif not l.startswith("      "):
            cur = None
    return out

def run_script(step):
    i = next(k for k, l in enumerate(step) if l.strip() == "run: |")
    body = []
    for l in step[i + 1:]:
        if l.strip() and not l.startswith("          "):
            break
        body.append(l[10:])
    return "\n".join(body)

cases = [("fork PR", "pull_request", "someone/paperclip", 1),
         ("same-repo PR", "pull_request", "iMelki/paperclip", 0),
         ("push", "push", "", 0)]
bad = 0
for job in ("verify", "e2e"):
    block = job_block(job)
    assert job_if(block) == "${{ always() }}", f"{job}: job guard must not skip forks"
    st = steps(block)
    assert not any("actions/checkout" in "\n".join(s) for s in st), f"{job}: must not check out"
    step = next(s for s in st if "name: Fail fork PRs" in s[0])
    for label, ev, head, want in cases:
        r = subprocess.run(["bash", "-c", run_script(step)], capture_output=True, text=True,
                           env={"EVENT_NAME": ev, "HEAD_REPO": head, "BASE_REPO": "iMelki/paperclip", "PATH": "/usr/bin:/bin"})
        ok = (r.returncode != 0) == bool(want)
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'} {job:6} {label:13} exit={r.returncode} {r.stdout.strip()}")
sys.exit(1 if bad else 0)
