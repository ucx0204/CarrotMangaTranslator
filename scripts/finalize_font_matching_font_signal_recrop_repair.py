#!/usr/bin/env python3
"""Finalize double-reviewed font-signal recrops into an isolated v3 artifact.

The v2 artifact intentionally shipped with a blank revision ledger.  Filling
that one CSV therefore changes a file named by the v2 ownership marker.  This
tool permits exactly that expected transition, while requiring every other v2
managed byte to retain its sealed hash.  A separate independent secondary
revision review is then bound to the completed root ledger.

Only unanimous revision accepts and the existing v2 consensus accepts are
emitted.  Their images and review contexts are regenerated directly from
hash-verified library pages.  Existing terminal decisions are sealed as
exclusions.  Missing, conflicting, revised, or rejected reviews fail closed.
The output is a new immutable artifact; existing datasets are never replaced.
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import shutil
import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

import adjudicate_font_matching_font_signal_recrop_repair as v2


v1 = v2.v1
repair = v2.repair

SCHEMA_VERSION = "font-matching-font-signal-recrop-repair-final-v3"
OWNER = "carrot-manga-translator/font-signal-recrop-repair-final"
MARKER_FILE = ".font-matching-font-signal-recrop-repair-final-owned.json"
ACCEPTED_FILE = "accepted-repairs.jsonl"
EXCLUSIONS_FILE = "terminal-exclusions.jsonl"
REPORT_FILE = "report.json"
ACCEPTED_IMAGE_DIR = "accepted-images"
CONTEXT_DIR = "review-context"
EVIDENCE_DIR = "evidence"
COMPLETED_LEDGER_EVIDENCE = f"{EVIDENCE_DIR}/completed-revision-ledger.csv"
SECONDARY_REVIEW_EVIDENCE = f"{EVIDENCE_DIR}/secondary-revision-review.jsonl"
V2_ADJUDICATIONS_EVIDENCE = f"{EVIDENCE_DIR}/v2-adjudications.jsonl"
V2_REVISIONS_EVIDENCE = f"{EVIDENCE_DIR}/v2-revisions.jsonl"
V2_REPORT_EVIDENCE = f"{EVIDENCE_DIR}/v2-report.json"
V2_MARKER_EVIDENCE = f"{EVIDENCE_DIR}/v2-ownership-marker.json"
PRIOR_PROPOSALS_EVIDENCE = f"{EVIDENCE_DIR}/prior-proposals.jsonl"
SECONDARY_SIDECAR_FILE = "secondary-revision-review-input.jsonl"
SECONDARY_SCHEMA_VERSION = (
    "font_matching_font_signal_recrop_revision_secondary_review_v1"
)
SECONDARY_DECISIONS = frozenset(
    {"approve_revision", "revise_bbox", "terminal_no_safe_crop"}
)
SECONDARY_KEYS = frozenset(
    {
        "schema_version",
        "reviewer",
        "sample_id",
        "revision_bbox_px",
        "decision",
        "reason",
        "directly_viewed",
        "direct_view_count",
        "promotion_performed",
    }
)
VIEW_KINDS = frozenset({"revision_preview", "revision_context", "full_page"})


class FontSignalFinalizationError(ValueError):
    """Raised when final acceptance cannot be proven without ambiguity."""


def canonical_json(value: Any) -> str:
    return repair.canonical_json(value)


def sha256_file(path: Path) -> str:
    return repair.sha256_file(path)


def sha256_json(value: Any) -> str:
    return repair.sha256_bytes(canonical_json(value).encode("utf-8"))


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    return repair.seal(value)


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    return repair.json_bytes(value, pretty=pretty)


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return repair.jsonl_bytes(rows)


def _read_jsonl(
    path: Path, label: str, *, allow_empty: bool = False
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise FontSignalFinalizationError(
                        f"{label}:{line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(value, Mapping):
                    raise FontSignalFinalizationError(
                        f"{label}:{line_number}: expected an object"
                    )
                rows.append(dict(value))
    except OSError as error:
        raise FontSignalFinalizationError(
            f"{label}: could not read {path}: {error}"
        ) from error
    if not rows and not allow_empty:
        raise FontSignalFinalizationError(f"{label}: JSONL is empty")
    return rows


def _unique(
    rows: Sequence[dict[str, Any]], key: str, label: str
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows, 1):
        value = repair.require_text(row.get(key), f"{label}:{index}.{key}")
        if value in output:
            raise FontSignalFinalizationError(
                f"{label}:{index}: duplicate {key} {value}"
            )
        output[value] = row
    return output


def _require_bbox(value: Any, label: str) -> tuple[int, int, int, int]:
    try:
        return repair.require_bbox(value, label)
    except repair.RecropRepairError as error:
        raise FontSignalFinalizationError(str(error)) from error


def _managed_files(root: Path) -> dict[str, str]:
    return {
        relative: sha256_file(root.joinpath(*PurePosixPath(relative).parts))
        for relative in sorted(v2._regular_file_inventory(root))
        if relative != MARKER_FILE
    }


def _validate_root_separation(
    *, output_root: Path, adjudication_root: Path, library_root: Path
) -> None:
    v2._require_disjoint(
        output_root, adjudication_root, "output root", "v2 adjudication root"
    )
    v2._require_disjoint(output_root, library_root, "output root", "library root")
    v2._require_disjoint(
        adjudication_root,
        library_root,
        "v2 adjudication root",
        "library root",
    )


def _verify_prior_proposal_pixels(
    proposal: Mapping[str, Any], library_root: Path, sample_id: str
) -> None:
    _, _, decoded = v2._resolve_library_page(proposal, library_root, sample_id)
    try:
        for key in ("direct_preview", "source_context"):
            asset = proposal.get(key)
            if not isinstance(asset, Mapping):
                raise FontSignalFinalizationError(
                    f"prior proposal[{sample_id}].{key}: asset is missing"
                )
            bbox = _require_bbox(
                asset.get("bbox_px"),
                f"prior proposal[{sample_id}].{key}.bbox_px",
            )
            v2._check_bbox(bbox, decoded, f"prior proposal[{sample_id}].{key}")
            expected = v1._png_crop(decoded, bbox)
            if (
                asset.get("file_sha256") != repair.sha256_bytes(expected)
                or asset.get("pixel_source") != "direct_hash_verified_library_page_crop"
                or asset.get("qa_overlay") is not False
                or asset.get("synthetic") is not False
            ):
                raise FontSignalFinalizationError(
                    f"prior proposal[{sample_id}].{key}: pixel binding drifted"
                )
    finally:
        decoded.close()


def _verify_revision_pixels(
    *,
    root: Path,
    revision: Mapping[str, Any],
    proposal: Mapping[str, Any],
    library_root: Path,
    sample_id: str,
) -> None:
    _, page_payload, decoded = v2._resolve_library_page(
        proposal, library_root, sample_id
    )
    try:
        page = revision.get("full_page_binding")
        if (
            not isinstance(page, Mapping)
            or page.get("path") != proposal["source_page"]["path"]
            or page.get("file_sha256") != repair.sha256_bytes(page_payload)
            or page.get("size_bytes") != len(page_payload)
            or page.get("size_px") != [decoded.width, decoded.height]
            or page.get("decoded_mode") != "RGB"
            or page.get("provenance") != "real_preserved"
            or page.get("storage_root") != "library_root"
        ):
            raise FontSignalFinalizationError(
                f"revision[{sample_id}]: full-page binding drifted"
            )
        for key in ("direct_preview", "revision_context"):
            asset = revision.get(key)
            if not isinstance(asset, Mapping):
                raise FontSignalFinalizationError(
                    f"revision[{sample_id}].{key}: asset is missing"
                )
            bbox = _require_bbox(
                asset.get("bbox_px"), f"revision[{sample_id}].{key}.bbox_px"
            )
            v2._check_bbox(bbox, decoded, f"revision[{sample_id}].{key}")
            expected = v1._png_crop(decoded, bbox)
            path = v2._safe_managed_path(
                root, asset.get("path"), f"revision[{sample_id}].{key}.path"
            )
            if (
                not path.is_file()
                or path.read_bytes() != expected
                or asset.get("file_sha256") != repair.sha256_bytes(expected)
                or asset.get("pixel_source") != "direct_hash_verified_library_page_crop"
                or asset.get("qa_overlay") is not False
                or asset.get("synthetic") is not False
                or asset.get("generated") is not False
            ):
                raise FontSignalFinalizationError(
                    f"revision[{sample_id}].{key}: pixel binding drifted"
                )
    finally:
        decoded.close()


def _load_v2_contract(
    *,
    adjudication_root: Path,
    completed_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
    expected_prior_accepts: int,
    expected_revisions: int,
    expected_exclusions: int,
) -> dict[str, Any]:
    root = adjudication_root.resolve()
    completed_ledger = completed_ledger.resolve()
    secondary_review = secondary_review.resolve()
    if completed_ledger != (root / v2.REVISION_LEDGER_FILE).resolve():
        raise FontSignalFinalizationError(
            "completed ledger must be the v2 revision-review-ledger.csv"
        )
    if v2._is_link_or_junction(root) or not root.is_dir():
        raise FontSignalFinalizationError("v2 adjudication root is missing or unsafe")
    marker_path = root / v2.MARKER_FILE
    marker = repair.read_json(marker_path, "v2 ownership marker")
    if (
        marker.get("schema_version") != v2.SCHEMA_VERSION
        or marker.get("owner") != v2.OWNER
        or marker.get("safe_replace") is not True
        or Path(str(marker.get("declared_root"))).resolve() != root
    ):
        raise FontSignalFinalizationError("v2 ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalFinalizationError("v2 marker lacks managed files")
    managed_names: set[str] = set()
    for relative, expected_sha in managed.items():
        safe = v2._safe_relative_path(relative, f"v2 marker[{relative}]")
        name = safe.as_posix()
        managed_names.add(name)
        repair.require_sha(expected_sha, f"v2 marker[{relative}].sha256")
        physical = root.joinpath(*safe.parts)
        if not physical.is_file():
            raise FontSignalFinalizationError(f"v2 managed file is missing: {name}")
        if name != v2.REVISION_LEDGER_FILE and sha256_file(physical) != expected_sha:
            raise FontSignalFinalizationError(
                f"v2 managed artifact is stale/tampered: {name}"
            )

    allowed_extra: set[str] = set()
    if v2._is_within(root, secondary_review):
        relative_secondary = secondary_review.relative_to(root).as_posix()
        if relative_secondary != SECONDARY_SIDECAR_FILE:
            raise FontSignalFinalizationError(
                "secondary review sidecar has an unexpected in-root path"
            )
        allowed_extra.add(relative_secondary)
    actual = v2._regular_file_inventory(root)
    expected_actual = {v2.MARKER_FILE, *managed_names, *allowed_extra}
    if actual != expected_actual:
        raise FontSignalFinalizationError(
            "v2 inventory differs outside the intended review sidecars; "
            f"missing={sorted(expected_actual-actual)[:8]} "
            f"unexpected={sorted(actual-expected_actual)[:8]}"
        )

    report_path = root / v2.REPORT_FILE
    report = repair.read_json(report_path, "v2 adjudication report")
    try:
        repair.validate_seal(report, "v2 adjudication report")
    except repair.RecropRepairError as error:
        raise FontSignalFinalizationError(str(error)) from error
    inputs = report.get("inputs")
    outputs = report.get("outputs")
    counts = report.get("counts")
    historical_ledger_sha = repair.require_sha(
        managed.get(v2.REVISION_LEDGER_FILE),
        "v2 marker historical revision ledger sha256",
    )
    if (
        not isinstance(inputs, Mapping)
        or not isinstance(outputs, Mapping)
        or not isinstance(counts, Mapping)
        or outputs.get("adjudications_sha256")
        != sha256_file(root / v2.ADJUDICATIONS_FILE)
        or outputs.get("revisions_sha256") != sha256_file(root / v2.REVISIONS_FILE)
        or outputs.get("revision_review_ledger_sha256") != historical_ledger_sha
        or counts.get("targets") != expected_targets
        or counts.get("accepted_but_withheld") != expected_prior_accepts
        or counts.get("revision_previews_pending") != expected_revisions
        or counts.get("terminal_but_withheld") != expected_exclusions
        or counts.get("promoted") != 0
    ):
        raise FontSignalFinalizationError("v2 report bindings drifted")

    adjudications = _unique(
        _read_jsonl(root / v2.ADJUDICATIONS_FILE, "v2 adjudications"),
        "sample_id",
        "v2 adjudications",
    )
    revisions = _unique(
        _read_jsonl(
            root / v2.REVISIONS_FILE,
            "v2 revisions",
            allow_empty=expected_revisions == 0,
        ),
        "sample_id",
        "v2 revisions",
    )
    prior_proposals_path = root / v2.PRIOR_PROPOSALS_EVIDENCE_FILE
    proposals = _unique(
        _read_jsonl(prior_proposals_path, "v2 prior proposal evidence"),
        "sample_id",
        "v2 prior proposal evidence",
    )
    if (
        len(adjudications) != expected_targets
        or set(adjudications) != set(proposals)
        or len(revisions) != expected_revisions
    ):
        raise FontSignalFinalizationError("v2 target projections drifted")

    prior_accept_ids: set[str] = set()
    exclusion_ids: set[str] = set()
    revision_ids: set[str] = set()
    for sample_id, adjudication in adjudications.items():
        proposal = proposals[sample_id]
        try:
            repair.validate_seal(adjudication, f"v2 adjudication[{sample_id}]")
            repair.validate_seal(proposal, f"v2 prior proposal[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalFinalizationError(str(error)) from error
        if (
            adjudication.get("schema_version") != v2.SCHEMA_VERSION
            or adjudication.get("record_type")
            != "font_signal_recrop_repair_adjudication"
            or adjudication.get("training_eligible") is not False
            or adjudication.get("promotion_allowed") is not False
            or adjudication.get("promoted") is not False
            or adjudication.get("prior_action") != proposal.get("action")
        ):
            raise FontSignalFinalizationError(
                f"v2 adjudication[{sample_id}]: unsafe contract"
            )
        disposition = adjudication.get("adjudicated_disposition")
        if disposition == "accept_proposal_withheld":
            if (
                adjudication.get("status") != "review_complete_withheld_not_promoted"
                or adjudication.get("review_alignment") != "consensus_keep_prior_recrop"
                or proposal.get("action") != "recrop"
                or adjudication.get("revision_record_sha256") is not None
            ):
                raise FontSignalFinalizationError(
                    f"v2 adjudication[{sample_id}]: prior accept drifted"
                )
            prior_accept_ids.add(sample_id)
        elif disposition == "confirm_terminal_withheld":
            if (
                adjudication.get("status") != "review_complete_withheld_not_promoted"
                or adjudication.get("review_alignment")
                != "consensus_terminal_exclusion"
                or proposal.get("action") != "terminal_replacement"
                or adjudication.get("revision_record_sha256") is not None
            ):
                raise FontSignalFinalizationError(
                    f"v2 adjudication[{sample_id}]: terminal exclusion drifted"
                )
            exclusion_ids.add(sample_id)
        elif disposition == "revision_preview_pending":
            if (
                adjudication.get("status") != "pending_direct_visual_review"
                or proposal.get("action") != "recrop"
            ):
                raise FontSignalFinalizationError(
                    f"v2 adjudication[{sample_id}]: revision disposition drifted"
                )
            revision_ids.add(sample_id)
        else:
            raise FontSignalFinalizationError(
                f"v2 adjudication[{sample_id}]: unresolved disposition"
            )
        _verify_prior_proposal_pixels(proposal, library_root, sample_id)

    if (
        len(prior_accept_ids) != expected_prior_accepts
        or len(exclusion_ids) != expected_exclusions
        or revision_ids != set(revisions)
    ):
        raise FontSignalFinalizationError("v2 disposition counts drifted")
    for sample_id, revision in revisions.items():
        try:
            repair.validate_seal(revision, f"v2 revision[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalFinalizationError(str(error)) from error
        adjudication = adjudications[sample_id]
        if (
            revision.get("schema_version") != v2.SCHEMA_VERSION
            or revision.get("record_type") != "font_signal_recrop_bbox_revision"
            or revision.get("status") != "pending_direct_visual_review"
            or revision.get("training_eligible") is not False
            or revision.get("promotion_allowed") is not False
            or revision.get("promoted") is not False
            or revision.get("record_sha256")
            != adjudication.get("revision_record_sha256")
        ):
            raise FontSignalFinalizationError(
                f"v2 revision[{sample_id}]: unsafe revision contract"
            )
        _verify_revision_pixels(
            root=root,
            revision=revision,
            proposal=proposals[sample_id],
            library_root=library_root,
            sample_id=sample_id,
        )
    if expected_revisions and sha256_file(completed_ledger) == historical_ledger_sha:
        raise FontSignalFinalizationError(
            "revision ledger still matches the blank v2 template"
        )
    return {
        "marker": marker,
        "marker_sha256": sha256_file(marker_path),
        "report": report,
        "report_sha256": sha256_file(report_path),
        "historical_ledger_sha256": historical_ledger_sha,
        "adjudications": adjudications,
        "adjudications_sha256": sha256_file(root / v2.ADJUDICATIONS_FILE),
        "revisions": revisions,
        "revisions_sha256": sha256_file(root / v2.REVISIONS_FILE),
        "proposals": proposals,
        "proposals_sha256": sha256_file(prior_proposals_path),
        "prior_accept_ids": prior_accept_ids,
        "revision_ids": revision_ids,
        "exclusion_ids": exclusion_ids,
    }


def _bbox_cell(
    value: str, label: str, *, allow_empty: bool = False
) -> tuple[int, int, int, int] | None:
    text = value.strip()
    if not text and allow_empty:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise FontSignalFinalizationError(f"{label}: invalid JSON bbox") from error
    return _require_bbox(parsed, label)


def _load_completed_ledger(
    path: Path, revisions: Mapping[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != v2.REVISION_LEDGER_HEADER:
                raise FontSignalFinalizationError(
                    "completed revision ledger header drifted"
                )
            raw_rows = [dict(row) for row in reader]
    except OSError as error:
        raise FontSignalFinalizationError(
            f"completed revision ledger could not be read: {error}"
        ) from error
    rows = _unique(raw_rows, "sample_id", "completed revision ledger")
    if set(rows) != set(revisions):
        raise FontSignalFinalizationError(
            "completed revision ledger does not cover revisions exactly"
        )
    output: dict[str, dict[str, Any]] = {}
    for sample_id, row in rows.items():
        revision = revisions[sample_id]
        preview = revision["direct_preview"]
        context = revision["revision_context"]
        if set(row) != set(v2.REVISION_LEDGER_HEADER) or any(
            value is None for value in row.values()
        ):
            raise FontSignalFinalizationError(
                f"completed revision ledger[{sample_id}]: malformed columns"
            )
        prior_bbox = _bbox_cell(
            row["prior_bbox_px"],
            f"completed revision ledger[{sample_id}].prior_bbox_px",
        )
        revision_bbox = _bbox_cell(
            row["revision_bbox_px"],
            f"completed revision ledger[{sample_id}].revision_bbox_px",
        )
        decision = repair.require_text(
            row.get("decision"),
            f"completed revision ledger[{sample_id}].decision",
        )
        reviewer = repair.require_text(
            row.get("reviewer"),
            f"completed revision ledger[{sample_id}].reviewer",
        )
        reviewed_at = repair._review_time(
            row.get("reviewed_at"),
            f"completed revision ledger[{sample_id}].reviewed_at",
        )
        notes = repair.require_text(
            row.get("notes"), f"completed revision ledger[{sample_id}].notes"
        )
        next_bbox = _bbox_cell(
            row.get("next_revision_bbox_px", ""),
            f"completed revision ledger[{sample_id}].next_revision_bbox_px",
            allow_empty=True,
        )
        if (
            row.get("review_alignment") != revision.get("review_alignment")
            or list(prior_bbox or ()) != revision.get("prior_bbox_px")
            or list(revision_bbox or ()) != revision.get("revision_bbox_px")
            or row.get("preview_path") != preview.get("path")
            or row.get("preview_sha256") != preview.get("file_sha256")
            or row.get("context_path") != context.get("path")
            or row.get("context_sha256") != context.get("file_sha256")
            or row.get("allowed_decisions") != v2.REVISION_ALLOWED_DECISIONS
            or decision not in {"accept_revision", "revise_bbox", "reject_revision"}
        ):
            raise FontSignalFinalizationError(
                f"completed revision ledger[{sample_id}]: revision binding drifted"
            )
        if decision == "revise_bbox":
            if next_bbox is None or list(next_bbox) == revision.get("revision_bbox_px"):
                raise FontSignalFinalizationError(
                    f"completed revision ledger[{sample_id}]: invalid next bbox"
                )
        elif next_bbox is not None:
            raise FontSignalFinalizationError(
                f"completed revision ledger[{sample_id}]: unexpected next bbox"
            )
        output[sample_id] = {
            "decision": decision,
            "next_revision_bbox_px": list(next_bbox) if next_bbox else None,
            "reviewer": reviewer,
            "reviewed_at": reviewed_at,
            "notes": notes,
            "row_sha256": sha256_json(row),
        }
    return output


def _load_secondary_reviews(
    path: Path,
    revisions: Mapping[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    rows = _unique(
        _read_jsonl(
            path,
            "secondary revision review",
            allow_empty=not revisions,
        ),
        "sample_id",
        "secondary revision review",
    )
    if set(rows) != set(revisions):
        raise FontSignalFinalizationError(
            "secondary revision review does not cover revisions exactly"
        )
    for sample_id, row in rows.items():
        revision = revisions[sample_id]
        if set(row) != SECONDARY_KEYS:
            raise FontSignalFinalizationError(
                f"secondary revision review[{sample_id}]: fields drifted"
            )
        decision = row.get("decision")
        viewed = row.get("directly_viewed")
        if (
            row.get("schema_version") != SECONDARY_SCHEMA_VERSION
            or list(
                _require_bbox(
                    row.get("revision_bbox_px"),
                    f"secondary revision review[{sample_id}].revision_bbox_px",
                )
            )
            != revision.get("revision_bbox_px")
            or decision not in SECONDARY_DECISIONS
            or row.get("direct_view_count") != 3
            or row.get("promotion_performed") is not False
            or not isinstance(viewed, list)
            or len(viewed) != 3
        ):
            raise FontSignalFinalizationError(
                f"secondary revision review[{sample_id}]: unsafe contract"
            )
        repair.require_text(
            row.get("reviewer"),
            f"secondary revision review[{sample_id}].reviewer",
        )
        repair.require_text(
            row.get("reason"),
            f"secondary revision review[{sample_id}].reason",
        )
        by_kind: dict[str, dict[str, Any]] = {}
        for index, item in enumerate(viewed, 1):
            if not isinstance(item, Mapping) or set(item) != {
                "kind",
                "path",
                "sha256",
            }:
                raise FontSignalFinalizationError(
                    f"secondary revision review[{sample_id}].directly_viewed"
                    f"[{index}]: malformed view"
                )
            kind = repair.require_text(
                item.get("kind"),
                f"secondary revision review[{sample_id}].view.kind",
            )
            if kind in by_kind:
                raise FontSignalFinalizationError(
                    f"secondary revision review[{sample_id}]: duplicate view {kind}"
                )
            by_kind[kind] = dict(item)
        expected_views = {
            "revision_preview": revision["direct_preview"],
            "revision_context": revision["revision_context"],
            "full_page": revision["full_page_binding"],
        }
        if set(by_kind) != VIEW_KINDS:
            raise FontSignalFinalizationError(
                f"secondary revision review[{sample_id}]: view coverage drifted"
            )
        for kind, expected in expected_views.items():
            if by_kind[kind].get("path") != expected.get("path") or by_kind[kind].get(
                "sha256"
            ) != expected.get("file_sha256"):
                raise FontSignalFinalizationError(
                    f"secondary revision review[{sample_id}]: {kind} binding drifted"
                )
    return rows


def _require_unanimous_revision_accepts(
    *,
    primary: Mapping[str, dict[str, Any]],
    secondary: Mapping[str, dict[str, Any]],
) -> None:
    if set(primary) != set(secondary):
        raise FontSignalFinalizationError("revision review target sets differ")
    failures: list[str] = []
    for sample_id in sorted(primary):
        if primary[sample_id]["reviewer"] == secondary[sample_id]["reviewer"]:
            failures.append(f"{sample_id}: reviewers are not independent")
        if primary[sample_id]["decision"] != "accept_revision":
            failures.append(f"{sample_id}: root={primary[sample_id]['decision']}")
        if secondary[sample_id]["decision"] != "approve_revision":
            failures.append(
                f"{sample_id}: secondary={secondary[sample_id]['decision']}"
            )
    if failures:
        raise FontSignalFinalizationError(
            f"revision consensus is incomplete: {failures[:8]}"
        )


def _source_page_binding(
    proposal: Mapping[str, Any], page_payload: bytes, decoded: Any
) -> dict[str, Any]:
    source = proposal["source_page"]
    return {
        "path": source["path"],
        "file_sha256": repair.sha256_bytes(page_payload),
        "size_bytes": len(page_payload),
        "size_px": [decoded.width, decoded.height],
        "decoded_mode": "RGB",
        "provenance": "real_preserved",
        "storage_root": "library_root",
    }


def _direct_asset(
    *, path: str, bbox: tuple[int, int, int, int], payload: bytes
) -> dict[str, Any]:
    return {
        "path": path,
        "bbox_px": list(bbox),
        "file_sha256": repair.sha256_bytes(payload),
        "size_px": [bbox[2] - bbox[0], bbox[3] - bbox[1]],
        "decoded_mode": "RGB",
        "pixel_source": "direct_hash_verified_library_page_crop",
        "qa_overlay": False,
        "synthetic": False,
        "generated": False,
    }


def _input_bindings(
    *,
    builder_source_sha256: str,
    contract: Mapping[str, Any],
    proposal: Mapping[str, Any],
    adjudication: Mapping[str, Any],
    completed_ledger: Path,
    secondary_review: Path,
    primary_row: Mapping[str, Any] | None,
    secondary_row: Mapping[str, Any] | None,
    revision: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "builder_source_sha256": builder_source_sha256,
        "v2_ownership_marker_sha256": contract["marker_sha256"],
        "v2_report_file_sha256": contract["report_sha256"],
        "v2_report_record_sha256": contract["report"]["record_sha256"],
        "v2_adjudications_file_sha256": contract["adjudications_sha256"],
        "v2_adjudication_record_sha256": adjudication["record_sha256"],
        "v2_revisions_file_sha256": contract["revisions_sha256"],
        "v2_revision_record_sha256": (
            revision.get("record_sha256") if revision else None
        ),
        "prior_proposals_evidence_sha256": contract["proposals_sha256"],
        "prior_proposal_record_sha256": proposal["record_sha256"],
        "completed_revision_ledger_sha256": sha256_file(completed_ledger),
        "completed_revision_ledger_row_sha256": (
            primary_row.get("row_sha256") if primary_row else None
        ),
        "secondary_revision_review_sha256": sha256_file(secondary_review),
        "secondary_revision_review_row_sha256": (
            sha256_json(secondary_row) if secondary_row else None
        ),
    }


def _write_tree(
    *,
    physical_root: Path,
    declared_root: Path,
    adjudication_root: Path,
    completed_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
    expected_prior_accepts: int,
    expected_revisions: int,
    expected_exclusions: int,
) -> dict[str, Any]:
    _validate_root_separation(
        output_root=declared_root,
        adjudication_root=adjudication_root,
        library_root=library_root,
    )
    contract = _load_v2_contract(
        adjudication_root=adjudication_root,
        completed_ledger=completed_ledger,
        secondary_review=secondary_review,
        library_root=library_root,
        expected_targets=expected_targets,
        expected_prior_accepts=expected_prior_accepts,
        expected_revisions=expected_revisions,
        expected_exclusions=expected_exclusions,
    )
    primary = _load_completed_ledger(completed_ledger, contract["revisions"])
    secondary = _load_secondary_reviews(secondary_review, contract["revisions"])
    _require_unanimous_revision_accepts(primary=primary, secondary=secondary)

    physical_root.mkdir(parents=True, exist_ok=False)
    (physical_root / ACCEPTED_IMAGE_DIR).mkdir()
    (physical_root / CONTEXT_DIR).mkdir()
    (physical_root / EVIDENCE_DIR).mkdir()
    builder_source_sha256 = sha256_file(Path(__file__).resolve())
    accepted_ids = sorted(contract["prior_accept_ids"] | contract["revision_ids"])
    accepted_rows: list[dict[str, Any]] = []
    for sample_id in accepted_ids:
        proposal = contract["proposals"][sample_id]
        adjudication = contract["adjudications"][sample_id]
        revision = contract["revisions"].get(sample_id)
        if revision is None:
            bbox = _require_bbox(
                proposal.get("recrop_bbox_px"),
                f"proposal[{sample_id}].recrop_bbox_px",
            )
            context_bbox = _require_bbox(
                proposal["source_context"].get("bbox_px"),
                f"proposal[{sample_id}].source_context.bbox_px",
            )
            acceptance_basis = "double_review_consensus_prior_recrop"
            primary_row = None
            secondary_row = None
        else:
            bbox = _require_bbox(
                revision.get("revision_bbox_px"),
                f"revision[{sample_id}].revision_bbox_px",
            )
            context_bbox = _require_bbox(
                revision["revision_context"].get("bbox_px"),
                f"revision[{sample_id}].revision_context.bbox_px",
            )
            acceptance_basis = "double_review_consensus_revision"
            primary_row = primary[sample_id]
            secondary_row = secondary[sample_id]
        _, page_payload, decoded = v2._resolve_library_page(
            proposal, library_root, sample_id
        )
        try:
            v2._check_bbox(bbox, decoded, f"accepted[{sample_id}].bbox")
            v2._check_bbox(context_bbox, decoded, f"accepted[{sample_id}].context_bbox")
            image_payload = v1._png_crop(decoded, bbox)
            context_payload = v1._png_crop(decoded, context_bbox)
            image_relative = f"{ACCEPTED_IMAGE_DIR}/{sample_id}.png"
            context_relative = f"{CONTEXT_DIR}/{sample_id}.png"
            (physical_root / ACCEPTED_IMAGE_DIR / f"{sample_id}.png").write_bytes(
                image_payload
            )
            (physical_root / CONTEXT_DIR / f"{sample_id}.png").write_bytes(
                context_payload
            )
            accepted_rows.append(
                seal(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "record_type": "font_signal_accepted_repair",
                        "sample_id": sample_id,
                        "status": "accepted_repair_final",
                        "acceptance_basis": acceptance_basis,
                        "coordinate_space": "source_page_pixels_xyxy_half_open",
                        "accepted_bbox_px": list(bbox),
                        "orientation": proposal.get("orientation"),
                        "target_semantics": proposal.get("target_semantics"),
                        "source_page": _source_page_binding(
                            proposal, page_payload, decoded
                        ),
                        "accepted_image": _direct_asset(
                            path=image_relative,
                            bbox=bbox,
                            payload=image_payload,
                        ),
                        "review_context": _direct_asset(
                            path=context_relative,
                            bbox=context_bbox,
                            payload=context_payload,
                        ),
                        "review_consensus": {
                            "v2_adjudication": copy.deepcopy(adjudication),
                            "completed_root_revision_review": (
                                {
                                    key: copy.deepcopy(value)
                                    for key, value in primary_row.items()
                                    if key != "row_sha256"
                                }
                                if primary_row
                                else None
                            ),
                            "independent_secondary_revision_review": (
                                copy.deepcopy(secondary_row) if secondary_row else None
                            ),
                        },
                        "bindings": _input_bindings(
                            builder_source_sha256=builder_source_sha256,
                            contract=contract,
                            proposal=proposal,
                            adjudication=adjudication,
                            completed_ledger=completed_ledger,
                            secondary_review=secondary_review,
                            primary_row=primary_row,
                            secondary_row=secondary_row,
                            revision=revision,
                        ),
                        "source_pixels": "hash_verified_library_page_only",
                        "training_eligible": True,
                        "accepted_for_downstream_training": True,
                        "merged_into_existing_dataset": False,
                    }
                )
            )
        finally:
            decoded.close()

    exclusion_rows: list[dict[str, Any]] = []
    for sample_id in sorted(contract["exclusion_ids"]):
        proposal = contract["proposals"][sample_id]
        adjudication = contract["adjudications"][sample_id]
        _, page_payload, decoded = v2._resolve_library_page(
            proposal, library_root, sample_id
        )
        try:
            exclusion_rows.append(
                seal(
                    {
                        "schema_version": SCHEMA_VERSION,
                        "record_type": "font_signal_terminal_exclusion",
                        "sample_id": sample_id,
                        "status": "terminal_exclusion_final",
                        "terminal_category": proposal.get("terminal_category"),
                        "rationale": proposal.get("rationale"),
                        "source_page": _source_page_binding(
                            proposal, page_payload, decoded
                        ),
                        "review_consensus": copy.deepcopy(adjudication),
                        "bindings": _input_bindings(
                            builder_source_sha256=builder_source_sha256,
                            contract=contract,
                            proposal=proposal,
                            adjudication=adjudication,
                            completed_ledger=completed_ledger,
                            secondary_review=secondary_review,
                            primary_row=None,
                            secondary_row=None,
                            revision=None,
                        ),
                        "training_eligible": False,
                        "excluded_from_downstream_training": True,
                        "merged_into_existing_dataset": False,
                    }
                )
            )
        finally:
            decoded.close()

    evidence_payloads = {
        COMPLETED_LEDGER_EVIDENCE: completed_ledger.read_bytes(),
        SECONDARY_REVIEW_EVIDENCE: secondary_review.read_bytes(),
        V2_ADJUDICATIONS_EVIDENCE: (
            adjudication_root / v2.ADJUDICATIONS_FILE
        ).read_bytes(),
        V2_REVISIONS_EVIDENCE: (adjudication_root / v2.REVISIONS_FILE).read_bytes(),
        V2_REPORT_EVIDENCE: (adjudication_root / v2.REPORT_FILE).read_bytes(),
        V2_MARKER_EVIDENCE: (adjudication_root / v2.MARKER_FILE).read_bytes(),
        PRIOR_PROPOSALS_EVIDENCE: (
            adjudication_root / v2.PRIOR_PROPOSALS_EVIDENCE_FILE
        ).read_bytes(),
    }
    for relative, payload in evidence_payloads.items():
        physical_root.joinpath(*PurePosixPath(relative).parts).write_bytes(payload)
    (physical_root / ACCEPTED_FILE).write_bytes(jsonl_bytes(accepted_rows))
    (physical_root / EXCLUSIONS_FILE).write_bytes(jsonl_bytes(exclusion_rows))

    acceptance_counts = Counter(row["acceptance_basis"] for row in accepted_rows)
    exclusion_counts = Counter(row["terminal_category"] for row in exclusion_rows)
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "font_signal_recrop_repair_final_report",
            "inputs": {
                "builder_source_sha256": builder_source_sha256,
                "v2_adjudication_root": str(adjudication_root),
                "v2_ownership_marker_sha256": contract["marker_sha256"],
                "v2_report_sha256": contract["report_sha256"],
                "v2_report_record_sha256": contract["report"]["record_sha256"],
                "v2_adjudications_sha256": contract["adjudications_sha256"],
                "v2_revisions_sha256": contract["revisions_sha256"],
                "prior_proposals_evidence_sha256": contract["proposals_sha256"],
                "completed_revision_ledger": {
                    "path": str(completed_ledger),
                    "sha256": sha256_file(completed_ledger),
                    "historical_blank_sha256": contract["historical_ledger_sha256"],
                },
                "secondary_revision_review": {
                    "path": str(secondary_review),
                    "sha256": sha256_file(secondary_review),
                },
                "library_root": str(library_root),
            },
            "counts": {
                "input_targets": expected_targets,
                "accepted_repairs": len(accepted_rows),
                "acceptance_basis": dict(sorted(acceptance_counts.items())),
                "terminal_exclusions": len(exclusion_rows),
                "terminal_categories": dict(sorted(exclusion_counts.items())),
                "root_revision_accepts": sum(
                    row["decision"] == "accept_revision" for row in primary.values()
                ),
                "secondary_revision_accepts": sum(
                    row["decision"] == "approve_revision" for row in secondary.values()
                ),
                "unresolved_or_disagreed": 0,
                "accepted_images": len(accepted_rows),
                "review_contexts": len(accepted_rows),
            },
            "outputs": {
                "accepted_repairs": ACCEPTED_FILE,
                "accepted_repairs_sha256": sha256_file(physical_root / ACCEPTED_FILE),
                "terminal_exclusions": EXCLUSIONS_FILE,
                "terminal_exclusions_sha256": sha256_file(
                    physical_root / EXCLUSIONS_FILE
                ),
                "evidence": {
                    relative: repair.sha256_bytes(payload)
                    for relative, payload in sorted(evidence_payloads.items())
                },
            },
            "finalization_policy": {
                "revision_acceptance_requires_root_and_secondary_consensus": True,
                "missing_reviews_fail_closed": True,
                "review_disagreements_fail_closed": True,
                "existing_consensus_accepts_preserved": True,
                "existing_terminal_exclusions_preserved": True,
                "source_pixels_recomputed_from_library": True,
            },
            "safety": {
                "v2_artifact_modified": False,
                "existing_accepted_datasets_modified": False,
                "source_pages_modified": False,
                "source_pixels": "hash_verified_library_pages_only",
                "qa_overlays_written": 0,
                "qa_overlays_used_as_pixels": 0,
                "synthetic_assets_written": 0,
                "generated_assets_written": 0,
            },
            "next_step": {
                "artifact_is_final_accepted_repair_input": True,
                "external_dataset_merge_performed": False,
                "downstream_ingestion_must_verify_this_report": True,
            },
            "declared_root": str(declared_root),
        }
    )
    (physical_root / REPORT_FILE).write_bytes(json_bytes(report, pretty=True))
    marker = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "safe_replace": False,
        "immutable": True,
        "declared_root": str(declared_root),
        "managed_files": _managed_files(physical_root),
    }
    (physical_root / MARKER_FILE).write_bytes(json_bytes(marker, pretty=True))
    return report


def _validate_output_marker(
    root: Path, *, expected_declared_root: Path
) -> dict[str, Any]:
    if v2._is_link_or_junction(root) or not root.is_dir():
        raise FontSignalFinalizationError("final output root is missing or unsafe")
    marker = repair.read_json(root / MARKER_FILE, "final ownership marker")
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("owner") != OWNER
        or marker.get("safe_replace") is not False
        or marker.get("immutable") is not True
        or Path(str(marker.get("declared_root"))).resolve()
        != expected_declared_root.resolve()
    ):
        raise FontSignalFinalizationError("final ownership marker is invalid")
    managed = marker.get("managed_files")
    if not isinstance(managed, Mapping) or not managed:
        raise FontSignalFinalizationError("final marker lacks managed files")
    expected = {MARKER_FILE}
    for relative, expected_sha in managed.items():
        safe = v2._safe_relative_path(relative, f"final marker[{relative}]")
        expected.add(safe.as_posix())
        repair.require_sha(expected_sha, f"final marker[{relative}].sha256")
        physical = root.joinpath(*safe.parts)
        if not physical.is_file() or sha256_file(physical) != expected_sha:
            raise FontSignalFinalizationError(
                f"final managed artifact is stale/tampered: {relative}"
            )
    actual = v2._regular_file_inventory(root)
    if actual != expected:
        raise FontSignalFinalizationError(
            "final managed inventory differs; "
            f"missing={sorted(expected-actual)[:8]} "
            f"unexpected={sorted(actual-expected)[:8]}"
        )
    return marker


def validate_tree(
    *,
    root: Path,
    declared_root: Path,
    adjudication_root: Path,
    completed_ledger: Path,
    secondary_review: Path,
    library_root: Path,
    expected_targets: int,
    expected_prior_accepts: int,
    expected_revisions: int,
    expected_exclusions: int,
) -> dict[str, Any]:
    _validate_root_separation(
        output_root=declared_root,
        adjudication_root=adjudication_root,
        library_root=library_root,
    )
    _validate_output_marker(root, expected_declared_root=declared_root)
    contract = _load_v2_contract(
        adjudication_root=adjudication_root,
        completed_ledger=completed_ledger,
        secondary_review=secondary_review,
        library_root=library_root,
        expected_targets=expected_targets,
        expected_prior_accepts=expected_prior_accepts,
        expected_revisions=expected_revisions,
        expected_exclusions=expected_exclusions,
    )
    primary = _load_completed_ledger(completed_ledger, contract["revisions"])
    secondary = _load_secondary_reviews(secondary_review, contract["revisions"])
    _require_unanimous_revision_accepts(primary=primary, secondary=secondary)

    evidence_expected = {
        COMPLETED_LEDGER_EVIDENCE: completed_ledger.read_bytes(),
        SECONDARY_REVIEW_EVIDENCE: secondary_review.read_bytes(),
        V2_ADJUDICATIONS_EVIDENCE: (
            adjudication_root / v2.ADJUDICATIONS_FILE
        ).read_bytes(),
        V2_REVISIONS_EVIDENCE: (adjudication_root / v2.REVISIONS_FILE).read_bytes(),
        V2_REPORT_EVIDENCE: (adjudication_root / v2.REPORT_FILE).read_bytes(),
        V2_MARKER_EVIDENCE: (adjudication_root / v2.MARKER_FILE).read_bytes(),
        PRIOR_PROPOSALS_EVIDENCE: (
            adjudication_root / v2.PRIOR_PROPOSALS_EVIDENCE_FILE
        ).read_bytes(),
    }
    for relative, expected in evidence_expected.items():
        path = root.joinpath(*PurePosixPath(relative).parts)
        if path.read_bytes() != expected:
            raise FontSignalFinalizationError(
                f"final evidence snapshot differs: {relative}"
            )

    accepted = _unique(
        _read_jsonl(root / ACCEPTED_FILE, "final accepted repairs"),
        "sample_id",
        "final accepted repairs",
    )
    exclusions = _unique(
        _read_jsonl(root / EXCLUSIONS_FILE, "final terminal exclusions"),
        "sample_id",
        "final terminal exclusions",
    )
    accepted_ids = contract["prior_accept_ids"] | contract["revision_ids"]
    if (
        set(accepted) != accepted_ids
        or set(exclusions) != contract["exclusion_ids"]
        or set(accepted) & set(exclusions)
        or set(accepted) | set(exclusions) != set(contract["adjudications"])
    ):
        raise FontSignalFinalizationError("final target projections drifted")

    for sample_id, record in accepted.items():
        try:
            repair.validate_seal(record, f"accepted repair[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalFinalizationError(str(error)) from error
        proposal = contract["proposals"][sample_id]
        revision = contract["revisions"].get(sample_id)
        expected_bbox = _require_bbox(
            (
                revision.get("revision_bbox_px")
                if revision
                else proposal.get("recrop_bbox_px")
            ),
            f"accepted repair[{sample_id}].expected_bbox",
        )
        expected_context_bbox = _require_bbox(
            (
                revision["revision_context"].get("bbox_px")
                if revision
                else proposal["source_context"].get("bbox_px")
            ),
            f"accepted repair[{sample_id}].expected_context_bbox",
        )
        _, page_payload, decoded = v2._resolve_library_page(
            proposal, library_root, sample_id
        )
        try:
            if (
                record.get("schema_version") != SCHEMA_VERSION
                or record.get("record_type") != "font_signal_accepted_repair"
                or record.get("status") != "accepted_repair_final"
                or record.get("accepted_bbox_px") != list(expected_bbox)
                or record.get("training_eligible") is not True
                or record.get("accepted_for_downstream_training") is not True
                or record.get("merged_into_existing_dataset") is not False
            ):
                raise FontSignalFinalizationError(
                    f"accepted repair[{sample_id}]: unsafe final contract"
                )
            source = record.get("source_page")
            if (
                not isinstance(source, Mapping)
                or source.get("path") != proposal["source_page"]["path"]
                or source.get("file_sha256") != repair.sha256_bytes(page_payload)
                or source.get("size_bytes") != len(page_payload)
                or source.get("size_px") != [decoded.width, decoded.height]
                or source.get("provenance") != "real_preserved"
            ):
                raise FontSignalFinalizationError(
                    f"accepted repair[{sample_id}]: source binding drifted"
                )
            for key, expected_bbox_for_asset in (
                ("accepted_image", expected_bbox),
                ("review_context", expected_context_bbox),
            ):
                asset = record.get(key)
                if not isinstance(asset, Mapping):
                    raise FontSignalFinalizationError(
                        f"accepted repair[{sample_id}].{key}: asset missing"
                    )
                bbox = _require_bbox(
                    asset.get("bbox_px"),
                    f"accepted repair[{sample_id}].{key}.bbox_px",
                )
                expected_payload = v1._png_crop(decoded, bbox)
                path = v2._safe_managed_path(
                    root,
                    asset.get("path"),
                    f"accepted repair[{sample_id}].{key}.path",
                )
                if (
                    bbox != expected_bbox_for_asset
                    or not path.is_file()
                    or path.read_bytes() != expected_payload
                    or asset.get("file_sha256") != repair.sha256_bytes(expected_payload)
                    or asset.get("pixel_source")
                    != "direct_hash_verified_library_page_crop"
                    or asset.get("qa_overlay") is not False
                    or asset.get("synthetic") is not False
                    or asset.get("generated") is not False
                ):
                    raise FontSignalFinalizationError(
                        f"accepted repair[{sample_id}].{key}: pixel drifted"
                    )
        finally:
            decoded.close()

    for sample_id, record in exclusions.items():
        try:
            repair.validate_seal(record, f"terminal exclusion[{sample_id}]")
        except repair.RecropRepairError as error:
            raise FontSignalFinalizationError(str(error)) from error
        proposal = contract["proposals"][sample_id]
        if (
            record.get("schema_version") != SCHEMA_VERSION
            or record.get("record_type") != "font_signal_terminal_exclusion"
            or record.get("status") != "terminal_exclusion_final"
            or record.get("terminal_category") != proposal.get("terminal_category")
            or record.get("training_eligible") is not False
            or record.get("excluded_from_downstream_training") is not True
            or record.get("merged_into_existing_dataset") is not False
        ):
            raise FontSignalFinalizationError(
                f"terminal exclusion[{sample_id}]: unsafe final contract"
            )

    report = repair.read_json(root / REPORT_FILE, "final report")
    try:
        repair.validate_seal(report, "final report")
    except repair.RecropRepairError as error:
        raise FontSignalFinalizationError(str(error)) from error
    inputs = report.get("inputs")
    counts = report.get("counts")
    outputs = report.get("outputs")
    if (
        not isinstance(inputs, Mapping)
        or inputs.get("builder_source_sha256") != sha256_file(Path(__file__).resolve())
        or inputs.get("completed_revision_ledger", {}).get("sha256")
        != sha256_file(completed_ledger)
        or inputs.get("secondary_revision_review", {}).get("sha256")
        != sha256_file(secondary_review)
        or not isinstance(counts, Mapping)
        or counts.get("input_targets") != expected_targets
        or counts.get("accepted_repairs") != expected_prior_accepts + expected_revisions
        or counts.get("terminal_exclusions") != expected_exclusions
        or counts.get("root_revision_accepts") != expected_revisions
        or counts.get("secondary_revision_accepts") != expected_revisions
        or counts.get("unresolved_or_disagreed") != 0
        or not isinstance(outputs, Mapping)
        or outputs.get("accepted_repairs_sha256") != sha256_file(root / ACCEPTED_FILE)
        or outputs.get("terminal_exclusions_sha256")
        != sha256_file(root / EXCLUSIONS_FILE)
    ):
        raise FontSignalFinalizationError("final report bindings drifted")
    return report


def _compare_trees(expected_root: Path, actual_root: Path) -> None:
    expected = {
        relative: expected_root.joinpath(*PurePosixPath(relative).parts).read_bytes()
        for relative in v2._regular_file_inventory(expected_root)
    }
    actual = {
        relative: actual_root.joinpath(*PurePosixPath(relative).parts).read_bytes()
        for relative in v2._regular_file_inventory(actual_root)
    }
    if expected.keys() != actual.keys():
        raise FontSignalFinalizationError(
            "deterministic rebuild file inventory differs"
        )
    stale = [name for name in expected if expected[name] != actual[name]]
    if stale:
        raise FontSignalFinalizationError(f"deterministic rebuild differs: {stale[:8]}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "validate"))
    parser.add_argument("--adjudication-root", type=Path, required=True)
    parser.add_argument("--completed-revision-ledger", type=Path, required=True)
    parser.add_argument("--secondary-revision-review", type=Path, required=True)
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--expected-targets", type=int, default=27)
    parser.add_argument("--expected-prior-accepts", type=int, default=16)
    parser.add_argument("--expected-revisions", type=int, default=4)
    parser.add_argument("--expected-exclusions", type=int, default=7)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        inputs = {
            "adjudication_root": args.adjudication_root.expanduser().resolve(),
            "completed_ledger": args.completed_revision_ledger.expanduser().resolve(),
            "secondary_review": args.secondary_revision_review.expanduser().resolve(),
            "library_root": args.library_root.expanduser().resolve(),
            "declared_root": args.output_root.expanduser().resolve(),
            "expected_targets": args.expected_targets,
            "expected_prior_accepts": args.expected_prior_accepts,
            "expected_revisions": args.expected_revisions,
            "expected_exclusions": args.expected_exclusions,
        }
        output_root = inputs["declared_root"]
        if args.command == "build":
            if output_root.exists():
                raise FontSignalFinalizationError(
                    f"refusing to overwrite final output root: {output_root}"
                )
            output_root.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(
                tempfile.mkdtemp(
                    prefix=f".{output_root.name}.staging-", dir=output_root.parent
                )
            )
            shutil.rmtree(staging)
            try:
                report = _write_tree(physical_root=staging, **inputs)
                validate_tree(root=staging, **inputs)
                staging.replace(output_root)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        else:
            report = validate_tree(root=output_root, **inputs)
            staging = Path(tempfile.mkdtemp(prefix="font-signal-final-validate-"))
            shutil.rmtree(staging)
            try:
                _write_tree(physical_root=staging, **inputs)
                _compare_trees(output_root, staging)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except (
        FontSignalFinalizationError,
        v2.FontSignalAdjudicationError,
        v1.FontSignalRepairError,
        repair.RecropRepairError,
        OSError,
        ValueError,
    ) as error:
        print(f"font-signal recrop finalization error: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
