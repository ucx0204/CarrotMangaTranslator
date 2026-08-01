#!/usr/bin/env python3
"""Split sealed v4 review cards into physically separate v5 A/B stages.

The v4 renderer already places all source-only evidence above a frozen gate and
all candidate pixels below it.  This tool losslessly partitions each verified
PNG at that boundary.  Validation rejoins both outputs and requires exact RGB
pixel equality with the immutable source card, so neither stage can silently
drop, duplicate, or move review evidence.

The outputs are review-only QA artifacts.  They are never training images.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

from PIL import Image


SCHEMA_VERSION = "font-matching-review-card-split-v5"
RECORD_TYPE = "font_matching_review_card_split_manifest"
MARKER_FILE = ".font-matching-v5-split-cards-owned.json"
MANIFEST_FILE = "manifest.json"
SOURCE_DIR = "source-only"
CANDIDATE_DIR = "candidate-only"
FULL_WIDTH = 2400
FULL_HEIGHT = 5840
SOURCE_BOTTOM = 1412
SOURCE_SIZE = (FULL_WIDTH, SOURCE_BOTTOM)
CANDIDATE_SIZE = (FULL_WIDTH, FULL_HEIGHT - SOURCE_BOTTOM)


class SplitCardError(ValueError):
    """Raised when a source or split-card contract fails closed."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def pretty_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pixel_sha256(image: Image.Image) -> str:
    rgb = image.convert("RGB")
    digest = hashlib.sha256()
    digest.update(b"font-matching-review-rgb-v1\0")
    digest.update(rgb.width.to_bytes(4, "big"))
    digest.update(rgb.height.to_bytes(4, "big"))
    digest.update(rgb.tobytes())
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(value)
    result.pop("record_sha256", None)
    result["record_sha256"] = sha256_bytes(canonical_json_bytes(result))
    return result


def validate_seal(value: Mapping[str, Any], location: str) -> None:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise SplitCardError(f"{location}: missing record seal")
    core = dict(value)
    core.pop("record_sha256", None)
    if sha256_bytes(canonical_json_bytes(core)) != expected:
        raise SplitCardError(f"{location}: record seal drifted")


