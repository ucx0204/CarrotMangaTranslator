#!/usr/bin/env python3
"""Exhaustively verify physical inputs for font-matching training."""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path
from typing import Sequence

try:
    import font_matching_catalog_assets as assets
except ImportError:  # pragma: no cover - import from repository root
    from scripts import font_matching_catalog_assets as assets  # type: ignore[no-redef]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate every real training crop and every canonical font render "
            "prototype against their sealed manifests."
        )
    )
    parser.add_argument(
        "--catalog-registry",
        type=Path,
        required=True,
        help="sealed font-matching catalog registry JSON",
    )
    parser.add_argument(
        "--training-export-dir",
        type=Path,
        required=True,
        help="sealed training export containing samples.jsonl",
    )
    parser.add_argument(
        "--render-bank-manifest",
        type=Path,
        required=True,
        help="production render-bank manifest JSON",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="destination for the deterministic sealed validation report",
    )
    return parser


def _write_verified_output(path_value: Path, payload: bytes) -> str:
    path = path_value.expanduser().resolve()
    if path.exists():
        if not path.is_file():
            raise assets.CatalogAssetError(
                f"validation report output is not a file: {path}"
            )
        try:
            existing = path.read_bytes()
        except OSError as error:
            raise assets.CatalogAssetError(
                f"could not read existing validation report {path}: {error}"
            ) from error
        if existing != payload:
            raise assets.CatalogAssetError(
                f"refusing to overwrite nonidentical validation report: {path}"
            )
        return "verified"

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    try:
        written = path.read_bytes()
    except OSError as error:
        raise assets.CatalogAssetError(
            f"could not verify written validation report {path}: {error}"
        ) from error
    if written != payload:
        raise assets.CatalogAssetError(
            f"validation report changed after atomic write: {path}"
        )
    return "written"


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = assets.validate_training_asset_bundle(
            catalog_registry=args.catalog_registry,
            training_export_dir=args.training_export_dir,
            render_bank_manifest=args.render_bank_manifest,
        )
        assets.validate_record_seal(report, location="validation report")
        payload = assets.json_bytes(report, pretty=True)
        status = _write_verified_output(args.output, payload)
        summary = {
            "counts": report["counts"],
            "output": str(args.output.expanduser().resolve()),
            "record_sha256": report["record_sha256"],
            "status": status,
        }
        print(assets.canonical_json(summary))
        return 0
    except (assets.CatalogAssetError, OSError, ValueError) as error:
        print(assets.canonical_json({"error": str(error), "status": "failed"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
