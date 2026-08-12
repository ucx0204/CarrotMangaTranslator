#!/usr/bin/env python3
"""Deblind high-value font reviews into a sealed, training-only label artifact.

The public review is joined to its private A-G bindings only after review.  The
published artifact contains active21 labels and source identity lineage, but no
sampling probabilities, model predictions, reviewer notes, or selection
reasons.  It is fail-closed against master test/validation, val33, independent
blind calibration/evaluation, library QA pages, and the adapter validation
fold of the supplied v8 dataset.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA = "manga-font-v2-high-value-supervised-labels-v1"
OWNER = "carrot-manga-translator/manga-font-v2-high-value-supervised-labels-v1"
MARKER_FILE = ".manga-font-v2-high-value-supervised-labels-v1-owned.json"
LABELS_FILE = "training-labels.jsonl"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
OUTPUT_FILES = frozenset({MARKER_FILE, LABELS_FILE, MANIFEST_FILE, REPORT_FILE})

QUEUE_SCHEMA = "manga-font-v2-high-value-supervised-queue-v1"
DECISION_SCHEMA = "manga-font-v2-high-value-blind-agent-decision-v1"
EXPECTED_SLOTS = tuple("ABCDEFG")
BODY_ROLES = frozenset({"dialogue", "narration", "thought"})
ROLE_MAP: Mapping[str, str] = {
    "aside": "aside_balloon_edge",
    "dialogue": "dialogue",
    "emphasis_dialogue": "emphasis_dialogue",
    "narration": "narration",
    "sfx": "sfx_impact",
    "shout": "shout",
    "sign_ui_title": "sign_ui_title",
    "thought": "thought",
}
FORBIDDEN_OUTPUT_KEY_PARTS = (
    "information_sampling",
    "model_probability",
    "model_prediction",
    "model_score",
    "notes",
    "selection_reason",
)


class HighValueSupervisedLabelError(ValueError):
    """Raised when a label or leakage boundary is incomplete."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(core))
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json(result).encode("utf-8"))
    return result