def require_mapping(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SplitCardError(f"{location}: expected object")
    return dict(value)


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value:
        raise SplitCardError(f"{location}: expected non-empty text")
    return value


def require_sha(value: Any, location: str) -> str:
    text = require_text(value, location)
    if len(text) != 64 or any(char not in "0123456789abcdef" for char in text):
        raise SplitCardError(f"{location}: expected lowercase SHA-256")
    return text


def safe_relative(value: Any, location: str) -> PurePosixPath:
    text = require_text(value, location).replace("\\", "/")
    relative = PurePosixPath(text)
    if relative.is_absolute() or not relative.parts:
        raise SplitCardError(f"{location}: expected relative path")
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise SplitCardError(f"{location}: unsafe path")
    return relative


def resolve_inside(root: Path, relative: PurePosixPath, location: str) -> Path:
    target = root.joinpath(*relative.parts).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as error:
        raise SplitCardError(f"{location}: path escapes root") from error
    return target


def read_json(path: Path, location: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SplitCardError(f"{location}: cannot read JSON: {error}") from error
    return require_mapping(value, location)


def write_once(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SplitCardError(f"refusing to overwrite {path}")
    path.write_bytes(payload)


def save_png(path: Path, image: Image.Image) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SplitCardError(f"refusing to overwrite {path}")
    with tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024) as handle:
        image.save(handle, format="PNG", optimize=False, compress_level=9)
        handle.seek(0)
        payload = handle.read()
    path.write_bytes(payload)
    return payload


def _open_verified_rgb(path: Path, expected_sha: str, location: str) -> Image.Image:
    payload = path.read_bytes()
    if sha256_bytes(payload) != expected_sha:
        raise SplitCardError(f"{location}: file SHA drifted")
    try:
        # Decode the exact bytes that were hashed. Reopening ``path`` here would
        # leave a hash/open race in which a changed file could be accepted.
        with Image.open(io.BytesIO(payload)) as opened:
            opened.load()
            if opened.mode != "RGB":
                raise SplitCardError(f"{location}: expected RGB PNG")
            image = opened.copy()
    except OSError as error:
        raise SplitCardError(f"{location}: invalid image: {error}") from error
    return image


def _validate_source_manifest(
    path: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    document = read_json(path, "source manifest")
    contract = require_mapping(document.get("card_render_contract"), "render contract")
    if contract.get("probe_profile") != "v4":
        raise SplitCardError("source manifest is not the v4 probe profile")
    if contract.get("canvas_px") != [FULL_WIDTH, FULL_HEIGHT]:
        raise SplitCardError("source card canvas drifted")
    if contract.get("source_stage_visually_separated") is not True:
        raise SplitCardError("source manifest does not attest visual separation")
    if (
        document.get("qa_overlay") is not True
        or document.get("training_asset") is not False
    ):
        raise SplitCardError("source cards are not review-only QA artifacts")
    cards_value = document.get("cards")
    if not isinstance(cards_value, list) or not cards_value:
        raise SplitCardError("source manifest has no cards")
    if document.get("card_count") != len(cards_value):
        raise SplitCardError("source card count drifted")
    cards = [
        require_mapping(row, f"cards[{index}]") for index, row in enumerate(cards_value)
    ]
    return document, cards


def _split_record(
    *,
    card: Mapping[str, Any],
    source_root: Path,
    output_root: Path,
) -> dict[str, Any]:
    assignment = require_mapping(card.get("assignment"), "card.assignment")
    artifact = require_mapping(card.get("artifact"), "card.artifact")
    assignment_id = require_text(assignment.get("assignment_id"), "assignment_id")
    sample_id = require_text(assignment.get("sample_id"), "sample_id")
    stage = require_text(assignment.get("stage"), "stage")
    if artifact.get("width") != FULL_WIDTH or artifact.get("height") != FULL_HEIGHT:
        raise SplitCardError(f"{assignment_id}: source dimensions drifted")
    source_relative = safe_relative(
        artifact.get("file"), f"{assignment_id}.artifact.file"
    )
    source_file = resolve_inside(source_root, source_relative, "source card")
    source_sha = require_sha(artifact.get("sha256"), f"{assignment_id}.artifact.sha256")
    image = _open_verified_rgb(source_file, source_sha, assignment_id)
    if image.size != (FULL_WIDTH, FULL_HEIGHT):
        raise SplitCardError(f"{assignment_id}: decoded dimensions drifted")

    source_stage = image.crop((0, 0, FULL_WIDTH, SOURCE_BOTTOM))
    candidate_stage = image.crop((0, SOURCE_BOTTOM, FULL_WIDTH, FULL_HEIGHT))
    if source_stage.size != SOURCE_SIZE or candidate_stage.size != CANDIDATE_SIZE:
        raise SplitCardError(f"{assignment_id}: split geometry drifted")

    source_out_relative = PurePosixPath(SOURCE_DIR, f"{assignment_id}.png")
    candidate_out_relative = PurePosixPath(CANDIDATE_DIR, f"{assignment_id}.png")
    source_payload = save_png(
        resolve_inside(output_root, source_out_relative, "source output"), source_stage
    )
    candidate_payload = save_png(
        resolve_inside(output_root, candidate_out_relative, "candidate output"),
        candidate_stage,
    )
    return {
        "assignment_id": assignment_id,
        "sample_id": sample_id,
        "stage": stage,
        "full_card": {
            "file": str(source_file),
            "sha256": source_sha,
            "pixel_sha256": pixel_sha256(image),
            "size_px": [FULL_WIDTH, FULL_HEIGHT],
        },
        "source_only": {
            "file": source_out_relative.as_posix(),
            "sha256": sha256_bytes(source_payload),
            "pixel_sha256": pixel_sha256(source_stage),
            "size_px": list(SOURCE_SIZE),
        },
        "candidate_only": {
            "file": candidate_out_relative.as_posix(),
            "sha256": sha256_bytes(candidate_payload),
            "pixel_sha256": pixel_sha256(candidate_stage),
            "size_px": list(CANDIDATE_SIZE),
        },
    }


def _managed_files(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == MARKER_FILE:
            continue
        files[path.relative_to(root).as_posix()] = sha256_file(path)
    return files


def _build_into(source_manifest: Path, output_root: Path) -> dict[str, Any]:
    source_document, cards = _validate_source_manifest(source_manifest)
    source_root = source_manifest.parent.resolve()
    records = [
        _split_record(card=card, source_root=source_root, output_root=output_root)
        for card in cards
    ]
    if len({row["assignment_id"] for row in records}) != len(records):
        raise SplitCardError("duplicate assignment IDs")
    manifest = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": RECORD_TYPE,
            "purpose": "review_only_physical_source_candidate_separation",
            "training_asset": False,
            "qa_overlay": True,
            "source_manifest": {
                "path": str(source_manifest.resolve()),
                "sha256": sha256_file(source_manifest),
                "renderer_hash": require_sha(
                    source_document.get("renderer_hash"), "source renderer_hash"
                ),
            },
            "split_contract": {
                "full_size_px": [FULL_WIDTH, FULL_HEIGHT],
                "source_box_px": [0, 0, FULL_WIDTH, SOURCE_BOTTOM],
                "candidate_box_px": [0, SOURCE_BOTTOM, FULL_WIDTH, FULL_HEIGHT],
                "source_candidate_pixel_overlap": 0,
                "lossless_vertical_rejoin_required": True,
                "candidate_pixels_visible_in_source_stage": False,
                "source_stage_must_be_sealed_before_candidate_stage": True,
            },
            "card_count": len(records),
            "cards": records,
        }
    )
    write_once(output_root / MANIFEST_FILE, pretty_json_bytes(manifest))
    marker = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_matching_review_card_split_tree_marker",
            "manifest_sha256": sha256_file(output_root / MANIFEST_FILE),
            "managed_files": _managed_files(output_root),
        }
    )
    write_once(output_root / MARKER_FILE, pretty_json_bytes(marker))
    return manifest


