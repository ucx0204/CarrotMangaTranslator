#!/usr/bin/env python3
"""Freeze the existing 15-font production vocabulary for a pragmatic release.

This is deliberately a narrow bridge, not a replacement for the successor
catalog pipeline.  The CLI accepts only the pinned v1 font-face/render-bank
pair, records the explicit user approval and known limitation in a sealed
authority contract, creates zero-delta v5 source records, and delegates the
actual active-catalog construction and asset validation to
``build_font_matching_runtime_artifact.build_active_catalog``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import build_font_matching_runtime_artifact as runtime


AUTHORITY_FILE = "pragmatic-release-authority.json"
DISPOSITION_FILE = "catalog-disposition.json"
FINAL_CATALOG_FILE = "final-catalog.json"
ACTIVE_CATALOG_FILE = runtime.ACTIVE_CATALOG_FILE

AUTHORITY_SCHEMA = "font-matching-user-approved-pragmatic-release-v1"
AUTHORITY_RECORD_TYPE = "font_matching_user_approved_pragmatic_release"
RELEASE_KIND = "legacy15_prior_only_pragmatic_release"
CATALOG_VERSION = "fontclip-font-catalog-v1-legacy15-pragmatic"

PINNED_FONT_FACE_MANIFEST_SHA256 = (
    "a290e1f525ff7e26024da96f60a4face6a7fbbf0dd264b5c3c09208432c4f47c"
)
PINNED_RENDER_BANK_MANIFEST_SHA256 = (
    "131181d5ed384655c14c2448b90f90783c5950561e96fe4b91d74041cb371ccf"
)
PINNED_CANDIDATE_IDS = (
    "cafe24-gowoonbam",
    "chosun-gungseo",
    "dohyeon",
    "gaegu",
    "griun-pol-sensibility",
    "jua",
    "mongtori",
    "nanum-barun-gothic",
    "nanum-gothic",
    "nanum-myeongjo",
    "ridi-batang",
    "seoul-hangang",
    "seoul-namsan",
    "seoul-namsan-vertical",
    "start-over",
)
EXPECTED_CANDIDATE_COUNT = 15
APPROVAL_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._:-]{7,127}$")
OUTPUT_FILES = frozenset(
    {
        AUTHORITY_FILE,
        DISPOSITION_FILE,
        FINAL_CATALOG_FILE,
        ACTIVE_CATALOG_FILE,
    }
)


class Legacy15FreezeError(RuntimeError):
    """Raised when the pragmatic legacy-catalog contract is not satisfied."""


def _read_json(path: Path, *, location: str) -> Mapping[str, Any]:
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_file():
        raise Legacy15FreezeError(f"{location} must be a regular file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Legacy15FreezeError(f"{location} is not valid UTF-8 JSON") from error
    if not isinstance(value, Mapping):
        raise Legacy15FreezeError(f"{location} must be a JSON object")
    return value


def _write_record(path: Path, record: Mapping[str, Any]) -> None:
    path.write_bytes(runtime.json_bytes(record, pretty=True))


def _candidate_ids(font_manifest: Mapping[str, Any]) -> tuple[str, ...]:
    if font_manifest.get("schema_version") != "font-face-manifest-v1":
        raise Legacy15FreezeError("font face manifest schema is unsupported")
    raw_families = font_manifest.get("families")
    if not isinstance(raw_families, list):
        raise Legacy15FreezeError("font face manifest families are missing")
    ids: list[str] = []
    for index, raw_family in enumerate(raw_families):
        if not isinstance(raw_family, Mapping):
            raise Legacy15FreezeError(f"font face family[{index}] is invalid")
        candidate_id = raw_family.get("font_id")
        if not isinstance(candidate_id, str) or not candidate_id.strip():
            raise Legacy15FreezeError(f"font face family[{index}] has no font_id")
        ids.append(candidate_id.strip())
    if (
        len(ids) != EXPECTED_CANDIDATE_COUNT
        or font_manifest.get("family_count") != EXPECTED_CANDIDATE_COUNT
        or len(set(ids)) != EXPECTED_CANDIDATE_COUNT
    ):
        raise Legacy15FreezeError("legacy catalog must contain exactly 15 families")
    normalized = tuple(sorted(ids))
    if normalized != PINNED_CANDIDATE_IDS:
        raise Legacy15FreezeError("legacy catalog candidate roster drifted")
    return normalized


def _validate_pinned_inputs(
    *,
    font_face_manifest_path: Path,
    render_bank_manifest_path: Path,
    asset_root: Path,
) -> tuple[tuple[str, ...], str, str]:
    font_manifest = _read_json(
        font_face_manifest_path, location="font face manifest"
    )
    render_manifest = _read_json(
        render_bank_manifest_path, location="render bank manifest"
    )
    font_sha = runtime.sha256_file(font_face_manifest_path.resolve())
    render_sha = runtime.sha256_file(render_bank_manifest_path.resolve())
    if font_sha != PINNED_FONT_FACE_MANIFEST_SHA256:
        raise Legacy15FreezeError("pinned v1 font face manifest hash drifted")
    if render_sha != PINNED_RENDER_BANK_MANIFEST_SHA256:
        raise Legacy15FreezeError("pinned v1 render bank manifest hash drifted")

    candidate_ids = _candidate_ids(font_manifest)
    try:
        runtime._font_face_inventory(
            font_manifest,
            asset_root=asset_root.resolve(),
            expected_candidate_ids=candidate_ids,
        )
        runtime._validate_deployment_render_bank(
            render_manifest,
            manifest_path=render_bank_manifest_path.resolve(),
            font_face_manifest_sha256=font_sha,
            expected_candidate_ids=candidate_ids,
        )
    except runtime.RuntimeArtifactError as error:
        raise Legacy15FreezeError(str(error)) from error
    return candidate_ids, font_sha, render_sha


def _authority_record(
    *,
    approval_id: str,
    candidate_ids: Sequence[str],
    font_manifest_sha256: str,
    render_manifest_sha256: str,
) -> Mapping[str, Any]:
    if not APPROVAL_ID_PATTERN.fullmatch(approval_id):
        raise Legacy15FreezeError(
            "approval id must be 8-128 lowercase identifier characters"
        )
    return runtime.seal_record(
        {
            "authorization": {
                "approval_id": approval_id,
                "approval_source": "explicit_user_instruction",
                "decision": "deploy_legacy15_now_and_defer_successor_catalog",
            },
            "candidate_contract": {
                "candidate_count": EXPECTED_CANDIDATE_COUNT,
                "candidate_ids": list(candidate_ids),
                "candidate_set_sha256": runtime._candidate_set_sha256(candidate_ids),
                "included_delta_candidate_count": 0,
                "prior_candidate_count": EXPECTED_CANDIDATE_COUNT,
                "removed_delta_candidate_count": 0,
            },
            "known_limitations": {
                "successor_catalog_validation_complete": False,
                "successor_catalog_work_deferred": True,
                "temporary_release_bridge": True,
            },
            "locale": "ko",
            "record_type": AUTHORITY_RECORD_TYPE,
            "release_kind": RELEASE_KIND,
            "schema_version": AUTHORITY_SCHEMA,
            "source_records": {
                "font_face_manifest_sha256": font_manifest_sha256,
                "render_bank_manifest_sha256": render_manifest_sha256,
            },
        }
    )


def _source_records(
    *, authority_sha256: str, font_sha256: str, render_sha256: str
) -> Mapping[str, str]:
    return {
        "font_face_manifest_sha256": font_sha256,
        "pragmatic_release_authority_record_sha256": authority_sha256,
        "render_bank_manifest_sha256": render_sha256,
    }


def _disposition_record(
    *, authority_sha256: str, font_sha256: str, render_sha256: str
) -> Mapping[str, Any]:
    return runtime.seal_record(
        {
            "candidate_count": 0,
            "entries": [],
            "final_release_allowed": True,
            "record_type": runtime.CATALOG_DISPOSITION_RECORD_TYPE,
            "release_basis": RELEASE_KIND,
            "release_state": "final_released",
            "schema_version": runtime.CATALOG_DISPOSITION_SCHEMA,
            "source_catalog_sha256": font_sha256,
            "source_records": _source_records(
                authority_sha256=authority_sha256,
                font_sha256=font_sha256,
                render_sha256=render_sha256,
            ),
            "source_render_bank_sha256": render_sha256,
            "workspace_contract_record_sha256": authority_sha256,
        }
    )


def _final_catalog_record(
    *,
    authority_sha256: str,
    disposition_sha256: str,
    candidate_ids: Sequence[str],
    font_sha256: str,
    render_sha256: str,
) -> Mapping[str, Any]:
    return runtime.seal_record(
        {
            "candidate_count": EXPECTED_CANDIDATE_COUNT,
            "candidate_ids": list(candidate_ids),
            "candidate_set_sha256": runtime._candidate_set_sha256(candidate_ids),
            "catalog_disposition_record_sha256": disposition_sha256,
            "catalog_version": CATALOG_VERSION,
            "included_delta_candidate_count": 0,
            "included_delta_candidates": [],
            "prior_candidate_count": EXPECTED_CANDIDATE_COUNT,
            "prior_candidate_ids": list(candidate_ids),
            "record_type": runtime.FINAL_CATALOG_RECORD_TYPE,
            "release_basis": RELEASE_KIND,
            "removed_delta_candidate_count": 0,
            "removed_delta_candidates": [],
            "schema_version": runtime.FINAL_CATALOG_SCHEMA,
            "source_catalog_sha256": font_sha256,
            "source_records": _source_records(
                authority_sha256=authority_sha256,
                font_sha256=font_sha256,
                render_sha256=render_sha256,
            ),
            "workspace_contract_record_sha256": authority_sha256,
        }
    )


def _validate_staged_bundle(
    *, staging: Path, authority_sha256: str, candidate_ids: Sequence[str]
) -> Mapping[str, Any]:
    authority = _read_json(staging / AUTHORITY_FILE, location="staged authority")
    disposition = _read_json(
        staging / DISPOSITION_FILE, location="staged disposition"
    )
    final_catalog = _read_json(
        staging / FINAL_CATALOG_FILE, location="staged final catalog"
    )
    for location, record in (
        ("staged authority", authority),
        ("staged disposition", disposition),
        ("staged final catalog", final_catalog),
    ):
        runtime.validate_record_seal(record, location=location)
    if (
        authority.get("schema_version") != AUTHORITY_SCHEMA
        or authority.get("record_type") != AUTHORITY_RECORD_TYPE
        or authority.get("record_sha256") != authority_sha256
    ):
        raise Legacy15FreezeError("pragmatic release authority drifted")
    for location, record in (
        ("catalog disposition", disposition),
        ("final catalog", final_catalog),
    ):
        sources = record.get("source_records")
        if (
            record.get("release_basis") != RELEASE_KIND
            or record.get("workspace_contract_record_sha256") != authority_sha256
            or not isinstance(sources, Mapping)
            or sources.get("pragmatic_release_authority_record_sha256")
            != authority_sha256
        ):
            raise Legacy15FreezeError(f"{location} lost pragmatic release authority")
    active = runtime.load_active_catalog(
        staging / ACTIVE_CATALOG_FILE, location="staged active catalog"
    )
    if (
        active["candidate_ids"] != tuple(candidate_ids)
        or active["excluded_candidates"]
        or any(
            item["disposition"]["evidence_source"]
            != "prior_production_catalog"
            for item in active["candidates"]
        )
        or active["source_records"]["final_catalog_record_sha256"]
        != final_catalog.get("record_sha256")
        or active["source_records"]["catalog_disposition_record_sha256"]
        != disposition.get("record_sha256")
    ):
        raise Legacy15FreezeError("generated active catalog is not prior-only legacy15")
    return active


def _existing_matches(staging: Path, output: Path) -> bool:
    if output.is_symlink() or not output.is_dir():
        raise Legacy15FreezeError("output path exists but is not a regular directory")
    existing_names = {path.name for path in output.iterdir()}
    if existing_names != OUTPUT_FILES:
        raise Legacy15FreezeError("existing output is not an owned legacy15 bundle")
    return all(
        (output / name).is_file()
        and not (output / name).is_symlink()
        and (output / name).read_bytes() == (staging / name).read_bytes()
        for name in OUTPUT_FILES
    )


def build_legacy15_pragmatic_active_catalog(
    *,
    font_face_manifest_path: Path,
    render_bank_manifest_path: Path,
    asset_root: Path,
    output_dir: Path,
    approval_id: str,
    acknowledge_pragmatic_limitations: bool,
) -> Mapping[str, Any]:
    if not acknowledge_pragmatic_limitations:
        raise Legacy15FreezeError(
            "explicit --acknowledge-pragmatic-limitations is required"
        )
    candidate_ids, font_sha, render_sha = _validate_pinned_inputs(
        font_face_manifest_path=font_face_manifest_path,
        render_bank_manifest_path=render_bank_manifest_path,
        asset_root=asset_root,
    )
    authority = _authority_record(
        approval_id=approval_id,
        candidate_ids=candidate_ids,
        font_manifest_sha256=font_sha,
        render_manifest_sha256=render_sha,
    )
    authority_sha = str(authority["record_sha256"])
    disposition = _disposition_record(
        authority_sha256=authority_sha,
        font_sha256=font_sha,
        render_sha256=render_sha,
    )
    final_catalog = _final_catalog_record(
        authority_sha256=authority_sha,
        disposition_sha256=str(disposition["record_sha256"]),
        candidate_ids=candidate_ids,
        font_sha256=font_sha,
        render_sha256=render_sha,
    )

    output = output_dir.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_name(f".{output.name}.staging-{uuid.uuid4().hex}")
    if staging.exists():
        raise Legacy15FreezeError("staging path unexpectedly exists")
    staging.mkdir()
    try:
        _write_record(staging / AUTHORITY_FILE, authority)
        _write_record(staging / DISPOSITION_FILE, disposition)
        _write_record(staging / FINAL_CATALOG_FILE, final_catalog)
        try:
            runtime.build_active_catalog(
                final_catalog_path=staging / FINAL_CATALOG_FILE,
                catalog_disposition_path=staging / DISPOSITION_FILE,
                deployment_font_face_manifest_path=font_face_manifest_path.resolve(),
                deployment_render_bank_manifest_path=render_bank_manifest_path.resolve(),
                asset_root=asset_root.resolve(),
                output_path=staging / ACTIVE_CATALOG_FILE,
            )
        except runtime.RuntimeArtifactError as error:
            raise Legacy15FreezeError(str(error)) from error
        active = _validate_staged_bundle(
            staging=staging,
            authority_sha256=authority_sha,
            candidate_ids=candidate_ids,
        )
        if output.exists():
            if not _existing_matches(staging, output):
                raise Legacy15FreezeError(
                    "output exists with different bytes; choose a new output directory"
                )
            status = "unchanged"
        else:
            os.replace(staging, output)
            status = "created"
        return {
            "active_catalog_record_sha256": active["record_sha256"],
            "authority_record_sha256": authority_sha,
            "candidate_count": EXPECTED_CANDIDATE_COUNT,
            "catalog_version": CATALOG_VERSION,
            "delta_candidate_count": 0,
            "output_dir": str(output),
            "status": status,
        }
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--font-face-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-catalog-v1/manifest.json"),
    )
    parser.add_argument(
        "--render-bank-manifest",
        type=Path,
        default=Path("datasets/fontclip-font-render-bank-v1/manifest.json"),
    )
    parser.add_argument("--asset-root", type=Path, default=Path("."))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--approval-id", required=True)
    parser.add_argument(
        "--acknowledge-pragmatic-limitations", action="store_true"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = build_legacy15_pragmatic_active_catalog(
            font_face_manifest_path=args.font_face_manifest,
            render_bank_manifest_path=args.render_bank_manifest,
            asset_root=args.asset_root,
            output_dir=args.output_dir,
            approval_id=args.approval_id,
            acknowledge_pragmatic_limitations=args.acknowledge_pragmatic_limitations,
        )
    except Legacy15FreezeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
