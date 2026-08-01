#!/usr/bin/env python3
"""Build the private, source-only v4 font-review seal.

The v4 review card deliberately does not infer a source role or treatment
while it is being rendered.  This tool projects those fields from the sealed
15-font final that is already bound into the review-ready inventory.  It also
checks the corresponding master row, so a stale or hand-edited projection
cannot silently steer the seven-font blind comparison.

The output is development-only review metadata.  It contains no pixels and is
never a training input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "font-matching-review-source-seal-v4"
RECORD_TYPE = "font_matching_review_source_seal"
REPORT_SCHEMA_VERSION = "font-matching-review-source-seal-report-v1"
REPORT_RECORD_TYPE = "font_matching_review_source_seal_report"
OWNER = "carrot-manga-translator/font-matching-review-source-seal-v4"
TOOL_ID = "manga-translator-font-matching-v4-source-seal-builder"
MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.json"
MARKER_FILE = ".font-matching-review-source-seal-owned.json"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
ALLOWED_ROLES = frozenset(
    {
        "aside_balloon_edge",
        "dialogue",
        "emphasis_dialogue",
        "narration",
        "other",
        "sfx_ambient",
        "sfx_comic",
        "sfx_emotion",
        "sfx_impact",
        "sfx_motion",
        "shout",
        "sign_ui_title",
        "thought",
        "whisper",
    }
)
TREATMENT_VALUES = {
    "distortion": frozenset({"none", "jitter", "slant", "wave", "perspective", "warp"}),
    "fill": frozenset({"solid", "inverse", "transparent", "pattern", "gradient"}),
    "outline": frozenset({"none", "single", "double", "multiple"}),
    "shadow": frozenset({"none", "hard", "soft"}),
}


class SourceSealError(ValueError):
    """Raised when a private source seal cannot be reproduced safely."""


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_jsonl_record(value: Any) -> str:
    """Hash one canonical JSONL record, including its required LF terminator."""

    return sha256_bytes((canonical_json(value) + "\n").encode("utf-8"))


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    output = dict(value)
    if "record_sha256" in output:
        raise SourceSealError("record is already sealed")
    output["record_sha256"] = sha256_json(output)
    return output


def seal_jsonl(value: Mapping[str, Any]) -> dict[str, Any]:
    output = dict(value)
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_jsonl_record(output)
    return output


def require_mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SourceSealError(f"{location}: expected an object")
    return value


def require_id(value: Any, location: str) -> str:
    if not isinstance(value, str) or SAFE_ID_RE.fullmatch(value) is None:
        raise SourceSealError(f"{location}: invalid identifier")
    return value


def require_sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise SourceSealError(f"{location}: invalid SHA256")
    return value


def validate_record_seal(value: Mapping[str, Any], location: str) -> str:
    expected = require_sha(value.get("record_sha256"), f"{location}.record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_json(core) != expected:
        raise SourceSealError(f"{location}: record seal mismatch")
    return expected


def validate_jsonl_record_seal(value: Mapping[str, Any], location: str) -> str:
    expected = require_sha(value.get("record_sha256"), f"{location}.record_sha256")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_jsonl_record(core) != expected:
        raise SourceSealError(f"{location}: record seal mismatch")
    return expected


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceSealError(f"{location}: could not read JSON: {error}") from error
    return dict(require_mapping(value, location))


def read_jsonl(path: Path, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    raise SourceSealError(f"{location}:{line_number}: blank line")
                value = json.loads(line)
                rows.append(dict(require_mapping(value, f"{location}:{line_number}")))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SourceSealError(f"{location}: could not read JSONL: {error}") from error
    if not rows:
        raise SourceSealError(f"{location}: no records")
    return rows


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def _master_rows(path: Path) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for line_number, row in enumerate(read_jsonl(path, "master manifest"), 1):
        sample_id = require_id(row.get("id"), f"master:{line_number}.id")
        if sample_id in output:
            raise SourceSealError(f"master:{line_number}: duplicate sample ID")
        output[sample_id] = row
    return output


def _boolean_treatment(value: Mapping[str, Any], location: str) -> dict[str, bool]:
    normalized: dict[str, str] = {}
    for field, allowed in TREATMENT_VALUES.items():
        raw = value.get(field)
        if not isinstance(raw, str) or raw not in allowed:
            raise SourceSealError(f"{location}.{field}: unsupported value {raw!r}")
        normalized[field] = raw
    return {
        "distortion": normalized["distortion"] != "none",
        "inverse": normalized["fill"] == "inverse",
        "outline": normalized["outline"] != "none",
        "shadow": normalized["shadow"] != "none",
        "texture": normalized["fill"] in {"gradient", "pattern"},
    }


def build_manifest(
    *, master_manifest: Path, inventory: Path, rubric: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    for label, path in (
        ("master manifest", master_manifest),
        ("review inventory", inventory),
        ("v4 rubric", rubric),
    ):
        if not path.is_file() or path.is_symlink():
            raise SourceSealError(f"{label}: missing, linked, or not a file: {path}")

    master_sha = sha256_file(master_manifest)
    inventory_sha = sha256_file(inventory)
    rubric_sha = sha256_file(rubric)
    master_by_id = _master_rows(master_manifest)
    samples: list[dict[str, Any]] = []
    role_counts: Counter[str] = Counter()
    treatment_counts: Counter[str] = Counter()
    seen: set[str] = set()

    for line_number, row in enumerate(read_jsonl(inventory, "review inventory"), 1):
        location = f"review inventory:{line_number}"
        validate_jsonl_record_seal(row, location)
        sample_id = require_id(row.get("sample_id"), f"{location}.sample_id")
        if sample_id in seen:
            raise SourceSealError(f"{location}: duplicate sample ID")
        seen.add(sample_id)
        if row.get("master_manifest_sha256") != master_sha:
            raise SourceSealError(f"{location}: master manifest binding is stale")
        merge = require_mapping(
            row.get("merge_provenance"), f"{location}.merge_provenance"
        )
        if merge.get("visibility") != "merge_only_not_reviewer_surface":
            raise SourceSealError(
                f"{location}: prior-final visibility contract changed"
            )
        prior = require_mapping(
            merge.get("prior_final_record"), f"{location}.prior_final_record"
        )
        prior_sha = validate_record_seal(prior, f"{location}.prior_final_record")
        if merge.get("prior_final_record_sha256") != prior_sha:
            raise SourceSealError(f"{location}: prior-final binding is stale")
        if prior.get("sample_id") != sample_id:
            raise SourceSealError(f"{location}: prior-final sample mismatch")
        master = master_by_id.get(sample_id)
        if master is None:
            raise SourceSealError(f"{location}: sample is absent from master")
        # The rescue master is intentionally split/font-label redacted, while
        # source_master_record_sha256 binds the unredacted parent row.  The two
        # byte hashes therefore cannot be equal.  Validate that opaque parent
        # binding and independently bind the complete redacted master file plus
        # its shared work/page projection.
        require_sha(
            merge.get("source_master_record_sha256"),
            f"{location}.merge_provenance.source_master_record_sha256",
        )
        if require_mapping(master.get("work"), f"master[{sample_id}].work").get(
            "id"
        ) != row.get("work_id") or require_mapping(
            master.get("page"), f"master[{sample_id}].page"
        ).get(
            "source_page_sha256"
        ) != row.get(
            "source_page_sha256"
        ):
            raise SourceSealError(f"{location}: master work/page binding mismatch")
        role = require_id(
            require_mapping(
                prior.get("role"), f"{location}.prior_final_record.role"
            ).get("primary"),
            f"{location}.prior_final_record.role.primary",
        )
        if role not in ALLOWED_ROLES:
            raise SourceSealError(f"{location}: unsupported source role {role!r}")
        treatment = _boolean_treatment(
            require_mapping(
                prior.get("treatment"), f"{location}.prior_final_record.treatment"
            ),
            f"{location}.prior_final_record.treatment",
        )
        samples.append(
            seal(
                {
                    "prior_final_record_sha256": prior_sha,
                    "sample_id": sample_id,
                    "sealed_role": role,
                    "treatment": treatment,
                }
            )
        )
        role_counts[role] += 1
        for field, enabled in treatment.items():
            if enabled:
                treatment_counts[field] += 1

    samples.sort(key=lambda value: str(value["sample_id"]))
    manifest = seal(
        {
            "development_only": True,
            "inputs": {
                "inventory_sha256": inventory_sha,
                "master_manifest_sha256": master_sha,
                "rubric_sha256": rubric_sha,
            },
            "record_type": RECORD_TYPE,
            "samples": samples,
            "schema_version": SCHEMA_VERSION,
        }
    )
    summary = {
        "master_sample_count": len(master_by_id),
        "role_counts": dict(sorted(role_counts.items())),
        "sample_count": len(samples),
        "sample_ids_sha256": sha256_json(sorted(seen)),
        "treatment_true_counts": dict(sorted(treatment_counts.items())),
    }
    return manifest, summary


def build_report(
    *, manifest: Mapping[str, Any], summary: Mapping[str, Any]
) -> dict[str, Any]:
    return seal(
        {
            "checks": {
                "automatic_source_role_inference": False,
                "font_identity_fields_present": False,
                "model_suggestions_present": False,
                "prior_final_row_bound": True,
                "qa_or_synthetic_pixels_written": 0,
                "source_master_manifest_and_projection_bound": True,
                "training_asset": False,
            },
            "derivation_contract": {
                "distortion": "prior.treatment.distortion != none",
                "inverse": "prior.treatment.fill == inverse",
                "outline": "prior.treatment.outline != none",
                "shadow": "prior.treatment.shadow != none",
                "texture": "prior.treatment.fill in {gradient,pattern}",
            },
            "inputs": dict(require_mapping(manifest.get("inputs"), "manifest.inputs")),
            "manifest_record_sha256": require_sha(
                manifest.get("record_sha256"), "manifest.record_sha256"
            ),
            "manifest_sha256": sha256_bytes(_json_bytes(manifest)),
            "record_type": REPORT_RECORD_TYPE,
            "schema_version": REPORT_SCHEMA_VERSION,
            "summary": dict(summary),
            "tool": TOOL_ID,
        }
    )


def _owned_marker(*, manifest_bytes: bytes, report_bytes: bytes) -> dict[str, Any]:
    return {
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "owner": OWNER,
        "report_sha256": sha256_bytes(report_bytes),
        "safe_replace": True,
        "schema_version": REPORT_SCHEMA_VERSION,
    }


def _assert_replaceable(output: Path) -> None:
    if not output.exists():
        return
    if not output.is_dir() or output.is_symlink():
        raise SourceSealError(f"output exists and is not a safe directory: {output}")
    marker_path = output / MARKER_FILE
    if not marker_path.is_file() or marker_path.is_symlink():
        raise SourceSealError("existing output is not owned by this tool")
    marker = read_json(marker_path, "ownership marker")
    if marker.get("owner") != OWNER or marker.get("safe_replace") is not True:
        raise SourceSealError("existing output ownership marker is invalid")


def _write_output(
    *, output: Path, manifest: Mapping[str, Any], report: Mapping[str, Any]
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    _assert_replaceable(output)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    completed = False
    try:
        manifest_bytes = _json_bytes(manifest)
        report_bytes = _json_bytes(report)
        (staging / MANIFEST_FILE).write_bytes(manifest_bytes)
        (staging / REPORT_FILE).write_bytes(report_bytes)
        (staging / MARKER_FILE).write_bytes(
            _json_bytes(
                _owned_marker(manifest_bytes=manifest_bytes, report_bytes=report_bytes)
            )
        )
        backup: Path | None = None
        if output.exists():
            backup = output.with_name(f".{output.name}.old-{os.getpid()}")
            if backup.exists():
                raise SourceSealError(f"temporary backup already exists: {backup}")
            os.replace(output, backup)
        try:
            os.replace(staging, output)
            completed = True
        except Exception:
            if backup is not None and backup.exists() and not output.exists():
                os.replace(backup, output)
            raise
        if backup is not None:
            shutil.rmtree(backup)
    finally:
        if not completed and staging.exists():
            shutil.rmtree(staging)


def validate_output(
    *, master_manifest: Path, inventory: Path, rubric: Path, output: Path
) -> dict[str, Any]:
    _assert_replaceable(output)
    expected_files = {MANIFEST_FILE, REPORT_FILE, MARKER_FILE}
    actual_files = {
        path.relative_to(output).as_posix()
        for path in output.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_files or any(
        path.is_symlink() for path in output.rglob("*")
    ):
        raise SourceSealError("output file inventory drifted")
    manifest, summary = build_manifest(
        master_manifest=master_manifest, inventory=inventory, rubric=rubric
    )
    report = build_report(manifest=manifest, summary=summary)
    manifest_bytes = _json_bytes(manifest)
    report_bytes = _json_bytes(report)
    if (output / MANIFEST_FILE).read_bytes() != manifest_bytes:
        raise SourceSealError("manifest differs from deterministic rebuild")
    if (output / REPORT_FILE).read_bytes() != report_bytes:
        raise SourceSealError("report differs from deterministic rebuild")
    marker = read_json(output / MARKER_FILE, "ownership marker")
    if marker != _owned_marker(
        manifest_bytes=manifest_bytes, report_bytes=report_bytes
    ):
        raise SourceSealError("ownership marker differs from deterministic rebuild")
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "validate"):
        command = subparsers.add_parser(name)
        command.add_argument("--master-manifest", type=Path, required=True)
        command.add_argument("--inventory", type=Path, required=True)
        command.add_argument("--rubric", type=Path, required=True)
        command.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    kwargs = {
        "master_manifest": args.master_manifest.expanduser().resolve(),
        "inventory": args.inventory.expanduser().resolve(),
        "rubric": args.rubric.expanduser().resolve(),
        "output": args.output_dir.expanduser().resolve(),
    }
    if args.command == "build":
        manifest, summary = build_manifest(
            master_manifest=kwargs["master_manifest"],
            inventory=kwargs["inventory"],
            rubric=kwargs["rubric"],
        )
        report = build_report(manifest=manifest, summary=summary)
        _write_output(output=kwargs["output"], manifest=manifest, report=report)
    validated = validate_output(**kwargs)
    print(
        canonical_json(
            {
                "manifest_record_sha256": validated["manifest_record_sha256"],
                "sample_count": validated["summary"]["sample_count"],
                "status": "valid",
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SourceSealError as error:
        raise SystemExit(f"error: {error}") from error