def validate_tree(root: Path, *, verify_source_cards: bool = True) -> dict[str, Any]:
    manifest_path = root / MANIFEST_FILE
    marker_path = root / MARKER_FILE
    manifest = read_json(manifest_path, "split manifest")
    marker = read_json(marker_path, "split marker")
    validate_seal(manifest, "split manifest")
    validate_seal(marker, "split marker")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or manifest.get("record_type") != RECORD_TYPE
    ):
        raise SplitCardError("split manifest schema drifted")
    if marker.get("manifest_sha256") != sha256_file(manifest_path):
        raise SplitCardError("split marker manifest hash drifted")
    expected_files = require_mapping(marker.get("managed_files"), "managed files")
    actual_files = _managed_files(root)
    if actual_files != expected_files:
        raise SplitCardError("managed split tree inventory drifted")
    cards_value = manifest.get("cards")
    if not isinstance(cards_value, list) or manifest.get("card_count") != len(
        cards_value
    ):
        raise SplitCardError("split manifest card count drifted")

    for index, raw in enumerate(cards_value):
        row = require_mapping(raw, f"cards[{index}]")
        assignment_id = require_text(row.get("assignment_id"), "assignment_id")
        source_desc = require_mapping(row.get("source_only"), "source_only")
        candidate_desc = require_mapping(row.get("candidate_only"), "candidate_only")
        source_path = resolve_inside(
            root,
            safe_relative(source_desc.get("file"), "source_only.file"),
            "source_only.file",
        )
        candidate_path = resolve_inside(
            root,
            safe_relative(candidate_desc.get("file"), "candidate_only.file"),
            "candidate_only.file",
        )
        source_image = _open_verified_rgb(
            source_path,
            require_sha(source_desc.get("sha256"), "source_only.sha256"),
            f"{assignment_id}.source_only",
        )
        candidate_image = _open_verified_rgb(
            candidate_path,
            require_sha(candidate_desc.get("sha256"), "candidate_only.sha256"),
            f"{assignment_id}.candidate_only",
        )
        if source_image.size != SOURCE_SIZE or candidate_image.size != CANDIDATE_SIZE:
            raise SplitCardError(f"{assignment_id}: split image dimensions drifted")
        if pixel_sha256(source_image) != source_desc.get("pixel_sha256"):
            raise SplitCardError(f"{assignment_id}: source pixels drifted")
        if pixel_sha256(candidate_image) != candidate_desc.get("pixel_sha256"):
            raise SplitCardError(f"{assignment_id}: candidate pixels drifted")
        if verify_source_cards:
            full_desc = require_mapping(row.get("full_card"), "full_card")
            full_path = Path(
                require_text(full_desc.get("file"), "full_card.file")
            ).resolve()
            full_image = _open_verified_rgb(
                full_path,
                require_sha(full_desc.get("sha256"), "full_card.sha256"),
                f"{assignment_id}.full_card",
            )
            joined = Image.new("RGB", (FULL_WIDTH, FULL_HEIGHT))
            joined.paste(source_image, (0, 0))
            joined.paste(candidate_image, (0, SOURCE_BOTTOM))
            if pixel_sha256(joined) != pixel_sha256(full_image):
                raise SplitCardError(f"{assignment_id}: lossless rejoin failed")
            if pixel_sha256(full_image) != full_desc.get("pixel_sha256"):
                raise SplitCardError(f"{assignment_id}: full source pixels drifted")
    return manifest


def build(source_manifest: Path, output_root: Path) -> dict[str, Any]:
    source_manifest = source_manifest.resolve()
    output_root = output_root.resolve()
    if output_root.exists():
        raise SplitCardError("output root already exists")
    source_root = source_manifest.parent.resolve()
    try:
        output_root.relative_to(source_root)
    except ValueError:
        pass
    else:
        raise SplitCardError("output root must not be inside source card root")
    output_root.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{output_root.name}.", dir=output_root.parent)
    )
    try:
        _build_into(source_manifest, temporary)
        validate_tree(temporary)
        os.replace(temporary, output_root)
        return validate_tree(output_root)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Losslessly split v4 blind cards into sealed v5 source/candidate stages."
    )
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--no-verify-source-cards", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        if args.command == "build":
            report = build(args.source_manifest, args.output_root)
        else:
            report = validate_tree(
                args.output_root.resolve(),
                verify_source_cards=not args.no_verify_source_cards,
            )
        print(
            json.dumps(
                {
                    "card_count": report["card_count"],
                    "manifest_record_sha256": report["record_sha256"],
                    "output_root": str(args.output_root.resolve()),
                    "status": "valid",
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    except (OSError, SplitCardError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
