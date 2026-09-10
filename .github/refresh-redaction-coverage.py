"""Refresh only the redaction branch's measured coverage inventory; preserve floors."""
import hashlib
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

REPOSITORY = "ucx0204/CarrotMangaTranslator"
BRANCH = "feat/manual-redaction-workspace-20260910"
ROOT = Path.cwd()
OUT = ROOT / ".tmp/redaction-coverage-refresh"
MANIFEST = "scripts/production-cleanup-coverage-floors.json"
TEST = "tests/productionCleanupCoverageGate.test.ts"
METRICS = ("lines", "statements", "functions", "branches")


def run(args, log=None, timeout=1800):
    if log:
        with (OUT / log).open("w", encoding="utf-8") as stream:
            result = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        print(f"{log}: exit {result.returncode}", flush=True)
        return result.returncode
    return subprocess.check_output(args, text=True, encoding="utf-8").strip()


def api(method, endpoint, data=None):
    payload = json.dumps(data).encode("utf-8") if data is not None else None
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/{endpoint}", data=payload, method=method,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                 "User-Agent": "redaction-coverage-refresh"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def measure():
    code = run(["node", "node_modules/vitest/vitest.mjs", "run", "--coverage",
                "--coverage.reportOnFailure", "--reporter=default", "--reporter=json",
                f"--outputFile.json={OUT / 'tests.json'}"], "coverage.log")
    report = json.loads((OUT / "tests.json").read_text(encoding="utf-8"))
    allowed = "production cleanup coverage floor gate tracks every coverage-eligible source touched since cleanup start"
    failed = [case["fullName"] for suite in report["testResults"]
              for case in suite["assertionResults"] if case["status"] == "failed"]
    assert code in (0, 1) and failed in ([], [allowed]), f"Unrelated test failures: {failed}"
    assert report["numFailedTests"] == len(failed), "Unreported test failure"
    assert all(suite["assertionResults"] or suite["status"] != "failed" for suite in report["testResults"]), "Test collection failure"
    text = (OUT / "coverage.log").read_text(encoding="utf-8", errors="replace")
    assert not re.search(r"ERROR: Coverage|Unhandled Errors|Unhandled Rejection", text), "Coverage threshold or runtime failure"
    coverage_path = ROOT / "coverage/coverage-summary.json"
    capture = coverage_path.read_bytes()
    (OUT / "coverage-summary.json").write_bytes(capture)
    data = json.loads(capture)
    records = {Path(name).resolve().relative_to(ROOT).as_posix(): record
               for name, record in data.items() if name != "total"}
    return records, hashlib.sha256(capture).hexdigest()


def refresh(records, capture_sha):
    scope = json.loads(run(["node", "-e",
        "const g=require('./scripts/check-production-cleanup-coverage.cjs');console.log(JSON.stringify(g.collectCoverageScope(process.cwd(),g.CLEANUP_BASE_COMMIT)))"]))
    (OUT / "scope.json").write_text(json.dumps(scope, indent=2), encoding="utf-8")
    baseline = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))
    updated = json.loads(json.dumps(baseline))
    retired, added = [], []
    for field, category in (("floors", "existing"), ("introducedFloors", "added")):
        current = {}
        for name in scope[category]:
            if name in baseline[field]:
                current[name] = baseline[field][name]
            else:
                assert name not in baseline["floors"] and name not in baseline["introducedFloors"], "Cannot reclassify a live baseline"
                record = records[name]
                current[name] = {metric: {key: record[metric][key] for key in ("total", "covered", "pct")} for metric in METRICS}
                added.append(name)
        for name in set(baseline[field]) - set(current):
            assert not (ROOT / name).exists(), f"Refusing to retire a live floor: {name}"
            retired.append(name)
        updated[field] = current
    updated["deletedFiles"] = scope["deleted"]
    updated["provenance"]["introducedArtifact"] = ".tmp/production-cleanup-coverage-accepted-node22.json"
    updated["provenance"]["introducedArtifactSha256"] = capture_sha
    (ROOT / MANIFEST).write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    test = (ROOT / TEST).read_text(encoding="utf-8")
    for category in ("existing", "added", "deleted"):
        pattern = rf"expect\(scope\.{category}\)\.toHaveLength\(\d+\);"
        test, count = re.subn(pattern, f"expect(scope.{category}).toHaveLength({len(scope[category])});", test)
        assert count == 1, "Inventory assertion changed unexpectedly"
    (ROOT / TEST).write_text(test, encoding="utf-8")
    subprocess.check_call(["node", "node_modules/prettier/bin/prettier.cjs", "--write", MANIFEST, TEST])
    # This enforces every original ratio against the same Windows measurement.
    # A coverage regression aborts before any remote object or ref is written.
    assert run(["node", "scripts/check-production-cleanup-coverage.cjs"], "floor-gate.log") == 0, "Existing coverage floor regression; see floor-gate.log"
    assert run(["node", "node_modules/vitest/vitest.mjs", "run", "tests/productionCleanupCoverageGate.test.ts", "tests/i18nKeyUsage.test.ts", "tests/manualRedactionLocales.test.ts"], "inventory-tests.log") == 0, "Updated inventory tests failed"
    subprocess.check_call(["git", "diff", "--check"])
    assert set(run(["git", "diff", "--name-only"]).splitlines()) == {MANIFEST, TEST}, "Unexpected changed paths"
    return {"added": added, "retired": retired, "counts": {k: len(v) for k, v in scope.items()}}


def publish(source, summary):
    remote = api("GET", f"git/ref/heads/{BRANCH}")["object"]["sha"]
    assert remote == source, "Branch advanced; refusing to replace concurrent work"
    base_tree = api("GET", f"git/commits/{source}")["tree"]["sha"]
    elements = []
    for name in (MANIFEST, TEST):
        blob = api("POST", "git/blobs", {"content": (ROOT / name).read_text(encoding="utf-8"), "encoding": "utf-8"})
        elements.append({"path": name, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    tree = api("POST", "git/trees", {"base_tree": base_tree, "tree": elements})
    message = ("fix(coverage): seal the split redaction editor inventory\n\n"
               f"Measured on Windows Node 22 at {source}, run {os.environ['GITHUB_RUN_ID']}.\n"
               "Preserve every live baseline ratio unchanged; retire only deleted files.\n"
               "Add exact measured floors for newly tracked sources and update exact inventory counts.\n"
               "The floor gate and inventory/catalog regressions pass before this commit.\n")
    commit = api("POST", "git/commits", {"message": message, "tree": tree["sha"], "parents": [source]})
    api("PATCH", f"git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    assert api("GET", f"git/ref/heads/{BRANCH}")["object"]["sha"] == commit["sha"]
    summary["commit"] = commit["sha"]
    print("COVERAGE_CHECKPOINT=" + commit["sha"], flush=True)


def main():
    assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
    assert os.environ["GITHUB_REF"] == "refs/heads/" + BRANCH
    assert os.name == "nt" and run(["node", "-p", "process.versions.node.split('.')[0]"]) == "22"
    OUT.mkdir(parents=True, exist_ok=True)
    source = run(["git", "rev-parse", "HEAD"])
    assert source == os.environ["GITHUB_SHA"]
    records, capture_sha = measure()
    summary = {"source": source, "captureSha256": capture_sha, **refresh(records, capture_sha)}
    (OUT / "result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    publish(source, summary)
    (OUT / "result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
