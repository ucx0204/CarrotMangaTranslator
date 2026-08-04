#!/usr/bin/env python3
"""Build an answer-free successor-authority calibration intake.

This intake is deliberately narrower than a review result.  Hidden source
prechecks may only decide whether a real crop is safe to admit.  Their role,
stratum, OCR, treatment, score, and rank fields are never copied into the
intake.  Every selected sample needs two independent clean prechecks; all
primary/secondary label assignments start in ``not_reviewed`` state.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts import build_font_matching_review_cards as card_builder  # noqa: E402
from scripts import font_matching_catalog_delta_ledger as delta  # noqa: E402


SCHEMA_VERSION = "font-matching-successor-authority-intake-v5"
OWNER = "carrot-manga-translator/font-matching-successor-authority-intake-v5"
MANIFEST_RECORD_TYPE = "font_catalog_delta_successor_authority_intake"
SAMPLE_RECORD_TYPE = "font_matching_successor_authority_intake_sample"
INVENTORY_RECORD_TYPE = "font_matching_successor_authority_review_inventory"
TRAINING_DISPOSITION = "permanent_train_quarantine_calibration_only"
PRECHECK_SUMMARY_SCHEMA = (
    "font-replacement-reservoir-neutral-source-visual-review-summary-v1"
)
PRECHECK_SUMMARY_RECORD_TYPE = (
    "font_replacement_reservoir_neutral_source_visual_review_summary"
)
PRECHECK_DECISION_SCHEMA = (
    "font-replacement-reservoir-neutral-source-visual-decision-v1"
)
PRECHECK_DECISION_RECORD_TYPE = (
    "font_replacement_reservoir_neutral_source_visual_decision"
)
COMPACT_PRECHECK_SCHEMA = "font-replacement-reservoir-source-visual-review-v1"
COMPACT_PRECHECK_RECORD_TYPE = "font_replacement_reservoir_source_visual_review"
INDEPENDENT_PRECHECK_SUMMARY_SCHEMA = (
    "font-replacement-reservoir-neutral-review-summary-v1"
)
INDEPENDENT_PRECHECK_SUMMARY_RECORD_TYPE = (
    "font_replacement_reservoir_neutral_visual_review_summary"
)
INDEPENDENT_PRECHECK_DECISION_SCHEMA = "font-replacement-reservoir-neutral-decision-v1"
INDEPENDENT_PRECHECK_DECISION_RECORD_TYPE = (
    "font_replacement_reservoir_neutral_visual_decision"
)
QUEUE_SCHEMA = "font-replacement-reservoir-source-queue-v1"
QUEUE_ITEM_RECORD_TYPE = "font_replacement_reservoir_source_queue_item"
REVIEW_STAGES = ("primary", "secondary")
MIN_DOUBLE_CLEAN_POOL = 72
EXACT_SELECTED_COUNT = 60
MAX_SAMPLES_PER_WORK = 5
EXPECTED_TRAIN_WORK_COUNT = 15
EXPECTED_SELECTED_PER_WORK = 4
MIN_DOUBLE_CLEAN_PER_WORK = 4
EXACT_STRATUM_COUNTS = {
    "ordinary_body": 8,
    "aside_whisper_handwritten": 12,
    "emphasis_shout": 12,
    "sfx_ambient": 4,
    "sfx_comic": 4,
    "sfx_emotion": 4,
    "sfx_impact": 4,
    "sfx_motion": 4,
    "sign_ui_title": 8,
}
EXPECTED_EXPANDED_RENDER_BANK_SHA256 = (
    "e27cf064ae5df0a83146f665387ee1462a286596d06a4f10f02f09585e975577"
)
EXPECTED_EXPANDED_FONT_CATALOG_SHA256 = (
    "2bd549480b7ccecf2dd31418fcf705c5eda5d0c8787bf86c12803bed77df9d34"
)
FRESH_DELTA_CANDIDATES = {
    "black-and-white-picture": {
        "blind_alias": "ko-candidate-2a5d12c7e8f32c30",
        "source_sha256": "4d72cd6de1f210b446c86f06b4e13d7641cbcfb1b375c6927341388aa8e08056",
    },
    "black-han-sans": {
        "blind_alias": "ko-candidate-a0144e95710224a2",
        "source_sha256": "31960809284026681774a8e52dc19ebcad26cf69b0ad9d560f288296fbb52739",
    },
    "gasoek-one": {
        "blind_alias": "ko-candidate-e7b4692fa6ce4ebc",
        "source_sha256": "73a6b8e0d12a56f0a070f19b44a93ae050f98eb926da5d2a7c8d6db92bd8d9c3",
    },
    "gugi": {
        "blind_alias": "ko-candidate-4cc309d56243eb25",
        "source_sha256": "c0b1f979979cfc309fb2438fa9464f96173353e0c4842cc7a5919658184ed9d3",
    },
    "kirang-haerang": {
        "blind_alias": "ko-candidate-cd8774e1d647c522",
        "source_sha256": "d677d28d466989017c520f00a2a7794ea581ea3d9fa9a830fbb44f1015eac72d",
    },
    "nanum-brush-script": {
        "blind_alias": "ko-candidate-f11ed4e82c1eacf1",
        "source_sha256": "27ceaf578c96f594cdf07fe0181b251790acbb746a164e45c1f6473f89911a31",
    },
    "single-day": {
        "blind_alias": "ko-candidate-9ee53bb2477d92a2",
        "source_sha256": "716ff67a4b0675b35c26d60a4bb83173f7d153ab754474ed36c3369593ca1ca8",
    },
}


class IntakeError(ValueError):
    """Raised when the successor intake fails closed."""


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(*parts: str) -> str:
    digest = hashlib.sha256()
    for part in parts:
        encoded = part.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    if "record_sha256" in value:
        raise IntakeError("record already contains a seal")
    output = copy.deepcopy(dict(value))
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(value: Mapping[str, Any], location: str) -> str:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise IntakeError(f"{location}: missing record seal")
    core = {key: child for key, child in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json_bytes(core)) != expected:
        raise IntakeError(f"{location}: record seal changed")
    return expected


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise IntakeError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise IntakeError(f"{path}: expected an object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise IntakeError(f"cannot read JSONL {path}: {error}") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise IntakeError(f"{path}:{line_number}: invalid JSON: {error}") from error
        if not isinstance(value, dict):
            raise IntakeError(f"{path}:{line_number}: expected an object")
        rows.append(value)
    return rows


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise IntakeError(f"input is missing: {resolved}")
    return {
        "path": str(resolved),
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _atomic_replace(output_dir: Path, payloads: Mapping[str, bytes]) -> None:
    output_dir = output_dir.resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        marker = output_dir / ".successor-authority-intake-v5-owned.json"
        if not marker.is_file():
            raise IntakeError(f"refusing to replace unowned output: {output_dir}")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.building-", dir=output_dir.parent)
    )
    try:
        for name, payload in payloads.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        marker = {
            "schema_version": SCHEMA_VERSION,
            "owner": OWNER,
        }
        (staging / ".successor-authority-intake-v5-owned.json").write_bytes(
            canonical_json_bytes(marker, pretty=True)
        )
        if output_dir.exists():
            backup = output_dir.with_name(output_dir.name + ".previous")
            if backup.exists():
                raise IntakeError(f"refusing existing backup: {backup}")
            os.replace(output_dir, backup)
            try:
                os.replace(staging, output_dir)
            except BaseException:
                os.replace(backup, output_dir)
                raise
            for child in backup.iterdir():
                if child.is_file():
                    child.unlink()
                else:
                    import shutil

                    shutil.rmtree(child)
            backup.rmdir()
        else:
            os.replace(staging, output_dir)
    finally:
        if staging.exists():
            import shutil

            shutil.rmtree(staging)


def _index(
    rows: Sequence[Mapping[str, Any]], key: str, location: str
) -> dict[str, Mapping[str, Any]]:
    output: dict[str, Mapping[str, Any]] = {}
    for index, row in enumerate(rows):
        value = row.get(key)
        if not isinstance(value, str) or not value:
            raise IntakeError(f"{location}[{index}].{key}: invalid identifier")
        if value in output:
            raise IntakeError(f"{location}: duplicate {key} {value}")
        output[value] = row
    return output


def _reviewed_surface_fingerprint(decision: Mapping[str, Any], location: str) -> str:
    contract = decision.get("source_review_contract")
    if not isinstance(contract, Mapping):
        raise IntakeError(f"{location}: missing source review contract")
    if (
        contract.get("candidate_font_pixels_viewed") is not False
        or contract.get("manual_source_view_complete") is not True
        or contract.get("metadata_only_decision") is not False
    ):
        raise IntakeError(
            f"{location}: precheck was not a manual candidate-free source pass"
        )
    surfaces = contract.get("reviewed_surfaces")
    if not isinstance(surfaces, list) or not surfaces:
        raise IntakeError(f"{location}: no reviewed source surface")
    normalized: list[dict[str, Any]] = []
    for index, value in enumerate(surfaces):
        if not isinstance(value, Mapping) or value.get("viewed") is not True:
            raise IntakeError(f"{location}.surfaces[{index}]: surface was not viewed")
        declared = value.get("declared_sha256")
        observed = value.get("observed_sha256")
        path_value = value.get("path")
        if not isinstance(declared, str) or declared != observed:
            raise IntakeError(f"{location}.surfaces[{index}]: observed bytes differ")
        if not isinstance(path_value, str):
            raise IntakeError(f"{location}.surfaces[{index}]: source path missing")
        path = Path(path_value)
        if not path.is_file() or sha256_file(path) != observed:
            raise IntakeError(f"{location}.surfaces[{index}]: source file changed")
        normalized.append(
            {
                "name": value.get("name"),
                "sha256": observed,
                "pixel_sha256": value.get("declared_pixel_sha256"),
                "size_px": value.get("declared_size_px"),
            }
        )
    if contract.get("reviewed_surface_count") != len(normalized):
        raise IntakeError(f"{location}: reviewed surface count changed")
    return sha256_bytes(canonical_json_bytes(normalized))


def _load_redacted_prechecks(
    summary_paths: Sequence[Path],
) -> tuple[
    dict[str, list[dict[str, Any]]],
    list[dict[str, Any]],
    dict[str, Mapping[str, Any]],
]:
    from scripts import font_matching_redacted_source_precheck_v5 as redacted

    if len(summary_paths) < 2 or len(summary_paths) % 2:
        raise IntakeError(
            "fresh redacted source reviews must be supplied as complete reviewer pairs"
        )
    evidence: dict[str, list[dict[str, Any]]] = defaultdict(list)
    bindings: list[dict[str, Any]] = []
    loaded_by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_review_records: set[str] = set()
    seen_pack_records: set[str] = set()
    seen_public_task_ids: set[str] = set()
    for index, path_value in enumerate(summary_paths):
        summary_path = path_value.resolve()
        try:
            summary, decisions, pack, tasks = redacted.load_review_summary(summary_path)
            private, private_queue = redacted.load_private_authority(
                Path(str(summary["pack_manifest"]["path"]))
            )
        except redacted.RedactedPrecheckError as error:
            raise IntakeError(str(error)) from error
        review_record = str(summary["record_sha256"])
        pack_record = str(pack["record_sha256"])
        if review_record in seen_review_records:
            raise IntakeError("redacted source review summary is duplicated")
        if pack_record in seen_pack_records:
            raise IntakeError("redacted source pack is reused")
        seen_review_records.add(review_record)
        seen_pack_records.add(pack_record)
        reviewer_id = str(summary["reviewer_id"])
        source_record = str(private["source_queue_manifest"]["record_sha256"])
        private_bindings = {
            str(value["public_precheck_task_id"]): value
            for value in private["task_bindings"]
        }
        decision_by_task = {
            str(value["public_precheck_task_id"]): value for value in decisions
        }
        if set(private_bindings) != set(decision_by_task):
            raise IntakeError("redacted review/private task coverage changed")
        if seen_public_task_ids.intersection(private_bindings):
            raise IntakeError("redacted public task IDs are reused across packs")
        seen_public_task_ids.update(private_bindings)
        decision_path = (
            summary_path.parent / str(summary["decisions"]["file"])
        ).resolve()
        loaded_by_source[source_record].append(
            {
                "summary": summary,
                "decisions": decision_by_task,
                "decision_path": decision_path,
                "pack": pack,
                "tasks": tasks,
                "private": private,
                "private_queue": private_queue,
                "private_bindings": private_bindings,
                "reviewer_id": reviewer_id,
            }
        )
        pack_path = Path(str(summary["pack_manifest"]["path"])).resolve()
        private_path = pack_path.parent.parent / "private-authority.json"
        bindings.append(
            {
                "summary": file_binding(summary_path),
                "summary_record_sha256": summary["record_sha256"],
                "decisions": file_binding(decision_path),
                "pack_manifest": file_binding(pack_path),
                "pack_manifest_record_sha256": pack["record_sha256"],
                "private_authority": file_binding(private_path),
                "private_authority_record_sha256": private["record_sha256"],
                "source_queue_manifest_record_sha256": source_record,
                "review_id": review_record,
                "reviewer_id": reviewer_id,
            }
        )
    queue_by_sample: dict[str, Mapping[str, Any]] = {}
    global_reviewer_ids: set[str] | None = None
    for source_record, reviews in loaded_by_source.items():
        if len(reviews) != 2:
            raise IntakeError(
                "each private source authority requires exactly two redacted reviews"
            )
        reviewer_ids = {str(value["reviewer_id"]) for value in reviews}
        if len(reviewer_ids) != 2:
            raise IntakeError("redacted source reviews must use distinct reviewers")
        if global_reviewer_ids is None:
            global_reviewer_ids = reviewer_ids
        elif reviewer_ids != global_reviewer_ids:
            raise IntakeError(
                "every redacted source batch must use the same two reviewers"
            )
        first_queue = reviews[0]["private_queue"]
        second_queue = reviews[1]["private_queue"]
        if set(first_queue) != set(second_queue) or any(
            first_queue[sample_id].get("record_sha256")
            != second_queue[sample_id].get("record_sha256")
            for sample_id in first_queue
        ):
            raise IntakeError("paired redacted reviews bind different private queues")
        if set(first_queue).intersection(queue_by_sample):
            raise IntakeError("redacted source batches overlap sample lineage")
        queue_by_sample.update(first_queue)

        private_orders = [
            [str(row["sample_id"]) for row in value["private"]["task_bindings"]]
            for value in reviews
        ]
        public_surface_sequences = [
            [
                tuple(
                    (
                        str(surface["file_sha256"]),
                        str(surface["pixel_sha256"]),
                    )
                    for surface in task["source_surfaces"]
                )
                for task in value["tasks"]
            ]
            for value in reviews
        ]
        if (
            private_orders[0] == private_orders[1]
            or public_surface_sequences[0] == public_surface_sequences[1]
        ):
            raise IntakeError(
                "paired redacted packs do not have independently randomized orders"
            )

        for value in reviews:
            for public_task_id, decision in value["decisions"].items():
                sample_id = str(value["private_bindings"][public_task_id]["sample_id"])
                evidence[sample_id].append(
                    {
                        "review_id": str(value["summary"]["record_sha256"]),
                        "reviewer_id": str(value["reviewer_id"]),
                        "decision_record_sha256": decision["record_sha256"],
                        "decision_file_sha256": sha256_file(value["decision_path"]),
                        "queue_item_record_sha256": value["private_queue"][sample_id][
                            "record_sha256"
                        ],
                        "reviewed_source_surfaces_sha256": decision[
                            "reviewed_source_surfaces_sha256"
                        ],
                        "eligibility": decision["eligibility"],
                    }
                )
    if global_reviewer_ids is None or any(
        len(rows) != 2
        or {str(row["reviewer_id"]) for row in rows} != global_reviewer_ids
        for rows in evidence.values()
    ):
        raise IntakeError("redacted reviews do not provide exact paired coverage")
    return evidence, bindings, queue_by_sample


def _load_prechecks(
    summary_paths: Sequence[Path],
) -> tuple[
    dict[str, list[dict[str, Any]]], list[dict[str, Any]], dict[str, Mapping[str, Any]]
]:
    # All legacy A1/A2/compact reports are permanently non-authoritative:
    # their reviewers could join task IDs or queue metadata to proposed
    # role/stratum fields.  Only two separately randomized redacted packs may
    # authorize a successor round.
    return _load_redacted_prechecks(summary_paths)

    if len(summary_paths) < 4:
        raise IntakeError("four independent shard-review summaries are required")
    evidence: dict[str, list[dict[str, Any]]] = defaultdict(list)
    summary_bindings: list[dict[str, Any]] = []
    queue_by_sample: dict[str, Mapping[str, Any]] = {}
    seen_review_ids: set[str] = set()
    for summary_index, path_value in enumerate(summary_paths):
        path = path_value.resolve()
        summary = read_json(path)
        record_sha = validate_seal(summary, f"precheck summary[{summary_index}]")
        if (
            summary.get("schema_version") == COMPACT_PRECHECK_SCHEMA
            and summary.get("record_type") == COMPACT_PRECHECK_RECORD_TYPE
        ):
            reviewer_id = summary.get("reviewer_id")
            review_mode = summary.get("review_mode")
            if (
                not isinstance(reviewer_id, str)
                or not isinstance(review_mode, str)
                or "source" not in review_mode
                or summary.get("candidate_font_pixels_viewed") is not False
                or summary.get("prior_font_labels_scores_ranks_viewed") is not False
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: unsafe compact review"
                )
            review_id = "compact-" + record_sha[:32]
            if review_id in seen_review_ids:
                raise IntakeError(
                    f"precheck summary[{summary_index}]: duplicate review"
                )
            seen_review_ids.add(review_id)
            queue_binding = summary.get("queue_binding")
            parent_binding = summary.get("parent_manifest_binding")
            if not isinstance(queue_binding, Mapping) or not isinstance(
                parent_binding, Mapping
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: compact bindings missing"
                )
            queue_path = Path(str(queue_binding.get("path"))).resolve()
            queue_manifest_path = Path(str(parent_binding.get("path"))).resolve()
            if (
                not queue_path.is_file()
                or sha256_file(queue_path) != queue_binding.get("sha256")
                or not queue_manifest_path.is_file()
                or sha256_file(queue_manifest_path) != parent_binding.get("sha256")
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: compact input changed"
                )
            queue_manifest = read_json(queue_manifest_path)
            validate_seal(queue_manifest, f"precheck queue manifest[{summary_index}]")
            if queue_manifest.get("record_sha256") != parent_binding.get(
                "record_sha256"
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: queue manifest changed"
                )
            queue_rows = read_jsonl(queue_path)
            queue_index = _index(
                queue_rows, "sample_id", f"precheck queue[{summary_index}]"
            )
            for sample_id, row in queue_index.items():
                validate_seal(row, f"precheck queue[{summary_index}][{sample_id}]")
                if (
                    row.get("schema_version") != QUEUE_SCHEMA
                    or row.get("record_type") != QUEUE_ITEM_RECORD_TYPE
                    or row.get("canonical_split") != "train"
                ):
                    raise IntakeError(f"precheck queue[{sample_id}]: unsafe queue row")
                previous = queue_by_sample.get(sample_id)
                if previous is not None and previous.get("record_sha256") != row.get(
                    "record_sha256"
                ):
                    raise IntakeError(
                        f"{sample_id}: queue identity differs between reviews"
                    )
                queue_by_sample[sample_id] = row
            decisions = summary.get("decisions")
            if not isinstance(decisions, list):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: decisions missing"
                )
            decision_index = _index(
                decisions, "sample_id", f"precheck decisions[{summary_index}]"
            )
            if set(decision_index) != set(queue_index):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: compact coverage changed"
                )
            clean_ids: set[str] = set()
            reject_ids: set[str] = set()
            for sample_id, decision in decision_index.items():
                if decision.get("queue_item_record_sha256") != queue_index[
                    sample_id
                ].get("record_sha256"):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: queue binding changed"
                    )
                status = decision.get("eligibility")
                if status not in {"clean", "reject"}:
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: eligibility unsupported"
                    )
                surfaces = decision.get("source_surfaces")
                inspected = decision.get("inspected_surface_kinds")
                if (
                    not isinstance(surfaces, list)
                    or not surfaces
                    or not isinstance(inspected, list)
                    or not inspected
                ):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: source was not inspected"
                    )
                normalized_surfaces: list[dict[str, Any]] = []
                for surface_index, surface_value in enumerate(surfaces):
                    if not isinstance(surface_value, Mapping):
                        raise IntakeError(
                            f"precheck decision[{sample_id}].surface[{surface_index}] changed"
                        )
                    surface_path = Path(str(surface_value.get("path"))).resolve()
                    expected_sha = surface_value.get("sha256")
                    if (
                        not surface_path.is_file()
                        or not isinstance(expected_sha, str)
                        or sha256_file(surface_path) != expected_sha
                    ):
                        raise IntakeError(
                            f"precheck decision[{sample_id}].surface[{surface_index}] bytes changed"
                        )
                    normalized_surfaces.append(
                        {
                            "kind": surface_value.get("kind"),
                            "sha256": expected_sha,
                            "pixel_sha256": surface_value.get("pixel_sha256"),
                        }
                    )
                surface_sha = sha256_bytes(canonical_json_bytes(normalized_surfaces))
                decision_sha = sha256_bytes(canonical_json_bytes(decision))
                (clean_ids if status == "clean" else reject_ids).add(sample_id)
                evidence[sample_id].append(
                    {
                        "review_id": review_id,
                        "reviewer_id": reviewer_id,
                        "decision_record_sha256": decision_sha,
                        "decision_file_sha256": sha256_file(path),
                        "queue_item_record_sha256": queue_index[sample_id][
                            "record_sha256"
                        ],
                        "reviewed_source_surfaces_sha256": surface_sha,
                        "eligibility": status,
                    }
                )
            compact_summary = summary.get("summary")
            if not isinstance(compact_summary, Mapping) or (
                compact_summary.get("inspected_count") != len(decision_index)
                or compact_summary.get("clean_count") != len(clean_ids)
                or compact_summary.get("reject_count") != len(reject_ids)
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: compact counts changed"
                )
            summary_bindings.append(
                {
                    "summary": file_binding(path),
                    "summary_record_sha256": record_sha,
                    "decisions": {**file_binding(path), "embedded": True},
                    "queue": file_binding(queue_path),
                    "queue_manifest": file_binding(queue_manifest_path),
                    "queue_manifest_record_sha256": parent_binding.get("record_sha256"),
                    "review_id": review_id,
                    "reviewer_id": reviewer_id,
                }
            )
            continue
        if (
            summary.get("schema_version") == INDEPENDENT_PRECHECK_SUMMARY_SCHEMA
            and summary.get("record_type") == INDEPENDENT_PRECHECK_SUMMARY_RECORD_TYPE
        ):
            reviewer_id = summary.get("reviewer_id")
            queue_id = summary.get("queue_id")
            shard = summary.get("shard")
            if (
                not isinstance(reviewer_id, str)
                or not reviewer_id
                or not isinstance(queue_id, str)
                or not queue_id
                or shard not in {"a", "b"}
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: independent identity missing"
                )
            review_id = "independent-" + record_sha[:32]
            if review_id in seen_review_ids:
                raise IntakeError(
                    f"precheck summary[{summary_index}]: duplicate review"
                )
            seen_review_ids.add(review_id)

            review_contract = summary.get("review_contract")
            if not isinstance(review_contract, Mapping) or (
                review_contract.get("visual_source_only") is not True
                or review_contract.get("candidate_font_pixels_viewed") is not False
                or review_contract.get("prior_answers_viewed") is not False
                or review_contract.get("prohibited_sibling_review_directory_viewed")
                is not False
                or review_contract.get("proposed_role_or_stratum_used_for_decision")
                is not False
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: unsafe independent review"
                )
            integrity = summary.get("integrity")
            required_integrity = (
                "queue_file_sha256_verified",
                "parent_manifest_file_sha256_verified",
                "parent_manifest_record_sha256_verified",
                "all_queue_item_record_sha256_verified",
                "all_surface_file_sha256_verified",
                "review_orders_complete_1_through_60",
                "successor_view_order_contract_met",
            )
            if not isinstance(integrity, Mapping) or any(
                integrity.get(key) is not True for key in required_integrity
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: independent integrity failed"
                )

            queue_binding = summary.get("queue_binding")
            parent_binding = summary.get("parent_manifest_binding")
            decisions_binding = summary.get("decisions_binding")
            if (
                not isinstance(queue_binding, Mapping)
                or not isinstance(parent_binding, Mapping)
                or not isinstance(decisions_binding, Mapping)
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: independent bindings missing"
                )
            queue_path = Path(str(queue_binding.get("path"))).resolve()
            queue_manifest_path = Path(str(parent_binding.get("path"))).resolve()
            decisions_path = Path(str(decisions_binding.get("path"))).resolve()
            if (
                not queue_path.is_file()
                or sha256_file(queue_path) != queue_binding.get("file_sha256")
                or not queue_manifest_path.is_file()
                or sha256_file(queue_manifest_path) != parent_binding.get("file_sha256")
                or not decisions_path.is_file()
                or sha256_file(decisions_path) != decisions_binding.get("file_sha256")
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: independent input changed"
                )
            queue_manifest = read_json(queue_manifest_path)
            queue_manifest_sha = validate_seal(
                queue_manifest, f"precheck queue manifest[{summary_index}]"
            )
            if (
                queue_manifest_sha != parent_binding.get("record_sha256")
                or parent_binding.get("record_sha256_verified") is not True
                or queue_manifest.get("queue_id") != queue_id
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: queue manifest changed"
                )

            queue_rows = read_jsonl(queue_path)
            expected_row_count = queue_binding.get("expected_row_count")
            if (
                not isinstance(expected_row_count, int)
                or expected_row_count != len(queue_rows)
                or summary.get("row_count") != len(queue_rows)
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: queue count changed"
                )
            queue_index = _index(
                queue_rows, "sample_id", f"precheck queue[{summary_index}]"
            )
            for sample_id, row in queue_index.items():
                validate_seal(row, f"precheck queue[{summary_index}][{sample_id}]")
                if (
                    row.get("schema_version") != QUEUE_SCHEMA
                    or row.get("record_type") != QUEUE_ITEM_RECORD_TYPE
                    or row.get("canonical_split") != "train"
                    or row.get("queue_id") != queue_id
                    or row.get("shard") != shard
                ):
                    raise IntakeError(f"precheck queue[{sample_id}]: unsafe queue row")
                previous = queue_by_sample.get(sample_id)
                if previous is not None and previous.get("record_sha256") != row.get(
                    "record_sha256"
                ):
                    raise IntakeError(
                        f"{sample_id}: queue identity differs between reviews"
                    )
                queue_by_sample[sample_id] = row

            decisions = read_jsonl(decisions_path)
            if decisions_binding.get("record_count") != len(decisions):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: decision count changed"
                )
            decision_index = _index(
                decisions, "sample_id", f"precheck decisions[{summary_index}]"
            )
            if set(decision_index) != set(queue_index):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: decision coverage changed"
                )
            clean_ids: set[str] = set()
            reject_ids: set[str] = set()
            record_shas: list[str] = []
            review_orders: list[int] = []
            for sample_id, decision in decision_index.items():
                decision_sha = validate_seal(
                    decision, f"precheck decisions[{summary_index}][{sample_id}]"
                )
                record_shas.append(decision_sha)
                review_order = decision.get("review_order")
                if not isinstance(review_order, int):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: review order missing"
                    )
                review_orders.append(review_order)
                if (
                    decision.get("schema_version")
                    != INDEPENDENT_PRECHECK_DECISION_SCHEMA
                    or decision.get("record_type")
                    != INDEPENDENT_PRECHECK_DECISION_RECORD_TYPE
                    or decision.get("reviewer_id") != reviewer_id
                    or decision.get("queue_id") != queue_id
                    or decision.get("shard") != shard
                ):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: independent identity changed"
                    )
                decision_contract = decision.get("review_contract")
                if not isinstance(decision_contract, Mapping) or (
                    decision_contract.get("visual_source_only") is not True
                    or decision_contract.get("candidate_font_pixels_viewed")
                    is not False
                    or decision_contract.get("prior_answers_viewed") is not False
                    or decision_contract.get(
                        "proposed_role_or_stratum_used_for_decision"
                    )
                    is not False
                ):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: unsafe independent review"
                    )
                decision_queue = decision.get("queue_binding")
                decision_parent = decision.get("parent_manifest_binding")
                if not isinstance(decision_queue, Mapping) or (
                    decision_queue.get("file_sha256")
                    != queue_binding.get("file_sha256")
                    or decision.get("queue_item_record_sha256")
                    != queue_index[sample_id].get("record_sha256")
                    or decision.get("queue_item_record_sha256_verified") is not True
                ):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: queue binding changed"
                    )
                if not isinstance(decision_parent, Mapping) or (
                    decision_parent.get("file_sha256")
                    != parent_binding.get("file_sha256")
                    or decision_parent.get("record_sha256") != queue_manifest_sha
                    or decision_parent.get("record_sha256_verified") is not True
                ):
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: parent binding changed"
                    )
                status = decision.get("decision")
                if status not in {"eligible", "reject"}:
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: decision unsupported"
                    )
                surfaces = decision.get("viewed_surfaces")
                if not isinstance(surfaces, list) or not surfaces:
                    raise IntakeError(
                        f"precheck decision[{sample_id}]: no viewed source surface"
                    )
                normalized_surfaces: list[dict[str, Any]] = []
                for surface_index, surface_value in enumerate(surfaces):
                    if not isinstance(surface_value, Mapping):
                        raise IntakeError(
                            f"precheck decision[{sample_id}].surface[{surface_index}] changed"
                        )
                    surface_path = Path(str(surface_value.get("path"))).resolve()
                    declared_sha = surface_value.get("declared_file_sha256")
                    actual_sha = surface_value.get("actual_file_sha256")
                    if (
                        surface_value.get("file_sha256_verified") is not True
                        or not isinstance(declared_sha, str)
                        or actual_sha != declared_sha
                        or not surface_path.is_file()
                        or sha256_file(surface_path) != declared_sha
                    ):
                        raise IntakeError(
                            f"precheck decision[{sample_id}].surface[{surface_index}] bytes changed"
                        )
                    normalized_surfaces.append(
                        {
                            "name": surface_value.get("view_name"),
                            "sha256": declared_sha,
                            "pixel_sha256": surface_value.get("declared_pixel_sha256"),
                            "size_px": surface_value.get("declared_size_px"),
                        }
                    )
                surface_sha = sha256_bytes(canonical_json_bytes(normalized_surfaces))
                normalized_status = "clean" if status == "eligible" else "reject"
                (clean_ids if normalized_status == "clean" else reject_ids).add(
                    sample_id
                )
                evidence[sample_id].append(
                    {
                        "review_id": review_id,
                        "reviewer_id": reviewer_id,
                        "decision_record_sha256": decision_sha,
                        "decision_file_sha256": sha256_file(decisions_path),
                        "queue_item_record_sha256": queue_index[sample_id][
                            "record_sha256"
                        ],
                        "reviewed_source_surfaces_sha256": surface_sha,
                        "eligibility": normalized_status,
                    }
                )
            combined_record_sha = sha256_bytes(
                ("\n".join(record_shas) + "\n").encode("utf-8")
            )
            if combined_record_sha != decisions_binding.get(
                "combined_record_sha256s_sha256"
            ) or sorted(review_orders) != list(range(1, len(decisions) + 1)):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: decision sequence changed"
                )
            result_counts = summary.get("result_counts")
            if not isinstance(result_counts, Mapping) or (
                result_counts.get("eligible") != len(clean_ids)
                or result_counts.get("reject") != len(reject_ids)
            ):
                raise IntakeError(
                    f"precheck summary[{summary_index}]: result counts changed"
                )
            summary_bindings.append(
                {
                    "summary": file_binding(path),
                    "summary_record_sha256": record_sha,
                    "decisions": file_binding(decisions_path),
                    "queue": file_binding(queue_path),
                    "queue_manifest": file_binding(queue_manifest_path),
                    "queue_manifest_record_sha256": queue_manifest_sha,
                    "review_id": review_id,
                    "reviewer_id": reviewer_id,
                }
            )
            continue
        if (
            summary.get("schema_version") != PRECHECK_SUMMARY_SCHEMA
            or summary.get("record_type") != PRECHECK_SUMMARY_RECORD_TYPE
            or summary.get("status") != "sealed_complete"
        ):
            raise IntakeError(
                f"precheck summary[{summary_index}]: unsupported contract"
            )
        review_id = summary.get("review_id")
        reviewer_id = summary.get("reviewer_id")
        if not isinstance(review_id, str) or not isinstance(reviewer_id, str):
            raise IntakeError(
                f"precheck summary[{summary_index}]: reviewer identity missing"
            )
        if review_id in seen_review_ids:
            raise IntakeError(f"precheck summary[{summary_index}]: duplicate review")
        seen_review_ids.add(review_id)
        review_contract = summary.get("review_contract")
        if not isinstance(review_contract, Mapping) or (
            review_contract.get("candidate_font_pixels_viewed") is not False
            or review_contract.get("manual_source_view_complete") is not True
            or review_contract.get("metadata_only_decision_count") != 0
        ):
            raise IntakeError(
                f"precheck summary[{summary_index}]: unsafe review contract"
            )
        bindings = summary.get("bindings")
        if not isinstance(bindings, Mapping):
            raise IntakeError(f"precheck summary[{summary_index}]: bindings missing")
        decisions_path = Path(str(bindings.get("decisions_path"))).resolve()
        queue_path = Path(str(bindings.get("queue_path"))).resolve()
        queue_manifest_path = Path(str(bindings.get("queue_manifest_path"))).resolve()
        if (
            not decisions_path.is_file()
            or sha256_file(decisions_path) != bindings.get("decisions_file_sha256")
            or not queue_path.is_file()
            or sha256_file(queue_path) != bindings.get("queue_file_sha256")
            or not queue_manifest_path.is_file()
            or sha256_file(queue_manifest_path)
            != bindings.get("queue_manifest_file_sha256")
        ):
            raise IntakeError(f"precheck summary[{summary_index}]: bound input changed")
        queue_manifest = read_json(queue_manifest_path)
        validate_seal(queue_manifest, f"precheck queue manifest[{summary_index}]")
        if queue_manifest.get("record_sha256") != bindings.get(
            "queue_manifest_record_sha256"
        ):
            raise IntakeError(
                f"precheck summary[{summary_index}]: queue manifest record changed"
            )
        queue_rows = read_jsonl(queue_path)
        queue_index = _index(
            queue_rows, "sample_id", f"precheck queue[{summary_index}]"
        )
        for sample_id, row in queue_index.items():
            validate_seal(row, f"precheck queue[{summary_index}][{sample_id}]")
            if (
                row.get("schema_version") != QUEUE_SCHEMA
                or row.get("record_type") != QUEUE_ITEM_RECORD_TYPE
                or row.get("canonical_split") != "train"
            ):
                raise IntakeError(f"precheck queue[{sample_id}]: unsafe queue row")
            previous = queue_by_sample.get(sample_id)
            if previous is not None and previous.get("record_sha256") != row.get(
                "record_sha256"
            ):
                raise IntakeError(
                    f"{sample_id}: queue identity differs between reviews"
                )
            queue_by_sample[sample_id] = row
        decisions = read_jsonl(decisions_path)
        decision_index = _index(
            decisions, "sample_id", f"precheck decisions[{summary_index}]"
        )
        if set(decision_index) != set(queue_index):
            raise IntakeError(
                f"precheck summary[{summary_index}]: decision coverage changed"
            )
        clean_ids: set[str] = set()
        reject_ids: set[str] = set()
        for sample_id, decision in decision_index.items():
            decision_sha = validate_seal(
                decision, f"precheck decisions[{summary_index}][{sample_id}]"
            )
            if (
                decision.get("schema_version") != PRECHECK_DECISION_SCHEMA
                or decision.get("record_type") != PRECHECK_DECISION_RECORD_TYPE
                or decision.get("review_id") != review_id
                or decision.get("reviewer_id") != reviewer_id
                or decision.get("canonical_split") != "train"
            ):
                raise IntakeError(f"precheck decision[{sample_id}]: identity changed")
            queue_binding = decision.get("queue_binding")
            if not isinstance(queue_binding, Mapping) or (
                queue_binding.get("queue_item_record_sha256")
                != queue_index[sample_id].get("record_sha256")
                or queue_binding.get("queue_file_sha256")
                != bindings.get("queue_file_sha256")
                or queue_binding.get("queue_manifest_record_sha256")
                != bindings.get("queue_manifest_record_sha256")
            ):
                raise IntakeError(
                    f"precheck decision[{sample_id}]: queue binding changed"
                )
            decision_value = decision.get("decision")
            if not isinstance(decision_value, Mapping):
                raise IntakeError(f"precheck decision[{sample_id}]: decision missing")
            status = decision_value.get("status")
            if status not in {"clean", "reject"}:
                raise IntakeError(f"precheck decision[{sample_id}]: status unsupported")
            surface_sha = _reviewed_surface_fingerprint(
                decision, f"precheck decision[{sample_id}]"
            )
            (clean_ids if status == "clean" else reject_ids).add(sample_id)
            evidence[sample_id].append(
                {
                    "review_id": review_id,
                    "reviewer_id": reviewer_id,
                    "decision_record_sha256": decision_sha,
                    "decision_file_sha256": sha256_file(decisions_path),
                    "queue_item_record_sha256": queue_index[sample_id]["record_sha256"],
                    "reviewed_source_surfaces_sha256": surface_sha,
                    "eligibility": status,
                }
            )
        declared_clean = set(summary.get("sample_sets", {}).get("clean_sample_ids", []))
        declared_reject = set(
            summary.get("sample_sets", {}).get("reject_sample_ids", [])
        )
        if declared_clean != clean_ids or declared_reject != reject_ids:
            raise IntakeError(
                f"precheck summary[{summary_index}]: summary partition changed"
            )
        summary_bindings.append(
            {
                "summary": file_binding(path),
                "summary_record_sha256": record_sha,
                "decisions": file_binding(decisions_path),
                "queue": file_binding(queue_path),
                "queue_manifest": file_binding(queue_manifest_path),
                "queue_manifest_record_sha256": bindings.get(
                    "queue_manifest_record_sha256"
                ),
                "review_id": review_id,
                "reviewer_id": reviewer_id,
            }
        )
    return evidence, summary_bindings, queue_by_sample


def _load_selected_master(
    path: Path, selected_ids: set[str]
) -> dict[str, Mapping[str, Any]]:
    output: dict[str, Mapping[str, Any]] = {}
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise IntakeError(f"successor master:{line_number}: expected object")
            sample_id = value.get("id")
            if sample_id not in selected_ids:
                continue
            if sample_id in output:
                raise IntakeError(f"successor master: duplicate {sample_id}")
            output[str(sample_id)] = value
    if set(output) != selected_ids:
        raise IntakeError(
            f"successor master lacks selected IDs: {sorted(selected_ids - set(output))[:8]}"
        )
    return output


def _render_candidates(
    render_bank_path: Path, font_catalog_path: Path
) -> tuple[list[str], dict[str, str], str]:
    """Derive the frozen new-seven set from the authoritative 22-family bank.

    The historical seven-family subset is not accepted as authority.  The
    expanded bank and catalog are byte-pinned, then each selected canonical
    face is rebound to its production font asset before assignments exist.
    """

    render_bank_path = render_bank_path.resolve()
    font_catalog_path = font_catalog_path.resolve()
    if sha256_file(render_bank_path) != EXPECTED_EXPANDED_RENDER_BANK_SHA256:
        raise IntakeError("render bank is not the frozen expanded v2 authority")
    if sha256_file(font_catalog_path) != EXPECTED_EXPANDED_FONT_CATALOG_SHA256:
        raise IntakeError("font catalog is not the frozen expanded v2 authority")
    manifest = read_json(render_bank_path)
    catalog = read_json(font_catalog_path)
    candidates = manifest.get("candidates")
    catalog_families = catalog.get("families")
    source_contract = manifest.get("source_contract")
    generation = manifest.get("generation")
    if (
        manifest.get("schema_version") != "font-render-bank-v1"
        or manifest.get("candidate_count") != 42
        or manifest.get("rendered_candidate_count") != 42
        or manifest.get("family_count") != 22
        or not isinstance(candidates, list)
        or len(candidates) != 42
        or not isinstance(source_contract, Mapping)
        or source_contract.get("schema_version") != "font-face-manifest-v1"
        or source_contract.get("manifest_sha256")
        != EXPECTED_EXPANDED_FONT_CATALOG_SHA256
        or not isinstance(generation, Mapping)
        or generation.get("complete_against_production_assets") is not True
        or generation.get("partial") is not False
        or generation.get("limit") is not None
    ):
        raise IntakeError("expanded render bank contract changed")
    if (
        catalog.get("schema_version") != "font-face-manifest-v1"
        or catalog.get("family_count") != 22
        or not isinstance(catalog_families, list)
        or len(catalog_families) != 22
    ):
        raise IntakeError("expanded font catalog contract changed")
    catalog_ids = {
        str(value.get("font_id"))
        for value in catalog_families
        if isinstance(value, Mapping)
    }
    if not set(FRESH_DELTA_CANDIDATES).issubset(catalog_ids):
        raise IntakeError("expanded catalog lacks a frozen new-seven family")

    canonical_by_id: dict[str, Mapping[str, Any]] = {}
    for index, value in enumerate(candidates):
        if not isinstance(value, Mapping):
            raise IntakeError(f"render candidate[{index}]: expected object")
        font_id = value.get("font_id")
        if (
            isinstance(font_id, str)
            and font_id in FRESH_DELTA_CANDIDATES
            and value.get("production_400_normal_canonical") is True
            and value.get("render_weight") == 400
            and value.get("render_style") == "normal"
        ):
            if font_id in canonical_by_id:
                raise IntakeError(f"expanded render bank repeats canonical {font_id}")
            canonical_by_id[font_id] = value
    if set(canonical_by_id) != set(FRESH_DELTA_CANDIDATES):
        raise IntakeError("expanded render bank lacks an exact new-seven canonical set")

    candidate_ids = list(FRESH_DELTA_CANDIDATES)
    id_to_alias: dict[str, str] = {}
    for font_id in candidate_ids:
        value = canonical_by_id[font_id]
        frozen = FRESH_DELTA_CANDIDATES[font_id]
        if (
            value.get("blind_alias") != frozen["blind_alias"]
            or value.get("source_sha256") != frozen["source_sha256"]
        ):
            raise IntakeError(f"expanded render candidate {font_id} identity changed")
        source_file = value.get("source_file")
        if not isinstance(source_file, str):
            raise IntakeError(f"expanded render candidate {font_id} asset missing")
        asset_path = (PROJECT_ROOT / source_file).resolve()
        try:
            asset_path.relative_to(PROJECT_ROOT.resolve())
        except ValueError as error:
            raise IntakeError(
                f"expanded render candidate {font_id} asset escapes project"
            ) from error
        if (
            not asset_path.is_file()
            or sha256_file(asset_path) != frozen["source_sha256"]
        ):
            raise IntakeError(f"expanded render candidate {font_id} asset changed")
        id_to_alias[font_id] = str(frozen["blind_alias"])
    return candidate_ids, id_to_alias, "font-face-manifest-v1"


def build_intake(
    *,
    round_id: str,
    selection_manifest: Path,
    precheck_summaries: Sequence[Path],
    base_inventory: Path,
    base_assignments: Path,
    successor_master_manifest: Path,
    successor_master_report: Path,
    successor_split_map: Path,
    catalog_registry: Path,
    render_bank_manifest: Path,
    font_catalog_manifest: Path,
    output_dir: Path,
    contaminated_sample_ids: Sequence[str] = (),
) -> dict[str, Any]:
    if not round_id:
        raise IntakeError("round_id is required")
    selected_ids, selection_binding = (
        delta._read_successor_authority_selection_manifest(
            selection_manifest.resolve(), round_id=round_id
        )
    )
    selected_ids = set(selected_ids)
    if len(selected_ids) != EXACT_SELECTED_COUNT:
        raise IntakeError("selection must be exact60")

    evidence, precheck_bindings, queue_by_sample = _load_prechecks(precheck_summaries)
    contaminated_ids = set(contaminated_sample_ids)
    if contaminated_ids:
        raise IntakeError(
            "legacy contaminated-sample exclusions are forbidden; rebuild fresh "
            "reviewer-specific redacted packs"
        )
    if len(contaminated_ids) != len(list(contaminated_sample_ids)):
        raise IntakeError("contaminated sample IDs contain duplicates")
    if not contaminated_ids.issubset(evidence):
        raise IntakeError("contaminated sample IDs escape the reviewed queues")
    double_clean: set[str] = set()
    for sample_id, rows in evidence.items():
        clean_rows = [row for row in rows if row["eligibility"] == "clean"]
        reviewer_ids = {str(row["reviewer_id"]) for row in rows}
        if len(rows) == 2 and len(clean_rows) == 2 and len(reviewer_ids) == 2:
            double_clean.add(sample_id)
    double_clean.difference_update(contaminated_ids)
    if len(double_clean) < MIN_DOUBLE_CLEAN_POOL:
        raise IntakeError(
            f"double-clean reserve is {len(double_clean)}, below required {MIN_DOUBLE_CLEAN_POOL}"
        )
    double_clean_work_counts = Counter(
        str(queue_by_sample[sample_id].get("work_id")) for sample_id in double_clean
    )
    double_clean_stratum_counts = Counter(
        str(queue_by_sample[sample_id].get("proposed_stratum"))
        for sample_id in double_clean
    )
    reserve_work_deficits = {
        work_id: max(0, MIN_DOUBLE_CLEAN_PER_WORK - count)
        for work_id, count in sorted(double_clean_work_counts.items())
        if count < MIN_DOUBLE_CLEAN_PER_WORK
    }
    if (
        len(double_clean_work_counts) != EXPECTED_TRAIN_WORK_COUNT
        or reserve_work_deficits
    ):
        raise IntakeError(
            "double-clean reserve violates 15-work/min4 gate: "
            f"works={len(double_clean_work_counts)}, deficits={reserve_work_deficits}"
        )
    reserve_stratum_deficits = {
        stratum: max(0, required - double_clean_stratum_counts.get(stratum, 0))
        for stratum, required in EXACT_STRATUM_COUNTS.items()
        if double_clean_stratum_counts.get(stratum, 0) < required
    }
    if reserve_stratum_deficits:
        raise IntakeError(
            "double-clean reserve cannot supply the exact scored quotas: "
            f"{reserve_stratum_deficits}"
        )
    if not selected_ids.issubset(double_clean):
        raise IntakeError(
            "selection includes a sample without exact two-reviewer clean eligibility: "
            f"{sorted(selected_ids - double_clean)[:8]}"
        )
    if not selected_ids.issubset(queue_by_sample):
        raise IntakeError("selection escapes the sealed precheck queues")

    successor_master_manifest = successor_master_manifest.resolve()
    successor_master_report = successor_master_report.resolve()
    successor_split_map = successor_split_map.resolve()
    catalog_registry = catalog_registry.resolve()
    render_bank_manifest = render_bank_manifest.resolve()
    font_catalog_manifest = font_catalog_manifest.resolve()
    base_inventory = base_inventory.resolve()
    base_assignments = base_assignments.resolve()
    for path in (
        successor_master_manifest,
        successor_master_report,
        successor_split_map,
        catalog_registry,
        render_bank_manifest,
        font_catalog_manifest,
        base_inventory,
        base_assignments,
    ):
        if not path.is_file():
            raise IntakeError(f"missing input: {path}")
    master_sha = sha256_file(successor_master_manifest)
    report = read_json(successor_master_report)
    outputs = report.get("outputs")
    if not isinstance(outputs, Mapping) or (
        outputs.get("master_manifest_sha256") != master_sha
        or outputs.get("split_map_sha256") != sha256_file(successor_split_map)
    ):
        raise IntakeError("successor master report authority changed")
    master_by_id = _load_selected_master(successor_master_manifest, selected_ids)
    work_counts = Counter()
    selected_strata = Counter()
    used_conflict_keys: set[str] = set()
    for sample_id, row in master_by_id.items():
        provenance = row.get("provenance")
        work = row.get("work")
        if (
            row.get("split") != "train"
            or not isinstance(provenance, Mapping)
            or provenance.get("synthetic") is not False
            or provenance.get("qa_overlay") is not False
            or not isinstance(work, Mapping)
            or not isinstance(work.get("id"), str)
        ):
            raise IntakeError(
                f"successor master[{sample_id}] is not real canonical train"
            )
        work_counts[str(work["id"])] += 1
        stratum = str(queue_by_sample[sample_id].get("proposed_stratum"))
        selected_strata[stratum] += 1
        conflict_keys = set(delta._master_calibration_leakage_keys(row))
        overlap = sorted(used_conflict_keys.intersection(conflict_keys))
        if overlap:
            raise IntakeError(
                f"selection repeats a page/visual lineage at {sample_id}: {overlap[:3]}"
            )
        used_conflict_keys.update(conflict_keys)
    if work_counts and max(work_counts.values()) > MAX_SAMPLES_PER_WORK:
        raise IntakeError(
            f"selection exceeds max {MAX_SAMPLES_PER_WORK} samples per work"
        )
    if len(work_counts) != EXPECTED_TRAIN_WORK_COUNT or set(work_counts.values()) != {
        EXPECTED_SELECTED_PER_WORK
    }:
        raise IntakeError(
            "selection must contain exactly 15 works with exactly 4 samples per work: "
            f"observed={dict(sorted(work_counts.items()))}"
        )
    if dict(selected_strata) != EXACT_STRATUM_COUNTS:
        raise IntakeError(
            "selection does not match the frozen scored quota: "
            f"expected={EXACT_STRATUM_COUNTS}, observed={dict(selected_strata)}"
        )

    base_inventory_ids = {
        str(row.get("sample_id")) for row in read_jsonl(base_inventory)
    }
    base_assignment_rows = read_jsonl(base_assignments)
    base_assignment_ids = {
        str(row.get("assignment_id")) for row in base_assignment_rows
    }
    superseded_sample_ids = selected_ids.intersection(base_inventory_ids)
    superseded_assignment_ids = {
        str(row.get("assignment_id"))
        for row in base_assignment_rows
        if str(row.get("sample_id")) in superseded_sample_ids
    }
    # Every scored sample receives a new round-bound public task pair.  A
    # source crop may already exist, but no historical task/answer authority
    # is ever reused by this intake.
    intake_ids = set(selected_ids)
    candidate_ids, id_to_alias, catalog_version = _render_candidates(
        render_bank_manifest, font_catalog_manifest
    )

    assignment_rows: list[dict[str, Any]] = []
    assignments_by_sample: dict[str, dict[str, str]] = defaultdict(dict)
    for review_order, sample_id in enumerate(sorted(intake_ids), 1):
        master = master_by_id[sample_id]
        work_id = str(master["work"]["id"])
        source_page_sha = str(master["page"]["source_page_sha256"])
        for stage in REVIEW_STAGES:
            seed = stable_hash(
                "font-matching-successor-authority-assignment-v5",
                round_id,
                stage,
                sample_id,
            )
            order = card_builder.expected_candidate_order(candidate_ids, seed)
            assignment: dict[str, Any] = {
                "schema_version": 1,
                "record_type": "manga_font_label_assignment",
                "sample_id": sample_id,
                "work_id": work_id,
                "source_page_sha256": source_page_sha,
                "stage": stage,
                "review_order": review_order,
                "priority_rank": 0,
                "catalog_version": catalog_version,
                "candidate_count": 7,
                "candidate_initial_state": "not_reviewed",
                "candidate_order_seed": seed,
                "candidate_order": order,
                "blind_alias_order": [id_to_alias[item] for item in order],
                "blind_first_pass": True,
                "release_state": "ready",
                "font_names_visible": False,
                "model_suggestions_visible": False,
                "prior_tiers_visible": False,
                "split_visible": False,
                "adjudication_if": list(delta.EXPECTED_TRIGGER_NAMES),
                "reviewer_independence": {
                    "required_for_secondary": stage == "secondary",
                    "same_reviewer_as_primary_allowed": (
                        False if stage == "secondary" else None
                    ),
                },
            }
            assignment["assignment_id"] = card_builder.expected_assignment_id(
                assignment
            )
            if assignment["assignment_id"] in base_assignment_ids:
                raise IntakeError(
                    f"successor intake assignment reuses historical ID: "
                    f"{assignment['assignment_id']}"
                )
            card_builder.validate_assignment(
                assignment, f"successor intake {sample_id}/{stage}"
            )
            assignments_by_sample[sample_id][stage] = str(assignment["assignment_id"])
            assignment_rows.append(assignment)
    assignment_rows.sort(
        key=lambda row: (
            0 if row["stage"] == "primary" else 1,
            int(row["review_order"]),
            str(row["assignment_id"]),
        )
    )

    inventory_rows: list[dict[str, Any]] = []
    sample_rows: list[dict[str, Any]] = []
    for sample_id in sorted(intake_ids):
        master = master_by_id[sample_id]
        clean_evidence = sorted(
            (
                {
                    key: row[key]
                    for key in (
                        "review_id",
                        "reviewer_id",
                        "decision_record_sha256",
                        "decision_file_sha256",
                        "queue_item_record_sha256",
                        "reviewed_source_surfaces_sha256",
                    )
                }
                for row in evidence[sample_id]
            ),
            key=lambda row: str(row["reviewer_id"]),
        )
        evidence_sha = sha256_bytes(canonical_json_bytes(clean_evidence))
        inventory_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": INVENTORY_RECORD_TYPE,
                    "sample_id": sample_id,
                    "work_id": master["work"]["id"],
                    "source_page_sha256": master["page"]["source_page_sha256"],
                    "master_manifest_sha256": master_sha,
                    "eligibility_evidence_sha256": evidence_sha,
                    "provenance": {"synthetic": False, "qa_overlay": False},
                    "training_disposition": TRAINING_DISPOSITION,
                }
            )
        )
        sample_rows.append(
            seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": SAMPLE_RECORD_TYPE,
                    "sample_id": sample_id,
                    "work_id": master["work"]["id"],
                    "source_page_sha256": master["page"]["source_page_sha256"],
                    "sample_crop_sha256": master["sample_crop_sha256"],
                    "split": "train",
                    "successor_master_row_sha256": sha256_bytes(
                        canonical_json_bytes(master)
                    ),
                    "source_catalog_id": master["provenance"]["source_catalog_id"],
                    "visual_lineage_conflict_keys": sorted(
                        delta._master_calibration_leakage_keys(master)
                    ),
                    "eligibility_evidence": clean_evidence,
                    "eligibility_evidence_sha256": evidence_sha,
                    "assignment_ids": [
                        assignments_by_sample[sample_id][stage]
                        for stage in REVIEW_STAGES
                    ],
                    "precheck_labels_inherited": False,
                    "baseline_label_fields_present": False,
                    "candidate_score_or_rank_fields_present": False,
                    "source_annotation_state": "not_reviewed",
                    "candidate_judgment_state": "not_reviewed",
                    "training_disposition": TRAINING_DISPOSITION,
                }
            )
        )

    output_payloads = {
        "selected-master.jsonl": jsonl_bytes(
            master_by_id[sample_id] for sample_id in sorted(selected_ids)
        ),
        "inventory.jsonl": jsonl_bytes(inventory_rows),
        "assignments.jsonl": jsonl_bytes(assignment_rows),
        "samples.jsonl": jsonl_bytes(sample_rows),
    }
    output_bindings = {
        name: {
            "file": name,
            "sha256": sha256_bytes(payload),
            "byte_size": len(payload),
        }
        for name, payload in output_payloads.items()
    }
    strata_counts = Counter(
        str(queue_by_sample[sample_id].get("proposed_stratum"))
        for sample_id in selected_ids
    )
    manifest = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": MANIFEST_RECORD_TYPE,
            "owner": OWNER,
            "round_id": round_id,
            "development_only": True,
            "answer_free": True,
            "precheck_labels_inherited": False,
            "precheck_contaminated_sample_count": len(contaminated_ids),
            "precheck_contaminated_sample_ids": sorted(contaminated_ids),
            "precheck_contaminated_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(contaminated_ids))
            ),
            "source_annotation_state": "not_reviewed",
            "candidate_judgment_state": "not_reviewed",
            "eligibility_contract": {
                "candidate_font_pixels_viewed": False,
                "manual_source_view_required": True,
                "metadata_only_forbidden": True,
                "independent_clean_reviewers_per_selected_sample": 2,
                "disagreement_policy": "reject_or_fresh_replacement_only",
                "minimum_double_clean_reserve": MIN_DOUBLE_CLEAN_POOL,
            },
            "selection_manifest": {
                **file_binding(selection_manifest),
                "record_sha256": selection_binding["record_sha256"],
            },
            "selected_sample_count": len(selected_ids),
            "selected_sample_ids": sorted(selected_ids),
            "selected_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(selected_ids))
            ),
            "double_clean_pool_count": len(double_clean),
            "double_clean_pool_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(double_clean))
            ),
            "double_clean_work_counts": dict(sorted(double_clean_work_counts.items())),
            "double_clean_stratum_counts": dict(
                sorted(double_clean_stratum_counts.items())
            ),
            "intake_sample_count": len(intake_ids),
            "intake_sample_ids": sorted(intake_ids),
            "intake_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(intake_ids))
            ),
            "fresh_public_task_sample_count": len(intake_ids),
            "fresh_public_assignment_count": len(assignment_rows),
            "reused_existing_task_sample_count": 0,
            "superseded_existing_task_sample_count": len(superseded_sample_ids),
            "superseded_existing_task_sample_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(superseded_sample_ids))
            ),
            "superseded_existing_assignment_count": len(superseded_assignment_ids),
            "superseded_existing_assignment_ids_sha256": sha256_bytes(
                canonical_json_bytes(sorted(superseded_assignment_ids))
            ),
            "selected_stratum_counts": dict(sorted(strata_counts.items())),
            "selected_work_counts": dict(sorted(work_counts.items())),
            "inputs": {
                "builder_source": file_binding(Path(__file__).resolve()),
                "base_inventory": file_binding(base_inventory),
                "base_assignments": file_binding(base_assignments),
                "successor_master_manifest": file_binding(successor_master_manifest),
                "successor_master_report": file_binding(successor_master_report),
                "successor_split_map": file_binding(successor_split_map),
                "catalog_registry": file_binding(catalog_registry),
                "render_bank_manifest": file_binding(render_bank_manifest),
                "font_catalog_manifest": file_binding(font_catalog_manifest),
                "precheck_reviews": precheck_bindings,
            },
            "outputs": output_bindings,
        }
    )
    payloads = {
        **output_payloads,
        "manifest.json": canonical_json_bytes(manifest, pretty=True),
    }
    _atomic_replace(output_dir, payloads)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round-id", required=True)
    parser.add_argument("--selection-manifest", type=Path, required=True)
    parser.add_argument("--precheck-summary", type=Path, action="append", required=True)
    parser.add_argument("--base-inventory", type=Path, required=True)
    parser.add_argument("--base-assignments", type=Path, required=True)
    parser.add_argument("--successor-master-manifest", type=Path, required=True)
    parser.add_argument("--successor-master-report", type=Path, required=True)
    parser.add_argument("--successor-split-map", type=Path, required=True)
    parser.add_argument("--catalog-registry", type=Path, required=True)
    parser.add_argument("--render-bank-manifest", type=Path, required=True)
    parser.add_argument("--font-catalog-manifest", type=Path, required=True)
    parser.add_argument(
        "--contaminated-sample-id",
        action="append",
        default=[],
        help=(
            "permanently remove a precheck sample whose reviewer saw proposed/"
            "prior metadata; repeat for every contaminated sample"
        ),
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = build_intake(
            round_id=args.round_id,
            selection_manifest=args.selection_manifest,
            precheck_summaries=args.precheck_summary,
            base_inventory=args.base_inventory,
            base_assignments=args.base_assignments,
            successor_master_manifest=args.successor_master_manifest,
            successor_master_report=args.successor_master_report,
            successor_split_map=args.successor_split_map,
            catalog_registry=args.catalog_registry,
            render_bank_manifest=args.render_bank_manifest,
            font_catalog_manifest=args.font_catalog_manifest,
            output_dir=args.output_dir,
            contaminated_sample_ids=args.contaminated_sample_id,
        )
    except (IntakeError, delta.DeltaLedgerError, OSError, ValueError) as error:
        print(f"error: {error}", file=__import__("sys").stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