def validate_record_seal(record: Mapping[str, Any], location: str) -> None:
    declared = record.get("record_sha256")
    if not isinstance(declared, str) or len(declared) != 64:
        raise HighValueSupervisedLabelError(f"{location}: invalid record seal")
    core = {key: value for key, value in record.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != declared:
        raise HighValueSupervisedLabelError(f"{location}: record seal drifted")


def mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise HighValueSupervisedLabelError(f"{location}: expected object")
    return value


def sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise HighValueSupervisedLabelError(f"{location}: expected array")
    return value


def text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise HighValueSupervisedLabelError(f"{location}: expected text")
    return result


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HighValueSupervisedLabelError(f"{location}: invalid JSON") from error
    return dict(mapping(value, location))


def iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    source = path.expanduser().resolve()
    if source.is_symlink() or not source.is_file():
        raise HighValueSupervisedLabelError(f"{location}: missing or linked JSONL")
    with source.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise HighValueSupervisedLabelError(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(mapping(value, f"{location}:{line_number}"))


def descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size < 1:
        raise HighValueSupervisedLabelError(f"missing regular artifact: {path}")
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = row_count
    return result


def source_descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result = descriptor(path, row_count=row_count)
    result["file"] = str(path.expanduser().resolve())
    return result


def safe_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise HighValueSupervisedLabelError(f"unsafe output directory: {result}")
    return result


def write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.write_bytes("".join(canonical_json(row) + "\n" for row in rows).encode("utf-8"))


def assert_no_private_model_fields(value: Any, location: str = "output") -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in FORBIDDEN_OUTPUT_KEY_PARTS):
                raise HighValueSupervisedLabelError(
                    f"{location}: forbidden private/model field {key!r}"
                )
            assert_no_private_model_fields(nested, f"{location}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, nested in enumerate(value):
            assert_no_private_model_fields(nested, f"{location}[{index}]")


def load_base_split(
    base_dataset_dir: Path,
) -> tuple[
    dict[str, int],
    dict[str, str],
    set[str],
    set[str],
    Mapping[str, Any],
]:
    root = base_dataset_dir.expanduser().resolve()
    npz_path = root / "role-family-dataset.npz"
    manifest_path = root / "manifest.json"
    manifest = read_json(manifest_path, "base dataset manifest")
    with np.load(npz_path, allow_pickle=False) as source:
        if not {"sample_ids", "split", "work_ids"} <= set(source.files):
            raise HighValueSupervisedLabelError(
                "base dataset lacks split/work identities"
            )
        sample_ids = tuple(str(value) for value in source["sample_ids"].tolist())
        split = source["split"].astype(np.int64, copy=False)
        work_ids = tuple(str(value) for value in source["work_ids"].tolist())
    if (
        len(sample_ids) != len(split)
        or len(sample_ids) != len(work_ids)
        or len(set(sample_ids)) != len(sample_ids)
        or not set(split.tolist()) <= {0, 1}
    ):
        raise HighValueSupervisedLabelError("base dataset sample/split inventory drifted")
    sample_split = dict(zip(sample_ids, split.tolist(), strict=True))
    sample_work = dict(zip(sample_ids, work_ids, strict=True))
    validation_sample_ids = {
        sample_id for sample_id, value in sample_split.items() if value == 1
    }
    validation_work_ids = {
        sample_work[sample_id] for sample_id in validation_sample_ids
    }
    if any(
        value == 0 and sample_work[sample_id] in validation_work_ids
        for sample_id, value in sample_split.items()
    ):
        raise HighValueSupervisedLabelError(
            "base dataset adapter-validation work leaked into train"
        )
    return sample_split, sample_work, validation_sample_ids, validation_work_ids, {
        "manifest": source_descriptor(manifest_path),
        "npz": source_descriptor(npz_path, row_count=len(sample_ids)),
    }


def load_master(manifest_path: Path) -> tuple[dict[str, Mapping[str, Any]], set[str], set[str]]:
    rows: dict[str, Mapping[str, Any]] = {}
    val_ids: set[str] = set()
    test_ids: set[str] = set()
    for index, row in enumerate(iter_jsonl(manifest_path, "master manifest"), 1):
        sample_id = text(row.get("id"), f"master:{index}.id")
        if sample_id in rows:
            raise HighValueSupervisedLabelError("master sample IDs are duplicated")
        rows[sample_id] = row
        split = text(row.get("split"), f"master:{index}.split")
        if split == "val":
            val_ids.add(sample_id)
        elif split == "test":
            test_ids.add(sample_id)
        elif split != "train":
            raise HighValueSupervisedLabelError(f"master:{index}: unsupported split")
    return rows, val_ids, test_ids


def sample_ids_from(path: Path, location: str) -> set[str]:
    result: set[str] = set()
    for row in iter_jsonl(path, location):
        value = row.get("sample_id", row.get("id"))
        if isinstance(value, str) and value:
            result.add(value)
    return result


def blind_pool_ids(paths: Sequence[Path]) -> tuple[set[str], set[str], list[dict[str, Any]]]:
    calibration: set[str] = set()
    evaluation: set[str] = set()
    descriptors: list[dict[str, Any]] = []
    for path in paths:
        count = 0
        for row in iter_jsonl(path, "blind pool"):
            count += 1
            sample_id = text(row.get("sample_id"), "blind pool.sample_id")
            purpose = row.get("purpose")
            if purpose is None:
                # The first pool revision predates the explicit 160/80 purpose
                # field.  Treat every such identity as belonging to both held
                # out boundaries; this is deliberately conservative.
                calibration.add(sample_id)
                evaluation.add(sample_id)
            elif purpose == "calibration":
                calibration.add(sample_id)
            elif purpose == "evaluation":
                evaluation.add(sample_id)
            else:
                raise HighValueSupervisedLabelError("blind pool purpose drifted")
        descriptors.append(source_descriptor(path, row_count=count))
    return calibration, evaluation, descriptors


def qa_page_hashes(paths: Sequence[Path]) -> tuple[set[str], list[dict[str, Any]]]:
    hashes: set[str] = set()
    descriptors: list[dict[str, Any]] = []
    for path in paths:
        count = 0
        for row in iter_jsonl(path, "QA cohort"):
            count += 1
            page = mapping(row.get("page"), "QA cohort.page")
            hashes.add(text(page.get("imageSha256"), "QA cohort.page.imageSha256"))
        descriptors.append(source_descriptor(path, row_count=count))
    return hashes, descriptors


def sorted_candidate_ids(values: Iterable[str], order: Mapping[str, int]) -> tuple[str, ...]:
    unique = set(values)
    if not unique <= order.keys():
        raise HighValueSupervisedLabelError("label escaped active21")
    return tuple(sorted(unique, key=order.__getitem__))


def build_labels(
    *,
    queue_dir: Path,
    review_dirs: Sequence[Path],
    expected_start_row: int,
    expected_end_row: int,
    base_dataset_dir: Path,
    master_manifest: Path,
    val33_file: Path,
    blind_pool_files: Sequence[Path],
    qa_cohort_files: Sequence[Path],
) -> tuple[list[dict[str, Any]], Mapping[str, Any]]:
    queue_root = queue_dir.expanduser().resolve()
    if expected_start_row < 1 or expected_end_row < expected_start_row:
        raise HighValueSupervisedLabelError("invalid expected review row span")
    review_roots = tuple(path.expanduser().resolve() for path in review_dirs)
    if not review_roots or len(review_roots) != len(set(review_roots)):
        raise HighValueSupervisedLabelError(
            "review directories must be non-empty and unique"
        )
    queue_report = read_json(queue_root / "report.json", "queue report")
    candidate_ids = tuple(str(value) for value in queue_report.get("candidate_ids", ()))
    if len(candidate_ids) != 21 or len(set(candidate_ids)) != 21 or "single-day" not in candidate_ids:
        raise HighValueSupervisedLabelError("queue candidate inventory is not active21")
    candidate_order = {value: index for index, value in enumerate(candidate_ids)}

    queue_by_review: dict[str, Mapping[str, Any]] = {}
    queue_count = 0
    for row in iter_jsonl(queue_root / "review-queue.jsonl", "review queue"):
        queue_count += 1
        validate_record_seal(row, f"review queue:{queue_count}")
        review_id = text(row.get("review_id"), "review queue.review_id")
        if review_id in queue_by_review:
            raise HighValueSupervisedLabelError("review queue IDs are duplicated")
        queue_by_review[review_id] = row
    if expected_end_row > queue_count:
        raise HighValueSupervisedLabelError(
            "expected review row span exceeds the public queue"
        )

    private_by_review: dict[str, Mapping[str, Any]] = {}
    private_count = 0
    for row in iter_jsonl(queue_root / "private-bindings.jsonl", "private bindings"):
        private_count += 1
        validate_record_seal(row, f"private bindings:{private_count}")
        review_id = text(row.get("review_id"), "private binding.review_id")
        if review_id in private_by_review:
            raise HighValueSupervisedLabelError("private binding IDs are duplicated")
        private_by_review[review_id] = row
    if set(queue_by_review) != set(private_by_review):
        raise HighValueSupervisedLabelError("public/private queue coverage drifted")

    decisions: list[Mapping[str, Any]] = []
    decision_shard_by_row: dict[int, str] = {}
    review_descriptors: list[dict[str, Any]] = []
    shard_states: dict[str, dict[str, Any]] = {}
    seen_review_ids: set[str] = set()
    seen_sample_ids: set[str] = set()
    for review_root in review_roots:
        shard_id = review_root.name
        if shard_id in shard_states:
            raise HighValueSupervisedLabelError("review shard names are duplicated")
        decision_path = review_root / "decisions-public-blind.jsonl"
        shard_decisions: list[Mapping[str, Any]] = []
        for line_number, row in enumerate(
            iter_jsonl(decision_path, f"blind decisions[{shard_id}]"), 1
        ):
            validate_record_seal(row, f"blind decisions[{shard_id}]:{line_number}")
            if row.get("schema_version") != DECISION_SCHEMA:
                raise HighValueSupervisedLabelError("blind decision schema drifted")
            authority = mapping(row.get("authority"), "blind decision authority")
            blindness = mapping(row.get("blindness"), "blind decision blindness")
            if (
                authority.get("training_eligible") is not False
                or authority.get("automatic_label_promotion_allowed") is not False
                or blindness.get("candidate_identifiers_visible") is not False
                or blindness.get("font_names_visible") is not False
                or blindness.get("model_predictions_visible") is not False
                or blindness.get("private_bindings_read") is not False
                or row.get("review_complete") is not True
            ):
                raise HighValueSupervisedLabelError(
                    "blind decision authority/blindness drifted"
                )
            queue_row = int(row.get("queue_row", -1))
            if not expected_start_row <= queue_row <= expected_end_row:
                raise HighValueSupervisedLabelError(
                    "decision escaped expected review row span"
                )
            review_id = text(row.get("review_id"), "blind decision.review_id")
            sample_id = text(row.get("sample_id"), "blind decision.sample_id")
            if (
                queue_row in decision_shard_by_row
                or review_id in seen_review_ids
                or sample_id in seen_sample_ids
            ):
                raise HighValueSupervisedLabelError(
                    "blind review shards contain duplicate row/review/sample identity"
                )
            decision_shard_by_row[queue_row] = shard_id
            seen_review_ids.add(review_id)
            seen_sample_ids.add(sample_id)
            decisions.append(row)
            shard_decisions.append(row)
        shard_rows = sorted(int(row["queue_row"]) for row in shard_decisions)
        if not shard_rows or shard_rows != list(range(shard_rows[0], shard_rows[-1] + 1)):
            raise HighValueSupervisedLabelError(
                f"blind review shard {shard_id} is not a contiguous row span"
            )
        shard_states[shard_id] = {
            "blind_rows_consumed": len(shard_rows),
            "excluded_rows": 0,
            "exclusions": Counter(),
            "row_end": shard_rows[-1],
            "row_start": shard_rows[0],
            "training_label_rows": 0,
        }
        review_descriptors.append(
            {
                "artifact": source_descriptor(review_root / "report.json"),
                "decisions": source_descriptor(
                    decision_path, row_count=len(shard_decisions)
                ),
                "row_span": [shard_rows[0], shard_rows[-1]],
                "shard_id": shard_id,
            }
        )
    expected_rows = set(range(expected_start_row, expected_end_row + 1))
    if len(decisions) != len(expected_rows) or set(decision_shard_by_row) != expected_rows:
        raise HighValueSupervisedLabelError(
            "combined blind decision coverage does not match the expected row span"
        )

    master_by_id, master_val_ids, master_test_ids = load_master(master_manifest)
    (
        base_split,
        base_work_by_sample,
        adapter_validation_ids,
        adapter_validation_work_ids,
        base_binding,
    ) = load_base_split(base_dataset_dir)
    val33_ids = sample_ids_from(val33_file, "val33")
    blind_calibration_ids, blind_evaluation_ids, blind_descriptors = blind_pool_ids(
        blind_pool_files
    )
    qa_hash_set, qa_descriptors = qa_page_hashes(qa_cohort_files)

    exclusions: Counter[str] = Counter()
    labels: list[dict[str, Any]] = []
    role_counts: Counter[str] = Counter()
    preferred_counts: Counter[str] = Counter()
    positive_counts: Counter[str] = Counter()
    work_counts: Counter[str] = Counter()
    source_page_hashes: set[str] = set()

    def record_exclusion(shard_id: str, reason: str) -> None:
        exclusions[reason] += 1
        state = shard_states[shard_id]
        state["excluded_rows"] = int(state["excluded_rows"]) + 1
        state_exclusions = state["exclusions"]
        if not isinstance(state_exclusions, Counter):
            raise HighValueSupervisedLabelError("review shard exclusion state drifted")
        state_exclusions[reason] += 1

    for decision in sorted(decisions, key=lambda row: int(row["queue_row"])):
        queue_row = int(decision["queue_row"])
        shard_id = decision_shard_by_row[queue_row]
        if decision.get("decision_status") != "completed":
            record_exclusion(shard_id, "decision_not_completed")
            continue
        if decision.get("crop_quality") != "pass":
            record_exclusion(shard_id, "crop_not_pass")
            continue
        if decision.get("candidate_search_complete") is not True:
            record_exclusion(shard_id, "candidate_search_incomplete")
            continue
        if decision.get("none_acceptable") is True:
            record_exclusion(shard_id, "full21_unresolved")
            continue
        review_id = text(decision.get("review_id"), "decision.review_id")
        public = mapping(queue_by_review.get(review_id), "decision public binding")
        private = mapping(private_by_review.get(review_id), "decision private binding")
        sample_id = text(decision.get("sample_id"), "decision.sample_id")
        if (
            public.get("sample_id") != sample_id
            or private.get("sample_id") != sample_id
            or decision.get("review_item_sha256") != public.get("record_sha256")
        ):
            raise HighValueSupervisedLabelError("blind decision binding drifted")
        if int(public.get("review_order", -1)) != int(decision["queue_row"]):
            raise HighValueSupervisedLabelError("blind decision queue order drifted")
        if sample_id not in master_by_id or sample_id not in base_split:
            raise HighValueSupervisedLabelError("accepted sample missing from master/base dataset")

        master = master_by_id[sample_id]
        if master.get("split") != "train":
            raise HighValueSupervisedLabelError("accepted sample escaped master train")
        master_work_id = text(
            mapping(master.get("work"), "master work").get("id"),
            "master work.id",
        )
        if base_work_by_sample[sample_id] != master_work_id:
            raise HighValueSupervisedLabelError("base/master work binding drifted")
        if (
            base_split[sample_id] != 0
            or sample_id in adapter_validation_ids
            or master_work_id in adapter_validation_work_ids
        ):
            record_exclusion(shard_id, "adapter_validation_work")
            continue
        if private.get("master_row_sha256") != sha256_bytes(
            canonical_json(master).encode("utf-8")
        ):
            raise HighValueSupervisedLabelError("private/master row binding drifted")
        slots = sequence(private.get("candidate_slots"), "private candidate_slots")
        slot_to_id = {
            text(mapping(value, "candidate slot").get("slot"), "candidate slot.slot"): text(
                mapping(value, "candidate slot").get("candidate_id"),
                "candidate slot.candidate_id",
            )
            for value in slots
        }
        if tuple(sorted(slot_to_id)) != EXPECTED_SLOTS or len(set(slot_to_id.values())) != 7:
            raise HighValueSupervisedLabelError("private A-G candidate binding drifted")
        if not set(slot_to_id.values()) <= set(candidate_ids):
            raise HighValueSupervisedLabelError("private binding escaped active21")

        preferred_slots = tuple(str(value) for value in decision.get("preferred_slots", ()))
        acceptable_slots = tuple(str(value) for value in decision.get("acceptable_slots", ()))
        marginal_slots = tuple(str(value) for value in decision.get("marginal_slots", ()))
        unacceptable_slots = tuple(str(value) for value in decision.get("unacceptable_slots", ()))
        unrenderable_slots = tuple(str(value) for value in decision.get("unrenderable_slots", ()))
        partition = (*preferred_slots, *acceptable_slots, *marginal_slots, *unacceptable_slots, *unrenderable_slots)
        if set(partition) != set(EXPECTED_SLOTS) or len(partition) != len(set(partition)):
            raise HighValueSupervisedLabelError("blind slot judgment is not an exact partition")
        if not preferred_slots:
            raise HighValueSupervisedLabelError("completed label lacks a preferred slot")
        preferred = sorted_candidate_ids((slot_to_id[value] for value in preferred_slots), candidate_order)
        positive = sorted_candidate_ids(
            (slot_to_id[value] for value in (*preferred_slots, *acceptable_slots)),
            candidate_order,
        )
        eligible = sorted_candidate_ids(
            (slot_to_id[value] for value in EXPECTED_SLOTS if value not in unrenderable_slots),
            candidate_order,
        )
        if not set(preferred) <= set(positive) <= set(eligible):
            raise HighValueSupervisedLabelError("candidate label nesting drifted")

        raw_role = text(decision.get("verified_role"), "decision.verified_role")
        role = ROLE_MAP.get(raw_role)
        if role is None:
            raise HighValueSupervisedLabelError(f"unsupported verified role: {raw_role}")
        role_confidence = float(decision.get("verified_role_confidence", 0.0))
        supervision_weight = float(decision.get("font_match_confidence", 0.0))
        if not (
            math.isfinite(role_confidence)
            and 0.0 < role_confidence <= 1.0
            and math.isfinite(supervision_weight)
            and 0.0 < supervision_weight <= 1.0
        ):
            raise HighValueSupervisedLabelError("label confidence escaped (0,1]")
        page = mapping(private.get("page"), "private page")
        source_page_sha256 = text(page.get("source_page_sha256"), "private source page")
        master_page = mapping(master.get("page"), "master page")
        if master_page.get("source_page_sha256") != source_page_sha256:
            raise HighValueSupervisedLabelError("private/master page binding drifted")
        work_id = text(mapping(private.get("work"), "private work").get("id"), "work.id")
        chapter_id = text(
            mapping(private.get("chapter"), "private chapter").get("id"), "chapter.id"
        )
        page_id = text(page.get("id"), "page.id")
        if master_work_id != work_id:
            raise HighValueSupervisedLabelError("private/master work binding drifted")

        label = seal_record(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "automatic_release_authority": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "human_gold": False,
                    "label_authority": "blind_agent_visual_supervision_deblinded_after_review",
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                },
                "candidate_labels": {
                    "eligible_candidate_ids": list(eligible),
                    "positive_candidate_ids": list(positive),
                    "preferred_candidate_ids": list(preferred),
                },
                "family": "body" if role in BODY_ROLES else "variant",
                "identity": {
                    "chapter_id": chapter_id,
                    "master_row_sha256": text(
                        private.get("master_row_sha256"), "private master_row_sha256"
                    ),
                    "page_id": page_id,
                    "source_page_sha256": source_page_sha256,
                    "work_id": work_id,
                },
                "queue_row": queue_row,
                "record_type": "manga_font_v2_high_value_training_label",
                "review_binding": {
                    "blind_decision_record_sha256": text(
                        decision.get("record_sha256"), "decision record seal"
                    ),
                    "private_binding_record_sha256": text(
                        private.get("record_sha256"), "private record seal"
                    ),
                    "public_review_item_record_sha256": text(
                        public.get("record_sha256"), "public record seal"
                    ),
                    "review_id": review_id,
                },
                "role": role,
                "role_confidence": role_confidence,
                "sample_id": sample_id,
                "schema_version": SCHEMA,
                "supervision_weight": supervision_weight,
            }
        )
        assert_no_private_model_fields(label)
        labels.append(label)
        shard_states[shard_id]["training_label_rows"] = (
            int(shard_states[shard_id]["training_label_rows"]) + 1
        )
        role_counts[role] += 1
        work_counts[work_id] += 1
        source_page_hashes.add(source_page_sha256)
        preferred_counts.update(preferred)
        positive_counts.update(positive)

    label_ids = {str(row["sample_id"]) for row in labels}
    label_work_ids = set(work_counts)
    overlap = {
        "adapter_validation": len(label_ids & adapter_validation_ids),
        "adapter_validation_work": len(
            label_work_ids & adapter_validation_work_ids
        ),
        "blind_calibration": len(label_ids & blind_calibration_ids),
        "blind_evaluation": len(label_ids & blind_evaluation_ids),
        "master_test": len(label_ids & master_test_ids),
        "master_val": len(label_ids & master_val_ids),
        "qa_pages": len(source_page_hashes & qa_hash_set),
        "val33": len(label_ids & val33_ids),
    }
    if any(overlap.values()):
        raise HighValueSupervisedLabelError(f"training/evaluation leakage detected: {overlap}")
    if len(labels) != len(label_ids):
        raise HighValueSupervisedLabelError("training labels contain duplicate sample IDs")

    review_shards: list[dict[str, Any]] = []
    for shard_id in sorted(
        shard_states, key=lambda value: int(shard_states[value]["row_start"])
    ):
        state = shard_states[shard_id]
        shard_exclusions = state["exclusions"]
        if not isinstance(shard_exclusions, Counter):
            raise HighValueSupervisedLabelError("review shard summary drifted")
        blind_rows = int(state["blind_rows_consumed"])
        training_rows = int(state["training_label_rows"])
        excluded_rows = int(state["excluded_rows"])
        if blind_rows != training_rows + excluded_rows:
            raise HighValueSupervisedLabelError(
                "review shard eligible/excluded count does not close"
            )
        review_shards.append(
            {
                "blind_rows_consumed": blind_rows,
                "excluded_rows": excluded_rows,
                "exclusions": dict(sorted(shard_exclusions.items())),
                "row_span": [int(state["row_start"]), int(state["row_end"])],
                "shard_id": shard_id,
                "training_label_rows": training_rows,
            }
        )

    lineage = {
        "base_dataset": base_binding,
        "blind_decisions": review_descriptors,
        "blind_pools": blind_descriptors,
        "master_manifest": source_descriptor(master_manifest, row_count=len(master_by_id)),
        "private_bindings": source_descriptor(
            queue_root / "private-bindings.jsonl", row_count=private_count
        ),
        "public_queue": source_descriptor(
            queue_root / "review-queue.jsonl", row_count=queue_count
        ),
        "qa_cohorts": qa_descriptors,
        "queue_report": source_descriptor(queue_root / "report.json"),
        "val33": source_descriptor(val33_file, row_count=len(val33_ids)),
    }
    return labels, {
        "candidate_ids": candidate_ids,
        "counts": {
            "blind_rows_consumed": len(decisions),
            "duplicate_counts": {
                "decision_queue_rows": 0,
                "decision_review_ids": 0,
                "decision_sample_ids": 0,
                "training_sample_ids": 0,
            },
            "excluded_rows": sum(exclusions.values()),
            "exclusions": dict(sorted(exclusions.items())),
            "expected_queue_row_span": [expected_start_row, expected_end_row],
            "preferred_candidate_counts": dict(sorted(preferred_counts.items())),
            "positive_candidate_counts": dict(sorted(positive_counts.items())),
            "role_counts": dict(sorted(role_counts.items())),
            "review_shards": review_shards,
            "source_page_count": len(source_page_hashes),
            "training_label_rows": len(labels),
            "work_count": len(work_counts),
            "work_row_counts": dict(sorted(work_counts.items())),
        },
        "lineage": lineage,
        "overlap": overlap,
    }


