#!/usr/bin/env python3
"""Aggregate finalized human labels into conservative work typography profiles.

This is an offline builder, not an auto-labeler.  It requires sealed final
records and emits an anchor only when enough high-confidence ordinary dialogue
examples agree with a useful margin.  Ambiguous works intentionally keep a
null anchor so the product abstains instead of overfitting a title or genre.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = "font-matching-work-profile-build-v1"
RECORD_TYPE = "font_matching_work_profile_build_record"
REPORT_TYPE = "font_matching_work_profile_build_report"
ANCHOR_ROLES = ("dialogue", "narration", "thought")
PALETTE_ROLES = (
    "whisper",
    "aside_balloon_edge",
    "emphasis_dialogue",
    "shout",
    "sfx_impact",
    "sfx_motion",
    "sfx_ambient",
    "sfx_emotion",
    "sfx_comic",
    "sign_ui_title",
    "other",
)
TIER_SCORE = {
    "preferred": 1.0,
    "acceptable": 0.75,
    "marginal": 0.25,
    "unacceptable": 0.0,
}


class WorkProfileError(ValueError):
    """Raised when final labels cannot safely produce work profiles."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    rendered = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
        if pretty
        else canonical_json(value)
    )
    return (rendered + "\n").encode("utf-8")


def jsonl_bytes(rows: Iterable[Mapping[str, Any]]) -> bytes:
    return b"".join(json_bytes(dict(row)) for row in rows)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkProfileError(f"{location}: expected an object")
    return value


