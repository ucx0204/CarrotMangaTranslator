#!/usr/bin/env python3
"""Materialize the selected R5 epoch-1 QA head as a sealed v7-r3 output.

The source R5 training output is immutable.  A fresh staging directory copies
its exact inventory, replaces only the runtime best-head file with the sealed
epoch-1 QA snapshot, and rewrites the chosen validation metadata and hashes.
The result remains QA-only: visual review is model-visible, not independent
gold, and neither this tool nor its manifest may promote a failed research
quality gate.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    from scripts import evaluate_manga_font_r5_qa_snapshots as snapshot_eval
    from scripts import label_manga_font_student_v7_mass21_pass as labeler
    from scripts import train_manga_font_student_v7_mass21_r5_visual_masked as r5
except ImportError:  # pragma: no cover - direct execution from scripts/
    import evaluate_manga_font_r5_qa_snapshots as snapshot_eval
    import label_manga_font_student_v7_mass21_pass as labeler
    import train_manga_font_student_v7_mass21_r5_visual_masked as r5


SCHEMA = "manga-font-r5-qa-snapshot-materialization-v1"
SELECTED_EPOCH = 1
QA_SELECTION_KEY = "qa_snapshot_selection"
AUTHORITY = snapshot_eval.QA_AUTHORITY


class SnapshotMaterializationError(ValueError):
    """Raised when materialization would cross a sealed QA boundary."""


def canonical_json(value: Any) -> str:
    return labeler.canonical_json(value)


def sha256_file(path: Path) -> str:
    return labeler.sha256_file(path)


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SnapshotMaterializationError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise SnapshotMaterializationError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise SnapshotMaterializationError(f"{location}: expected text")
    return result


def _sha(value: Any, location: str) -> str:
    result = _text(value, location).lower()
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise SnapshotMaterializationError(f"{location}: expected SHA256")
    return result


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise SnapshotMaterializationError(f"{location}: missing or linked file")
    try:
        return _mapping(json.loads(resolved.read_text(encoding="utf-8")), location)
    except json.JSONDecodeError as error:
        raise SnapshotMaterializationError(f"{location}: invalid JSON") from error


def _inventory_hashes(root: Path) -> Mapping[str, str]:
    resolved = root.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_dir():
        raise SnapshotMaterializationError("source inventory is missing or linked")
    entries = tuple(resolved.iterdir())
    if {path.name for path in entries} != r5.r3.OUTPUT_FILES or any(
        path.is_symlink() or not path.is_file() for path in entries
    ):
        raise SnapshotMaterializationError("source inventory drifted")
    return {path.name: sha256_file(path) for path in sorted(entries, key=lambda path: path.name)}


def _load_history(root: Path) -> tuple[Mapping[str, Any], ...]:
    path = root / r5.r3.v7.HISTORY
    rows: list[Mapping[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = _mapping(json.loads(line), f"history:{line_number}")
            except json.JSONDecodeError as error:
                raise SnapshotMaterializationError("history is invalid JSONL") from error
            try:
                r5.r3.v7.base.validate_record_seal(
                    row, location=f"history:{line_number}"
                )
            except r5.r3.v7.base.RuntimeArtifactError as error:
                raise SnapshotMaterializationError(str(error)) from error
            if (
                int(row.get("epoch", -1)) != line_number
                or row.get("schema_version") != r5.r3.SCHEMA
            ):
                raise SnapshotMaterializationError("history epoch/schema drifted")
            rows.append(row)
    if not rows:
        raise SnapshotMaterializationError("history is empty")
    return tuple(rows)


def selected_history_val(
    history: Sequence[Mapping[str, Any]], *, selected_epoch: int
) -> tuple[Mapping[str, Any], str]:
    if selected_epoch != SELECTED_EPOCH or len(history) < selected_epoch:
        raise SnapshotMaterializationError("only the evaluated epoch 1 may be selected")
    row = history[selected_epoch - 1]
    if int(row.get("epoch", -1)) != selected_epoch:
        raise SnapshotMaterializationError("selected history epoch drifted")
    value = _mapping(row.get("val"), "selected history val")
    record_sha = _sha(row.get("record_sha256"), "selected history record SHA")
    if int(value.get("evaluated_positive_rows", -1)) != r5.r3.v7.VAL_ROWS:
        raise SnapshotMaterializationError("selected validation inventory drifted")
    return copy.deepcopy(dict(value)), record_sha


def _research_gate(best_val: Mapping[str, Any]) -> Mapping[str, Any]:
    gate = r5.r3.v7.v6.research_gate(best_val)
    if not isinstance(gate, Mapping) or gate.get("passed") is not False:
        raise SnapshotMaterializationError(
            "QA materialization cannot select or promote a passing research gate"
        )
    return copy.deepcopy(dict(gate))


def _load_evaluation_selection(
    evaluation_dir: Path,
    *,
    selected_epoch: int,
) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    root = evaluation_dir.expanduser().resolve()
    try:
        validation = snapshot_eval.validate_output(root)
    except snapshot_eval.SnapshotEvaluationError as error:
        raise SnapshotMaterializationError(str(error)) from error
    manifest_path = root / snapshot_eval.MANIFEST_FILE
    report_path = root / snapshot_eval.REPORT_FILE
    manifest = _read_json(manifest_path, "snapshot evaluation manifest")
    report = _read_json(report_path, "snapshot evaluation report")
    authority = _mapping(manifest.get("authority"), "snapshot evaluation authority")
    if (
        validation.get("status")
        != "validated_r5_snapshot_visual_qa_not_independent_gold"
        or int(validation.get("rows_per_epoch", -1)) != 934
        or authority.get("human_gold") is not False
        or authority.get("independent_gold") is not False
        or authority.get("quality_gate_authority") is not False
        or authority.get("training_eligible") is not False
        or authority.get("visual_review_authority") != AUTHORITY
    ):
        raise SnapshotMaterializationError("snapshot evaluation authority drifted")
    cohorts = _mapping(manifest.get("decision_cohorts"), "evaluation cohorts")
    abcd = _mapping(cohorts.get("abcd_heldout"), "ABCD heldout cohort")
    post = _mapping(cohorts.get(snapshot_eval.POST_CUTOFF_COHORT), "post-cutoff E cohort")
    if (
        int(abcd.get("row_count", -1)) != 502
        or int(post.get("row_count", -1)) != 432
        or int(post.get("decided_rows", -1)) != 354
        or int(post.get("review_needed_rows", -1)) != 78
    ):
        raise SnapshotMaterializationError("snapshot evaluation cohort drifted")
    snapshots = {
        int(_mapping(value, "evaluated snapshot").get("epoch", -1)): _mapping(
            value, "evaluated snapshot"
        )
        for value in _sequence(manifest.get("snapshots"), "evaluated snapshots")
    }
    selected = snapshots.get(selected_epoch)
    if selected is None:
        raise SnapshotMaterializationError("selected snapshot was not evaluated")
    metric_rows: dict[int, Mapping[str, Any]] = {}
    with (root / snapshot_eval.METRICS_FILE).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = _mapping(json.loads(line), f"snapshot metric:{line_number}")
            snapshot_eval.validate_record_seal(
                row, location=f"snapshot metric:{line_number}"
            )
            binding = _mapping(row.get("snapshot"), "snapshot metric binding")
            metric_rows[int(binding.get("epoch", -1))] = row
    epoch0 = _mapping(metric_rows.get(0), "epoch0 metric")
    epoch0_check = _mapping(
        epoch0.get("epoch0_baseline_self_check"), "epoch0 baseline self-check"
    )
    selected_metric = _mapping(metric_rows.get(selected_epoch), "selected epoch metric")
    if (
        epoch0_check.get("status") != "passed"
        or float(epoch0_check.get("exact_match_rate", -1.0)) != 1.0
        or int(epoch0_check.get("matched_rows", -1)) != 934
        or _mapping(selected_metric.get("snapshot"), "selected metric snapshot").get(
            "sha256"
        )
        != selected.get("sha256")
    ):
        raise SnapshotMaterializationError("snapshot metric/self-check binding drifted")
    return selected, selected_metric, {
        "file": str(root),
        "manifest_record_sha256": _sha(
            manifest.get("record_sha256"), "evaluation manifest seal"
        ),
        "manifest_sha256": sha256_file(manifest_path),
        "report_record_sha256": _sha(
            report.get("record_sha256"), "evaluation report seal"
        ),
        "report_sha256": sha256_file(report_path),
    }


def build_selection_record(
    *,
    source_root: Path,
    source_manifest: Mapping[str, Any],
    snapshot_dir: Path,
    snapshot: snapshot_eval.Snapshot,
    evaluation_binding: Mapping[str, Any],
    selected_metric: Mapping[str, Any],
    history_record_sha256: str,
    chosen_gate: Mapping[str, Any],
) -> Mapping[str, Any]:
    source_gate = _mapping(source_manifest.get("quality_gate"), "source quality gate")
    if source_gate.get("passed") is not False or chosen_gate.get("passed") is not False:
        raise SnapshotMaterializationError("quality gate promotion is forbidden")
    return {
        "authority": {
            "human_gold": False,
            "independent_gold": False,
            "quality_gate_authority": False,
            "selection_authority": "model_visible_visual_qa_only",
            "training_eligible": False,
        },
        "candidate_ids": list(snapshot_eval._active_ids()),  # noqa: SLF001
        "epoch": snapshot.epoch,
        "evaluation_manifest_sha256": evaluation_binding["manifest_sha256"],
        "evaluation_report_sha256": evaluation_binding["report_sha256"],
        "evaluation_source": copy.deepcopy(dict(evaluation_binding)),
        "history_epoch_record_sha256": history_record_sha256,
        "latest_checkpoint_policy": (
            "inherited training-resume evidence only; runtime head is the selected snapshot"
        ),
        "predictions_val_policy": (
            "inherited automatic-best diagnostic rows; selected best_val is bound to the "
            "sealed epoch history and is not recomputed or promoted by this materializer"
        ),
        "prototype_policy": "fixed published R5/R3 prototype tensor used by snapshot QA",
        "quality_gate": {
            "chosen_epoch_passed": False,
            "promoted": False,
            "source_passed": False,
        },
        "release_approved": False,
        "schema_version": SCHEMA,
        "selected_metric_record_sha256": _sha(
            selected_metric.get("record_sha256"), "selected metric seal"
        ),
        "snapshot_dir": str(snapshot_dir.expanduser().resolve()),
        "snapshot_file": snapshot.path.name,
        "snapshot_sha256": snapshot.sha256,
        "source_training_output": {
            "best_head_sha256": _sha(
                _mapping(source_manifest.get("files"), "source files")
                .get(r5.r3.v7.BEST_HEAD, {})
                .get("sha256"),
                "source best-head SHA",
            ),
            "file": str(source_root),
            "manifest_record_sha256": _sha(
                source_manifest.get("record_sha256"), "source manifest seal"
            ),
            "manifest_sha256": sha256_file(source_root / r5.r3.v7.MANIFEST),
        },
    }


def rewrite_manifest(
    source_manifest: Mapping[str, Any],
    *,
    selected_epoch: int,
    selected_val: Mapping[str, Any],
    chosen_gate: Mapping[str, Any],
    selection_record: Mapping[str, Any],
    staged_head: Path,
) -> Mapping[str, Any]:
    result = copy.deepcopy(dict(source_manifest))
    result.pop("record_sha256", None)
    files = dict(_mapping(result.get("files"), "materialized files"))
    files[r5.r3.v7.BEST_HEAD] = {
        "byte_size": staged_head.stat().st_size,
        "file": r5.r3.v7.BEST_HEAD,
        "sha256": sha256_file(staged_head),
    }
    result["best_epoch"] = selected_epoch
    result["best_val"] = copy.deepcopy(dict(selected_val))
    result["files"] = files
    result[QA_SELECTION_KEY] = copy.deepcopy(dict(selection_record))
    result["quality_gate"] = copy.deepcopy(dict(chosen_gate))
    return r5.r3.v7.base.seal_record(result)


def _write_manifest_and_marker(staging: Path, manifest: Mapping[str, Any]) -> None:
    manifest_path = staging / r5.r3.v7.MANIFEST
    manifest_path.write_bytes(r5.r3.v7.base.json_bytes(manifest, pretty=True))
    marker = {
        "artifacts": {
            name: sha256_file(staging / name)
            for name in r5.r3.OUTPUT_FILES - {r5.r3.MARKER}
        },
        "owner": r5.r3.OWNER,
        "safe_replace": True,
        "schema_version": r5.r3.SCHEMA,
    }
    (staging / r5.r3.MARKER).write_bytes(
        r5.r3.v7.base.json_bytes(marker, pretty=True)
    )


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    try:
        r3_validation = r5.r3.validate_output(root)
        r5_validation = r5.validate_output(root)
        loaded = labeler.load_model_artifacts(root, source_kind="v7-r3")
    except (
        r5.r3.MangaFontV7Mass21R3Error,
        r5.MangaFontV7Mass21R5Error,
        labeler.MangaFontV7PassError,
    ) as error:
        raise SnapshotMaterializationError(str(error)) from error
    manifest = _read_json(root / r5.r3.v7.MANIFEST, "materialized manifest")
    selection = _mapping(manifest.get(QA_SELECTION_KEY), "QA snapshot selection")
    authority = _mapping(selection.get("authority"), "QA selection authority")
    if (
        selection.get("schema_version") != SCHEMA
        or int(selection.get("epoch", -1)) != SELECTED_EPOCH
        or selection.get("release_approved") is not False
        or authority.get("human_gold") is not False
        or authority.get("independent_gold") is not False
        or authority.get("quality_gate_authority") is not False
        or authority.get("training_eligible") is not False
        or authority.get("selection_authority") != "model_visible_visual_qa_only"
    ):
        raise SnapshotMaterializationError("QA selection authority drifted")
    source_binding = _mapping(
        selection.get("source_training_output"), "source training binding"
    )
    source_root = Path(_text(source_binding.get("file"), "source training path"))
    if source_root.expanduser().resolve() == root:
        raise SnapshotMaterializationError("materialized output aliases its source")
    try:
        r5.validate_output(source_root)
    except r5.MangaFontV7Mass21R5Error as error:
        raise SnapshotMaterializationError("source R5 output drifted") from error
    source_manifest_path = source_root.expanduser().resolve() / r5.r3.v7.MANIFEST
    source_manifest = _read_json(source_manifest_path, "source training manifest")
    if (
        source_binding.get("manifest_sha256") != sha256_file(source_manifest_path)
        or source_binding.get("manifest_record_sha256")
        != source_manifest.get("record_sha256")
    ):
        raise SnapshotMaterializationError("source training provenance drifted")
    evaluation_root = Path(
        _text(
            _mapping(selection.get("evaluation_source"), "evaluation source").get(
                "file"
            ),
            "evaluation path",
        )
    )
    selected_binding, selected_metric, evaluation_binding = _load_evaluation_selection(
        evaluation_root, selected_epoch=SELECTED_EPOCH
    )
    if (
        selection.get("evaluation_manifest_sha256")
        != evaluation_binding["manifest_sha256"]
        or selection.get("evaluation_report_sha256")
        != evaluation_binding["report_sha256"]
        or selection.get("selected_metric_record_sha256")
        != selected_metric.get("record_sha256")
    ):
        raise SnapshotMaterializationError("snapshot evaluation provenance drifted")
    snapshots = snapshot_eval.load_snapshots(
        Path(_text(selection.get("snapshot_dir"), "snapshot directory"))
    )
    snapshot = next((value for value in snapshots if value.epoch == SELECTED_EPOCH), None)
    if (
        snapshot is None
        or snapshot.path.name != selection.get("snapshot_file")
        or snapshot.sha256 != selection.get("snapshot_sha256")
        or snapshot.sha256 != selected_binding.get("sha256")
        or sha256_file(root / r5.r3.v7.BEST_HEAD) != snapshot.sha256
    ):
        raise SnapshotMaterializationError("materialized head/snapshot binding drifted")
    history = _load_history(root)
    selected_val, history_sha = selected_history_val(
        history, selected_epoch=SELECTED_EPOCH
    )
    gate = _research_gate(selected_val)
    selection_gate = _mapping(selection.get("quality_gate"), "QA selection gate")
    if (
        int(manifest.get("best_epoch", -1)) != SELECTED_EPOCH
        or canonical_json(manifest.get("best_val")) != canonical_json(selected_val)
        or canonical_json(manifest.get("quality_gate")) != canonical_json(gate)
        or manifest.get("quality_gate", {}).get("passed") is not False
        or selection_gate
        != {"chosen_epoch_passed": False, "promoted": False, "source_passed": False}
        or selection.get("history_epoch_record_sha256") != history_sha
        or loaded.bindings.get("checkpoint_sha256") != snapshot.sha256
        or loaded.candidate_ids != snapshot_eval._active_ids()  # noqa: SLF001
    ):
        raise SnapshotMaterializationError("materialized epoch/gate/model binding drifted")
    return {
        "best_epoch": SELECTED_EPOCH,
        "checkpoint_sha256": snapshot.sha256,
        "labeler_v7_r3_load": True,
        "output_dir": str(root),
        "quality_gate_passed": False,
        "qa_only": True,
        "r3_status": r3_validation.get("status"),
        "r5_status": r5_validation.get("status"),
        "release_approved": False,
        "status": "validated_r5_epoch1_qa_snapshot_materialization",
    }


def materialize(
    *,
    source_output_dir: Path,
    snapshot_dir: Path,
    snapshot_evaluation_dir: Path,
    selected_epoch: int,
    output_dir: Path,
) -> Mapping[str, Any]:
    if selected_epoch != SELECTED_EPOCH:
        raise SnapshotMaterializationError("this sealed selection is epoch 1 only")
    source_root = source_output_dir.expanduser().resolve()
    destination = output_dir.expanduser().resolve()
    if destination == source_root or source_root in destination.parents:
        raise SnapshotMaterializationError("output must be separate from the source tree")
    if destination.exists():
        raise SnapshotMaterializationError("materialized output already exists")
    try:
        source_validation = r5.validate_output(source_root)
    except r5.MangaFontV7Mass21R5Error as error:
        raise SnapshotMaterializationError(str(error)) from error
    if source_validation.get("status") != "validated_v7_mass21_r5_visual_masked_output":
        raise SnapshotMaterializationError("source R5 completion status drifted")
    source_hashes = _inventory_hashes(source_root)
    source_manifest = _read_json(source_root / r5.r3.v7.MANIFEST, "source manifest")
    source_gate = _mapping(source_manifest.get("quality_gate"), "source quality gate")
    if source_gate.get("passed") is not False:
        raise SnapshotMaterializationError("source research gate must remain failed")
    history = _load_history(source_root)
    selected_val, history_sha = selected_history_val(
        history, selected_epoch=selected_epoch
    )
    chosen_gate = _research_gate(selected_val)
    snapshots = snapshot_eval.load_snapshots(snapshot_dir)
    snapshot = next((value for value in snapshots if value.epoch == selected_epoch), None)
    if snapshot is None:
        raise SnapshotMaterializationError("selected snapshot is missing")
    selected_binding, selected_metric, evaluation_binding = _load_evaluation_selection(
        snapshot_evaluation_dir, selected_epoch=selected_epoch
    )
    if (
        snapshot.sha256 != selected_binding.get("sha256")
        or tuple(selected_binding.get("candidate_ids", ()))
        != snapshot_eval._active_ids()  # noqa: SLF001
        or tuple(source_manifest.get("candidate_ids", ()))
        != snapshot_eval._active_ids()  # noqa: SLF001
    ):
        raise SnapshotMaterializationError("source/snapshot/evaluation binding drifted")
    reference = _mapping(
        _read_json(
            snapshot_evaluation_dir.expanduser().resolve() / snapshot_eval.MANIFEST_FILE,
            "snapshot evaluation manifest",
        ).get("reference_model"),
        "snapshot evaluation reference model",
    )
    source_prototype_sha = sha256_file(source_root / r5.r3.v7.PROTOTYPES)
    if reference.get("prototypes_sha256") != source_prototype_sha:
        raise SnapshotMaterializationError("fixed prototype binding drifted")
    selection_record = build_selection_record(
        source_root=source_root,
        source_manifest=source_manifest,
        snapshot_dir=snapshot_dir,
        snapshot=snapshot,
        evaluation_binding=evaluation_binding,
        selected_metric=selected_metric,
        history_record_sha256=history_sha,
        chosen_gate=chosen_gate,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent)
    )
    published = False
    try:
        for name in r5.r3.OUTPUT_FILES:
            shutil.copy2(source_root / name, staging / name)
        shutil.copy2(snapshot.path, staging / r5.r3.v7.BEST_HEAD)
        manifest = rewrite_manifest(
            source_manifest,
            selected_epoch=selected_epoch,
            selected_val=selected_val,
            chosen_gate=chosen_gate,
            selection_record=selection_record,
            staged_head=staging / r5.r3.v7.BEST_HEAD,
        )
        _write_manifest_and_marker(staging, manifest)
        validate_output(staging)
        if _inventory_hashes(source_root) != source_hashes:
            raise SnapshotMaterializationError("source output changed during materialization")
        os.replace(staging, destination)
        published = True
        result = dict(validate_output(destination))
        result["source_unchanged"] = _inventory_hashes(source_root) == source_hashes
        return result
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    materialize_parser = commands.add_parser("materialize")
    materialize_parser.add_argument("--source-output-dir", type=Path, required=True)
    materialize_parser.add_argument("--snapshot-dir", type=Path, required=True)
    materialize_parser.add_argument(
        "--snapshot-evaluation-dir", type=Path, required=True
    )
    materialize_parser.add_argument(
        "--selected-epoch", type=int, default=SELECTED_EPOCH
    )
    materialize_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            result = materialize(
                source_output_dir=args.source_output_dir,
                snapshot_dir=args.snapshot_dir,
                snapshot_evaluation_dir=args.snapshot_evaluation_dir,
                selected_epoch=args.selected_epoch,
                output_dir=args.output_dir,
            )
    except (
        SnapshotMaterializationError,
        OSError,
        KeyError,
        TypeError,
        ValueError,
    ) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