def build_output(args: argparse.Namespace) -> Mapping[str, Any]:
    output = safe_output(args.output_dir)
    if output.exists():
        raise HighValueSupervisedLabelError("output directory already exists")
    labels, summary = build_labels(
        queue_dir=args.queue_dir,
        review_dirs=tuple(args.review_dir),
        expected_start_row=args.expected_start_row,
        expected_end_row=args.expected_end_row,
        base_dataset_dir=args.base_dataset_dir,
        master_manifest=args.master_manifest,
        val33_file=args.val33_file,
        blind_pool_files=tuple(args.blind_pool_file),
        qa_cohort_files=tuple(args.qa_cohort_file),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    published = False
    try:
        write_jsonl(staging / LABELS_FILE, labels)
        manifest = seal_record(
            {
                "authority": {
                    "automatic_label_promotion_allowed": False,
                    "automatic_release_authority": False,
                    "calibration_eligible": False,
                    "evaluation_eligible": False,
                    "human_gold": False,
                    "review_authority": "codex_agent_direct_visual_supervision",
                    "training_eligible": True,
                    "training_only": True,
                },
                "candidate_ids": list(summary["candidate_ids"]),
                "counts": copy.deepcopy(summary["counts"]),
                "labels": descriptor(staging / LABELS_FILE, row_count=len(labels)),
                "lineage": copy.deepcopy(summary["lineage"]),
                "overlap": copy.deepcopy(summary["overlap"]),
                "record_type": "manga_font_v2_high_value_supervised_labels_manifest",
                "schema_version": SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        assert_no_private_model_fields(manifest)
        (staging / MANIFEST_FILE).write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                "artifacts": {
                    LABELS_FILE: descriptor(staging / LABELS_FILE, row_count=len(labels)),
                    MANIFEST_FILE: descriptor(staging / MANIFEST_FILE),
                },
                "counts": copy.deepcopy(summary["counts"]),
                "manifest_record_sha256": manifest["record_sha256"],
                "overlap": copy.deepcopy(summary["overlap"]),
                "record_type": "manga_font_v2_high_value_supervised_labels_report",
                "schema_version": SCHEMA,
            }
        )
        assert_no_private_model_fields(report)
        (staging / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    LABELS_FILE: sha256_file(staging / LABELS_FILE),
                    MANIFEST_FILE: sha256_file(staging / MANIFEST_FILE),
                    REPORT_FILE: sha256_file(staging / REPORT_FILE),
                },
                "owner": OWNER,
                "safe_replace": True,
                "schema_version": SCHEMA,
            }
        )
        (staging / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
        validate_output(staging, require_current_source=True)
        os.replace(staging, output)
        published = True
        return validate_output(output, require_current_source=True)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_output(
    output_dir: Path, *, require_current_source: bool = False
) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if root.is_symlink() or not root.is_dir() or {path.name for path in root.iterdir()} != OUTPUT_FILES:
        raise HighValueSupervisedLabelError("output exact inventory drifted")
    marker = read_json(root / MARKER_FILE, "marker")
    manifest = read_json(root / MANIFEST_FILE, "manifest")
    report = read_json(root / REPORT_FILE, "report")
    for location, record in (("marker", marker), ("manifest", manifest), ("report", report)):
        validate_record_seal(record, location)
        assert_no_private_model_fields(record, location)
    source_code_sha256 = manifest.get("source_code_sha256")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != SCHEMA
        or report.get("schema_version") != SCHEMA
        or not isinstance(source_code_sha256, str)
        or len(source_code_sha256) != 64
        or any(value not in "0123456789abcdef" for value in source_code_sha256)
        or (
            require_current_source
            and source_code_sha256 != sha256_file(Path(__file__).resolve())
        )
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
    ):
        raise HighValueSupervisedLabelError("metadata/schema drifted")
    marker_artifacts = mapping(marker.get("artifacts"), "marker artifacts")
    for name in (LABELS_FILE, MANIFEST_FILE, REPORT_FILE):
        if marker_artifacts.get(name) != sha256_file(root / name):
            raise HighValueSupervisedLabelError(f"marker hash drifted: {name}")
    labels: list[dict[str, Any]] = []
    manifest_authority = mapping(manifest.get("authority"), "manifest authority")
    if (
        manifest_authority.get("automatic_label_promotion_allowed") is not False
        or manifest_authority.get("automatic_release_authority") is not False
        or manifest_authority.get("calibration_eligible") is not False
        or manifest_authority.get("evaluation_eligible") is not False
        or manifest_authority.get("human_gold") is not False
        or manifest_authority.get("review_authority")
        != "codex_agent_direct_visual_supervision"
        or manifest_authority.get("training_eligible") is not True
        or manifest_authority.get("training_only") is not True
    ):
        raise HighValueSupervisedLabelError("manifest authority drifted")
    for line_number, row in enumerate(iter_jsonl(root / LABELS_FILE, "training labels"), 1):
        validate_record_seal(row, f"training labels:{line_number}")
        assert_no_private_model_fields(row, f"training labels:{line_number}")
        authority = mapping(row.get("authority"), "label authority")
        candidates = mapping(row.get("candidate_labels"), "candidate labels")
        preferred = set(str(value) for value in candidates.get("preferred_candidate_ids", ()))
        positive = set(str(value) for value in candidates.get("positive_candidate_ids", ()))
        eligible = set(str(value) for value in candidates.get("eligible_candidate_ids", ()))
        if (
            row.get("schema_version") != SCHEMA
            or authority.get("training_eligible") is not True
            or authority.get("training_only") is not True
            or authority.get("automatic_release_authority") is not False
            or authority.get("calibration_eligible") is not False
            or authority.get("evaluation_eligible") is not False
            or authority.get("human_gold") is not False
            or authority.get("automatic_label_promotion_allowed") is not False
            or authority.get("automatic_release_authority") is not False
            or authority.get("review_authority")
            != "codex_agent_direct_visual_supervision"
            or not preferred
            or not preferred <= positive <= eligible
        ):
            raise HighValueSupervisedLabelError("training label authority/masks drifted")
        labels.append(row)
    sample_ids = [str(row.get("sample_id")) for row in labels]
    counts = mapping(manifest.get("counts"), "manifest counts")
    overlap = mapping(manifest.get("overlap"), "manifest overlap")
    labels_descriptor = mapping(manifest.get("labels"), "manifest labels")
    if (
        len(sample_ids) != len(set(sample_ids))
        or len(labels) != int(counts.get("training_label_rows", -1))
        or any(int(value) != 0 for value in overlap.values())
        or labels_descriptor != descriptor(root / LABELS_FILE, row_count=len(labels))
    ):
        raise HighValueSupervisedLabelError("label count/overlap/descriptor drifted")
    return {
        "candidate_count": len(manifest.get("candidate_ids", ())),
        "label_file": str(root / LABELS_FILE),
        "output_dir": str(root),
        "status": "validated_training_only_high_value_supervision",
        "training_label_rows": len(labels),
    }