def require_text(value: Any, *, location: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized:
        raise WorkProfileError(f"{location}: expected non-empty text")
    return normalized


def require_bounded_text(value: Any, *, location: str, maximum: int = 200) -> str:
    normalized = require_text(value, location=location)
    if len(normalized) > maximum:
        raise WorkProfileError(f"{location}: text exceeds {maximum} characters")
    return normalized


def require_store_id(value: Any, *, location: str) -> str:
    normalized = require_bounded_text(value, location=location)
    if normalized in {".", ".."} or "/" in normalized or "\\" in normalized:
        raise WorkProfileError(f"{location}: invalid store id")
    return normalized


def require_positive_integer(value: Any, *, location: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WorkProfileError(f"{location}: expected a positive integer")
    return value


def require_probability(value: Any, *, location: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or not 0 <= float(value) <= 1
    ):
        raise WorkProfileError(f"{location}: expected probability")
    return float(value)


def require_sha(value: Any, *, location: str) -> str:
    normalized = require_text(value, location=location).lower()
    if len(normalized) != 64 or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise WorkProfileError(f"{location}: expected lowercase SHA-256")
    return normalized


def require_timestamp(value: Any, *, location: str) -> datetime:
    normalized = require_text(value, location=location)
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as error:
        raise WorkProfileError(f"{location}: expected an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise WorkProfileError(f"{location}: timestamp must include an offset")
    return parsed.astimezone(timezone.utc)


def read_jsonl(path: Path, *, location: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                rows.append(
                    dict(require_mapping(value, location=f"{location}:{line_number}"))
                )
    except (OSError, json.JSONDecodeError) as error:
        raise WorkProfileError(f"could not read {location}: {error}") from error
    if not rows:
        raise WorkProfileError(f"{location}: no records")
    return rows


def _seal(value: Mapping[str, Any]) -> dict[str, Any]:
    core = dict(value)
    return {
        **core,
        "record_sha256": sha256_bytes(canonical_json(core).encode("utf-8")),
    }


def _validate_final_seal(value: Mapping[str, Any], *, location: str) -> None:
    expected = require_text(
        value.get("record_sha256"), location=f"{location}.record_sha256"
    )
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise WorkProfileError(f"{location}: final record seal mismatch")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
        handle.flush()
    temporary.replace(path)


def _candidate_universe(row: Mapping[str, Any], *, location: str) -> frozenset[str]:
    judgment = require_mapping(
        row.get("font_judgment"), location=f"{location}.font_judgment"
    )
    candidates: list[str] = []
    for tier in (*TIER_SCORE, "unrenderable", "not_reviewed"):
        values = judgment.get(tier)
        if not isinstance(values, list):
            raise WorkProfileError(f"{location}.font_judgment.{tier}: expected array")
        candidates.extend(
            require_bounded_text(value, location=f"{location}.font_judgment.{tier}")
            for value in values
        )
    if len(candidates) != len(set(candidates)):
        raise WorkProfileError(f"{location}: candidate tiers overlap")
    if judgment.get("not_reviewed"):
        raise WorkProfileError(
            f"{location}: final record still has unreviewed candidates"
        )
    return frozenset(candidates)


def _eligible(
    row: Mapping[str, Any],
    *,
    role: str,
    consistency_policy: str,
) -> bool:
    role_value = require_mapping(row.get("role"), location="final.role")
    resolution = require_mapping(row.get("resolution"), location="final.resolution")
    consistency = require_mapping(row.get("consistency"), location="final.consistency")
    judgment = require_mapping(row.get("font_judgment"), location="final.font_judgment")
    return (
        role_value.get("primary") == role
        and require_probability(
            role_value.get("confidence"), location="final.role.confidence"
        )
        >= 0.9
        and require_probability(
            resolution.get("confidence"), location="final.resolution.confidence"
        )
        >= 0.8
        and consistency.get("policy") == consistency_policy
        and judgment.get("none_acceptable") is False
    )


def _candidate_scores(
    rows: Sequence[Mapping[str, Any]], candidate_ids: Sequence[str]
) -> tuple[dict[str, float], float]:
    totals: Counter[str] = Counter()
    denominators: Counter[str] = Counter()
    evidence_confidences: list[float] = []
    for row in rows:
        role = require_mapping(row["role"], location="role")
        resolution = require_mapping(row["resolution"], location="resolution")
        evidence_confidences.append(
            min(float(role["confidence"]), float(resolution["confidence"]))
        )
        judgment = require_mapping(row["font_judgment"], location="font_judgment")
        skipped = set(judgment["unrenderable"]) | set(judgment["not_reviewed"])
        tier_by_candidate = {
            str(candidate): tier for tier in TIER_SCORE for candidate in judgment[tier]
        }
        for candidate_id in candidate_ids:
            if candidate_id in skipped:
                continue
            denominators[candidate_id] += 1
            totals[candidate_id] += TIER_SCORE[tier_by_candidate[candidate_id]]
    scores = {
        candidate_id: (
            totals[candidate_id] / denominators[candidate_id]
            if denominators[candidate_id]
            else 0.0
        )
        for candidate_id in candidate_ids
    }
    return scores, sum(evidence_confidences) / len(evidence_confidences)


def _rank_scores(scores: Mapping[str, float]) -> list[tuple[str, float]]:
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def _consensus_confidence(top: float, margin: float, evidence: float) -> float:
    consensus = min(1.0, 0.45 + top * 0.4 + margin * 0.6)
    return round(min(evidence, consensus), 6)


def _build_anchor(
    rows: Sequence[Mapping[str, Any]],
    *,
    candidate_ids: Sequence[str],
    minimum_evidence: int,
) -> dict[str, Any] | None:
    if len(rows) < minimum_evidence:
        return None
    scores, evidence_confidence = _candidate_scores(rows, candidate_ids)
    ranked = _rank_scores(scores)
    top_id, top_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    margin = top_score - second_score
    if top_score < 0.65 or margin < 0.08:
        return None
    allowed = [
        candidate_id
        for candidate_id, score in ranked
        if score >= 0.65 and score >= top_score - 0.15
    ][:3]
    return {
        "primaryFontId": top_id,
        "allowedFontIds": allowed,
        "origin": "learned",
        "evidenceCount": len(rows),
        "confidence": _consensus_confidence(top_score, margin, evidence_confidence),
        "replacementPolicy": {
            "minimumEvidenceCount": minimum_evidence,
            "minimumScoreMargin": 0.1,
        },
        "updatedAt": _latest_timestamp(rows),
    }


def _build_palette(
    role: str,
    rows: Sequence[Mapping[str, Any]],
    *,
    candidate_ids: Sequence[str],
    minimum_evidence: int,
) -> dict[str, Any] | None:
    if len(rows) < minimum_evidence:
        return None
    scores, evidence_confidence = _candidate_scores(rows, candidate_ids)
    ranked = _rank_scores(scores)
    top_score = ranked[0][1]
    allowed = [
        candidate_id
        for candidate_id, score in ranked
        if score >= 0.5 and score >= top_score - 0.25
    ][:4]
    if len(allowed) < 2:
        return None
    confidence = round(min(evidence_confidence, 0.45 + top_score * 0.5), 6)
    return {
        "role": role,
        "allowedFontIds": allowed,
        "maxDistinctFonts": len(allowed),
        "reuseVisualClusterFont": True,
        "evidenceCount": len(rows),
        "confidence": confidence,
    }


def _latest_timestamp(rows: Sequence[Mapping[str, Any]]) -> str:
    values = [
        require_timestamp(
            require_mapping(row["resolution"], location="resolution").get(
                "resolved_at"
            ),
            location="resolution.resolved_at",
        )
        for row in rows
    ]
    return max(values).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_profiles(
    *,
    final_labels: Path,
    output: Path,
    report_output: Path,
    runtime_catalog_version: str,
    runtime_model_version: str,
    runtime_renderer_hash: str,
    expected_finals: int | None = None,
    minimum_dialogue_evidence: int = 20,
    minimum_secondary_anchor_evidence: int = 8,
    minimum_palette_evidence: int = 3,
    vertical_only_font_ids: frozenset[str] = frozenset({"seoul-namsan-vertical"}),
) -> dict[str, Any]:
    normalized_catalog_version = require_bounded_text(
        runtime_catalog_version, location="runtime_catalog_version"
    )
    normalized_model_version = require_bounded_text(
        runtime_model_version, location="runtime_model_version"
    )
    normalized_renderer_hash = require_sha(
        runtime_renderer_hash, location="runtime_renderer_hash"
    )
    minimum_dialogue_evidence = require_positive_integer(
        minimum_dialogue_evidence, location="minimum_dialogue_evidence"
    )
    minimum_secondary_anchor_evidence = require_positive_integer(
        minimum_secondary_anchor_evidence,
        location="minimum_secondary_anchor_evidence",
    )
    minimum_palette_evidence = require_positive_integer(
        minimum_palette_evidence, location="minimum_palette_evidence"
    )
    if expected_finals is not None:
        expected_finals = require_positive_integer(
            expected_finals, location="expected_finals"
        )
    finals = read_jsonl(final_labels, location="final labels")
    if expected_finals is not None and len(finals) != expected_finals:
        raise WorkProfileError(f"expected {expected_finals} finals, got {len(finals)}")
    sample_ids: set[str] = set()
    universes: set[frozenset[str]] = set()
    source_catalog_versions: set[str] = set()
    source_catalog_hashes: set[str] = set()
    source_renderer_hashes: set[str] = set()
    by_work: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(finals, 1):
        location = f"finals[{index}]"
        _validate_final_seal(row, location=location)
        if row.get("record_type") != "manga_font_label_final":
            raise WorkProfileError(f"{location}: unsupported record type")
        sample_id = require_text(row.get("sample_id"), location=f"{location}.sample_id")
        if sample_id in sample_ids:
            raise WorkProfileError(f"duplicate final sample: {sample_id}")
        sample_ids.add(sample_id)
        work_id = require_store_id(row.get("work_id"), location=f"{location}.work_id")
        resolution = require_mapping(
            row.get("resolution"), location=f"{location}.resolution"
        )
        source_catalog_versions.add(
            require_bounded_text(
                resolution.get("catalog_version"),
                location=f"{location}.resolution.catalog_version",
            )
        )
        source_catalog_hashes.add(
            require_sha(
                resolution.get("catalog_sha256"),
                location=f"{location}.resolution.catalog_sha256",
            )
        )
        source_renderer_hashes.add(
            require_sha(
                resolution.get("renderer_hash"),
                location=f"{location}.resolution.renderer_hash",
            )
        )
        require_timestamp(
            resolution.get("resolved_at"),
            location=f"{location}.resolution.resolved_at",
        )
        universes.add(_candidate_universe(row, location=location))
        by_work[work_id].append(row)
    if len(universes) != 1:
        raise WorkProfileError("final labels do not share one candidate universe")
    candidate_ids = tuple(sorted(next(iter(universes))))
    if not candidate_ids:
        raise WorkProfileError("final labels have an empty candidate universe")
    if (
        len(source_catalog_versions) != 1
        or len(source_catalog_hashes) != 1
        or len(source_renderer_hashes) != 1
    ):
        raise WorkProfileError(
            "final labels do not share one source catalog and renderer contract"
        )
    unknown_vertical = vertical_only_font_ids - set(candidate_ids)
    if unknown_vertical:
        raise WorkProfileError(
            f"unknown vertical-only fonts: {sorted(unknown_vertical)}"
        )

    profile_records: list[dict[str, Any]] = []
    anchor_counts: Counter[str] = Counter()
    palette_count = 0
    for work_id in sorted(by_work):
        rows = by_work[work_id]
        anchors: dict[str, dict[str, Any] | None] = {}
        for role in ANCHOR_ROLES:
            eligible = [
                row
                for row in rows
                if _eligible(row, role=role, consistency_policy="inherit_work_anchor")
            ]
            minimum = (
                minimum_dialogue_evidence
                if role == "dialogue"
                else minimum_secondary_anchor_evidence
            )
            anchors[role] = _build_anchor(
                eligible,
                candidate_ids=candidate_ids,
                minimum_evidence=minimum,
            )
            if anchors[role] is not None:
                anchor_counts[role] += 1
        palettes: list[dict[str, Any]] = []
        for role in PALETTE_ROLES:
            eligible = [
                row
                for row in rows
                if _eligible(row, role=role, consistency_policy="intentional_override")
            ]
            palette = _build_palette(
                role,
                eligible,
                candidate_ids=candidate_ids,
                minimum_evidence=minimum_palette_evidence,
            )
            if palette is not None:
                palettes.append(palette)
        palette_count += len(palettes)
        timestamp = _latest_timestamp(rows)
        dialogue_anchor = anchors["dialogue"]
        component_confidences = [
            component["confidence"]
            for component in (*anchors.values(), *palettes)
            if component is not None
        ]
        profile = {
            "schemaVersion": 2,
            "workId": work_id,
            "dialogueAnchor": dialogue_anchor,
            "narrationAnchor": anchors["narration"],
            "thoughtAnchor": anchors["thought"],
            "rolePalettes": palettes,
            "intentionalOverrides": [],
            "userLocks": [],
            "orientationPolicy": {
                "horizontalAllowedFontIds": [
                    candidate_id
                    for candidate_id in candidate_ids
                    if candidate_id not in vertical_only_font_ids
                ],
                "verticalAllowedFontIds": list(candidate_ids),
                "verticalOnlyFontIds": sorted(vertical_only_font_ids),
            },
            "consistencyPolicy": {
                "reuseBodyAnchors": True,
                "requireIntentionalOverrideForBodySwitch": True,
                "reuseVisualClusterFont": True,
                "maxAccentFontsPerRole": 4,
            },
            "genrePrior": None,
            "evidenceCount": len(rows),
            "confidence": max(component_confidences, default=0),
            "catalogVersion": normalized_catalog_version,
            "modelVersion": normalized_model_version,
            "rendererHash": normalized_renderer_hash,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
        source_ids = sorted(str(row["sample_id"]) for row in rows)
        profile_records.append(
            _seal(
                {
                    "schema_version": SCHEMA_VERSION,
                    "record_type": RECORD_TYPE,
                    "work_id": work_id,
                    "profile": profile,
                    "source_sample_ids": source_ids,
                    "source_final_record_sha256s": sorted(
                        str(row["record_sha256"]) for row in rows
                    ),
                }
            )
        )
    payload = jsonl_bytes(profile_records)
    report = _seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": REPORT_TYPE,
            "counts": {
                "finals": len(finals),
                "works": len(profile_records),
                "candidate_families": len(candidate_ids),
                "anchors": dict(sorted(anchor_counts.items())),
                "palettes": palette_count,
                "null_dialogue_anchors": sum(
                    record["profile"]["dialogueAnchor"] is None
                    for record in profile_records
                ),
            },
            "candidate_ids": list(candidate_ids),
            "hashes": {
                "final_labels_sha256": sha256_file(final_labels),
                "profiles_sha256": sha256_bytes(payload),
            },
            "source_evidence_contract": {
                "catalog_version": next(iter(source_catalog_versions)),
                "catalog_sha256": next(iter(source_catalog_hashes)),
                "renderer_hash": next(iter(source_renderer_hashes)),
            },
            "runtime_profile_contract": {
                "catalog_version": normalized_catalog_version,
                "model_version": normalized_model_version,
                "renderer_hash": normalized_renderer_hash,
            },
            "safety": {
                "work_titles_used": False,
                "genre_prior_profiles": 0,
                "automatic_anchor_without_minimum_evidence": 0,
                "unreviewed_candidates": 0,
            },
        }
    )
    _atomic_write(output, payload)
    _atomic_write(report_output, json_bytes(report, pretty=True))
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-labels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    parser.add_argument("--runtime-catalog-version", required=True)
    parser.add_argument("--runtime-model-version", required=True)
    parser.add_argument("--runtime-renderer-hash", required=True)
    parser.add_argument("--expected-finals", type=int)
    parser.add_argument("--minimum-dialogue-evidence", type=int, default=20)
    parser.add_argument("--minimum-secondary-anchor-evidence", type=int, default=8)
    parser.add_argument("--minimum-palette-evidence", type=int, default=3)
    parser.add_argument(
        "--vertical-only-font-id",
        action="append",
        dest="vertical_only_font_ids",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = build_profiles(
            final_labels=args.final_labels.resolve(),
            output=args.output.resolve(),
            report_output=args.report_output.resolve(),
            runtime_catalog_version=args.runtime_catalog_version,
            runtime_model_version=args.runtime_model_version,
            runtime_renderer_hash=args.runtime_renderer_hash,
            expected_finals=args.expected_finals,
            minimum_dialogue_evidence=args.minimum_dialogue_evidence,
            minimum_secondary_anchor_evidence=args.minimum_secondary_anchor_evidence,
            minimum_palette_evidence=args.minimum_palette_evidence,
            vertical_only_font_ids=frozenset(
                args.vertical_only_font_ids or {"seoul-namsan-vertical"}
            ),
        )
    except WorkProfileError as error:
        print(f"error: {error}")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
