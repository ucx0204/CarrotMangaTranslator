#!/usr/bin/env python3
"""Fuse the two 28k pseudo-label passes into leakage-safe active21 targets.

The source passes intentionally store only top-5 probabilities.  This tool
reconstructs the omitted probability mass conservatively, ensembles the two
rankers and their independent prototype references, removes the retired Gugi
class, and emits dense *soft* targets for every master-v3 train row.  These
records remain pseudo evidence (never human gold) and are consumed only with a
small per-row weight by the mass-training loop.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


SCHEMA = "manga-font-student-v6-mass21-pseudo-v1"
REPORT_SCHEMA = "manga-font-student-v6-mass21-pseudo-report-v1"
OWNER = "carrot-manga-translator/manga-font-mass21-pseudo-targets"
MARKER = ".manga-font-mass21-pseudo-targets-owned.json"
ROWS_FILE = "pseudo-targets.jsonl"
REPORT_FILE = "report.json"
RETIRED_FONT_ID = "gugi"
EXPECTED_MASTER_ROWS = 28_094
EXPECTED_TRAIN_ROWS = 19_664
EXPECTED_SOURCE_ROWS = 28_096


class Mass21PseudoError(ValueError):
    """Raised when source evidence or an output boundary drifts."""


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _record_sha(row: Mapping[str, Any]) -> str:
    payload = dict(row)
    payload.pop("record_sha256", None)
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _object(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise Mass21PseudoError(f"{location}: expected object")
    return value


def _array(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise Mass21PseudoError(f"{location}: expected array")
    return value


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise Mass21PseudoError(f"{location}: missing or linked file")
    try:
        return _object(json.loads(path.read_text(encoding="utf-8")), location)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Mass21PseudoError(f"{location}: invalid JSON") from error


def _load_pass(path: Path, *, expected_pass: int) -> dict[str, Mapping[str, Any]]:
    if path.is_symlink() or not path.is_file():
        raise Mass21PseudoError(f"pass{expected_pass}: missing or linked file")
    rows: dict[str, Mapping[str, Any]] = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _object(json.loads(line), f"pass{expected_pass} row {line_number}")
            except json.JSONDecodeError as error:
                raise Mass21PseudoError(
                    f"pass{expected_pass} row {line_number}: invalid JSON"
                ) from error
            sample_id = str(row.get("sample_id", ""))
            if (
                not sample_id
                or row.get("pass_number") != expected_pass
                or row.get("label_authority") != "pseudo_not_gold"
                or row.get("training_eligible") is not False
                or sample_id in rows
            ):
                raise Mass21PseudoError(
                    f"pass{expected_pass} row {line_number}: authority/identity drifted"
                )
            rows[sample_id] = row
    if len(rows) != EXPECTED_SOURCE_ROWS:
        raise Mass21PseudoError(
            f"pass{expected_pass}: expected {EXPECTED_SOURCE_ROWS} rows, got {len(rows)}"
        )
    return rows


def _active_candidates(cache_contract: Path) -> tuple[str, ...]:
    contract = _read_json(cache_contract, "cache contract")
    source = tuple(str(value) for value in _array(contract.get("candidate_ids"), "candidate_ids"))
    if len(source) != 22 or source.count(RETIRED_FONT_ID) != 1 or len(set(source)) != 22:
        raise Mass21PseudoError("cache contract is not the sealed full22 vocabulary")
    return tuple(font_id for font_id in source if font_id != RETIRED_FONT_ID)


def _master_train_rows(path: Path) -> tuple[list[Mapping[str, Any]], str]:
    if path.is_symlink() or not path.is_file():
        raise Mass21PseudoError("master manifest is missing or linked")
    digest = hashlib.sha256()
    train: list[Mapping[str, Any]] = []
    total = 0
    seen: set[str] = set()
    with path.open("rb") as handle:
        for line_number, raw in enumerate(handle, 1):
            digest.update(raw)
            if not raw.strip():
                continue
            total += 1
            try:
                row = _object(json.loads(raw), f"master row {line_number}")
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise Mass21PseudoError(f"master row {line_number}: invalid JSON") from error
            if row.get("split") != "train":
                continue
            sample_id = str(row.get("id", ""))
            if not sample_id or sample_id in seen:
                raise Mass21PseudoError(f"master row {line_number}: duplicate/empty id")
            seen.add(sample_id)
            train.append(row)
    if total != EXPECTED_MASTER_ROWS or len(train) != EXPECTED_TRAIN_ROWS:
        raise Mass21PseudoError(
            f"master counts drifted: total={total}, train={len(train)}"
        )
    return train, digest.hexdigest()


def _parent_id(row: Mapping[str, Any]) -> str | None:
    provenance = _object(row.get("provenance"), "master provenance")
    lineage = provenance.get("source_lineage")
    if not isinstance(lineage, list):
        return None
    for value in lineage:
        item = _object(value, "source lineage")
        if item.get("provenance") == "real_master_superseded":
            parent = str(item.get("id", ""))
            return parent or None
    return None


def _dense_top5(
    value: Any,
    *,
    source_ids: tuple[str, ...],
    location: str,
) -> list[float]:
    section = _object(value, location)
    top5 = _array(section.get("top5"), f"{location}.top5")
    if len(top5) != 5:
        raise Mass21PseudoError(f"{location}: expected top5")
    observed: dict[str, float] = {}
    for index, raw in enumerate(top5):
        item = _object(raw, f"{location}.top5[{index}]")
        font_id = str(item.get("font_id", ""))
        try:
            probability = float(item.get("probability"))
        except (TypeError, ValueError) as error:
            raise Mass21PseudoError(f"{location}: invalid probability") from error
        if (
            font_id not in source_ids
            or font_id in observed
            or not math.isfinite(probability)
            or probability < 0.0
        ):
            raise Mass21PseudoError(f"{location}: invalid top5 member")
        observed[font_id] = probability
    remaining = max(0.0, 1.0 - sum(observed.values()))
    unseen = len(source_ids) - len(observed)
    fallback = remaining / unseen if unseen else 0.0
    dense = [observed.get(font_id, fallback) for font_id in source_ids]
    total = sum(dense)
    if total <= 0.0:
        raise Mass21PseudoError(f"{location}: empty distribution")
    return [value / total for value in dense]


def _selected(row: Mapping[str, Any], head: str) -> str:
    return str(_object(row.get(head), head).get("selected_font_id", ""))


def _fused_target(
    first: Mapping[str, Any],
    second: Mapping[str, Any],
    *,
    active_ids: tuple[str, ...],
) -> tuple[list[float], float, dict[str, Any]]:
    source_ids = (*active_ids, RETIRED_FONT_ID)
    components = (
        (0.25, _dense_top5(first.get("ranker"), source_ids=source_ids, location="pass1.ranker")),
        (0.15, _dense_top5(first.get("direct_reference"), source_ids=source_ids, location="pass1.direct")),
        (0.40, _dense_top5(second.get("ranker"), source_ids=source_ids, location="pass2.ranker")),
        (0.20, _dense_top5(second.get("direct_reference"), source_ids=source_ids, location="pass2.direct")),
    )
    combined = [sum(weight * values[index] for weight, values in components) for index in range(22)]
    active = combined[: len(active_ids)]
    total = sum(active)
    if total <= 0.0:
        raise Mass21PseudoError("retired projection removed all probability mass")
    projected = [value / total for value in active]
    # Mild sharpening preserves alternatives while making the low-weight target useful.
    sharpened = [max(value, 1e-9) ** 1.35 for value in projected]
    sharpened_total = sum(sharpened)
    probabilities = [value / sharpened_total for value in sharpened]

    pass_agreement = _selected(first, "ranker") == _selected(second, "ranker")
    head_agreement = _selected(second, "ranker") == _selected(second, "direct_reference")
    try:
        margin = float(_object(second.get("ranker"), "pass2.ranker").get("top1_margin", 0.0))
    except (TypeError, ValueError) as error:
        raise Mass21PseudoError("pass2 margin is invalid") from error
    if not math.isfinite(margin) or margin < 0.0:
        raise Mass21PseudoError("pass2 margin is invalid")
    weight = 0.04 + min(0.08, margin * 4.0)
    if pass_agreement:
        weight += 0.04
    if head_agreement:
        weight += 0.03
    if _selected(second, "ranker") == RETIRED_FONT_ID:
        weight *= 0.35
    weight = min(0.18, max(0.01, weight))
    metadata = {
        "pass1_ranker_top1": _selected(first, "ranker"),
        "pass2_direct_top1": _selected(second, "direct_reference"),
        "pass2_ranker_top1": _selected(second, "ranker"),
        "pass_agreement": pass_agreement,
        "pass2_head_agreement": head_agreement,
        "pass2_margin": margin,
        "retired_top1_downweighted": _selected(second, "ranker") == RETIRED_FONT_ID,
    }
    return probabilities, weight, metadata


def _atomic_text(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def _prepare_output(path: Path) -> Path:
    root = path.expanduser().resolve()
    if root.exists():
        marker = root / MARKER
        if root.is_symlink() or not marker.is_file():
            raise Mass21PseudoError("refusing to replace an unowned output directory")
        owned = _read_json(marker, "output marker")
        if owned.get("owner") != OWNER or owned.get("safe_replace") is not True:
            raise Mass21PseudoError("output ownership marker drifted")
        shutil.rmtree(root)
    root.mkdir(parents=True)
    return root


def build(args: argparse.Namespace) -> Mapping[str, Any]:
    active_ids = _active_candidates(args.cache_contract)
    master_rows, master_sha = _master_train_rows(args.master_manifest)
    first_rows = _load_pass(args.pass1, expected_pass=1)
    second_rows = _load_pass(args.pass2, expected_pass=2)
    teacher_bindings = {
        "pass1_sha256": _sha256(args.pass1),
        "pass2_sha256": _sha256(args.pass2),
    }
    root = _prepare_output(args.output_dir)
    rows_path = root / ROWS_FILE
    digest = hashlib.sha256()
    font_usage: Counter[str] = Counter()
    source_usage: Counter[str] = Counter()
    weights: list[float] = []
    successor_count = 0
    with rows_path.open("wb") as output:
        for master_row in master_rows:
            sample_id = str(master_row["id"])
            teacher_id = sample_id
            if teacher_id not in first_rows or teacher_id not in second_rows:
                teacher_id = _parent_id(master_row) or ""
                successor_count += 1
            if teacher_id not in first_rows or teacher_id not in second_rows:
                raise Mass21PseudoError(f"{sample_id}: no pass1/pass2 teacher row")
            probabilities, weight, ensemble = _fused_target(
                first_rows[teacher_id], second_rows[teacher_id], active_ids=active_ids
            )
            if teacher_id != sample_id:
                weight = max(0.01, weight * 0.5)
            top_index = max(range(len(probabilities)), key=probabilities.__getitem__)
            font_usage[active_ids[top_index]] += 1
            source_usage[str(master_row.get("metadata", {}).get("candidate_primary_category") or "ordinary")] += 1
            weights.append(weight)
            row: dict[str, Any] = {
                "candidate_ids": list(active_ids),
                "ensemble": ensemble,
                "label_authority": "pseudo_soft_not_gold",
                "master_row_sha256": hashlib.sha256(_canonical(master_row).encode("utf-8")).hexdigest(),
                "probabilities": [round(value, 10) for value in probabilities],
                "round": 1,
                "sample_id": sample_id,
                "schema_version": SCHEMA,
                "source_category": str(master_row.get("metadata", {}).get("candidate_primary_category") or "ordinary"),
                "source_teacher_sample_id": teacher_id,
                "split": "train",
                "teacher_bindings": teacher_bindings,
                "training_eligible": False,
                "weight": round(weight, 8),
                "work_id": str(_object(master_row.get("work"), "master work").get("id", "")),
            }
            # Rounding may move the sum by a few ulps; repair the final element exactly.
            difference = 1.0 - sum(row["probabilities"])
            row["probabilities"][-1] = round(row["probabilities"][-1] + difference, 10)
            row["record_sha256"] = _record_sha(row)
            payload = (_canonical(row) + "\n").encode("utf-8")
            output.write(payload)
            digest.update(payload)
        output.flush()
        os.fsync(output.fileno())
    report: dict[str, Any] = {
        "active_candidate_count": len(active_ids),
        "candidate_ids": list(active_ids),
        "font_usage": dict(sorted(font_usage.items())),
        "label_authority": "pseudo_soft_not_gold",
        "master_manifest_sha256": master_sha,
        "mean_weight": sum(weights) / len(weights),
        "output_file": ROWS_FILE,
        "output_sha256": digest.hexdigest(),
        "record_count": len(weights),
        "schema_version": REPORT_SCHEMA,
        "source_category_counts": dict(sorted(source_usage.items())),
        "successor_teacher_rows": successor_count,
        "test_rows_emitted": 0,
        "training_eligible_rows": 0,
        "weight_max": max(weights),
        "weight_min": min(weights),
    }
    report["record_sha256"] = _record_sha(report)
    _atomic_text(root / REPORT_FILE, _canonical(report) + "\n")
    marker = {
        "artifacts": {
            REPORT_FILE: _sha256(root / REPORT_FILE),
            ROWS_FILE: _sha256(rows_path),
        },
        "owner": OWNER,
        "safe_replace": True,
        "schema_version": REPORT_SCHEMA,
    }
    marker["record_sha256"] = _record_sha(marker)
    _atomic_text(root / MARKER, _canonical(marker) + "\n")
    return report


def validate(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    marker = _read_json(root / MARKER, "output marker")
    report = _read_json(root / REPORT_FILE, "output report")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("record_sha256") != _record_sha(marker)
        or report.get("record_sha256") != _record_sha(report)
    ):
        raise Mass21PseudoError("output seal drifted")
    artifacts = _object(marker.get("artifacts"), "marker artifacts")
    for name in (REPORT_FILE, ROWS_FILE):
        if artifacts.get(name) != _sha256(root / name):
            raise Mass21PseudoError(f"output hash drifted: {name}")
    count = 0
    with (root / ROWS_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = _object(json.loads(line), f"output row {line_number}")
            probabilities = [float(value) for value in _array(row.get("probabilities"), "probabilities")]
            if (
                row.get("schema_version") != SCHEMA
                or row.get("split") != "train"
                or row.get("label_authority") != "pseudo_soft_not_gold"
                or row.get("training_eligible") is not False
                or row.get("record_sha256") != _record_sha(row)
                or len(probabilities) != 21
                or not math.isclose(sum(probabilities), 1.0, rel_tol=0.0, abs_tol=1e-5)
            ):
                raise Mass21PseudoError(f"output row {line_number}: boundary drifted")
            count += 1
    if count != EXPECTED_TRAIN_ROWS or report.get("record_count") != count:
        raise Mass21PseudoError("output count drifted")
    return {"record_count": count, "status": "valid", "output_sha256": _sha256(root / ROWS_FILE)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--master-manifest", type=Path, required=True)
    build_parser.add_argument("--pass1", type=Path, required=True)
    build_parser.add_argument("--pass2", type=Path, required=True)
    build_parser.add_argument("--cache-contract", type=Path, required=True)
    build_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build(args) if args.command == "build" else validate(args.output_dir)
    except (Mass21PseudoError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"mass21 pseudo error: {error}") from error
    print(_canonical(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
