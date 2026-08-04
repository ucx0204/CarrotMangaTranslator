#!/usr/bin/env python3
"""Build and seal metadata-redacted source-crop prechecks for calibration v5."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


PACK_SCHEMA = "font-matching-redacted-source-precheck-pack-v5"
PACK_RECORD_TYPE = "font_matching_redacted_source_precheck_pack"
TASK_SCHEMA = "font-matching-redacted-source-precheck-task-v5"
TASK_RECORD_TYPE = "font_matching_redacted_source_precheck_task"
PRIVATE_SCHEMA = "font-matching-redacted-source-precheck-private-v5"
PRIVATE_RECORD_TYPE = "font_matching_redacted_source_precheck_private_authority"
REVIEW_SCHEMA = "font-matching-redacted-source-precheck-review-v5"
REVIEW_RECORD_TYPE = "font_matching_redacted_source_precheck_review"
DECISION_SCHEMA = "font-matching-redacted-source-precheck-decision-v5"
DECISION_RECORD_TYPE = "font_matching_redacted_source_precheck_decision"
QUEUE_SCHEMA = "font-replacement-reservoir-source-queue-v1"
QUEUE_ITEM_RECORD_TYPE = "font_replacement_reservoir_source_queue_item"
OWNER = "carrot-manga-translator/font-matching-redacted-source-precheck-v5"
AXES = (
    "complete_text_object",
    "text_pixels_unclipped",
    "single_target_isolated",
    "editorial_overlay_absent",
)
DEFECT_CODES = (
    "none",
    "clipped_text",
    "partial_text_object",
    "neighboring_text",
    "editorial_overlay",
    "no_text_signal",
    "other",
)
PUBLIC_TASK_KEYS = {
    "schema_version",
    "record_type",
    "pack_id",
    "public_precheck_task_id",
    "review_order",
    "source_surfaces",
    "record_sha256",
}
PUBLIC_SURFACE_KEYS = {
    "kind",
    "path",
    "file_sha256",
    "pixel_sha256",
    "size_px",
}
FORBIDDEN_REVIEWER_KEYS = {
    "work",
    "work_id",
    "work_title",
    "chapter",
    "chapter_id",
    "page",
    "page_id",
    "role",
    "proposed_role",
    "stratum",
    "proposed_stratum",
    "ocr",
    "ocr_hint",
    "ocr_hint_private",
    "title",
    "proposal",
    "selection_priority",
    "priority",
    "font",
    "font_id",
    "font_score",
    "font_rank",
    "label",
    "score",
    "rank",
}


class RedactedPrecheckError(ValueError):
    pass


def canonical_json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    if "record_sha256" in value:
        raise RedactedPrecheckError("record already contains a seal")
    output = copy.deepcopy(dict(value))
    output["record_sha256"] = sha256_bytes(canonical_json_bytes(output))
    return output


def validate_seal(value: Mapping[str, Any], location: str) -> str:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise RedactedPrecheckError(f"{location}: missing record seal")
    core = {key: child for key, child in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json_bytes(core)) != expected:
        raise RedactedPrecheckError(f"{location}: record seal changed")
    return expected


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise RedactedPrecheckError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise RedactedPrecheckError(f"{path}: expected object")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError as error:
        raise RedactedPrecheckError(f"cannot read {path}: {error}") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise RedactedPrecheckError(
                f"{path}:{line_number}: invalid JSON: {error}"
            ) from error
        if not isinstance(value, dict):
            raise RedactedPrecheckError(f"{path}:{line_number}: expected object")
        rows.append(value)
    return rows


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(canonical_json_bytes(row) + b"\n" for row in rows)


def file_binding(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise RedactedPrecheckError(f"missing file: {resolved}")
    return {
        "path": str(resolved),
        "sha256": sha256_file(resolved),
        "byte_size": resolved.stat().st_size,
    }


def _pixel_sha(path: Path) -> tuple[str, list[int]]:
    try:
        with Image.open(path) as source:
            image = source.convert("RGB")
            width, height = image.size
            payload = (
                b"font-matching-rgb8-pixels-v1\0"
                + width.to_bytes(8, "big")
                + height.to_bytes(8, "big")
                + image.tobytes()
            )
    except (OSError, ValueError) as error:
        raise RedactedPrecheckError(f"cannot decode source surface {path}: {error}") from error
    return sha256_bytes(payload), [width, height]


def _assert_no_forbidden_keys(value: Any, location: str) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).casefold()
            if normalized in FORBIDDEN_REVIEWER_KEYS or any(
                token in normalized
                for token in ("ocr", "stratum", "priority", "font_", "work_title")
            ):
                raise RedactedPrecheckError(
                    f"{location}: reviewer-visible forbidden key {key}"
                )
            _assert_no_forbidden_keys(child, f"{location}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_no_forbidden_keys(child, f"{location}[{index}]")


def _validated_master_surfaces(
    master_row: Mapping[str, Any],
    queue_row: Mapping[str, Any],
    catalog_roots: Mapping[str, Path],
    location: str,
) -> list[dict[str, Any]]:
    provenance = master_row.get("provenance")
    page = master_row.get("page")
    views = master_row.get("views")
    if (
        master_row.get("id") != queue_row.get("sample_id")
        or master_row.get("split") != "train"
        or not isinstance(provenance, Mapping)
        or provenance.get("synthetic") is not False
        or provenance.get("qa_overlay") is not False
        or not isinstance(page, Mapping)
        or not isinstance(views, Mapping)
    ):
        raise RedactedPrecheckError(f"{location}: successor master authority changed")
    expected_master_sha = (
        queue_row.get("related_hashes", {})
        if isinstance(queue_row.get("related_hashes"), Mapping)
        else {}
    ).get("successor_master_row_canonical_sha256")
    if expected_master_sha != sha256_bytes(canonical_json_bytes(master_row)):
        raise RedactedPrecheckError(f"{location}: successor master row binding changed")
    source_catalog_id = provenance.get("source_catalog_id")
    if not isinstance(source_catalog_id, str):
        raise RedactedPrecheckError(f"{location}: source catalog identity missing")
    catalog_root = catalog_roots.get(source_catalog_id)
    if catalog_root is None:
        raise RedactedPrecheckError(f"{location}: source catalog is unregistered")
    raw_surfaces: list[tuple[str, Mapping[str, Any], Path]] = []
    for name in ("raw_224", "context_224", "glyph_224"):
        value = views.get(name)
        if not isinstance(value, Mapping):
            raise RedactedPrecheckError(f"{location}: master view {name} missing")
        if name == "raw_224":
            source_native = value.get("source_native")
            if isinstance(source_native, Mapping):
                value = source_native
            public_name = "raw_source"
        else:
            public_name = name
        if not isinstance(value, Mapping) or value.get("status") != "available":
            raise RedactedPrecheckError(f"{location}: master view {name} unavailable")
        relative = value.get("path")
        if not isinstance(relative, str):
            raise RedactedPrecheckError(f"{location}: master view {name} path missing")
        source_path = (catalog_root / relative).resolve()
        try:
            source_path.relative_to(catalog_root)
        except ValueError as error:
            raise RedactedPrecheckError(f"{location}: master view escapes catalog") from error
        raw_surfaces.append((public_name, value, source_path))
    locator = page.get("source_locator")
    if (
        not isinstance(locator, Mapping)
        or locator.get("provenance") != "real_preserved"
        or locator.get("storage_root") != "library_root"
    ):
        raise RedactedPrecheckError(f"{location}: real source-page locator missing")
    page_relative = locator.get("path")
    if not isinstance(page_relative, str):
        raise RedactedPrecheckError(f"{location}: source-page path missing")
    library_root = (PROJECT_ROOT / "library").resolve()
    page_path = (library_root / page_relative).resolve()
    try:
        page_path.relative_to(library_root)
    except ValueError as error:
        raise RedactedPrecheckError(f"{location}: source page escapes library") from error
    raw_surfaces.append(("source_page", locator, page_path))
    output: list[dict[str, Any]] = []
    for name, value, path in raw_surfaces:
        expected_sha = value.get("file_sha256")
        if not isinstance(expected_sha, str):
            raise RedactedPrecheckError(f"{location}.{name}: source binding missing")
        if not path.is_file() or sha256_file(path) != expected_sha:
            raise RedactedPrecheckError(f"{location}.{name}: source bytes changed")
        pixel_sha, actual_size = _pixel_sha(path)
        declared_size = value.get(
            "size_px",
            value.get("declared_size_px", value.get("expected_size_px")),
        )
        if declared_size is not None and declared_size != actual_size:
            raise RedactedPrecheckError(f"{location}.{name}: source size changed")
        output.append(
            {
                "kind": name,
                "source_path": str(path),
                "file_sha256": expected_sha,
                "pixel_sha256": pixel_sha,
                "size_px": actual_size,
            }
        )
    if not output:
        raise RedactedPrecheckError(f"{location}: no source surfaces")
    return output


def _atomic_output(output_root: Path, payloads: Mapping[str, bytes]) -> None:
    output_root = output_root.resolve()
    if output_root.exists() and any(output_root.iterdir()):
        marker = output_root / ".font-matching-redacted-precheck-v5-owned.json"
        if not marker.is_file():
            raise RedactedPrecheckError(f"refusing to replace unowned output: {output_root}")
    output_root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output_root.name}.building-", dir=output_root.parent))
    try:
        for relative, payload in payloads.items():
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        (staging / ".font-matching-redacted-precheck-v5-owned.json").write_bytes(
            canonical_json_bytes({"schema_version": PACK_SCHEMA, "owner": OWNER}, pretty=True)
        )
        if output_root.exists():
            backup = output_root.with_name(output_root.name + ".previous")
            if backup.exists():
                raise RedactedPrecheckError(f"refusing existing backup: {backup}")
            os.replace(output_root, backup)
            try:
                os.replace(staging, output_root)
            except BaseException:
                os.replace(backup, output_root)
                raise
            shutil.rmtree(backup)
        else:
            os.replace(staging, output_root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def build_pack(
    *,
    source_queue_manifest: Path,
    output_root: Path,
    pack_id: str,
    intended_reviewer_id: str,
) -> dict[str, Any]:
    source_queue_manifest = source_queue_manifest.resolve()
    source_manifest = read_json(source_queue_manifest)
    source_manifest_record_sha = validate_seal(source_manifest, "source queue manifest")
    shards = source_manifest.get("shards")
    candidate_count = source_manifest.get("candidate_count")
    if (
        source_manifest.get("schema_version") != QUEUE_SCHEMA
        or source_manifest.get("record_type")
        != "font_replacement_reservoir_source_queue_manifest"
        or not isinstance(candidate_count, int)
        or not 2 <= candidate_count <= 1000
        or not isinstance(shards, Mapping)
        or not shards
        or any(not isinstance(shard, str) or not shard for shard in shards)
    ):
        raise RedactedPrecheckError("source queue manifest contract changed")
    all_rows: list[dict[str, Any]] = []
    private_queue_bindings: list[dict[str, Any]] = []
    for shard in sorted(shards):
        shard_value = shards[shard]
        if not isinstance(shard_value, Mapping):
            raise RedactedPrecheckError(f"source queue shard {shard} changed")
        queue_path = Path(str(shard_value.get("path"))).resolve()
        if not queue_path.is_file() or sha256_file(queue_path) != shard_value.get("sha256"):
            raise RedactedPrecheckError(f"source queue shard {shard} bytes changed")
        rows = read_jsonl(queue_path)
        if shard_value.get("row_count") != len(rows) or not rows:
            raise RedactedPrecheckError(f"source queue shard {shard} coverage changed")
        private_queue_bindings.append(
            {"shard": shard, "queue": file_binding(queue_path), "row_count": len(rows)}
        )
        for row in rows:
            validate_seal(row, f"source queue {shard}")
            if (
                row.get("schema_version") != QUEUE_SCHEMA
                or row.get("record_type") != QUEUE_ITEM_RECORD_TYPE
                or row.get("shard") != shard
                or row.get("canonical_split") != "train"
            ):
                raise RedactedPrecheckError(f"source queue shard {shard} row changed")
            all_rows.append(row)
    sample_ids = [str(row.get("sample_id")) for row in all_rows]
    if len(sample_ids) != candidate_count or len(set(sample_ids)) != candidate_count:
        raise RedactedPrecheckError("source queue sample coverage changed")
    selection_contract = source_manifest.get("selection_contract")
    master_binding = (
        selection_contract.get("authority_master_manifest")
        if isinstance(selection_contract, Mapping)
        else None
    )
    if not isinstance(master_binding, Mapping):
        raise RedactedPrecheckError("source queue master authority missing")
    registry_binding = (
        selection_contract.get("catalog_registry")
        if isinstance(selection_contract, Mapping)
        else None
    )
    if not isinstance(registry_binding, Mapping):
        raise RedactedPrecheckError("source queue catalog registry missing")
    registry_path = Path(str(registry_binding.get("path"))).resolve()
    if (
        not registry_path.is_file()
        or sha256_file(registry_path) != registry_binding.get("sha256")
    ):
        raise RedactedPrecheckError("source queue catalog registry bytes changed")
    registry = read_json(registry_path)
    registry_record_sha = validate_seal(registry, "source queue catalog registry")
    if registry_record_sha != registry_binding.get("record_sha256"):
        raise RedactedPrecheckError("source queue catalog registry record changed")
    catalogs = registry.get("catalogs")
    if not isinstance(catalogs, list):
        raise RedactedPrecheckError("source queue catalog registry changed")
    catalog_roots: dict[str, Path] = {}
    for value in catalogs:
        if not isinstance(value, Mapping):
            raise RedactedPrecheckError("source queue catalog registry row changed")
        catalog_id = value.get("catalog_id")
        root_value = value.get("root")
        if (
            not isinstance(catalog_id, str)
            or not isinstance(root_value, str)
            or catalog_id in catalog_roots
        ):
            raise RedactedPrecheckError("source queue catalog registry identity changed")
        catalog_root = Path(root_value).resolve()
        manifest_path = catalog_root / str(value.get("manifest_name"))
        if (
            not manifest_path.is_file()
            or sha256_file(manifest_path) != value.get("manifest_sha256")
        ):
            raise RedactedPrecheckError(
                f"source catalog {catalog_id} manifest changed"
            )
        catalog_roots[catalog_id] = catalog_root
    master_path = Path(str(master_binding.get("path"))).resolve()
    if (
        not master_path.is_file()
        or sha256_file(master_path) != master_binding.get("sha256")
    ):
        raise RedactedPrecheckError("source queue master authority bytes changed")
    wanted_ids = set(sample_ids)
    master_by_id: dict[str, dict[str, Any]] = {}
    try:
        with master_path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RedactedPrecheckError(
                        f"successor master:{line_number}: invalid JSON"
                    ) from error
                if not isinstance(value, dict):
                    raise RedactedPrecheckError(
                        f"successor master:{line_number}: expected object"
                    )
                sample_id = value.get("id")
                if sample_id not in wanted_ids:
                    continue
                if sample_id in master_by_id:
                    raise RedactedPrecheckError(f"successor master repeats {sample_id}")
                master_by_id[str(sample_id)] = value
    except OSError as error:
        raise RedactedPrecheckError(f"cannot read successor master: {error}") from error
    if set(master_by_id) != wanted_ids:
        raise RedactedPrecheckError("successor master lacks a queued sample")

    # Each reviewer must receive an independently randomized order.  Keeping the
    # nonce only in the sealed private authority makes the shuffle auditable by
    # the intake builder without giving reviewers a cross-pack join key.
    order_nonce = secrets.token_bytes(32)

    def private_order_key(row: Mapping[str, Any]) -> bytes:
        sample_id = str(row["sample_id"])
        return hashlib.sha256(
            order_nonce
            + b"\x00"
            + pack_id.encode("utf-8")
            + b"\x00"
            + sample_id.encode("utf-8")
        ).digest()

    order_keys = [private_order_key(row) for row in all_rows]
    if len(set(order_keys)) != len(order_keys):
        raise RedactedPrecheckError("cryptographic review-order collision")
    ordered_source = sorted(all_rows, key=private_order_key)
    tasks: list[dict[str, Any]] = []
    private_task_bindings: list[dict[str, Any]] = []
    asset_payloads: dict[str, bytes] = {}
    used_task_ids: set[str] = set()
    for review_order, source_row in enumerate(ordered_source, 1):
        sample_id = str(source_row["sample_id"])
        while True:
            public_task_id = "fmrpt-" + secrets.token_hex(16)
            if public_task_id not in used_task_ids:
                used_task_ids.add(public_task_id)
                break
        source_surfaces = _validated_master_surfaces(
            master_by_id[sample_id],
            source_row,
            catalog_roots,
            f"source queue[{sample_id}]",
        )
        public_surfaces: list[dict[str, Any]] = []
        private_surface_bindings: list[dict[str, Any]] = []
        for surface_index, source_surface in enumerate(source_surfaces, 1):
            source_path = Path(str(source_surface["source_path"])).resolve()
            suffix = source_path.suffix.casefold()
            if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                suffix = ".img"
            relative = (
                f"assets/{public_task_id}/{surface_index:02d}-"
                f"{source_surface['kind']}{suffix}"
            )
            asset_payloads[f"reviewer-pack/{relative}"] = source_path.read_bytes()
            public_surfaces.append(
                {
                    "kind": source_surface["kind"],
                    "path": relative,
                    "file_sha256": source_surface["file_sha256"],
                    "pixel_sha256": source_surface["pixel_sha256"],
                    "size_px": source_surface["size_px"],
                }
            )
            private_surface_bindings.append(
                {
                    **source_surface,
                    "reviewer_pack_path": relative,
                }
            )
        task = seal(
            {
                "schema_version": TASK_SCHEMA,
                "record_type": TASK_RECORD_TYPE,
                "pack_id": pack_id,
                "public_precheck_task_id": public_task_id,
                "review_order": review_order,
                "source_surfaces": public_surfaces,
            }
        )
        if set(task) != PUBLIC_TASK_KEYS:
            raise RedactedPrecheckError(f"task[{sample_id}]: public schema changed")
        for surface in task["source_surfaces"]:
            if set(surface) != PUBLIC_SURFACE_KEYS:
                raise RedactedPrecheckError(f"task[{sample_id}]: surface schema changed")
        _assert_no_forbidden_keys(task, f"task[{sample_id}]")
        tasks.append(task)
        private_task_bindings.append(
            {
                "sample_id": sample_id,
                "public_precheck_task_id": public_task_id,
                "public_task_record_sha256": task["record_sha256"],
                "source_queue_item_record_sha256": source_row["record_sha256"],
                "source_shard": source_row["shard"],
                "source_review_order": source_row["review_order"],
                "source_surfaces": private_surface_bindings,
            }
        )
    tasks_payload = jsonl_bytes(tasks)
    response_template = jsonl_bytes(
        {
            "public_precheck_task_id": task["public_precheck_task_id"],
            "review_order": task["review_order"],
            "eligibility_axes": {axis: None for axis in AXES},
            "defect_code": None,
        }
        for task in tasks
    )
    private = seal(
        {
            "schema_version": PRIVATE_SCHEMA,
            "record_type": PRIVATE_RECORD_TYPE,
            "owner": OWNER,
            "pack_id": pack_id,
            "intended_reviewer_id": intended_reviewer_id,
            "source_queue_manifest": {
                **file_binding(source_queue_manifest),
                "record_sha256": source_manifest_record_sha,
            },
            "source_queue_files": private_queue_bindings,
            "successor_master_manifest": file_binding(master_path),
            "catalog_registry": {
                **file_binding(registry_path),
                "record_sha256": registry_record_sha,
            },
            "private_review_order": {
                "method": "sha256_private_nonce_pack_id_sample_id_sort_v1",
                "nonce_hex": order_nonce.hex(),
                "ordered_sample_ids_sha256": sha256_bytes(
                    canonical_json_bytes(
                        [str(row["sample_id"]) for row in ordered_source]
                    )
                ),
            },
            "task_bindings": private_task_bindings,
            "task_count": len(tasks),
        }
    )
    private_payload = canonical_json_bytes(private, pretty=True)
    manifest = seal(
        {
            "schema_version": PACK_SCHEMA,
            "record_type": PACK_RECORD_TYPE,
            "owner": OWNER,
            "pack_id": pack_id,
            "intended_reviewer_id": intended_reviewer_id,
            "development_only": True,
            "task_count": len(tasks),
            "review_order_contract": f"exact_1_through_{len(tasks)}",
            "cross_reviewer_order_contract": (
                "independent_cryptographic_shuffle_private_authority_sealed"
            ),
            "source_surface_authority": (
                "successor_master_raw_context_glyph_and_real_page_only"
            ),
            "reviewer_visible_fields": [
                "public_precheck_task_id",
                "review_order",
                "source_surfaces.kind",
                "source_surfaces.path",
                "source_surfaces.file_sha256",
                "source_surfaces.pixel_sha256",
                "source_surfaces.size_px",
            ],
            "private_authority_record_sha256": private["record_sha256"],
            "private_authority_file_sha256": sha256_bytes(private_payload),
            "outputs": {
                "tasks.jsonl": {
                    "file": "tasks.jsonl",
                    "sha256": sha256_bytes(tasks_payload),
                    "byte_size": len(tasks_payload),
                },
                "response-template.jsonl": {
                    "file": "response-template.jsonl",
                    "sha256": sha256_bytes(response_template),
                    "byte_size": len(response_template),
                },
            },
        }
    )
    _atomic_output(
        output_root,
        {
            **asset_payloads,
            "private-authority.json": private_payload,
            "reviewer-pack/tasks.jsonl": tasks_payload,
            "reviewer-pack/response-template.jsonl": response_template,
            "reviewer-pack/manifest.json": canonical_json_bytes(manifest, pretty=True),
        },
    )
    return manifest


def load_pack(manifest_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest_path = manifest_path.resolve()
    manifest = read_json(manifest_path)
    validate_seal(manifest, "redacted pack manifest")
    task_count = manifest.get("task_count")
    if (
        manifest.get("schema_version") != PACK_SCHEMA
        or manifest.get("record_type") != PACK_RECORD_TYPE
        or manifest.get("owner") != OWNER
        or manifest.get("development_only") is not True
        or not isinstance(task_count, int)
        or not 2 <= task_count <= 1000
        or manifest.get("review_order_contract")
        != f"exact_1_through_{task_count}"
        or manifest.get("cross_reviewer_order_contract")
        != "independent_cryptographic_shuffle_private_authority_sealed"
        or not isinstance(manifest.get("intended_reviewer_id"), str)
    ):
        raise RedactedPrecheckError("redacted pack manifest contract changed")
    outputs = manifest.get("outputs")
    if not isinstance(outputs, Mapping) or set(outputs) != {
        "tasks.jsonl",
        "response-template.jsonl",
    }:
        raise RedactedPrecheckError("redacted pack outputs changed")
    task_binding = outputs["tasks.jsonl"]
    if not isinstance(task_binding, Mapping):
        raise RedactedPrecheckError("redacted task binding changed")
    task_path = (manifest_path.parent / str(task_binding.get("file"))).resolve()
    try:
        task_path.relative_to(manifest_path.parent.resolve())
    except ValueError as error:
        raise RedactedPrecheckError("redacted task path escapes pack") from error
    if (
        not task_path.is_file()
        or task_path.stat().st_size != task_binding.get("byte_size")
        or sha256_file(task_path) != task_binding.get("sha256")
    ):
        raise RedactedPrecheckError("redacted task file changed")
    tasks = read_jsonl(task_path)
    if len(tasks) != task_count:
        raise RedactedPrecheckError("redacted task coverage changed")
    seen: set[str] = set()
    for index, task in enumerate(tasks, 1):
        validate_seal(task, f"redacted task[{index}]")
        if (
            set(task) != PUBLIC_TASK_KEYS
            or task.get("schema_version") != TASK_SCHEMA
            or task.get("record_type") != TASK_RECORD_TYPE
            or task.get("pack_id") != manifest.get("pack_id")
            or task.get("review_order") != index
            or not isinstance(task.get("public_precheck_task_id"), str)
            or task["public_precheck_task_id"] in seen
        ):
            raise RedactedPrecheckError(f"redacted task[{index}] contract changed")
        seen.add(task["public_precheck_task_id"])
        surfaces = task.get("source_surfaces")
        if (
            not isinstance(surfaces, list)
            or {surface.get("kind") for surface in surfaces if isinstance(surface, Mapping)}
            != {"raw_source", "context_224", "glyph_224", "source_page"}
            or len(surfaces) != 4
        ):
            raise RedactedPrecheckError(f"redacted task[{index}] surfaces missing")
        for surface in surfaces:
            if not isinstance(surface, Mapping) or set(surface) != PUBLIC_SURFACE_KEYS:
                raise RedactedPrecheckError(f"redacted task[{index}] surface changed")
            path = (manifest_path.parent / str(surface.get("path"))).resolve()
            try:
                path.relative_to(manifest_path.parent.resolve())
            except ValueError as error:
                raise RedactedPrecheckError(
                    f"redacted task[{index}] surface path escapes pack"
                ) from error
            if not path.is_file() or sha256_file(path) != surface.get("file_sha256"):
                raise RedactedPrecheckError(f"redacted task[{index}] surface bytes changed")
            pixel_sha, size = _pixel_sha(path)
            if pixel_sha != surface.get("pixel_sha256") or size != surface.get("size_px"):
                raise RedactedPrecheckError(f"redacted task[{index}] surface pixels changed")
        _assert_no_forbidden_keys(task, f"redacted task[{index}]")
    return manifest, tasks


def load_private_authority(
    pack_manifest_path: Path,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    pack_manifest_path = pack_manifest_path.resolve()
    pack_manifest, tasks = load_pack(pack_manifest_path)
    private_path = pack_manifest_path.parent.parent / "private-authority.json"
    private = read_json(private_path)
    validate_seal(private, "redacted private authority")
    if (
        private.get("schema_version") != PRIVATE_SCHEMA
        or private.get("record_type") != PRIVATE_RECORD_TYPE
        or private.get("owner") != OWNER
        or private.get("pack_id") != pack_manifest.get("pack_id")
        or private.get("intended_reviewer_id")
        != pack_manifest.get("intended_reviewer_id")
        or private.get("task_count") != pack_manifest.get("task_count")
        or private.get("record_sha256")
        != pack_manifest.get("private_authority_record_sha256")
        or sha256_file(private_path)
        != pack_manifest.get("private_authority_file_sha256")
    ):
        raise RedactedPrecheckError("redacted private authority changed")
    source_manifest_binding = private.get("source_queue_manifest")
    if not isinstance(source_manifest_binding, Mapping):
        raise RedactedPrecheckError("private source queue manifest binding missing")
    source_manifest_path = Path(str(source_manifest_binding.get("path"))).resolve()
    if (
        not source_manifest_path.is_file()
        or sha256_file(source_manifest_path) != source_manifest_binding.get("sha256")
        or source_manifest_path.stat().st_size
        != source_manifest_binding.get("byte_size")
    ):
        raise RedactedPrecheckError("private source queue manifest bytes changed")
    source_manifest = read_json(source_manifest_path)
    if (
        validate_seal(source_manifest, "private source queue manifest")
        != source_manifest_binding.get("record_sha256")
    ):
        raise RedactedPrecheckError("private source queue manifest record changed")
    master_binding = private.get("successor_master_manifest")
    if not isinstance(master_binding, Mapping):
        raise RedactedPrecheckError("private successor master binding missing")
    master_path = Path(str(master_binding.get("path"))).resolve()
    if (
        not master_path.is_file()
        or sha256_file(master_path) != master_binding.get("sha256")
        or master_path.stat().st_size != master_binding.get("byte_size")
    ):
        raise RedactedPrecheckError("private successor master bytes changed")
    registry_binding = private.get("catalog_registry")
    if not isinstance(registry_binding, Mapping):
        raise RedactedPrecheckError("private catalog registry binding missing")
    registry_path = Path(str(registry_binding.get("path"))).resolve()
    if (
        not registry_path.is_file()
        or sha256_file(registry_path) != registry_binding.get("sha256")
        or registry_path.stat().st_size != registry_binding.get("byte_size")
    ):
        raise RedactedPrecheckError("private catalog registry bytes changed")
    if (
        validate_seal(read_json(registry_path), "private catalog registry")
        != registry_binding.get("record_sha256")
    ):
        raise RedactedPrecheckError("private catalog registry record changed")
    queue_bindings = private.get("source_queue_files")
    task_bindings = private.get("task_bindings")
    if not isinstance(queue_bindings, list) or not isinstance(task_bindings, list):
        raise RedactedPrecheckError("private source bindings missing")
    queue_by_sample: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(queue_bindings):
        if not isinstance(value, Mapping) or set(value) != {"shard", "queue", "row_count"}:
            raise RedactedPrecheckError(f"private queue binding[{index}] changed")
        binding = value.get("queue")
        if not isinstance(binding, Mapping):
            raise RedactedPrecheckError(f"private queue binding[{index}] missing")
        queue_path = Path(str(binding.get("path"))).resolve()
        if (
            not queue_path.is_file()
            or sha256_file(queue_path) != binding.get("sha256")
            or queue_path.stat().st_size != binding.get("byte_size")
        ):
            raise RedactedPrecheckError(f"private queue[{index}] bytes changed")
        rows = read_jsonl(queue_path)
        if value.get("row_count") != len(rows):
            raise RedactedPrecheckError(f"private queue[{index}] coverage changed")
        for row in rows:
            validate_seal(row, f"private queue[{index}]")
            sample_id = row.get("sample_id")
            if not isinstance(sample_id, str) or sample_id in queue_by_sample:
                raise RedactedPrecheckError("private queue sample identity changed")
            queue_by_sample[sample_id] = row
    task_by_public_id = {
        str(task["public_precheck_task_id"]): task for task in tasks
    }
    private_order = private.get("private_review_order")
    if not isinstance(private_order, Mapping) or set(private_order) != {
        "method",
        "nonce_hex",
        "ordered_sample_ids_sha256",
    }:
        raise RedactedPrecheckError("private review-order authority changed")
    if (
        private_order.get("method")
        != "sha256_private_nonce_pack_id_sample_id_sort_v1"
    ):
        raise RedactedPrecheckError("private review-order method changed")
    try:
        order_nonce = bytes.fromhex(str(private_order.get("nonce_hex")))
    except ValueError as error:
        raise RedactedPrecheckError("private review-order nonce changed") from error
    if len(order_nonce) != 32:
        raise RedactedPrecheckError("private review-order nonce changed")
    binding_by_id: dict[str, Mapping[str, Any]] = {}
    public_ids: set[str] = set()
    for value in task_bindings:
        if not isinstance(value, Mapping):
            raise RedactedPrecheckError("private task binding changed")
        sample_id = value.get("sample_id")
        if not isinstance(sample_id, str) or sample_id in binding_by_id:
            raise RedactedPrecheckError("private task identity changed")
        public_id = value.get("public_precheck_task_id")
        if not isinstance(public_id, str) or public_id in public_ids:
            raise RedactedPrecheckError("private public-task identity changed")
        public_ids.add(public_id)
        binding_by_id[sample_id] = value
    if (
        public_ids != set(task_by_public_id)
        or set(queue_by_sample) != set(binding_by_id)
    ):
        raise RedactedPrecheckError("private/public task coverage changed")
    binding_public_order = [
        str(value["public_precheck_task_id"]) for value in task_bindings
    ]
    task_public_order = [
        str(task["public_precheck_task_id"]) for task in tasks
    ]
    if binding_public_order != task_public_order:
        raise RedactedPrecheckError("private/public review order changed")
    expected_sample_order = sorted(
        queue_by_sample,
        key=lambda sample_id: hashlib.sha256(
            order_nonce
            + b"\x00"
            + str(private["pack_id"]).encode("utf-8")
            + b"\x00"
            + sample_id.encode("utf-8")
        ).digest(),
    )
    actual_sample_order = [str(value["sample_id"]) for value in task_bindings]
    if (
        actual_sample_order != expected_sample_order
        or sha256_bytes(canonical_json_bytes(actual_sample_order))
        != private_order.get("ordered_sample_ids_sha256")
    ):
        raise RedactedPrecheckError("private cryptographic review order changed")
    for sample_id, value in binding_by_id.items():
        public_id = str(value["public_precheck_task_id"])
        source_surfaces = value.get("source_surfaces")
        public_surfaces = task_by_public_id[public_id].get("source_surfaces")
        if (
            not isinstance(source_surfaces, list)
            or not isinstance(public_surfaces, list)
            or len(source_surfaces) != 4
            or len(public_surfaces) != 4
        ):
            raise RedactedPrecheckError(
                f"private task[{sample_id}] surface binding changed"
            )
        for source_surface, public_surface in zip(
            source_surfaces, public_surfaces
        ):
            if not isinstance(source_surface, Mapping) or not isinstance(
                public_surface, Mapping
            ):
                raise RedactedPrecheckError(
                    f"private task[{sample_id}] surface record changed"
                )
            source_path = Path(str(source_surface.get("source_path"))).resolve()
            if (
                not source_path.is_file()
                or sha256_file(source_path)
                != source_surface.get("file_sha256")
                or source_surface.get("reviewer_pack_path")
                != public_surface.get("path")
                or source_surface.get("kind") != public_surface.get("kind")
                or source_surface.get("file_sha256")
                != public_surface.get("file_sha256")
                or source_surface.get("pixel_sha256")
                != public_surface.get("pixel_sha256")
                or source_surface.get("size_px") != public_surface.get("size_px")
            ):
                raise RedactedPrecheckError(
                    f"private task[{sample_id}] source surface changed"
                )
        if (
            value.get("public_task_record_sha256")
            != task_by_public_id[public_id].get("record_sha256")
            or value.get("source_queue_item_record_sha256")
            != queue_by_sample[sample_id].get("record_sha256")
            or value.get("source_shard") != queue_by_sample[sample_id].get("shard")
            or value.get("source_review_order")
            != queue_by_sample[sample_id].get("review_order")
        ):
            raise RedactedPrecheckError(f"private task[{sample_id}] binding changed")
    return private, queue_by_sample


def load_review_summary(
    summary_path: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    summary_path = summary_path.resolve()
    summary = read_json(summary_path)
    validate_seal(summary, "redacted review summary")
    expected_summary_keys = {
        "schema_version",
        "record_type",
        "owner",
        "pack_id",
        "reviewer_id",
        "development_only",
        "review_contract",
        "pack_manifest",
        "task_count",
        "clean_count",
        "reject_count",
        "decisions",
        "record_sha256",
    }
    if (
        set(summary) != expected_summary_keys
        or summary.get("schema_version") != REVIEW_SCHEMA
        or summary.get("record_type") != REVIEW_RECORD_TYPE
        or summary.get("owner") != OWNER
        or summary.get("development_only") is not True
        or not isinstance(summary.get("reviewer_id"), str)
    ):
        raise RedactedPrecheckError("redacted review summary contract changed")
    expected_contract = {
        "visual_source_only": True,
        "candidate_font_pixels_viewed": False,
        "prior_answers_viewed": False,
        "proposed_role_or_stratum_viewed": False,
        "work_chapter_page_title_viewed": False,
        "other_reviewer_results_viewed": False,
        "role_inference_recorded": False,
        "eligibility_axes": list(AXES),
    }
    if summary.get("review_contract") != expected_contract:
        raise RedactedPrecheckError("redacted review blindness contract changed")
    pack_binding = summary.get("pack_manifest")
    if not isinstance(pack_binding, Mapping):
        raise RedactedPrecheckError("redacted review pack binding missing")
    pack_path = Path(str(pack_binding.get("path"))).resolve()
    if (
        not pack_path.is_file()
        or sha256_file(pack_path) != pack_binding.get("sha256")
        or pack_path.stat().st_size != pack_binding.get("byte_size")
    ):
        raise RedactedPrecheckError("redacted review pack bytes changed")
    pack, tasks = load_pack(pack_path)
    if (
        pack.get("record_sha256") != pack_binding.get("record_sha256")
        or pack.get("pack_id") != summary.get("pack_id")
        or pack.get("intended_reviewer_id") != summary.get("reviewer_id")
    ):
        raise RedactedPrecheckError("redacted review pack record changed")
    decision_binding = summary.get("decisions")
    if not isinstance(decision_binding, Mapping) or set(decision_binding) != {
        "file",
        "sha256",
        "byte_size",
    }:
        raise RedactedPrecheckError("redacted review decision binding changed")
    decision_path = (summary_path.parent / str(decision_binding["file"])).resolve()
    try:
        decision_path.relative_to(summary_path.parent.resolve())
    except ValueError as error:
        raise RedactedPrecheckError("redacted decision path escapes review") from error
    if (
        not decision_path.is_file()
        or sha256_file(decision_path) != decision_binding.get("sha256")
        or decision_path.stat().st_size != decision_binding.get("byte_size")
    ):
        raise RedactedPrecheckError("redacted review decisions changed")
    decisions = read_jsonl(decision_path)
    task_count = len(tasks)
    if len(decisions) != task_count or summary.get("task_count") != task_count:
        raise RedactedPrecheckError("redacted review coverage changed")
    task_by_id = {
        str(task["public_precheck_task_id"]): task for task in tasks
    }
    clean_count = 0
    seen: set[str] = set()
    expected_decision_keys = {
        "schema_version",
        "record_type",
        "pack_id",
        "public_precheck_task_id",
        "review_order",
        "task_record_sha256",
        "reviewer_id",
        "eligibility_axes",
        "eligibility",
        "defect_code",
        "reviewed_source_surfaces_sha256",
        "record_sha256",
    }
    for index, decision in enumerate(decisions, 1):
        validate_seal(decision, f"redacted decision[{index}]")
        public_task_id = decision.get("public_precheck_task_id")
        if (
            set(decision) != expected_decision_keys
            or decision.get("schema_version") != DECISION_SCHEMA
            or decision.get("record_type") != DECISION_RECORD_TYPE
            or decision.get("pack_id") != pack.get("pack_id")
            or decision.get("reviewer_id") != summary.get("reviewer_id")
            or not isinstance(public_task_id, str)
            or public_task_id in seen
            or public_task_id not in task_by_id
        ):
            raise RedactedPrecheckError(f"redacted decision[{index}] identity changed")
        seen.add(public_task_id)
        task = task_by_id[public_task_id]
        axes = decision.get("eligibility_axes")
        clean = decision.get("eligibility") == "clean"
        if (
            decision.get("review_order") != task.get("review_order")
            or decision.get("task_record_sha256") != task.get("record_sha256")
            or not isinstance(axes, Mapping)
            or set(axes) != set(AXES)
            or any(not isinstance(axes[axis], bool) for axis in AXES)
            or decision.get("eligibility") not in {"clean", "reject"}
            or clean != all(bool(axes[axis]) for axis in AXES)
            or decision.get("defect_code") not in DEFECT_CODES
            or clean != (decision.get("defect_code") == "none")
        ):
            raise RedactedPrecheckError(
                f"redacted decision[{public_task_id}] judgment changed"
            )
        surface_sha = sha256_bytes(
            canonical_json_bytes(
                [
                    {
                        "kind": value["kind"],
                        "file_sha256": value["file_sha256"],
                        "pixel_sha256": value["pixel_sha256"],
                        "size_px": value["size_px"],
                    }
                    for value in task["source_surfaces"]
                ]
            )
        )
        if decision.get("reviewed_source_surfaces_sha256") != surface_sha:
            raise RedactedPrecheckError(
                f"redacted decision[{public_task_id}] surface changed"
            )
        if clean:
            clean_count += 1
        _assert_no_forbidden_keys(
            decision, f"redacted decision[{public_task_id}]"
        )
    if set(task_by_id) != seen or (
        summary.get("clean_count") != clean_count
        or summary.get("reject_count") != task_count - clean_count
    ):
        raise RedactedPrecheckError("redacted review partition changed")
    return summary, decisions, pack, tasks


def seal_review(
    *,
    pack_manifest: Path,
    responses_path: Path,
    reviewer_id: str,
    output_root: Path,
) -> dict[str, Any]:
    pack_manifest_value, tasks = load_pack(pack_manifest)
    if reviewer_id != pack_manifest_value.get("intended_reviewer_id"):
        raise RedactedPrecheckError("reviewer does not own this redacted pack")
    responses = read_jsonl(responses_path.resolve())
    if len(responses) != len(tasks):
        raise RedactedPrecheckError("review response coverage changed")
    response_by_id: dict[str, Mapping[str, Any]] = {}
    for index, response in enumerate(responses, 1):
        if set(response) != {
            "public_precheck_task_id",
            "review_order",
            "eligibility_axes",
            "defect_code",
        }:
            raise RedactedPrecheckError(f"response[{index}] contains forbidden fields")
        public_task_id = response.get("public_precheck_task_id")
        if not isinstance(public_task_id, str) or public_task_id in response_by_id:
            raise RedactedPrecheckError(f"response[{index}] identity changed")
        response_by_id[public_task_id] = response
    task_ids = {str(task["public_precheck_task_id"]) for task in tasks}
    if set(response_by_id) != task_ids:
        raise RedactedPrecheckError("review response sample coverage changed")
    decisions: list[dict[str, Any]] = []
    clean_count = 0
    for task in tasks:
        public_task_id = str(task["public_precheck_task_id"])
        response = response_by_id[public_task_id]
        axes = response.get("eligibility_axes")
        if (
            response.get("review_order") != task.get("review_order")
            or not isinstance(axes, Mapping)
            or set(axes) != set(AXES)
            or any(not isinstance(axes[axis], bool) for axis in AXES)
            or response.get("defect_code") not in DEFECT_CODES
        ):
            raise RedactedPrecheckError(f"response[{public_task_id}] judgment changed")
        clean = all(bool(axes[axis]) for axis in AXES)
        if clean != (response.get("defect_code") == "none"):
            raise RedactedPrecheckError(f"response[{public_task_id}] defect semantics changed")
        if clean:
            clean_count += 1
        surface_sha = sha256_bytes(
            canonical_json_bytes(
                [
                    {
                        "kind": value["kind"],
                        "file_sha256": value["file_sha256"],
                        "pixel_sha256": value["pixel_sha256"],
                        "size_px": value["size_px"],
                    }
                    for value in task["source_surfaces"]
                ]
            )
        )
        decisions.append(
            seal(
                {
                    "schema_version": DECISION_SCHEMA,
                    "record_type": DECISION_RECORD_TYPE,
                    "pack_id": task["pack_id"],
                    "public_precheck_task_id": public_task_id,
                    "review_order": task["review_order"],
                    "task_record_sha256": task["record_sha256"],
                    "reviewer_id": reviewer_id,
                    "eligibility_axes": dict(axes),
                    "eligibility": "clean" if clean else "reject",
                    "defect_code": response["defect_code"],
                    "reviewed_source_surfaces_sha256": surface_sha,
                }
            )
        )
    decision_payload = jsonl_bytes(decisions)
    summary = seal(
        {
            "schema_version": REVIEW_SCHEMA,
            "record_type": REVIEW_RECORD_TYPE,
            "owner": OWNER,
            "pack_id": pack_manifest_value["pack_id"],
            "reviewer_id": reviewer_id,
            "development_only": True,
            "review_contract": {
                "visual_source_only": True,
                "candidate_font_pixels_viewed": False,
                "prior_answers_viewed": False,
                "proposed_role_or_stratum_viewed": False,
                "work_chapter_page_title_viewed": False,
                "other_reviewer_results_viewed": False,
                "role_inference_recorded": False,
                "eligibility_axes": list(AXES),
            },
            "pack_manifest": {
                **file_binding(pack_manifest.resolve()),
                "record_sha256": pack_manifest_value["record_sha256"],
            },
            "task_count": len(tasks),
            "clean_count": clean_count,
            "reject_count": len(tasks) - clean_count,
            "decisions": {
                "file": "decisions.jsonl",
                "sha256": sha256_bytes(decision_payload),
                "byte_size": len(decision_payload),
            },
        }
    )
    _atomic_output(
        output_root,
        {
            "decisions.jsonl": decision_payload,
            "summary.json": canonical_json_bytes(summary, pretty=True),
        },
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    pack = subparsers.add_parser("build-pack")
    pack.add_argument("--source-queue-manifest", type=Path, required=True)
    pack.add_argument("--output-root", type=Path, required=True)
    pack.add_argument("--pack-id", required=True)
    pack.add_argument("--intended-reviewer-id", required=True)
    review = subparsers.add_parser("seal-review")
    review.add_argument("--pack-manifest", type=Path, required=True)
    review.add_argument("--responses", type=Path, required=True)
    review.add_argument("--reviewer-id", required=True)
    review.add_argument("--output-root", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build-pack":
            result = build_pack(
                source_queue_manifest=args.source_queue_manifest,
                output_root=args.output_root,
                pack_id=args.pack_id,
                intended_reviewer_id=args.intended_reviewer_id,
            )
        else:
            result = seal_review(
                pack_manifest=args.pack_manifest,
                responses_path=args.responses,
                reviewer_id=args.reviewer_id,
                output_root=args.output_root,
            )
    except (RedactedPrecheckError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
