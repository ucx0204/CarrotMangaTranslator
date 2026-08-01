#!/usr/bin/env python3
"""Seal the only two approved irreducible font-signal terminal exclusions.

This tool never edits the sealed final-v3 repair tree and never creates crop,
mask, synthetic, or generated pixels.  The operator must explicitly name both
hard-coded sample IDs.  Each terminal decision is then bound to the byte- and
pixel-verified accepted crop, wider review context, preserved source page, and
the exact fail-closed glyph-normalization hold that made rectangular repair
unsafe.  Any other hold remains unresolved and prevents finalization.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

try:
    import promote_font_matching_font_signal_recrop_repair as promotion
except ImportError:  # pragma: no cover - import from repository root
    from scripts import (  # type: ignore[no-redef]
        promote_font_matching_font_signal_recrop_repair as promotion,
    )


class TerminalFinalizationError(promotion.FontSignalPromotionError):
    """Raised when a human terminal exclusion cannot be sealed safely."""


def _absolute_unresolved(path: Path) -> Path:
    return path.expanduser().absolute()


def _reject_symlink(path: Path, location: str) -> None:
    current = path
    while True:
        if current.exists() and current.is_symlink():
            raise TerminalFinalizationError(f"{location} contains a symlink: {current}")
        parent = current.parent
        if parent == current:
            break
        current = parent


def _normalized_ids(values: Sequence[str]) -> set[str]:
    ids = {
        promotion.require_component(value, f"exclude-id[{index}]")
        for index, value in enumerate(values, 1)
    }
    if len(ids) != len(values):
        raise TerminalFinalizationError("--exclude-id must not repeat an ID")
    if ids != set(promotion.TERMINAL_REVIEW_ALLOWED_IDS):
        raise TerminalFinalizationError(
            "--exclude-id must name exactly the two approved contaminated samples"
        )
    return ids


def _load_final_and_gate(
    *,
    final_root: Path,
    library_root: Path,
    expected_accepted: int,
    expected_terminal: int,
) -> tuple[promotion.FinalSnapshot, dict[str, Any]]:
    if not final_root.is_dir() or final_root.is_symlink():
        raise TerminalFinalizationError(f"invalid final-v3 root: {final_root}")
    if not library_root.is_dir() or library_root.is_symlink():
        raise TerminalFinalizationError(f"invalid library root: {library_root}")
    final = promotion.load_final_snapshot(
        final_root,
        library_root,
        expected_accepted=expected_accepted,
        expected_terminal=expected_terminal,
    )
    glyph_report = promotion._glyph_preflight_report(final)
    _require_exact_hold_population(final, glyph_report)
    return final, glyph_report


def _require_exact_hold_population(
    final: promotion.FinalSnapshot, glyph_report: Mapping[str, Any]
) -> None:
    records = promotion._glyph_records_by_id(glyph_report)
    if set(records) != set(final.accepted):
        raise TerminalFinalizationError(
            "glyph preflight population differs from final-v3 accepted repairs"
        )
    holds = {
        sample_id
        for sample_id, record in records.items()
        if record.get("status") != "pass"
    }
    if holds != set(promotion.TERMINAL_REVIEW_ALLOWED_IDS):
        raise TerminalFinalizationError(
            "glyph holds must be exactly the two approved contaminated samples: "
            f"holds={sorted(holds)}"
        )
    for sample_id in sorted(holds):
        if records[sample_id].get("review_hold_reasons") != [
            promotion.TERMINAL_REVIEW_REASON
        ]:
            raise TerminalFinalizationError(
                f"{sample_id}: terminal reason differs from the reviewed art hold"
            )


def _source_binding(
    final: promotion.FinalSnapshot, glyph_report: Mapping[str, Any]
) -> dict[str, Any]:
    return {
        "final_v3_marker_sha256": final.marker_file_sha256,
        "final_v3_report_sha256": final.file_hashes[promotion.FINAL_REPORT],
        "final_v3_accepted_sha256": final.file_hashes[promotion.FINAL_ACCEPTED],
        "final_v3_terminal_sha256": final.file_hashes[promotion.FINAL_TERMINAL],
        "glyph_preflight_record_sha256": glyph_report["record_sha256"],
    }


def _build_documents(
    *,
    final: promotion.FinalSnapshot,
    glyph_report: Mapping[str, Any],
    reviewer: str,
    declared_root: Path,
    library_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    reviewer = promotion.require_component(reviewer, "reviewer")
    glyph_records = promotion._glyph_records_by_id(glyph_report)
    records = [
        promotion.seal(
            promotion.terminal_review_record_core(
                final,
                sample_id=sample_id,
                glyph_record=glyph_records[sample_id],
                reviewer=reviewer,
            )
        )
        for sample_id in sorted(promotion.TERMINAL_REVIEW_ALLOWED_IDS)
    ]
    ledger_payload = promotion.jsonl_bytes(records)
    source_binding = _source_binding(final, glyph_report)
    report = promotion.seal(
        {
            "schema_version": promotion.TERMINAL_REVIEW_SCHEMA_VERSION,
            "record_type": "font_signal_recrop_terminal_resolution_report",
            "tool": promotion.TERMINAL_REVIEW_TOOL_ID,
            "completed": True,
            "terminal_ids": sorted(promotion.TERMINAL_REVIEW_ALLOWED_IDS),
            "reviewer": reviewer,
            "counts": {
                "final_v3_accepted_checked": len(final.accepted),
                "glyph_normalization_pass": len(final.accepted) - len(records),
                "human_terminal_exclusions": len(records),
                "unresolved_review_holds": 0,
                "replacement_pixels_created": 0,
                "synthetic_or_generated_pixels": 0,
            },
            "inputs": {
                "builder_source_sha256": promotion.sha256_file(
                    Path(__file__).resolve()
                ),
                "promotion_contract_source_sha256": promotion.sha256_file(
                    Path(promotion.__file__).resolve()
                ),
                "final_v3_root": str(final.root),
                **source_binding,
                "library_root": str(library_root),
            },
            "outputs": {
                "root": str(declared_root),
                promotion.TERMINAL_REVIEW_LEDGER: promotion.sha256_bytes(
                    ledger_payload
                ),
            },
            "contracts": {
                "allowed_terminal_ids": sorted(promotion.TERMINAL_REVIEW_ALLOWED_IDS),
                "allowed_reason": promotion.TERMINAL_REVIEW_REASON,
                "all_other_glyph_gates_must_pass": True,
                "accepted_crop_context_and_source_page_hash_bound": True,
                "terminal_parent_exclusion_required_during_promotion": True,
                "source_derived_mask_override_allowed": False,
                "generated_or_synthetic_repair_allowed": False,
            },
            "safety": {
                "final_v3_modified": False,
                "library_modified": False,
                "assets_written": 0,
                "replacement_pixels_created": 0,
                "generated_or_synthetic_pixels": 0,
                "qa_overlay_pixels": 0,
            },
        }
    )
    return records, report


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    final: promotion.FinalSnapshot,
    glyph_report: Mapping[str, Any],
    reviewer: str,
    library_root: Path,
) -> dict[str, Any]:
    physical_root.mkdir(parents=True, exist_ok=False)
    records, report = _build_documents(
        final=final,
        glyph_report=glyph_report,
        reviewer=reviewer,
        declared_root=declared_root,
        library_root=library_root,
    )
    (physical_root / promotion.TERMINAL_REVIEW_LEDGER).write_bytes(
        promotion.jsonl_bytes(records)
    )
    (physical_root / promotion.TERMINAL_REVIEW_REPORT).write_bytes(
        promotion.json_bytes(report, pretty=True)
    )
    marker = {
        "schema_version": promotion.TERMINAL_REVIEW_SCHEMA_VERSION,
        "owner": promotion.TERMINAL_REVIEW_OWNER,
        "tool": promotion.TERMINAL_REVIEW_TOOL_ID,
        "completed": True,
        "immutable": True,
        "safe_replace": False,
        "declared_root": str(declared_root),
        "managed_files": promotion._managed_files(
            physical_root, marker_name=promotion.TERMINAL_REVIEW_MARKER
        ),
    }
    (physical_root / promotion.TERMINAL_REVIEW_MARKER).write_bytes(
        promotion.json_bytes(marker, pretty=True)
    )
    return report


def _validate_paths(
    *,
    final_root: Path,
    library_root: Path,
    output_root: Path,
    require_output_absent: bool,
) -> None:
    for path, location in (
        (final_root, "final-v3 root"),
        (library_root, "library root"),
        (output_root, "terminal-review output root"),
    ):
        _reject_symlink(path, location)
    if require_output_absent and (output_root.exists() or output_root.is_symlink()):
        raise TerminalFinalizationError(
            f"terminal-review output root already exists: {output_root}"
        )
    promotion.assert_disjoint(
        output_root, final_root, "terminal-review output root", "final-v3 root"
    )
    promotion.assert_disjoint(
        output_root, library_root, "terminal-review output root", "library root"
    )


def _preflight_report(
    *,
    final: promotion.FinalSnapshot,
    glyph_report: Mapping[str, Any],
    reviewer: str,
    output_root: Path,
    library_root: Path,
) -> dict[str, Any]:
    records, report = _build_documents(
        final=final,
        glyph_report=glyph_report,
        reviewer=reviewer,
        declared_root=output_root,
        library_root=library_root,
    )
    return promotion.seal(
        {
            "schema_version": promotion.TERMINAL_REVIEW_SCHEMA_VERSION,
            "record_type": "font_signal_recrop_terminal_resolution_read_only_preflight",
            "tool": promotion.TERMINAL_REVIEW_TOOL_ID,
            "completed": True,
            "read_only": True,
            "output_root_created": False,
            "terminal_ids": [row["sample_id"] for row in records],
            "source_binding": _source_binding(final, glyph_report),
            "future_report_record_sha256": report["record_sha256"],
            "counts": copy.deepcopy(report["counts"]),
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate", "preflight"))
    parser.add_argument("--final-root", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--exclude-id", action="append", default=[], required=True)
    parser.add_argument(
        "--expected-accepted", type=int, default=promotion.EXPECTED_ACCEPTED
    )
    parser.add_argument(
        "--expected-terminal", type=int, default=promotion.EXPECTED_TERMINAL
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.expected_accepted < 1 or args.expected_terminal < 0:
        raise TerminalFinalizationError("expected counts must be non-negative")
    _normalized_ids(args.exclude_id)
    reviewer = promotion.require_component(args.reviewer, "reviewer")
    final_root = _absolute_unresolved(args.final_root)
    library_root = _absolute_unresolved(args.library_root)
    output_root = _absolute_unresolved(args.output_root)
    _validate_paths(
        final_root=final_root,
        library_root=library_root,
        output_root=output_root,
        require_output_absent=args.command != "validate",
    )
    final, glyph_report = _load_final_and_gate(
        final_root=final_root,
        library_root=library_root,
        expected_accepted=args.expected_accepted,
        expected_terminal=args.expected_terminal,
    )
    if args.command == "preflight":
        report = _preflight_report(
            final=final,
            glyph_report=glyph_report,
            reviewer=reviewer,
            output_root=output_root,
            library_root=library_root,
        )
    elif args.command == "build":
        output_root.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{output_root.name}.tmp-", dir=output_root.parent)
        )
        shutil.rmtree(temporary)
        try:
            report = _write_tree(
                physical_root=temporary,
                declared_root=output_root,
                final=final,
                glyph_report=glyph_report,
                reviewer=reviewer,
                library_root=library_root,
            )
            revalidated_final, revalidated_glyph = _load_final_and_gate(
                final_root=final_root,
                library_root=library_root,
                expected_accepted=args.expected_accepted,
                expected_terminal=args.expected_terminal,
            )
            if _source_binding(revalidated_final, revalidated_glyph) != _source_binding(
                final, glyph_report
            ):
                raise TerminalFinalizationError(
                    "final-v3 or source pages changed after terminal preflight"
                )
            _validate_paths(
                final_root=final_root,
                library_root=library_root,
                output_root=output_root,
                require_output_absent=True,
            )
            temporary.replace(output_root)
            promotion.load_terminal_review_snapshot(
                output_root,
                final=revalidated_final,
                glyph_report=revalidated_glyph,
            )
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    else:
        review = promotion.load_terminal_review_snapshot(
            output_root,
            final=final,
            glyph_report=glyph_report,
        )
        if {row.row["reviewer"] for row in review.records.values()} != {reviewer}:
            raise TerminalFinalizationError("terminal-review reviewer drifted")
        temporary = Path(tempfile.mkdtemp(prefix="font-signal-terminal-validate-"))
        shutil.rmtree(temporary)
        try:
            report = _write_tree(
                physical_root=temporary,
                declared_root=output_root,
                final=final,
                glyph_report=glyph_report,
                reviewer=reviewer,
                library_root=library_root,
            )
            promotion._compare_trees(output_root, temporary)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
