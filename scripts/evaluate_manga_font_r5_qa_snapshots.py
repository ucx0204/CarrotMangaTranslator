#!/usr/bin/env python3
"""Evaluate R5 QA head snapshots on sealed visual-review cutoffs.

This is a read-only, model-visible QA tool.  It compares every contiguous R5
epoch head against the same active21 candidate order, the same published R3
prototype tensor, and the same sealed SigLIP2 patch-token cache.  It never
promotes visual review to human gold or training supervision.

Two cohorts are supported in one pass:

* the A/B/C/D overlay's held-out visual QA rows; and
* a later, post-training-cutoff named-review artifact such as agent E.

Only the union of those sample IDs is loaded from the hidden-state arrays.  A
full-array rehash is intentionally not performed here; instead the caller must
pin the already validated cache identity and manifest SHA256 explicitly.  All
top-level seals, index hashes, selected shard seals, shapes, identities, and
finite selected tensor values are still checked fail-closed.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import build_manga_font_fast_review_batches as named_review
    from scripts import build_manga_font_master_v3_siglip2_hidden_cache as cache
    from scripts import evaluate_manga_font_visual_heldout_v1 as heldout_eval
    from scripts import label_manga_font_student_v7_mass21_pass as labeler
    from scripts import train_manga_font_student_v7_mass21_r5_visual_masked as r5
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_fast_review_batches as named_review
    import build_manga_font_master_v3_siglip2_hidden_cache as cache
    import evaluate_manga_font_visual_heldout_v1 as heldout_eval
    import label_manga_font_student_v7_mass21_pass as labeler
    import train_manga_font_student_v7_mass21_r5_visual_masked as r5


SCHEMA = "manga-font-r5-qa-snapshot-evaluation-v1"
MANIFEST_SCHEMA = "manga-font-r5-qa-snapshot-evaluation-manifest-v1"
REPORT_SCHEMA = "manga-font-r5-qa-snapshot-evaluation-report-v1"
METRIC_SCHEMA = "manga-font-r5-qa-snapshot-metric-v1"
ROW_SCHEMA = "manga-font-r5-qa-snapshot-comparison-row-v1"
OWNER = "carrot-manga-translator/manga-font-r5-qa-snapshot-evaluation-v1"
MARKER_FILE = ".manga-font-r5-qa-snapshot-evaluation-v1-owned.json"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
METRICS_FILE = "snapshot-metrics.jsonl"
ROWS_FILE = "evaluation-rows.jsonl"
OUTPUT_FILES = frozenset(
    {MARKER_FILE, MANIFEST_FILE, REPORT_FILE, METRICS_FILE, ROWS_FILE}
)
SNAPSHOT_PATTERN = re.compile(r"epoch-(?P<epoch>\d{3})-head\.safetensors")
SNAPSHOT_PURPOSE = "qa_only_not_automatic_model_selection"
QA_AUTHORITY = heldout_eval.QA_AUTHORITY
POST_CUTOFF_COHORT = "post_cutoff_e"
DEFAULT_CACHE_MANIFEST_SHA256 = (
    "101f577cdfe361ce7b3ee00e181c807173e5e1f0fd6bf42991412d820056be5c"
)
DEFAULT_CACHE_IDENTITY_SHA256 = (
    "0ee304f1d2c3f8e069aee50cafa2bdbc872982b19bce549b12ea9f850b26bb67"
)


class SnapshotEvaluationError(ValueError):
    """Raised when an evaluation input or sealed output drifts."""


@dataclass(frozen=True)
class Snapshot:
    epoch: int
    path: Path
    sha256: str
    byte_size: int
    state: Mapping[str, Any]

    def binding(self) -> Mapping[str, Any]:
        return {
            "byte_size": self.byte_size,
            "candidate_ids": list(_active_ids()),
            "epoch": self.epoch,
            "file": self.path.name,
            "purpose": SNAPSHOT_PURPOSE,
            "schema_version": r5.QA_SNAPSHOT_SCHEMA,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class CacheIndexRow:
    cache_index: int
    sample_id: str
    split: str
    shard_ordinal: int


@dataclass
class SelectedCache:
    root: Path
    rows: Mapping[str, CacheIndexRow]
    shards: Mapping[int, Mapping[str, Any]]
    binding: Mapping[str, Any]
    rows_read: int = 0

    def read(self, selected: Sequence[CacheIndexRow]) -> np.ndarray:
        if not selected:
            raise SnapshotEvaluationError("selected cache batch is empty")
        result = np.empty(
            (
                len(selected),
                len(labeler.VIEW_NAMES),
                labeler.v7.PATCH_COUNT,
                labeler.v7.HIDDEN_SIZE,
            ),
            dtype="<f2",
        )
        grouped: defaultdict[int, list[tuple[int, CacheIndexRow]]] = defaultdict(list)
        for output_index, row in enumerate(selected):
            grouped[row.shard_ordinal].append((output_index, row))
        for ordinal, values in grouped.items():
            descriptor = self.shards[ordinal]
            start = int(descriptor["start_cache_index"])
            path = (
                self.root
                / cache.SHARDS_DIR
                / str(descriptor["directory"])
                / cache.SHARD_ARRAY
            )
            array = np.load(path, mmap_mode="r", allow_pickle=False)
            try:
                for output_index, row in values:
                    result[output_index] = array[row.cache_index - start]
            finally:
                mapped = getattr(array, "_mmap", None)
                if mapped is not None:
                    mapped.close()
        if not np.isfinite(result).all():
            raise SnapshotEvaluationError("selected hidden tokens are non-finite")
        self.rows_read += len(selected)
        return result


def canonical_json(value: Any) -> str:
    return labeler.canonical_json(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    return (payload + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    return labeler.sha256_file(path)


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    return labeler.seal_record(core)


def validate_record_seal(row: Mapping[str, Any], *, location: str) -> None:
    try:
        labeler.validate_record_seal(row, location=location)
    except labeler.MangaFontV7PassError as error:
        raise SnapshotEvaluationError(str(error)) from error


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SnapshotEvaluationError(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise SnapshotEvaluationError(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise SnapshotEvaluationError(f"{location}: expected text")
    return result


def _sha(value: Any, location: str) -> str:
    result = _text(value, location).lower()
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise SnapshotEvaluationError(f"{location}: expected SHA256")
    return result


def _read_json(path: Path, location: str) -> Mapping[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise SnapshotEvaluationError(f"{location}: missing or linked file")
    try:
        return _mapping(json.loads(resolved.read_text(encoding="utf-8")), location)
    except json.JSONDecodeError as error:
        raise SnapshotEvaluationError(f"{location}: invalid JSON") from error


def _iter_jsonl(path: Path, location: str) -> Iterable[tuple[int, Mapping[str, Any]]]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise SnapshotEvaluationError(f"{location}: missing or linked file")
    with resolved.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise SnapshotEvaluationError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield line_number, _mapping(row, f"{location}:{line_number}")


def _active_ids() -> tuple[str, ...]:
    candidate_ids = heldout_eval._active_ids()  # noqa: SLF001
    if len(candidate_ids) != 21 or "gugi" in candidate_ids:
        raise SnapshotEvaluationError("active21 candidate contract drifted")
    return candidate_ids


def load_snapshots(snapshot_dir: Path) -> tuple[Snapshot, ...]:
    root = snapshot_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise SnapshotEvaluationError("snapshot directory is missing or linked")
    paths = sorted(root.iterdir(), key=lambda value: value.name)
    if not paths:
        raise SnapshotEvaluationError("snapshot directory is empty")
    snapshots: list[Snapshot] = []
    try:
        from safetensors import safe_open
        from safetensors.torch import load_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise SnapshotEvaluationError("safetensors is required") from error
    for path in paths:
        match = SNAPSHOT_PATTERN.fullmatch(path.name)
        if path.is_symlink() or not path.is_file() or match is None:
            raise SnapshotEvaluationError(f"unexpected snapshot entry: {path.name}")
        epoch = int(match.group("epoch"))
        try:
            with safe_open(str(path), framework="pt", device="cpu") as handle:
                metadata = dict(handle.metadata() or {})
            state = dict(load_file(str(path), device="cpu"))
        except (OSError, RuntimeError, ValueError) as error:
            raise SnapshotEvaluationError(f"invalid snapshot: {path.name}") from error
        expected_metadata = {
            "candidate_ids": json.dumps(list(_active_ids())),
            "epoch": str(epoch),
            "purpose": SNAPSHOT_PURPOSE,
            "schema_version": r5.QA_SNAPSHOT_SCHEMA,
        }
        if metadata != expected_metadata or not state:
            raise SnapshotEvaluationError(f"snapshot metadata/state drifted: {path.name}")
        snapshots.append(
            Snapshot(
                epoch=epoch,
                path=path,
                sha256=sha256_file(path),
                byte_size=path.stat().st_size,
                state=state,
            )
        )
    epochs = tuple(snapshot.epoch for snapshot in snapshots)
    if epochs != tuple(range(len(snapshots))):
        raise SnapshotEvaluationError("snapshots must be contiguous from epoch 000")
    return tuple(snapshots)


def _load_post_cutoff_decisions(
    artifact_dir: Path,
) -> tuple[dict[str, heldout_eval.HeldoutDecision], Mapping[str, Any]]:
    root = artifact_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise SnapshotEvaluationError("post-cutoff review artifact is missing or linked")
    report_path = root / "report.json"
    report = _read_json(report_path, "post-cutoff report")
    outputs = _mapping(report.get("outputs"), "post-cutoff outputs")
    expected_files = {
        "correction": "corrections.jsonl",
        "confirmed": "confirmed.jsonl",
        "review_needed": "review-needed.jsonl",
    }
    decision_rows: dict[str, tuple[str, Mapping[str, Any]]] = {}
    output_bindings: dict[str, Any] = {}
    for kind, filename in expected_files.items():
        descriptor = _mapping(outputs.get(kind), f"post-cutoff outputs.{kind}")
        path = root / filename
        rows = [row for _, row in _iter_jsonl(path, f"post-cutoff {kind}")]
        for index, row in enumerate(rows, 1):
            try:
                named_review.validate_record_seal(
                    row, location=f"post-cutoff {kind}:{index}"
                )
            except named_review.FastNamedReviewError as error:
                raise SnapshotEvaluationError(str(error)) from error
            sample_id = _text(row.get("sample_id"), "post-cutoff sample_id")
            if sample_id in decision_rows:
                raise SnapshotEvaluationError("post-cutoff verdict identity overlaps")
            decision_rows[sample_id] = (kind, row)
        if (
            descriptor.get("file") != filename
            or int(descriptor.get("records", -1)) != len(rows)
            or descriptor.get("sha256") != sha256_file(path)
        ):
            raise SnapshotEvaluationError(f"post-cutoff {kind} descriptor drifted")
        output_bindings[kind] = {
            "file": str(path),
            "row_count": len(rows),
            "sha256": sha256_file(path),
        }
    counts = _mapping(report.get("counts"), "post-cutoff counts")
    if (
        int(counts.get("corrections", -1))
        != output_bindings["correction"]["row_count"]
        or int(counts.get("confirmed", -1))
        != output_bindings["confirmed"]["row_count"]
        or int(counts.get("review_needed", -1))
        != output_bindings["review_needed"]["row_count"]
        or int(counts.get("visually_inspected_rows", -1)) != len(decision_rows)
    ):
        raise SnapshotEvaluationError("post-cutoff report counts drifted")
    source_binding = _mapping(report.get("source"), "post-cutoff source")
    source_path = Path(_text(source_binding.get("review_items_file"), "source path"))
    if not source_path.is_absolute():
        source_path = (Path.cwd() / source_path).resolve()
    if source_binding.get("review_items_sha256") != sha256_file(source_path):
        raise SnapshotEvaluationError("post-cutoff source hash drifted")
    source_rows: dict[str, Mapping[str, Any]] = {}
    for line_number, row in _iter_jsonl(source_path, "post-cutoff source"):
        sample_id = str(row.get("sample_id", ""))
        if sample_id not in decision_rows:
            continue
        try:
            named_review.validate_review_item(row)
        except named_review.FastNamedReviewError as error:
            raise SnapshotEvaluationError(
                f"post-cutoff source:{line_number}: {error}"
            ) from error
        if sample_id in source_rows:
            raise SnapshotEvaluationError("post-cutoff source identity duplicated")
        source_rows[sample_id] = row
    if set(source_rows) != set(decision_rows):
        raise SnapshotEvaluationError("post-cutoff source coverage drifted")
    decisions: dict[str, heldout_eval.HeldoutDecision] = {}
    for sample_id, (kind, row) in decision_rows.items():
        item = source_rows[sample_id]
        candidates = tuple(
            _text(
                _mapping(candidate, "post-cutoff candidate").get("candidate_id"),
                "post-cutoff candidate id",
            )
            for candidate in _sequence(item.get("candidates"), "post-cutoff candidates")
        )
        reviewed = tuple(str(value) for value in row.get("reviewed_font_ids", ()))
        source_top1 = _text(
            _mapping(
                _sequence(item.get("pass_summaries"), "post-cutoff summaries")[-1],
                "post-cutoff summary",
            ).get("ranker_top1_font_id"),
            "post-cutoff source top1",
        )
        if (
            len(candidates) != 5
            or reviewed != candidates
            or row.get("review_item_sha256") != item.get("record_sha256")
            or row.get("label_authority") != "pseudo_not_gold"
            or row.get("promotion_allowed") is not False
            or row.get("training_eligible") is not False
        ):
            raise SnapshotEvaluationError("post-cutoff source/verdict binding drifted")
        selected = row.get("selected_font_id") if kind != "review_needed" else None
        acceptable = tuple(str(value) for value in row.get("acceptable_font_ids", ()))
        if kind == "correction" and (selected not in candidates or selected == source_top1):
            raise SnapshotEvaluationError("post-cutoff correction drifted")
        if kind == "confirmed" and selected != source_top1:
            raise SnapshotEvaluationError("post-cutoff confirmation drifted")
        if kind == "review_needed" and (
            row.get("status") != "review_needed"
            or row.get("suggested_font_id") is not None
            or acceptable
        ):
            raise SnapshotEvaluationError("post-cutoff unresolved verdict drifted")
        if not set(acceptable) <= set(candidates):
            raise SnapshotEvaluationError("post-cutoff acceptable font was not visible")
        source = _mapping(item.get("source"), "post-cutoff source block")
        role_probe = _mapping(item.get("role_probe"), "post-cutoff role probe")
        decisions[sample_id] = heldout_eval.HeldoutDecision(
            sample_id=sample_id,
            split=_text(item.get("split"), "post-cutoff split"),
            cohort=POST_CUTOFF_COHORT,
            decision_kind=kind,
            review_item_sha256=str(item["record_sha256"]),
            reviewed_font_ids=candidates,
            selected_font_id=selected,
            acceptable_font_ids=acceptable,
            source_top1_font_id=source_top1,
            decision_sha256=_sha(row.get("record_sha256"), "verdict seal"),
            role=_text(role_probe.get("role"), "post-cutoff role"),
            source_category=_text(source.get("source_category"), "source category"),
        )
    decided = sum(value.decision_kind != "review_needed" for value in decisions.values())
    return decisions, {
        "authority": "codex_visual_review_not_human_gold",
        "cohort": POST_CUTOFF_COHORT,
        "decided_rows": decided,
        "file": str(root),
        "outputs": output_bindings,
        "report_sha256": sha256_file(report_path),
        "review_needed_rows": len(decisions) - decided,
        "row_count": len(decisions),
        "source": {
            "file": str(source_path),
            "sha256": sha256_file(source_path),
        },
        "training_eligible": False,
    }


def load_decisions(
    heldout_decisions: Path,
    post_cutoff_artifact: Path | None,
    *,
    expected_heldout_rows: int,
) -> tuple[dict[str, heldout_eval.HeldoutDecision], Mapping[str, Any]]:
    try:
        heldout, heldout_binding = heldout_eval._load_heldout(  # noqa: SLF001
            heldout_decisions, expected_row_count=expected_heldout_rows
        )
    except heldout_eval.VisualHeldoutEvaluationError as error:
        raise SnapshotEvaluationError(str(error)) from error
    combined = dict(heldout)
    bindings: dict[str, Any] = {"abcd_heldout": heldout_binding}
    if post_cutoff_artifact is not None:
        post_cutoff, post_binding = _load_post_cutoff_decisions(post_cutoff_artifact)
        overlap = set(combined) & set(post_cutoff)
        if overlap:
            raise SnapshotEvaluationError("heldout/post-cutoff identity overlap")
        combined.update(post_cutoff)
        bindings[POST_CUTOFF_COHORT] = post_binding
    return combined, bindings


def _validate_baseline_cache_binding(
    baseline_review_predictions: Path,
    *,
    expected_manifest_sha256: str,
    expected_identity_sha256: str,
) -> Mapping[str, Any]:
    marker_path = baseline_review_predictions.expanduser().resolve().parent / labeler.MARKER
    marker = _read_json(marker_path, "baseline marker")
    validate_record_seal(marker, location="baseline marker")
    visual = _mapping(marker.get("visual_features"), "baseline visual features")
    if (
        visual.get("kind") != "sealed_siglip2_last_hidden_state_patch_tokens"
        or visual.get("manifest_sha256") != expected_manifest_sha256
        or visual.get("cache_identity_sha256") != expected_identity_sha256
        or int(visual.get("row_count", -1)) != labeler.mass21.MASTER_TOTAL_ROWS
    ):
        raise SnapshotEvaluationError("baseline/cache binding drifted")
    return copy.deepcopy(dict(visual))


def load_selected_cache(
    cache_dir: Path,
    decisions: Mapping[str, heldout_eval.HeldoutDecision],
    *,
    expected_manifest_sha256: str,
    expected_identity_sha256: str,
) -> SelectedCache:
    root = cache_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir():
        raise SnapshotEvaluationError("hidden cache is missing or linked")
    children = tuple(root.iterdir())
    if {path.name for path in children} != cache.FINAL_ROOT_FILES or any(
        path.is_symlink() for path in children
    ):
        raise SnapshotEvaluationError("hidden cache root inventory drifted")
    marker = _read_json(root / cache.MARKER, "cache marker")
    contract = _read_json(root / cache.BUILD_CONTRACT, "cache contract")
    manifest = _read_json(root / cache.MANIFEST, "cache manifest")
    for name, value in (("marker", marker), ("contract", contract), ("manifest", manifest)):
        try:
            cache._validate_record_seal(value, f"cache {name}")  # noqa: SLF001
        except cache.HiddenStateCacheError as error:
            raise SnapshotEvaluationError(str(error)) from error
    actual_manifest_sha = sha256_file(root / cache.MANIFEST)
    identity = _sha(contract.get("cache_identity_sha256"), "cache identity")
    if (
        actual_manifest_sha != expected_manifest_sha256
        or manifest.get("cache_identity_sha256") != identity
        or marker.get("cache_identity_sha256") != identity
        or identity != expected_identity_sha256
        or marker.get("status") != "complete"
        or marker.get("owner") != cache.OWNER
    ):
        raise SnapshotEvaluationError("hidden cache pinned identity/SHA drifted")
    artifacts = _mapping(marker.get("artifacts"), "cache marker artifacts")
    for filename in (cache.BUILD_CONTRACT, cache.SAMPLE_INDEX, cache.MANIFEST):
        descriptor = _mapping(artifacts.get(filename), f"cache artifact {filename}")
        path = root / filename
        if (
            descriptor.get("file") != filename
            or descriptor.get("sha256") != sha256_file(path)
            or int(descriptor.get("byte_size", -1)) != path.stat().st_size
        ):
            raise SnapshotEvaluationError(f"cache top-level descriptor drifted: {filename}")
    model = _mapping(contract.get("model"), "cache model")
    tensor = _mapping(contract.get("tensor"), "cache tensor")
    views = _mapping(contract.get("views"), "cache views")
    if (
        model.get("base_model_id") != labeler.base.MODEL_ID
        or model.get("base_model_revision") != labeler.base.MODEL_REVISION
        or model.get("cached_tensor") != "last_hidden_state"
        or model.get("pooler_output_used") is not False
        or int(model.get("hidden_size", 0)) != labeler.v7.HIDDEN_SIZE
        or int(model.get("patch_count", 0)) != labeler.v7.PATCH_COUNT
        or tensor != cache._tensor_contract()  # noqa: SLF001
        or views != cache._view_contract()  # noqa: SLF001
    ):
        raise SnapshotEvaluationError("hidden cache model/tensor/view contract drifted")
    shard_values = _sequence(manifest.get("shards"), "cache shards")
    shards = {
        int(_mapping(value, "cache shard")["shard_ordinal"]): _mapping(
            value, "cache shard"
        )
        for value in shard_values
    }
    if tuple(sorted(shards)) != tuple(range(len(shards))):
        raise SnapshotEvaluationError("hidden cache shard ordinals drifted")
    shard_root = root / cache.SHARDS_DIR
    if shard_root.is_symlink() or not shard_root.is_dir():
        raise SnapshotEvaluationError("hidden cache shard root drifted")
    if {path.name for path in shard_root.iterdir()} != {
        str(value["directory"]) for value in shards.values()
    }:
        raise SnapshotEvaluationError("hidden cache shard inventory drifted")
    wanted = set(decisions)
    selected: dict[str, CacheIndexRow] = {}
    row_count = 0
    index_path = root / cache.SAMPLE_INDEX
    for line_number, row in _iter_jsonl(index_path, "cache sample index"):
        row_count += 1
        try:
            cache._validate_record_seal(row, f"cache index:{line_number}")  # noqa: SLF001
        except cache.HiddenStateCacheError as error:
            raise SnapshotEvaluationError(str(error)) from error
        cache_index = int(row.get("cache_index", -1))
        if cache_index != line_number - 1 or int(row.get("master_row_index", -1)) != cache_index:
            raise SnapshotEvaluationError("cache sample index order drifted")
        sample_id = str(row.get("sample_id", ""))
        if sample_id not in wanted:
            continue
        split = _text(row.get("split"), "cache selected split")
        if split != decisions[sample_id].split or sample_id in selected:
            raise SnapshotEvaluationError("cache selected identity/split drifted")
        ordinal = next(
            (
                number
                for number, descriptor in shards.items()
                if int(descriptor["start_cache_index"])
                <= cache_index
                < int(descriptor["end_cache_index_exclusive"])
            ),
            -1,
        )
        if ordinal < 0:
            raise SnapshotEvaluationError("cache selected shard coverage gap")
        selected[sample_id] = CacheIndexRow(cache_index, sample_id, split, ordinal)
    expected_rows = int(_mapping(manifest.get("index"), "cache manifest index").get("record_count", -1))
    if row_count != expected_rows or set(selected) != wanted:
        raise SnapshotEvaluationError("cache selected/global index coverage drifted")
    selected_ordinals = sorted({row.shard_ordinal for row in selected.values()})
    for ordinal in selected_ordinals:
        descriptor = shards[ordinal]
        directory = shard_root / str(descriptor["directory"])
        if directory.is_symlink() or not directory.is_dir() or {
            path.name for path in directory.iterdir()
        } != cache.SHARD_FILES:
            raise SnapshotEvaluationError("selected shard inventory drifted")
        shard_marker = _read_json(directory / cache.SHARD_MARKER, "selected shard marker")
        seal = _read_json(directory / cache.SHARD_SEAL, "selected shard seal")
        try:
            cache._validate_record_seal(shard_marker, "selected shard marker")  # noqa: SLF001
            seal_sha = cache._validate_record_seal(seal, "selected shard seal")  # noqa: SLF001
        except cache.HiddenStateCacheError as error:
            raise SnapshotEvaluationError(str(error)) from error
        hidden = _mapping(seal.get("hidden_states"), "selected hidden descriptor")
        index = _mapping(seal.get("index"), "selected index descriptor")
        array_path = directory / cache.SHARD_ARRAY
        shard_index_path = directory / cache.SHARD_INDEX
        if (
            seal_sha != descriptor.get("seal_record_sha256")
            or seal.get("cache_identity_sha256") != identity
            or int(seal.get("shard_ordinal", -1)) != ordinal
            or hidden.get("file") != cache.SHARD_ARRAY
            or int(hidden.get("byte_size", -1)) != array_path.stat().st_size
            or hidden.get("sha256") != descriptor.get("hidden_states_sha256")
            or index.get("file") != cache.SHARD_INDEX
            or index.get("sha256") != sha256_file(shard_index_path)
            or int(index.get("byte_size", -1)) != shard_index_path.stat().st_size
        ):
            raise SnapshotEvaluationError("selected shard seal/descriptor drifted")
        values = np.load(array_path, mmap_mode="r", allow_pickle=False)
        try:
            expected_shape = (
                int(descriptor["row_count"]),
                len(labeler.VIEW_NAMES),
                labeler.v7.PATCH_COUNT,
                labeler.v7.HIDDEN_SIZE,
            )
            if values.dtype != np.dtype("<f2") or values.shape != expected_shape:
                raise SnapshotEvaluationError("selected shard tensor shape/dtype drifted")
        finally:
            mapped = getattr(values, "_mmap", None)
            if mapped is not None:
                mapped.close()
    binding = {
        "array_integrity": (
            "pinned_prevalidated_manifest_and_identity; selected shard seals, sizes, "
            "shapes, and selected finite values checked; no full-array rehash"
        ),
        "build_contract_sha256": sha256_file(root / cache.BUILD_CONTRACT),
        "cache_identity_sha256": identity,
        "file": str(root),
        "manifest_sha256": actual_manifest_sha,
        "model_revision": model["base_model_revision"],
        "row_count": row_count,
        "sample_index_sha256": sha256_file(index_path),
        "selected_row_count": len(selected),
        "selected_shard_count": len(selected_ordinals),
        "tensor_shape_per_row": [
            len(labeler.VIEW_NAMES),
            labeler.v7.PATCH_COUNT,
            labeler.v7.HIDDEN_SIZE,
        ],
    }
    return SelectedCache(root=root, rows=selected, shards=shards, binding=binding)


def _prediction(
    baseline: heldout_eval.Prediction,
    probabilities: np.ndarray,
    *,
    snapshot: Snapshot,
) -> heldout_eval.Prediction:
    if probabilities.shape != (len(_active_ids()),) or not np.isfinite(probabilities).all():
        raise SnapshotEvaluationError("snapshot probability vector drifted")
    order = np.argsort(-probabilities, kind="stable")
    ranking = tuple(_active_ids()[int(index)] for index in order)
    record_sha = labeler.sha256_bytes(
        canonical_json(
            {
                "epoch": snapshot.epoch,
                "probabilities": [round(float(value), 10) for value in probabilities],
                "sample_id": baseline.sample_id,
                "snapshot_sha256": snapshot.sha256,
            }
        ).encode("utf-8")
    )
    return heldout_eval.Prediction(
        sample_id=baseline.sample_id,
        split=baseline.split,
        work_id=baseline.work_id,
        chapter_id=baseline.chapter_id,
        page_id=baseline.page_id,
        master_row_sha256=baseline.master_row_sha256,
        source_category=baseline.source_category,
        source_kind=baseline.source_kind,
        source_row_index=baseline.source_row_index,
        candidate_ids=_active_ids(),
        probabilities=tuple(float(value) for value in probabilities),
        ranking=ranking,
        record_sha256=record_sha,
    )


def require_epoch0_topk_self_check(
    baseline: Mapping[str, heldout_eval.Prediction],
    candidate: Mapping[str, heldout_eval.Prediction],
    *,
    top_k: int,
) -> Mapping[str, Any]:
    if not 1 <= top_k <= len(_active_ids()) or set(baseline) != set(candidate):
        raise SnapshotEvaluationError("epoch0 self-check inputs drifted")
    mismatches = [
        sample_id
        for sample_id in sorted(baseline)
        if baseline[sample_id].ranking[:top_k] != candidate[sample_id].ranking[:top_k]
    ]
    if mismatches:
        raise SnapshotEvaluationError(
            f"epoch0 baseline top{top_k} self-check failed: {mismatches[:5]}"
        )
    return {
        "baseline_top_k": top_k,
        "exact_match_rate": 1.0,
        "matched_rows": len(baseline),
        "status": "passed",
    }


def _wrap_rows(
    rows: Sequence[Mapping[str, Any]], snapshot: Snapshot
) -> tuple[Mapping[str, Any], ...]:
    output: list[Mapping[str, Any]] = []
    for row in rows:
        core = dict(row)
        core.pop("record_sha256", None)
        core.update(
            {
                "record_type": "manga_font_r5_qa_snapshot_comparison_row",
                "schema_version": ROW_SCHEMA,
                "snapshot_epoch": snapshot.epoch,
                "snapshot_sha256": snapshot.sha256,
            }
        )
        output.append(seal_record(core))
    return tuple(output)


def compute_metrics(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
    """Add explicit cutoff and split slices to the shared visual-QA metrics."""
    result = dict(heldout_eval.compute_report_metrics(rows))
    abcd = [row for row in rows if row.get("cohort") != POST_CUTOFF_COHORT]
    post_cutoff = [row for row in rows if row.get("cohort") == POST_CUTOFF_COHORT]
    by_split: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    post_by_split: defaultdict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in rows:
        split = str(row.get("split", ""))
        by_split[split].append(row)
        if row.get("cohort") == POST_CUTOFF_COHORT:
            post_by_split[split].append(row)
    result["by_evaluation_set"] = {
        "abcd_heldout": heldout_eval._metrics(abcd),  # noqa: SLF001
        POST_CUTOFF_COHORT: heldout_eval._metrics(post_cutoff),  # noqa: SLF001
    }
    result["by_split"] = {
        split: heldout_eval._metrics(values)  # noqa: SLF001
        for split, values in sorted(by_split.items())
    }
    result["post_cutoff_e_by_split"] = {
        split: heldout_eval._metrics(values)  # noqa: SLF001
        for split, values in sorted(post_by_split.items())
    }
    return result


def score_snapshots(
    *,
    snapshots: Sequence[Snapshot],
    reference: labeler.ModelArtifacts,
    selected_cache: SelectedCache,
    sample_ids: Sequence[str],
    device: str,
    amp_dtype: str,
    batch_size: int,
) -> Mapping[int, np.ndarray]:
    if batch_size < 1:
        raise SnapshotEvaluationError("batch size must be positive")
    runtime = labeler.build_runtime(
        reference,
        device_name=device,
        amp_name=amp_dtype,
        load_visual_encoder=False,
    )
    scores = {
        snapshot.epoch: np.empty((len(sample_ids), len(_active_ids())), dtype=np.float32)
        for snapshot in snapshots
    }
    ordered_rows = [selected_cache.rows[sample_id] for sample_id in sample_ids]
    for start in range(0, len(sample_ids), batch_size):
        stop = min(start + batch_size, len(sample_ids))
        hidden = selected_cache.read(ordered_rows[start:stop])
        for snapshot in snapshots:
            try:
                runtime.head.load_state_dict(snapshot.state, strict=True)
            except (RuntimeError, ValueError) as error:
                raise SnapshotEvaluationError(
                    f"snapshot state architecture drifted: epoch {snapshot.epoch}"
                ) from error
            output = labeler.infer_hidden_states(runtime, hidden)
            probabilities = labeler.softmax(output["scores"], temperature=1.0)
            scores[snapshot.epoch][start:stop] = probabilities
    if selected_cache.rows_read != len(sample_ids):
        raise SnapshotEvaluationError("hidden cache rows were reread or skipped")
    return scores


def _descriptor(path: Path, *, row_count: int | None = None) -> Mapping[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    with path.open("wb") as handle:
        for row in rows:
            handle.write(json_bytes(row))


def _safe_output(destination: Path) -> None:
    if not destination.exists():
        return
    marker_path = destination / MARKER_FILE
    marker = _read_json(marker_path, "existing output marker")
    validate_record_seal(marker, location="existing output marker")
    if marker.get("owner") != OWNER or marker.get("safe_replace") is not True:
        raise SnapshotEvaluationError("refusing to replace unowned output")


def evaluate(args: argparse.Namespace) -> Mapping[str, Any]:
    expected_manifest_sha = _sha(
        args.expected_hidden_cache_manifest_sha256, "expected cache manifest SHA"
    )
    expected_identity_sha = _sha(
        args.expected_hidden_cache_identity_sha256, "expected cache identity SHA"
    )
    snapshots = load_snapshots(args.snapshot_dir)
    decisions, decision_bindings = load_decisions(
        args.heldout_decisions,
        args.post_cutoff_review_artifact,
        expected_heldout_rows=args.expected_heldout_rows,
    )
    try:
        baseline, baseline_binding = heldout_eval._load_pass(  # noqa: SLF001
            args.baseline_review_predictions,
            wanted_ids=set(decisions),
            name="baseline",
        )
    except heldout_eval.VisualHeldoutEvaluationError as error:
        raise SnapshotEvaluationError(str(error)) from error
    baseline_cache_binding = _validate_baseline_cache_binding(
        args.baseline_review_predictions,
        expected_manifest_sha256=expected_manifest_sha,
        expected_identity_sha256=expected_identity_sha,
    )
    selected_cache = load_selected_cache(
        args.hidden_cache_dir,
        decisions,
        expected_manifest_sha256=expected_manifest_sha,
        expected_identity_sha256=expected_identity_sha,
    )
    try:
        reference = labeler.load_model_artifacts(
            args.reference_model_dir, source_kind=args.reference_model_source
        )
    except labeler.MangaFontV7PassError as error:
        raise SnapshotEvaluationError(str(error)) from error
    if reference.candidate_ids != _active_ids():
        raise SnapshotEvaluationError("reference model candidate order drifted")
    sample_ids = tuple(
        row.sample_id for row in sorted(selected_cache.rows.values(), key=lambda row: row.cache_index)
    )
    probabilities = score_snapshots(
        snapshots=snapshots,
        reference=reference,
        selected_cache=selected_cache,
        sample_ids=sample_ids,
        device=args.device,
        amp_dtype=args.amp_dtype,
        batch_size=args.batch_size,
    )
    metric_rows: list[Mapping[str, Any]] = []
    comparison_rows: list[Mapping[str, Any]] = []
    for snapshot in snapshots:
        candidate = {
            sample_id: _prediction(
                baseline[sample_id], probabilities[snapshot.epoch][index], snapshot=snapshot
            )
            for index, sample_id in enumerate(sample_ids)
        }
        self_check = (
            require_epoch0_topk_self_check(
                baseline, candidate, top_k=args.epoch0_self_check_top_k
            )
            if snapshot.epoch == 0
            else {"status": "not_applicable_nonzero_epoch"}
        )
        try:
            rows = heldout_eval.build_evaluation_rows(decisions, baseline, candidate)
        except heldout_eval.VisualHeldoutEvaluationError as error:
            raise SnapshotEvaluationError(str(error)) from error
        wrapped = _wrap_rows(rows, snapshot)
        comparison_rows.extend(wrapped)
        metrics = compute_metrics(rows)
        top1 = Counter(candidate[sample_id].ranking[0] for sample_id in sample_ids)
        metric_rows.append(
            seal_record(
                {
                    "authority": QA_AUTHORITY,
                    "candidate_ids": list(_active_ids()),
                    "epoch0_baseline_self_check": self_check,
                    "metrics": metrics,
                    "record_type": "manga_font_r5_qa_snapshot_metric",
                    "row_count": len(rows),
                    "schema_version": METRIC_SCHEMA,
                    "snapshot": snapshot.binding(),
                    "top1_distribution": dict(sorted(top1.items())),
                    "training_eligible": False,
                }
            )
        )
    destination = args.output_dir.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    _safe_output(destination)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=destination.parent)
    )
    try:
        metrics_path = staging / METRICS_FILE
        rows_path = staging / ROWS_FILE
        _write_jsonl(metrics_path, metric_rows)
        _write_jsonl(rows_path, comparison_rows)
        reference_binding = {
            **copy.deepcopy(dict(reference.bindings)),
            "candidate_ids": list(reference.candidate_ids),
            "file": str(reference.source_dir),
            "prototype_policy": "fixed_published_reference_prototypes_for_every_epoch",
        }
        manifest = seal_record(
            {
                "authority": {
                    "human_gold": False,
                    "independent_gold": False,
                    "quality_gate_authority": False,
                    "training_eligible": False,
                    "visual_review_authority": QA_AUTHORITY,
                },
                "baseline": {
                    **copy.deepcopy(dict(baseline_binding)),
                    "hidden_cache": baseline_cache_binding,
                },
                "candidate_ids": list(_active_ids()),
                "decision_cohorts": copy.deepcopy(dict(decision_bindings)),
                "hidden_cache": {
                    **copy.deepcopy(dict(selected_cache.binding)),
                    "actual_selected_rows_read": selected_cache.rows_read,
                },
                "record_type": "manga_font_r5_qa_snapshot_evaluation_manifest",
                "reference_model": reference_binding,
                "row_count_per_snapshot": len(decisions),
                "schema_version": MANIFEST_SCHEMA,
                "snapshots": [snapshot.binding() for snapshot in snapshots],
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        manifest_path = staging / MANIFEST_FILE
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "artifacts": {
                    MANIFEST_FILE: _descriptor(manifest_path),
                    METRICS_FILE: _descriptor(metrics_path, row_count=len(metric_rows)),
                    ROWS_FILE: _descriptor(rows_path, row_count=len(comparison_rows)),
                },
                "authority": copy.deepcopy(dict(manifest["authority"])),
                "epoch_metrics": [
                    {
                        "epoch": int(_mapping(row["snapshot"], "snapshot")["epoch"]),
                        "metrics": copy.deepcopy(row["metrics"]),
                        "snapshot_sha256": _mapping(row["snapshot"], "snapshot")["sha256"],
                    }
                    for row in metric_rows
                ],
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_r5_qa_snapshot_evaluation_report",
                "schema_version": REPORT_SCHEMA,
            }
        )
        report_path = staging / REPORT_FILE
        report_path.write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "manifest_sha256": sha256_file(manifest_path),
                "owner": OWNER,
                "report_sha256": sha256_file(report_path),
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return validate_output(destination)


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {
        path.name for path in root.iterdir()
    } != OUTPUT_FILES:
        raise SnapshotEvaluationError("evaluation output inventory drifted")
    marker = _read_json(root / MARKER_FILE, "evaluation marker")
    manifest = _read_json(root / MANIFEST_FILE, "evaluation manifest")
    report = _read_json(root / REPORT_FILE, "evaluation report")
    for name, row in (("marker", marker), ("manifest", manifest), ("report", report)):
        validate_record_seal(row, location=f"evaluation {name}")
    if (
        marker.get("owner") != OWNER
        or marker.get("safe_replace") is not True
        or marker.get("schema_version") != SCHEMA
        or marker.get("manifest_sha256") != sha256_file(root / MANIFEST_FILE)
        or marker.get("report_sha256") != sha256_file(root / REPORT_FILE)
        or manifest.get("schema_version") != MANIFEST_SCHEMA
        or report.get("schema_version") != REPORT_SCHEMA
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or manifest.get("source_code_sha256") != sha256_file(Path(__file__).resolve())
        or tuple(manifest.get("candidate_ids", ())) != _active_ids()
    ):
        raise SnapshotEvaluationError("evaluation metadata drifted")
    artifacts = _mapping(report.get("artifacts"), "evaluation artifacts")
    for filename in (MANIFEST_FILE, METRICS_FILE, ROWS_FILE):
        descriptor = _mapping(artifacts.get(filename), f"artifact {filename}")
        path = root / filename
        if (
            descriptor.get("file") != filename
            or descriptor.get("sha256") != sha256_file(path)
            or int(descriptor.get("byte_size", -1)) != path.stat().st_size
        ):
            raise SnapshotEvaluationError(f"evaluation artifact drifted: {filename}")
    metric_rows = [row for _, row in _iter_jsonl(root / METRICS_FILE, "snapshot metrics")]
    epochs: list[int] = []
    metrics_by_epoch: dict[int, Mapping[str, Any]] = {}
    for index, row in enumerate(metric_rows, 1):
        validate_record_seal(row, location=f"snapshot metrics:{index}")
        snapshot = _mapping(row.get("snapshot"), "snapshot metric binding")
        epoch = int(snapshot.get("epoch", -1))
        if (
            row.get("schema_version") != METRIC_SCHEMA
            or row.get("authority") != QA_AUTHORITY
            or row.get("training_eligible") is not False
            or tuple(row.get("candidate_ids", ())) != _active_ids()
        ):
            raise SnapshotEvaluationError("snapshot metric authority drifted")
        epochs.append(epoch)
        metrics_by_epoch[epoch] = _mapping(row.get("metrics"), "snapshot metrics")
    if epochs != list(range(len(metric_rows))):
        raise SnapshotEvaluationError("snapshot metric epochs drifted")
    grouped: defaultdict[int, list[Mapping[str, Any]]] = defaultdict(list)
    seen: set[tuple[int, str]] = set()
    for line_number, row in _iter_jsonl(root / ROWS_FILE, "evaluation rows"):
        validate_record_seal(row, location=f"evaluation rows:{line_number}")
        epoch = int(row.get("snapshot_epoch", -1))
        sample_id = _text(row.get("sample_id"), "evaluation row sample")
        identity = (epoch, sample_id)
        if identity in seen:
            raise SnapshotEvaluationError("evaluation row identity duplicated")
        seen.add(identity)
        if (
            row.get("schema_version") != ROW_SCHEMA
            or row.get("evaluation_authority") != QA_AUTHORITY
            or row.get("training_eligible") is not False
            or epoch not in metrics_by_epoch
        ):
            raise SnapshotEvaluationError("evaluation row authority drifted")
        grouped[epoch].append(row)
    row_count = int(manifest.get("row_count_per_snapshot", -1))
    for epoch in epochs:
        if len(grouped[epoch]) != row_count:
            raise SnapshotEvaluationError("evaluation epoch row coverage drifted")
        recomputed = compute_metrics(grouped[epoch])
        if canonical_json(recomputed) != canonical_json(metrics_by_epoch[epoch]):
            raise SnapshotEvaluationError("evaluation epoch metrics drifted")
    authority = _mapping(report.get("authority"), "evaluation authority")
    if any(
        authority.get(name) is not False
        for name in ("human_gold", "independent_gold", "quality_gate_authority", "training_eligible")
    ):
        raise SnapshotEvaluationError("evaluation authority boundary drifted")
    cache_binding = _mapping(manifest.get("hidden_cache"), "manifest hidden cache")
    if int(cache_binding.get("actual_selected_rows_read", -1)) != row_count:
        raise SnapshotEvaluationError("selected cache row-read count drifted")
    return {
        "epochs": epochs,
        "output_dir": str(root),
        "rows_per_epoch": row_count,
        "selected_cache_rows_read_once": int(cache_binding["actual_selected_rows_read"]),
        "status": "validated_r5_snapshot_visual_qa_not_independent_gold",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("--snapshot-dir", type=Path, required=True)
    evaluate_parser.add_argument("--reference-model-dir", type=Path, required=True)
    evaluate_parser.add_argument(
        "--reference-model-source", choices=("v7-r2", "v7-r3"), default="v7-r3"
    )
    evaluate_parser.add_argument("--hidden-cache-dir", type=Path, required=True)
    evaluate_parser.add_argument(
        "--expected-hidden-cache-manifest-sha256",
        default=DEFAULT_CACHE_MANIFEST_SHA256,
    )
    evaluate_parser.add_argument(
        "--expected-hidden-cache-identity-sha256",
        default=DEFAULT_CACHE_IDENTITY_SHA256,
    )
    evaluate_parser.add_argument(
        "--baseline-review-predictions", type=Path, required=True
    )
    evaluate_parser.add_argument("--heldout-decisions", type=Path, required=True)
    evaluate_parser.add_argument(
        "--expected-heldout-rows", type=int, default=502
    )
    evaluate_parser.add_argument("--post-cutoff-review-artifact", type=Path)
    evaluate_parser.add_argument("--epoch0-self-check-top-k", type=int, default=5)
    evaluate_parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    evaluate_parser.add_argument(
        "--amp-dtype", choices=("none", "bf16", "fp16"), default="bf16"
    )
    evaluate_parser.add_argument("--batch-size", type=int, default=64)
    evaluate_parser.add_argument("--output-dir", type=Path, required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = validate_output(args.output_dir) if args.command == "validate" else evaluate(args)
    except (
        SnapshotEvaluationError,
        OSError,
        KeyError,
        TypeError,
        ValueError,
        heldout_eval.VisualHeldoutEvaluationError,
        labeler.MangaFontV7PassError,
    ) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
