"""Bounded diagnostics for the manual workspace feature branch; no publishing."""
import json
import os
import re
import subprocess
from pathlib import Path

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"
ROOT = Path(".tmp/manual-redaction-check")
ROOT.mkdir(parents=True, exist_ok=True)


def invoke(command, timeout=1200):
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", result.stdout + result.stderr)
    return result.returncode, text


_, source = invoke(["git", "rev-parse", "HEAD"])
results = {"source": source.strip(), "run_id": os.environ["GITHUB_RUN_ID"], "checks": []}
commands = [
    ("typecheck", ["npm.cmd", "run", "typecheck"]),
    ("typecheck:electron", ["npm.cmd", "run", "typecheck:electron"]),
    ("focused tests", ["npm.cmd", "run", "test", "--", "tests/manualRedaction", "tests/imageRedaction.test.ts", "tests/imageRedactionReview.test.ts"]),
    ("mock boundaries", ["npm.cmd", "run", "check:test-mock-boundaries"]),
]
for name, command in commands:
    try:
        code, text = invoke(command)
    except subprocess.TimeoutExpired:
        code, text = 124, "Command exceeded its bounded execution timeout."
    (ROOT / (name.replace(":", "-").replace(" ", "-") + ".log")).write_text(text, encoding="utf-8")
    results["checks"].append({"name": name, "exit_code": code})
    print("CHECK: " + name, flush=True)
    print(text[-20000:], flush=True)

_, changes = invoke(["git", "diff", "--name-only", "--diff-filter=AM", "19b660f4160e4a64ce479caa09a20437f9ed3c81", "HEAD"])
files = [name for name in changes.splitlines() if name.endswith((".ts", ".tsx"))]
if files:
    code, text = invoke(["node", "node_modules/eslint/bin/eslint.js", "--format", "json", "--max-warnings", "0", *files])
    (ROOT / "eslint.json").write_text(text, encoding="utf-8")
    print("CHECK: focused ESLint", flush=True)
    try:
        for entry in json.loads(text):
            path = Path(entry["filePath"]).relative_to(Path.cwd()).as_posix()
            for message in entry["messages"]:
                print(f"{path}:{message.get('line', 0)} {message.get('ruleId')} {message['message']}")
    except (json.JSONDecodeError, ValueError):
        print(text[-16000:])
    results["checks"].append({"name": "focused ESLint", "exit_code": code})

(ROOT / "result.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print("VALIDATION_RESULT=" + json.dumps(results), flush=True)
raise SystemExit(any(check["exit_code"] for check in results["checks"]))