def default_qa_cohorts() -> list[Path]:
    return sorted(Path("artifacts").glob("library-full-pipeline-font-qa-v*/cohorts/*.jsonl"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument(
        "--queue-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-high-value-supervised-queue-r1-800"),
    )
    build.add_argument(
        "--review-dir",
        action="append",
        type=Path,
        default=[],
    )
    build.add_argument("--expected-start-row", type=int, default=1)
    build.add_argument("--expected-end-row", type=int, default=200)
    build.add_argument(
        "--base-dataset-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v8-role-family-dataset-r3-body-holdout"),
    )
    build.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    build.add_argument(
        "--val33-file",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-human-overlay-adjudicated-val33-v1/"
            "val-samples-adjudicated.jsonl"
        ),
    )
    build.add_argument("--blind-pool-file", action="append", type=Path, default=[])
    build.add_argument("--qa-cohort-file", action="append", type=Path, default=[])
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "build":
        if not args.review_dir:
            args.review_dir = [
                Path(
                    "artifacts/manga-font-v2-high-value-blind-review-agent-001-200-r1"
                )
            ]
        if not args.blind_pool_file:
            args.blind_pool_file = [
                Path(
                    "artifacts/manga-font-v2-independent-blind-calibration-eval-pool-r1/"
                    "private-bindings.jsonl"
                ),
                Path(
                    "artifacts/manga-font-v2-independent-blind-calibration-eval-pool-r2/"
                    "private-bindings.jsonl"
                ),
            ]
        if not args.qa_cohort_file:
            args.qa_cohort_file = default_qa_cohorts()
        if not args.qa_cohort_file:
            raise SystemExit("high-value supervised label error: no QA cohorts found")
    try:
        result = build_output(args) if args.command == "build" else validate_output(args.output_dir)
    except (HighValueSupervisedLabelError, OSError, KeyError, ValueError) as error:
        raise SystemExit(f"high-value supervised label error: {error}") from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
