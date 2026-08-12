#!/usr/bin/env python3
"""Build a conservative r7-assisted refinement of the active21 pseudo pool.

The tool has two deliberately separate products:

* a sealed, diagnostic-only prediction bundle for all 28,094 master-v3 rows;
* a loader-compatible pseudo bundle containing only the existing 18,952 train
  pseudo identities.

R7 is evidence, never label authority.  Agent/human reviewed identities are
preserved byte-for-byte at the record level, master val/test rows are never
written to the pseudo target file, and the role-conditioned prior is derived
only from sealed training-only reviewed labels.  Single Day is hard-negative
evidence for body/bubble-edge rows and remains available for credible SFX or
specialist consensus.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from scripts import ablate_manga_font_v2_candidate_score_ensembles as ablation
    from scripts import build_manga_font_student_v8_role_family_dataset as dataset
    from scripts import refine_manga_font_v2_pseudo_labels as refinement
    from scripts import seal_manga_font_v2_high_value_supervised_labels as high_value
except ImportError:  # pragma: no cover - direct execution from scripts/
    import ablate_manga_font_v2_candidate_score_ensembles as ablation
    import build_manga_font_student_v8_role_family_dataset as dataset
    import refine_manga_font_v2_pseudo_labels as refinement
    import seal_manga_font_v2_high_value_supervised_labels as high_value


SCHEMA = "manga-font-v2-pseudo-refinement-r2-v1"
INFERENCE_SCHEMA = "manga-font-v2-r7-master-predictions-v1"
INFERENCE_OWNER = "carrot-manga-translator/manga-font-v2-r7-master-predictions-v1"
INFERENCE_MARKER = ".manga-font-v2-r7-master-predictions-owned.json"
INFERENCE_ARCHIVE = "predictions.npz"
INFERENCE_MANIFEST = "manifest.json"
INFERENCE_REPORT = "report.json"
INFERENCE_FILES = frozenset(
    {INFERENCE_MARKER, INFERENCE_ARCHIVE, INFERENCE_MANIFEST, INFERENCE_REPORT}
)
EXPECTED_MASTER_ROWS = 28_094
EXPECTED_PSEUDO_ROWS = 18_952
EXPECTED_SPLITS = {"train": 19_664, "val": 4_218, "test": 4_212}
SINGLE_DAY_ID = "single-day"
BODY_HARD_NEGATIVE_ROLES = frozenset({"dialogue", "narration", "thought"})
SPECIALIST_ROLES = frozenset(
    {"emphasis_dialogue", "sfx_impact", "shout", "sign_ui_title"}
)
SOURCE_ROLE: Mapping[str, str] = {
    "ordinary": "dialogue",
    "page_sound": "sfx_impact",
    "text_free": "emphasis_dialogue",
    "bubble_edge": "aside_balloon_edge",
    "ocr_hard": "emphasis_dialogue",
    "ocr_anime_region": "emphasis_dialogue",
    "font_signal_present": "emphasis_dialogue",
}


class PseudoRefinementR2Error(ValueError):
    """Raised when a sealed input, split, or authority boundary drifts."""


@dataclass(frozen=True)
class MasterRow:
    sample_id: str
    split: str
    work_id: str
    work_title: str
    source_category: str
    master_line_sha256: str
    master_row_sha256: str


@dataclass(frozen=True)
class ReviewRow:
    sample_id: str
    split: str
    work_id: str
    source_category: str
    master_row_sha256: str
    record_sha256: str
    probabilities: np.ndarray
    confidence: float
    top1_disagreement: float


@dataclass(frozen=True)
class CacheBinding:
    cache_index: int


@dataclass(frozen=True)
class EnsembleDecision:
    probabilities: np.ndarray
    weights: Mapping[str, float]
    agreement: str
    top1_guard: str
    single_day_policy: str
    single_day_multiplier: float
    weight_multiplier: float


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        return (
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")
    return (canonical_json(value) + "\n").encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal_record(value: Mapping[str, Any]) -> dict[str, Any]:
    row = copy.deepcopy(dict(value))
    row.pop("record_sha256", None)
    row["record_sha256"] = sha256_bytes(canonical_json(row).encode("utf-8"))
    return row


def validate_record_seal(value: Mapping[str, Any], location: str) -> None:
    expected = value.get("record_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise PseudoRefinementR2Error(f"{location}: invalid record seal")
    core = {key: item for key, item in value.items() if key != "record_sha256"}
    if sha256_bytes(canonical_json(core).encode("utf-8")) != expected:
        raise PseudoRefinementR2Error(f"{location}: record seal drifted")


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PseudoRefinementR2Error(f"{location}: expected object")
    return value


def _sequence(value: Any, location: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise PseudoRefinementR2Error(f"{location}: expected array")
    return value


def _text(value: Any, location: str) -> str:
    result = value.strip() if isinstance(value, str) else ""
    if not result:
        raise PseudoRefinementR2Error(f"{location}: expected text")
    return result


def _read_json(path: Path, location: str) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise PseudoRefinementR2Error(f"{location}: missing regular file")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PseudoRefinementR2Error(f"{location}: invalid JSON") from error
    return dict(_mapping(value, location))


def _iter_jsonl(path: Path, location: str) -> Iterable[dict[str, Any]]:
    resolved = path.expanduser().resolve()
    if resolved.is_symlink() or not resolved.is_file():
        raise PseudoRefinementR2Error(f"{location}: missing regular file")
    with resolved.open(encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise PseudoRefinementR2Error(
                    f"{location}:{line_number}: invalid JSON"
                ) from error
            yield dict(_mapping(value, f"{location}:{line_number}"))


def _safe_new_output(path: Path) -> Path:
    result = path.expanduser().resolve()
    forbidden = {Path.cwd().resolve(), Path.home().resolve(), Path(result.anchor)}
    if result in forbidden or len(result.parts) < 3 or len(result.name) < 3:
        raise PseudoRefinementR2Error(f"unsafe output directory: {result}")
    if result.exists():
        raise PseudoRefinementR2Error(f"output already exists: {result}")
    result.parent.mkdir(parents=True, exist_ok=True)
    return result


def _descriptor(path: Path, *, row_count: int | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "byte_size": path.stat().st_size,
        "file": path.name,
        "sha256": sha256_file(path),
    }
    if row_count is not None:
        result["row_count"] = int(row_count)
    return result


def _ordered_sha(values: Iterable[str]) -> str:
    return sha256_bytes(("\n".join(values) + "\n").encode("utf-8"))


def _normalize(values: Sequence[float] | np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64)
    if result.ndim != 1 or not np.isfinite(result).all() or np.any(result < 0.0):
        raise PseudoRefinementR2Error("probability vector is invalid")
    total = float(result.sum())
    if total <= 0.0:
        raise PseudoRefinementR2Error("probability vector has zero mass")
    result = result / total
    result[-1] += 1.0 - float(result.sum())
    return result


def _softmax(values: np.ndarray) -> np.ndarray:
    source = values.astype(np.float64, copy=False)
    shifted = source - source.max(axis=1, keepdims=True)
    result = np.exp(shifted)
    result /= result.sum(axis=1, keepdims=True)
    return result.astype(np.float32)


def _entropy(probabilities: np.ndarray) -> np.ndarray:
    values = np.asarray(probabilities, dtype=np.float64)
    return -np.sum(values * np.log(np.clip(values, 1e-12, None)), axis=1)


def _source_role(source_category: str) -> str:
    try:
        return SOURCE_ROLE[source_category]
    except KeyError as error:
        raise PseudoRefinementR2Error(
            f"unsupported source category: {source_category}"
        ) from error


def _load_master(path: Path) -> list[MasterRow]:
    source = path.expanduser().resolve()
    rows: list[MasterRow] = []
    seen: set[str] = set()
    with source.open("rb") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            try:
                value = json.loads(raw.decode("utf-8-sig" if line_number == 1 else "utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise PseudoRefinementR2Error(
                    f"master:{line_number}: invalid JSON"
                ) from error
            sample_id = _text(value.get("id"), f"master:{line_number}.id")
            if sample_id in seen:
                raise PseudoRefinementR2Error("master identity duplicated")
            seen.add(sample_id)
            metadata = _mapping(value.get("metadata"), f"master:{line_number}.metadata")
            category = metadata.get("candidate_category") or metadata.get(
                "candidate_primary_category"
            )
            source_category = str(category) if category else "ordinary"
            _source_role(source_category)
            work = _mapping(value.get("work"), f"master:{line_number}.work")
            rows.append(
                MasterRow(
                    sample_id=sample_id,
                    split=_text(value.get("split"), f"master:{line_number}.split"),
                    work_id=_text(work.get("id"), f"master:{line_number}.work.id"),
                    work_title=_text(
                        work.get("title"), f"master:{line_number}.work.title"
                    ),
                    source_category=source_category,
                    master_line_sha256=sha256_bytes(raw),
                    master_row_sha256=sha256_bytes(raw.rstrip(b"\r\n")),
                )
            )
    splits = Counter(row.split for row in rows)
    if len(rows) != EXPECTED_MASTER_ROWS or dict(splits) != EXPECTED_SPLITS:
        raise PseudoRefinementR2Error(
            f"master row/split count drifted: {len(rows)} {dict(splits)}"
        )
    return rows


def _load_r5_review(
    path: Path, *, master_rows: Sequence[MasterRow], candidate_ids: tuple[str, ...]
) -> list[ReviewRow]:
    rows: list[ReviewRow] = []
    for index, value in enumerate(_iter_jsonl(path, "R5 review")):
        if index >= len(master_rows):
            raise PseudoRefinementR2Error("R5 review has extra rows")
        master = master_rows[index]
        sample_id = _text(value.get("sample_id"), "R5 review.sample_id")
        probabilities = _normalize(
            _sequence(value.get("probabilities"), "R5 review.probabilities")
        )
        if (
            sample_id != master.sample_id
            or value.get("split") != master.split
            or value.get("work_id") != master.work_id
            or value.get("source_category") != master.source_category
            or value.get("master_row_sha256") != master.master_row_sha256
            or probabilities.shape != (len(candidate_ids),)
            or tuple(value.get("candidate_ids", ())) != candidate_ids
        ):
            raise PseudoRefinementR2Error(f"{sample_id}: R5/master binding drifted")
        refinement.validate_record_seal(value, location=f"R5 review:{sample_id}")
        disagreement = value.get("top1_disagreement")
        if disagreement is None:
            raw_disagreement = value.get("view_disagreement", {})
            disagreement = (
                raw_disagreement.get("top1_disagreement", 1.0)
                if isinstance(raw_disagreement, Mapping)
                else raw_disagreement
            )
        rows.append(
            ReviewRow(
                sample_id=sample_id,
                split=master.split,
                work_id=master.work_id,
                source_category=master.source_category,
                master_row_sha256=master.master_row_sha256,
                record_sha256=_text(
                    value.get("record_sha256"), "R5 review.record_sha256"
                ),
                probabilities=probabilities.astype(np.float32),
                confidence=float(value.get("confidence", probabilities.max())),
                top1_disagreement=float(disagreement),
            )
        )
    if len(rows) != len(master_rows):
        raise PseudoRefinementR2Error("R5 review row count drifted")
    return rows


def _load_cache_bindings(
    cache_root: Path,
    *,
    master_rows: Sequence[MasterRow],
    cache_manifest: Mapping[str, Any],
) -> list[CacheBinding]:
    index_path = cache_root / "sample-index.jsonl"
    declared = _mapping(cache_manifest.get("index"), "hidden cache index")
    if (
        declared.get("record_count") != len(master_rows)
        or declared.get("sha256") != sha256_file(index_path)
    ):
        raise PseudoRefinementR2Error("hidden cache index descriptor drifted")
    bindings: list[CacheBinding] = []
    for index, value in enumerate(_iter_jsonl(index_path, "hidden cache index")):
        if index >= len(master_rows):
            raise PseudoRefinementR2Error("hidden cache index has extra rows")
        master = master_rows[index]
        validate_record_seal(value, f"hidden cache index:{index + 1}")
        if (
            value.get("cache_index") != index
            or value.get("master_row_index") != index
            or value.get("sample_id") != master.sample_id
            or value.get("split") != master.split
            or value.get("work_id") != master.work_id
            or value.get("master_line_sha256") != master.master_line_sha256
        ):
            raise PseudoRefinementR2Error(
                f"{master.sample_id}: hidden cache/master binding drifted"
            )
        bindings.append(CacheBinding(index))
    if len(bindings) != len(master_rows):
        raise PseudoRefinementR2Error("hidden cache index row count drifted")
    return bindings


def _candidate_ids_from_r1(root: Path) -> tuple[str, ...]:
    validation = refinement.validate_output(root)
    if int(validation.get("pseudo_rows", -1)) != EXPECTED_PSEUDO_ROWS:
        raise PseudoRefinementR2Error("source refinement row count drifted")
    manifest = _read_json(root / refinement.MANIFEST_FILE, "r1 manifest")
    candidate_ids = tuple(str(value) for value in manifest.get("candidate_ids", ()))
    if len(candidate_ids) != 21 or SINGLE_DAY_ID not in candidate_ids:
        raise PseudoRefinementR2Error("active21 candidate contract drifted")
    return candidate_ids


def _distribution(
    probabilities: np.ndarray, candidate_ids: Sequence[str]
) -> Mapping[str, Any]:
    top1 = probabilities.argmax(axis=1)
    counts = np.bincount(top1, minlength=len(candidate_ids))
    row_count = int(len(probabilities))
    return {
        "entropy_mean": float(_entropy(probabilities).mean()) if row_count else None,
        "font_probability_mass": {
            candidate_id: float(probabilities[:, index].sum())
            for index, candidate_id in enumerate(candidate_ids)
        },
        "font_top1": {
            candidate_id: {
                "count": int(counts[index]),
                "share": float(counts[index] / row_count) if row_count else 0.0,
            }
            for index, candidate_id in enumerate(candidate_ids)
        },
        "max_top1_share": float(counts.max() / row_count) if row_count else 0.0,
        "row_count": row_count,
        "unique_top1_fonts": int(np.count_nonzero(counts)),
    }


def _agreement_summary(
    first: np.ndarray,
    second: np.ndarray,
    *,
    candidate_ids: Sequence[str],
) -> Mapping[str, Any]:
    first_top = first.argmax(axis=1)
    second_top = second.argmax(axis=1)
    agree = first_top == second_top
    pairs: Counter[str] = Counter(
        f"{candidate_ids[int(a)]}->{candidate_ids[int(b)]}"
        for a, b in zip(first_top[~agree], second_top[~agree], strict=True)
    )
    return {
        "agreement_count": int(agree.sum()),
        "agreement_rate": float(agree.mean()) if len(agree) else 0.0,
        "disagreement_count": int((~agree).sum()),
        "largest_disagreement_pairs": dict(pairs.most_common(30)),
    }


def _group_inference_report(
    r5: np.ndarray,
    r7: np.ndarray,
    groups: Sequence[str],
    *,
    candidate_ids: Sequence[str],
    titles: Mapping[str, str] | None = None,
) -> Mapping[str, Any]:
    result: dict[str, Any] = {}
    values = np.asarray(groups)
    for group in sorted(set(str(value) for value in values.tolist())):
        mask = values == group
        item: dict[str, Any] = {
            "r5": _distribution(r5[mask], candidate_ids),
            "r7": _distribution(r7[mask], candidate_ids),
            "r5_r7": _agreement_summary(
                r5[mask], r7[mask], candidate_ids=candidate_ids
            ),
        }
        if titles is not None and group in titles:
            item["work_title"] = titles[group]
        result[group] = item
    return result


def _write_inference_bundle(
    *,
    destination: Path,
    arrays: Mapping[str, np.ndarray],
    manifest_core: Mapping[str, Any],
    report_core: Mapping[str, Any],
) -> Mapping[str, Any]:
    output = _safe_new_output(destination)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        archive = staging / INFERENCE_ARCHIVE
        np.savez_compressed(archive, **arrays)
        manifest = seal_record(
            {
                **dict(manifest_core),
                "archive": _descriptor(archive, row_count=len(arrays["sample_ids"])),
                "record_type": "manga_font_v2_r7_master_predictions_manifest",
                "schema_version": INFERENCE_SCHEMA,
                "source_code_sha256": sha256_file(Path(__file__).resolve()),
            }
        )
        manifest_path = staging / INFERENCE_MANIFEST
        manifest_path.write_bytes(json_bytes(manifest, pretty=True))
        report = seal_record(
            {
                **dict(report_core),
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_v2_r7_master_predictions_report",
                "schema_version": INFERENCE_SCHEMA,
            }
        )
        report_path = staging / INFERENCE_REPORT
        report_path.write_bytes(json_bytes(report, pretty=True))
        marker = seal_record(
            {
                "artifacts": {
                    INFERENCE_ARCHIVE: sha256_file(archive),
                    INFERENCE_MANIFEST: sha256_file(manifest_path),
                    INFERENCE_REPORT: sha256_file(report_path),
                },
                "owner": INFERENCE_OWNER,
                "safe_replace": True,
                "schema_version": INFERENCE_SCHEMA,
            }
        )
        (staging / INFERENCE_MARKER).write_bytes(json_bytes(marker, pretty=True))
        validate_inference_output(staging)
        os.replace(staging, output)
        return validate_inference_output(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def validate_inference_output(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if (
        root.is_symlink()
        or not root.is_dir()
        or {path.name for path in root.iterdir()} != INFERENCE_FILES
    ):
        raise PseudoRefinementR2Error("inference exact inventory drifted")
    marker = _read_json(root / INFERENCE_MARKER, "inference marker")
    manifest = _read_json(root / INFERENCE_MANIFEST, "inference manifest")
    report = _read_json(root / INFERENCE_REPORT, "inference report")
    for location, value in (
        ("inference marker", marker),
        ("inference manifest", manifest),
        ("inference report", report),
    ):
        validate_record_seal(value, location)
    artifacts = _mapping(marker.get("artifacts"), "inference marker artifacts")
    if (
        marker.get("owner") != INFERENCE_OWNER
        or marker.get("schema_version") != INFERENCE_SCHEMA
        or marker.get("safe_replace") is not True
        or manifest.get("schema_version") != INFERENCE_SCHEMA
        or report.get("schema_version") != INFERENCE_SCHEMA
        or report.get("manifest_record_sha256") != manifest.get("record_sha256")
        or artifacts.get(INFERENCE_ARCHIVE)
        != sha256_file(root / INFERENCE_ARCHIVE)
        or artifacts.get(INFERENCE_MANIFEST)
        != sha256_file(root / INFERENCE_MANIFEST)
        or artifacts.get(INFERENCE_REPORT) != sha256_file(root / INFERENCE_REPORT)
    ):
        raise PseudoRefinementR2Error("inference metadata/hash drifted")
    descriptor = _mapping(manifest.get("archive"), "inference archive")
    if descriptor != _descriptor(root / INFERENCE_ARCHIVE, row_count=EXPECTED_MASTER_ROWS):
        raise PseudoRefinementR2Error("inference archive descriptor drifted")
    with np.load(root / INFERENCE_ARCHIVE, allow_pickle=False) as source:
        expected_fields = {
            "candidate_ids",
            "confidence_r5",
            "family_probabilities_r7",
            "master_row_sha256",
            "predicted_family_r7",
            "probabilities_r5",
            "probabilities_r7",
            "raw_margin_r7",
            "record_sha256_r5",
            "roles",
            "sample_ids",
            "single_day_allowed_r7",
            "source_categories",
            "splits",
            "view_disagreement_r5",
            "work_ids",
            "work_titles",
        }
        if set(source.files) != expected_fields:
            raise PseudoRefinementR2Error("inference archive field inventory drifted")
        candidate_ids = tuple(str(value) for value in source["candidate_ids"].tolist())
        sample_ids = source["sample_ids"]
        r5 = source["probabilities_r5"]
        r7 = source["probabilities_r7"]
        splits = source["splits"]
        if (
            len(candidate_ids) != 21
            or SINGLE_DAY_ID not in candidate_ids
            or sample_ids.shape != (EXPECTED_MASTER_ROWS,)
            or len(set(str(value) for value in sample_ids.tolist())) != EXPECTED_MASTER_ROWS
            or r5.shape != (EXPECTED_MASTER_ROWS, 21)
            or r7.shape != r5.shape
            or not np.isfinite(r5).all()
            or not np.isfinite(r7).all()
            or not np.allclose(r5.sum(axis=1), 1.0, atol=2e-6)
            or not np.allclose(r7.sum(axis=1), 1.0, atol=2e-6)
            or dict(Counter(str(value) for value in splits.tolist())) != EXPECTED_SPLITS
        ):
            raise PseudoRefinementR2Error("inference archive tensor/row contract drifted")
        order_sha = _ordered_sha(str(value) for value in sample_ids.tolist())
    if manifest.get("sample_order_sha256") != order_sha:
        raise PseudoRefinementR2Error("inference sample order drifted")
    return {
        "candidate_count": 21,
        "output_dir": str(root),
        "row_count": EXPECTED_MASTER_ROWS,
        "status": "validated_diagnostic_only_r7_master_predictions",
    }


def infer_master(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    candidate_ids = _candidate_ids_from_r1(args.refined_r1_dir)
    master_path = args.master_manifest.expanduser().resolve()
    master_rows = _load_master(master_path)
    r5_path = args.r5_review.expanduser().resolve()
    r5_rows = _load_r5_review(
        r5_path, master_rows=master_rows, candidate_ids=candidate_ids
    )

    cache_root = args.hidden_cache_dir.expanduser().resolve()
    cache_manifest = _read_json(cache_root / "manifest.json", "hidden cache manifest")
    if (
        cache_manifest.get("schema_version")
        != "manga-font-master-v3-siglip2-hidden-cache-v1"
        or _mapping(cache_manifest.get("sources"), "hidden sources").get(
            "master_manifest_sha256"
        )
        != sha256_file(master_path)
        or _mapping(cache_manifest.get("selection"), "hidden selection").get(
            "selected_row_count"
        )
        != EXPECTED_MASTER_ROWS
    ):
        raise PseudoRefinementR2Error("hidden cache/master contract drifted")
    cache_bindings = _load_cache_bindings(
        cache_root, master_rows=master_rows, cache_manifest=cache_manifest
    )

    query_npz = args.query_dataset_npz.expanduser().resolve()
    query_manifest = _read_json(query_npz.parent / "manifest.json", "query manifest")
    if _mapping(query_manifest.get("dataset"), "query dataset").get(
        "sha256"
    ) != sha256_file(query_npz):
        raise PseudoRefinementR2Error("query dataset hash drifted")
    with np.load(query_npz, allow_pickle=False) as source:
        query_candidate_ids = tuple(str(value) for value in source["candidate_ids"].tolist())
        query_ids = tuple(str(value) for value in source["sample_ids"].tolist())
        query_views = np.array(source["query_views"], dtype="<f2", copy=True)
        prototypes = np.array(source["prototype_queries"], dtype=np.float32, copy=True)
    if (
        query_candidate_ids != candidate_ids
        or len(query_ids) != 23_882
        or len(set(query_ids)) != len(query_ids)
        or query_views.shape != (23_882, 3, 4, 256)
        or prototypes.shape != (21, 4, 256)
    ):
        raise PseudoRefinementR2Error("query dataset tensor contract drifted")
    master_index = {row.sample_id: index for index, row in enumerate(master_rows)}
    query_positions = np.asarray([master_index[value] for value in query_ids], dtype=np.int64)
    expected_cached = {
        index for index, row in enumerate(master_rows) if row.split != "test"
    }
    if set(query_positions.tolist()) != expected_cached:
        raise PseudoRefinementR2Error("query cache is not exact master train+val coverage")
    missing_positions = np.asarray(
        [index for index, row in enumerate(master_rows) if row.split == "test"],
        dtype=np.int64,
    )

    torch, head, r5_prototypes, head_binding = dataset._load_r5_head_and_prototypes(  # noqa: SLF001
        args.r5_head_dir, device_name=args.device
    )
    if not np.array_equal(prototypes, r5_prototypes):
        raise PseudoRefinementR2Error("query dataset/R5 prototype bank drifted")
    missing_views = dataset._extract_query_views(  # noqa: SLF001
        cache_root=cache_root,
        cache_manifest=cache_manifest,
        bindings=[cache_bindings[index] for index in missing_positions.tolist()],
        torch=torch,
        head=head,
        device_name=args.device,
        batch_size=args.query_batch_size,
    )
    del head
    all_views = np.empty((EXPECTED_MASTER_ROWS, 3, 4, 256), dtype="<f2")
    all_views[query_positions] = query_views
    all_views[missing_positions] = missing_views
    del query_views, missing_views
    if not np.isfinite(all_views).all():
        raise PseudoRefinementR2Error("assembled query views contain non-finite values")

    device = torch.device(args.device)
    adapter, adapter_manifest = ablation._load_r3h(  # noqa: SLF001
        args.adapter_dir.expanduser().resolve(),
        torch=torch,
        candidate_count=len(candidate_ids),
        device=device,
    )
    outputs = ablation._adapter_outputs(  # noqa: SLF001
        torch=torch,
        model=adapter,
        query_views=all_views,
        prototypes=prototypes,
        device=device,
        batch_size=args.adapter_batch_size,
    )
    routed = ablation.production_route(
        body_scores=outputs["body_candidate_scores"],
        variant_scores=outputs["variant_candidate_scores"],
        family_logits=outputs["family_logits"],
        single_day_index=candidate_ids.index(SINGLE_DAY_ID),
    )
    r7_probabilities = _softmax(routed["deployed_scores"])
    r5_probabilities = np.stack([row.probabilities for row in r5_rows]).astype(np.float32)

    roles = np.asarray(
        [_source_role(row.source_category) for row in master_rows], dtype="<U32"
    )
    splits = np.asarray([row.split for row in master_rows], dtype="<U8")
    source_categories = np.asarray(
        [row.source_category for row in master_rows], dtype="<U32"
    )
    work_ids = np.asarray([row.work_id for row in master_rows], dtype="<U40")
    work_titles = np.asarray([row.work_title for row in master_rows], dtype="<U160")
    titles = {row.work_id: row.work_title for row in master_rows}
    inference_report = {
        "authority": {
            "automatic_pseudo_promotion": False,
            "diagnostic_only": True,
            "label_authority": False,
            "r7_top1_is_gold": False,
            "training_eligible": False,
        },
        "candidate_ids": list(candidate_ids),
        "elapsed_seconds": time.perf_counter() - started,
        "global": {
            "r5": _distribution(r5_probabilities, candidate_ids),
            "r7": _distribution(r7_probabilities, candidate_ids),
            "r5_r7": _agreement_summary(
                r5_probabilities, r7_probabilities, candidate_ids=candidate_ids
            ),
        },
        "groups": {
            "role": _group_inference_report(
                r5_probabilities,
                r7_probabilities,
                roles.tolist(),
                candidate_ids=candidate_ids,
            ),
            "source_category": _group_inference_report(
                r5_probabilities,
                r7_probabilities,
                source_categories.tolist(),
                candidate_ids=candidate_ids,
            ),
            "split": _group_inference_report(
                r5_probabilities,
                r7_probabilities,
                splits.tolist(),
                candidate_ids=candidate_ids,
            ),
            "work": _group_inference_report(
                r5_probabilities,
                r7_probabilities,
                work_ids.tolist(),
                candidate_ids=candidate_ids,
                titles=titles,
            ),
        },
        "single_day": {
            "allowed_count": int(np.sum(routed["single_day_allowed"])),
            "predicted_top1_count": int(
                np.sum(r7_probabilities.argmax(axis=1) == candidate_ids.index(SINGLE_DAY_ID))
            ),
        },
    }
    arrays = {
        "candidate_ids": np.asarray(candidate_ids, dtype="<U32"),
        "confidence_r5": np.asarray([row.confidence for row in r5_rows], dtype=np.float32),
        "family_probabilities_r7": routed["family_probabilities"].astype(np.float32),
        "master_row_sha256": np.asarray(
            [row.master_row_sha256 for row in master_rows], dtype="<U64"
        ),
        "predicted_family_r7": routed["predicted_family"].astype(np.int8),
        "probabilities_r5": r5_probabilities,
        "probabilities_r7": r7_probabilities,
        "raw_margin_r7": routed["raw_margin"].astype(np.float32),
        "record_sha256_r5": np.asarray(
            [row.record_sha256 for row in r5_rows], dtype="<U64"
        ),
        "roles": roles,
        "sample_ids": np.asarray([row.sample_id for row in master_rows], dtype="<U40"),
        "single_day_allowed_r7": routed["single_day_allowed"].astype(np.bool_),
        "source_categories": source_categories,
        "splits": splits,
        "view_disagreement_r5": np.asarray(
            [row.top1_disagreement for row in r5_rows], dtype=np.float32
        ),
        "work_ids": work_ids,
        "work_titles": work_titles,
    }
    manifest_core = {
        "authority": inference_report["authority"],
        "candidate_ids": list(candidate_ids),
        "counts": {
            "master_rows": EXPECTED_MASTER_ROWS,
            "query_views_recomputed_from_hidden_cache": int(len(missing_positions)),
            "query_views_reused_from_sealed_hidden_cache_derivative": int(len(query_ids)),
            "split_counts": EXPECTED_SPLITS,
        },
        "sample_order_sha256": _ordered_sha(row.sample_id for row in master_rows),
        "sources": {
            "adapter": {
                "checkpoint_sha256": sha256_file(
                    args.adapter_dir.expanduser().resolve()
                    / "role-family-adapter.safetensors"
                ),
                "manifest_sha256": sha256_file(
                    args.adapter_dir.expanduser().resolve() / "manifest.json"
                ),
                "selected_interpolation_alpha": adapter_manifest.get("best_epoch", {}).get(
                    "interpolation_alpha"
                ),
            },
            "hidden_cache": {
                "index_sha256": sha256_file(cache_root / "sample-index.jsonl"),
                "manifest_sha256": sha256_file(cache_root / "manifest.json"),
            },
            "master_manifest_sha256": sha256_file(master_path),
            "query_dataset": {
                "manifest_sha256": sha256_file(query_npz.parent / "manifest.json"),
                "npz_sha256": sha256_file(query_npz),
            },
            "r5_head": head_binding,
            "r5_review_sha256": sha256_file(r5_path),
            "refined_r1_manifest_sha256": sha256_file(
                args.refined_r1_dir / refinement.MANIFEST_FILE
            ),
        },
    }
    return _write_inference_bundle(
        destination=args.output_dir,
        arrays=arrays,
        manifest_core=manifest_core,
        report_core=inference_report,
    )


def _load_high_value_labels(
    root: Path, candidate_ids: tuple[str, ...]
) -> tuple[dict[str, dict[str, Any]], Mapping[str, Any]]:
    validation = high_value.validate_output(root, require_current_source=False)
    labels: dict[str, dict[str, Any]] = {}
    for row in _iter_jsonl(root / high_value.LABELS_FILE, "high-value labels"):
        sample_id = _text(row.get("sample_id"), "high-value sample_id")
        if sample_id in labels:
            raise PseudoRefinementR2Error("high-value identity duplicated")
        if tuple(row.get("candidate_labels", {}).get("eligible_candidate_ids", ())) and not set(
            row["candidate_labels"]["eligible_candidate_ids"]
        ) <= set(candidate_ids):
            raise PseudoRefinementR2Error("high-value candidate inventory drifted")
        labels[sample_id] = row
    if len(labels) != int(validation.get("training_label_rows", -1)):
        raise PseudoRefinementR2Error("high-value row count drifted")
    return labels, {
        "labels_sha256": sha256_file(root / high_value.LABELS_FILE),
        "manifest_sha256": sha256_file(root / high_value.MANIFEST_FILE),
        "validation": dict(validation),
    }


def build_role_priors(
    labels: Mapping[str, Mapping[str, Any]], candidate_ids: tuple[str, ...]
) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    """Derive smoothed priors without treating the prior as direct authority."""

    index = {value: position for position, value in enumerate(candidate_ids)}
    role_sums: dict[str, np.ndarray] = defaultdict(
        lambda: np.zeros(len(candidate_ids), dtype=np.float64)
    )
    family_sums: dict[str, np.ndarray] = defaultdict(
        lambda: np.zeros(len(candidate_ids), dtype=np.float64)
    )
    role_counts: Counter[str] = Counter()
    sd_index = index[SINGLE_DAY_ID]
    for row in labels.values():
        role = _text(row.get("role"), "high-value role")
        family = _text(row.get("family"), "high-value family")
        candidates = _mapping(row.get("candidate_labels"), "high-value candidates")
        preferred = [str(value) for value in candidates.get("preferred_candidate_ids", ())]
        positive = [str(value) for value in candidates.get("positive_candidate_ids", ())]
        if family == "body":
            preferred = [value for value in preferred if value != SINGLE_DAY_ID]
            positive = [value for value in positive if value != SINGLE_DAY_ID]
        target = np.zeros(len(candidate_ids), dtype=np.float64)
        if preferred:
            for value in preferred:
                target[index[value]] += 0.75 / len(preferred)
        residual = [value for value in positive if value not in preferred]
        if residual:
            for value in residual:
                target[index[value]] += 0.25 / len(residual)
        elif preferred:
            for value in preferred:
                target[index[value]] += 0.25 / len(preferred)
        if target.sum() <= 0.0:
            raise PseudoRefinementR2Error("high-value label has no usable prior target")
        target /= target.sum()
        role_sums[role] += target
        family_sums[family] += target
        role_counts[role] += 1
    uniform = np.full(len(candidate_ids), 1.0 / len(candidate_ids))
    family_priors = {
        family: _normalize(values + 2.0 * uniform)
        for family, values in family_sums.items()
    }
    priors: dict[str, np.ndarray] = {}
    for role, values in role_sums.items():
        family = "body" if role in BODY_HARD_NEGATIVE_ROLES else "variant"
        prior = _normalize(values + 8.0 * family_priors[family] + 1.0 * uniform)
        if family == "body":
            prior[sd_index] = 0.0
            prior = _normalize(prior)
        priors[role] = prior
    for source_role in set(SOURCE_ROLE.values()):
        if source_role not in priors:
            family = "body" if source_role in BODY_HARD_NEGATIVE_ROLES else "variant"
            priors[source_role] = family_priors[family]
    report = {
        "body_single_day_removed": True,
        "role_counts": dict(role_counts),
        "role_priors": {
            role: {
                candidate_id: float(prior[index[candidate_id]])
                for candidate_id in candidate_ids
            }
            for role, prior in sorted(priors.items())
        },
        "smoothing": {
            "family_pseudocount": 8.0,
            "uniform_pseudocount": 1.0,
        },
    }
    return priors, report


def _agreement_kind(anchor_top: int, r5_top: int, r7_top: int) -> str:
    if anchor_top == r5_top == r7_top:
        return "unanimous"
    if r5_top == r7_top:
        return "r5_r7_consensus"
    if anchor_top == r7_top:
        return "anchor_r7"
    if anchor_top == r5_top:
        return "anchor_r5"
    return "all_disagree"


def _weights_for_agreement(agreement: str) -> dict[str, float]:
    return {
        "unanimous": {"r1": 0.60, "r5": 0.18, "r7": 0.17, "role_prior": 0.05},
        "r5_r7_consensus": {
            "r1": 0.62,
            "r5": 0.17,
            "r7": 0.16,
            "role_prior": 0.05,
        },
        "anchor_r7": {"r1": 0.66, "r5": 0.14, "r7": 0.15, "role_prior": 0.05},
        "anchor_r5": {"r1": 0.68, "r5": 0.15, "r7": 0.12, "role_prior": 0.05},
        "all_disagree": {"r1": 0.78, "r5": 0.10, "r7": 0.07, "role_prior": 0.05},
    }[agreement]


def _suppress_single_day(
    probabilities: np.ndarray, *, sd_index: int, multiplier: float
) -> np.ndarray:
    result = probabilities.astype(np.float64, copy=True)
    old = float(result[sd_index])
    result[sd_index] = old * multiplier
    removed = old - float(result[sd_index])
    others = np.arange(len(result)) != sd_index
    denominator = float(result[others].sum())
    if denominator <= 0.0:
        result[others] = removed / int(others.sum())
    else:
        result[others] += removed * result[others] / denominator
    return _normalize(result)


def _force_anchor_top1(probabilities: np.ndarray, anchor: np.ndarray) -> np.ndarray:
    """Use the smallest anchor interpolation that restores anchor top-1."""

    anchor_top = int(anchor.argmax())
    if int(probabilities.argmax()) == anchor_top:
        return probabilities
    low, high = 0.0, 1.0
    for _ in range(36):
        middle = (low + high) / 2.0
        candidate = _normalize((1.0 - middle) * probabilities + middle * anchor)
        if int(candidate.argmax()) == anchor_top:
            high = middle
        else:
            low = middle
    return _normalize((1.0 - high) * probabilities + high * anchor)


def conservative_ensemble(
    *,
    anchor: Sequence[float],
    r5: Sequence[float],
    r7: Sequence[float],
    role_prior: Sequence[float],
    candidate_ids: tuple[str, ...],
    role: str,
    source_category: str,
    r5_confidence: float,
    r7_single_day_allowed: bool,
) -> EnsembleDecision:
    anchor_p = _normalize(anchor)
    r5_p = _normalize(r5)
    r7_p = _normalize(r7)
    prior_p = _normalize(role_prior)
    anchor_top = int(anchor_p.argmax())
    r5_top = int(r5_p.argmax())
    r7_top = int(r7_p.argmax())
    agreement = _agreement_kind(anchor_top, r5_top, r7_top)
    weights = _weights_for_agreement(agreement)
    combined = _normalize(
        weights["r1"] * anchor_p
        + weights["r5"] * r5_p
        + weights["r7"] * r7_p
        + weights["role_prior"] * prior_p
    )
    sd_index = candidate_ids.index(SINGLE_DAY_ID)
    hard_negative = (
        role in BODY_HARD_NEGATIVE_ROLES
        or source_category in {"ordinary", "bubble_edge"}
    )
    specialist = role in SPECIALIST_ROLES or source_category == "page_sound"
    r5_top3 = set(int(value) for value in np.argsort(-r5_p, kind="stable")[:3])
    strong_sd_evidence = (
        anchor_top == sd_index
        or (r5_top == sd_index and r7_top == sd_index)
        or (
            r7_top == sd_index
            and r7_single_day_allowed
            and sd_index in r5_top3
        )
    )
    if hard_negative:
        multiplier = 0.02 if source_category == "ordinary" else 0.05
        sd_policy = "body_or_bubble_edge_hard_negative"
        combined = _suppress_single_day(combined, sd_index=sd_index, multiplier=multiplier)
    elif specialist and strong_sd_evidence:
        multiplier = 1.0
        sd_policy = "specialist_positive_preserved"
    elif specialist:
        multiplier = 0.35
        sd_policy = "specialist_unconfirmed_negative"
        combined = _suppress_single_day(combined, sd_index=sd_index, multiplier=multiplier)
    else:
        multiplier = 0.25
        sd_policy = "uncertain_negative"
        combined = _suppress_single_day(combined, sd_index=sd_index, multiplier=multiplier)

    proposed_top = int(combined.argmax())
    allow_consensus_shift = (
        proposed_top == r5_top == r7_top
        and r5_confidence >= 0.30
        and proposed_top != sd_index
    )
    if hard_negative and anchor_top == sd_index:
        guard = "single_day_anchor_overridden_by_hard_negative"
    elif proposed_top == anchor_top:
        guard = "anchor_top1_retained"
    elif allow_consensus_shift:
        guard = "r5_r7_consensus_shift_allowed"
    else:
        combined = _force_anchor_top1(combined, anchor_p)
        guard = "unsupported_shift_reverted_to_anchor"
    weight_multiplier = 0.90 if agreement == "all_disagree" else 1.0
    return EnsembleDecision(
        probabilities=combined,
        weights=weights,
        agreement=agreement,
        top1_guard=guard,
        single_day_policy=sd_policy,
        single_day_multiplier=multiplier,
        weight_multiplier=weight_multiplier,
    )


def _load_inference_arrays(root: Path) -> tuple[dict[str, np.ndarray], Mapping[str, Any]]:
    validation = validate_inference_output(root)
    with np.load(root / INFERENCE_ARCHIVE, allow_pickle=False) as source:
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    return arrays, {
        "archive_sha256": sha256_file(root / INFERENCE_ARCHIVE),
        "manifest_sha256": sha256_file(root / INFERENCE_MANIFEST),
        "report_sha256": sha256_file(root / INFERENCE_REPORT),
        "validation": dict(validation),
    }


def _group_refinement_report(
    before: np.ndarray,
    after: np.ndarray,
    r5: np.ndarray,
    r7: np.ndarray,
    groups: Sequence[str],
    *,
    candidate_ids: tuple[str, ...],
    protected: np.ndarray,
    titles: Mapping[str, str] | None = None,
) -> Mapping[str, Any]:
    result: dict[str, Any] = {}
    group_values = np.asarray(groups)
    before_top = before.argmax(axis=1)
    after_top = after.argmax(axis=1)
    for group in sorted(set(str(value) for value in group_values.tolist())):
        mask = group_values == group
        item: dict[str, Any] = {
            "before": _distribution(before[mask], candidate_ids),
            "after": _distribution(after[mask], candidate_ids),
            "top1_shift_count": int(np.sum(before_top[mask] != after_top[mask])),
            "protected_reviewed_rows": int(np.sum(protected[mask])),
            "r1_r5": _agreement_summary(
                before[mask], r5[mask], candidate_ids=candidate_ids
            ),
            "r1_r7": _agreement_summary(
                before[mask], r7[mask], candidate_ids=candidate_ids
            ),
            "r5_r7": _agreement_summary(r5[mask], r7[mask], candidate_ids=candidate_ids),
        }
        if titles is not None and group in titles:
            item["work_title"] = titles[group]
        result[group] = item
    return result


def _write_loader_bundle(
    *,
    destination: Path,
    output_rows: Sequence[Mapping[str, Any]],
    lineage_rows: Sequence[Mapping[str, Any]],
    candidate_ids: tuple[str, ...],
    inputs: Mapping[str, Any],
    report_core: Mapping[str, Any],
) -> Mapping[str, Any]:
    output = _safe_new_output(destination)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    try:
        pseudo_path = staging / refinement.PSEUDO_FILE
        lineage_path = staging / refinement.LINEAGE_FILE
        with pseudo_path.open("wb") as handle:
            for row in output_rows:
                handle.write(json_bytes(row))
        with lineage_path.open("wb") as handle:
            for row in lineage_rows:
                handle.write(json_bytes(row))
        # The v1 source hash is the compatibility validator contract.  The
        # actual r2 producer hash is separately sealed below.
        manifest = refinement.seal_record(
            {
                "authority": {
                    "human_gold_promotions": 0,
                    "label_authority": refinement.AUTHORITY,
                    "loader_top_level_authority": refinement.LOADER_AUTHORITY,
                    "promotion_allowed": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(candidate_ids),
                "counts": {
                    "changed_rows": len(lineage_rows),
                    "output_pseudo_rows": len(output_rows),
                    "pass_review_rows": EXPECTED_MASTER_ROWS,
                },
                "inputs": dict(inputs),
                "output_sample_order_sha256": _ordered_sha(
                    str(row["sample_id"]) for row in output_rows
                ),
                "parameters": {
                    "ensemble": "bounded_r1_r5_r7_role_prior",
                    "r7_is_label_authority": False,
                    "reviewed_rows_preserved": True,
                },
                "producer_code_sha256": sha256_file(Path(__file__).resolve()),
                "record_type": "manga_font_v2_pseudo_refinement_manifest",
                "r2_schema_version": SCHEMA,
                "schema_version": refinement.MANIFEST_SCHEMA,
                "source_code_sha256": refinement.sha256_file(
                    Path(refinement.__file__).resolve()
                ),
            }
        )
        manifest_path = staging / refinement.MANIFEST_FILE
        manifest_path.write_bytes(refinement.json_bytes(manifest, pretty=True))
        report = refinement.seal_record(
            {
                **dict(report_core),
                "artifacts": {
                    refinement.LINEAGE_FILE: refinement._artifact_descriptor(  # noqa: SLF001
                        lineage_path, row_count=len(lineage_rows)
                    ),
                    refinement.MANIFEST_FILE: refinement._artifact_descriptor(  # noqa: SLF001
                        manifest_path
                    ),
                    refinement.PSEUDO_FILE: refinement._artifact_descriptor(  # noqa: SLF001
                        pseudo_path, row_count=len(output_rows)
                    ),
                },
                "authority": {
                    "human_gold_promotions": 0,
                    "label_authority": refinement.AUTHORITY,
                    "lineage_label_authority": refinement.LINEAGE_AUTHORITY,
                    "loader_top_level_authority": refinement.LOADER_AUTHORITY,
                    "promotion_allowed": False,
                    "training_eligible": False,
                },
                "candidate_ids": list(candidate_ids),
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_v2_pseudo_refinement_report",
                "r2_schema_version": SCHEMA,
                "schema_version": refinement.REPORT_SCHEMA,
            }
        )
        report_path = staging / refinement.REPORT_FILE
        report_path.write_bytes(refinement.json_bytes(report, pretty=True))
        marker = refinement.seal_record(
            {
                "manifest_sha256": refinement.sha256_file(manifest_path),
                "owner": refinement.OWNER,
                "report_sha256": refinement.sha256_file(report_path),
                "safe_replace": True,
                "schema_version": refinement.SCHEMA,
            }
        )
        (staging / refinement.MARKER_FILE).write_bytes(
            refinement.json_bytes(marker, pretty=True)
        )
        refinement.validate_output(staging)
        os.replace(staging, output)
        return refinement.validate_output(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def build_refinement(args: argparse.Namespace) -> Mapping[str, Any]:
    started = time.perf_counter()
    candidate_ids = _candidate_ids_from_r1(args.refined_r1_dir)
    arrays, inference_binding = _load_inference_arrays(args.inference_dir)
    if tuple(str(value) for value in arrays["candidate_ids"].tolist()) != candidate_ids:
        raise PseudoRefinementR2Error("inference/r1 candidate order drifted")
    sample_ids = [str(value) for value in arrays["sample_ids"].tolist()]
    sample_index = {value: index for index, value in enumerate(sample_ids)}
    high_labels, high_binding = _load_high_value_labels(
        args.high_value_labels_dir, candidate_ids
    )
    priors, prior_report = build_role_priors(high_labels, candidate_ids)

    source_rows = list(
        _iter_jsonl(
            args.refined_r1_dir / refinement.PSEUDO_FILE, "refined r1 pseudo"
        )
    )
    if len(source_rows) != EXPECTED_PSEUDO_ROWS:
        raise PseudoRefinementR2Error("refined r1 pseudo row count drifted")
    visual_reviewed = {
        str(row["sample_id"]) for row in source_rows if row.get("pseudo_visual_review")
    }
    protected_ids = set(high_labels) | visual_reviewed
    if not set(high_labels) <= {str(row["sample_id"]) for row in source_rows}:
        raise PseudoRefinementR2Error("high-value labels escaped the train pseudo pool")

    output_rows: list[dict[str, Any]] = []
    lineage_rows: list[dict[str, Any]] = []
    before: list[np.ndarray] = []
    after: list[np.ndarray] = []
    r5_values: list[np.ndarray] = []
    r7_values: list[np.ndarray] = []
    roles: list[str] = []
    categories: list[str] = []
    work_ids: list[str] = []
    protected_flags: list[bool] = []
    action_counts: Counter[str] = Counter()
    titles: dict[str, str] = {}
    seen: set[str] = set()

    for source in source_rows:
        sample_id = _text(source.get("sample_id"), "r1 pseudo.sample_id")
        if sample_id in seen or sample_id not in sample_index:
            raise PseudoRefinementR2Error("r1 pseudo identity duplicated or missing")
        seen.add(sample_id)
        position = sample_index[sample_id]
        split = str(arrays["splits"][position])
        category = str(arrays["source_categories"][position])
        work_id = str(arrays["work_ids"][position])
        role = str(arrays["roles"][position])
        if (
            split != "train"
            or source.get("split") != "train"
            or source.get("source_category") != category
            or source.get("work_id") != work_id
            or source.get("master_row_sha256")
            != str(arrays["master_row_sha256"][position])
        ):
            raise PseudoRefinementR2Error(f"{sample_id}: r1/inference binding drifted")
        original = _normalize(source.get("probabilities", ()))
        r5 = _normalize(arrays["probabilities_r5"][position])
        r7 = _normalize(arrays["probabilities_r7"][position])
        protected = sample_id in protected_ids
        before.append(original)
        r5_values.append(r5)
        r7_values.append(r7)
        roles.append(role)
        categories.append(category)
        work_ids.append(work_id)
        titles[work_id] = str(arrays["work_titles"][position])
        protected_flags.append(protected)
        if protected:
            output_rows.append(copy.deepcopy(source))
            after.append(original)
            action_counts["reviewed_authority_preserved"] += 1
            if sample_id in high_labels:
                action_counts["protected_high_value"] += 1
            if sample_id in visual_reviewed:
                action_counts["protected_visual_review"] += 1
            continue

        decision = conservative_ensemble(
            anchor=original,
            r5=r5,
            r7=r7,
            role_prior=priors[role],
            candidate_ids=candidate_ids,
            role=role,
            source_category=category,
            r5_confidence=float(arrays["confidence_r5"][position]),
            r7_single_day_allowed=bool(arrays["single_day_allowed_r7"][position]),
        )
        updated = decision.probabilities
        weight_before = float(source.get("weight", 0.0))
        weight_after = weight_before * decision.weight_multiplier
        actions = [
            {
                "agreement": decision.agreement,
                "kind": "conservative_r1_r5_r7_role_prior_ensemble",
                "r7_is_label_authority": False,
                "role": role,
                "weights": dict(decision.weights),
            },
            {
                "kind": "single_day_role_conditioned_policy",
                "multiplier": decision.single_day_multiplier,
                "policy": decision.single_day_policy,
            },
            {
                "kind": "top1_shift_guard",
                "policy": decision.top1_guard,
            },
        ]
        teacher = _mapping(source.get("teacher_bindings"), "r1 teacher bindings")
        teacher_sha = sha256_bytes(canonical_json(teacher).encode("utf-8"))
        source_record_sha = _text(source.get("record_sha256"), "r1 record seal")
        refinement_core = {
            "actions": actions,
            "authority": refinement.AUTHORITY,
            "inference_manifest_sha256": inference_binding["manifest_sha256"],
            "label_authority": refinement.LINEAGE_AUTHORITY,
            "pass_review_record_sha256": str(arrays["record_sha256_r5"][position]),
            "promotion_allowed": False,
            "r7_is_label_authority": False,
            "r2_schema_version": SCHEMA,
            "sample_id": sample_id,
            "source_record_sha256": source_record_sha,
            "source_teacher_bindings_sha256": teacher_sha,
            "training_eligible": False,
        }
        refinement_id = sha256_bytes(canonical_json(refinement_core).encode("utf-8"))
        row = copy.deepcopy(source)
        previous = row.get("pseudo_v2_refinement")
        if previous is not None:
            row["previous_pseudo_v2_refinement_sha256"] = sha256_bytes(
                canonical_json(previous).encode("utf-8")
            )
        row["probabilities"] = [float(value) for value in updated.tolist()]
        row["weight"] = float(weight_after)
        row["label_authority"] = refinement.LOADER_AUTHORITY
        row["training_eligible"] = False
        row["pseudo_v2_refinement"] = {
            **refinement_core,
            "refinement_id": refinement_id,
        }
        row = refinement.seal_record(row)
        output_rows.append(row)
        after.append(updated)
        lineage_rows.append(
            refinement.seal_record(
                {
                    "actions": actions,
                    "authority": refinement.AUTHORITY,
                    "candidate_ids": list(candidate_ids),
                    "label_authority": refinement.LINEAGE_AUTHORITY,
                    "output_record_sha256": row["record_sha256"],
                    "pass_review_record_sha256": str(
                        arrays["record_sha256_r5"][position]
                    ),
                    "probability_top1_after": candidate_ids[int(updated.argmax())],
                    "probability_top1_before": candidate_ids[int(original.argmax())],
                    "promotion_allowed": False,
                    "record_type": "manga_font_v2_pseudo_refinement_lineage_row",
                    "refinement_id": refinement_id,
                    "sample_id": sample_id,
                    "schema_version": refinement.LINEAGE_SCHEMA,
                    "single_day_probability_after": float(
                        updated[candidate_ids.index(SINGLE_DAY_ID)]
                    ),
                    "single_day_probability_before": float(
                        original[candidate_ids.index(SINGLE_DAY_ID)]
                    ),
                    "source_category": category,
                    "source_record_sha256": source_record_sha,
                    "source_teacher_bindings_sha256": teacher_sha,
                    "training_eligible": False,
                    "weight_after": float(weight_after),
                    "weight_before": float(weight_before),
                }
            )
        )
        action_counts[f"agreement_{decision.agreement}"] += 1
        action_counts[f"top1_guard_{decision.top1_guard}"] += 1
        action_counts[f"single_day_{decision.single_day_policy}"] += 1

    before_array = np.stack(before)
    after_array = np.stack(after)
    r5_array = np.stack(r5_values)
    r7_array = np.stack(r7_values)
    protected_array = np.asarray(protected_flags, dtype=np.bool_)
    before_top = before_array.argmax(axis=1)
    after_top = after_array.argmax(axis=1)
    sd_index = candidate_ids.index(SINGLE_DAY_ID)
    hard_negative = np.asarray(
        [
            role in BODY_HARD_NEGATIVE_ROLES or category in {"ordinary", "bubble_edge"}
            for role, category in zip(roles, categories, strict=True)
        ],
        dtype=np.bool_,
    )
    unprotected_hard = hard_negative & ~protected_array
    before_distribution = _distribution(before_array, candidate_ids)
    after_distribution = _distribution(after_array, candidate_ids)
    entropy_before = float(_entropy(before_array).mean())
    entropy_after = float(_entropy(after_array).mean())
    collapse = {
        "entropy_delta": entropy_after - entropy_before,
        "max_share_delta": float(after_distribution["max_top1_share"])
        - float(before_distribution["max_top1_share"]),
        "passed": bool(
            float(after_distribution["max_top1_share"])
            <= max(0.65, float(before_distribution["max_top1_share"]) + 0.05)
            and int(after_distribution["unique_top1_fonts"])
            >= min(15, int(before_distribution["unique_top1_fonts"]))
            and entropy_after >= entropy_before - 0.15
            and int(np.sum((after_top == sd_index) & unprotected_hard)) == 0
        ),
        "policy": {
            "entropy_drop_max": 0.15,
            "max_top1_share": "min(0.65,before+0.05)",
            "minimum_unique_top1_fonts": min(
                15, int(before_distribution["unique_top1_fonts"])
            ),
            "unprotected_body_or_bubble_edge_single_day_top1_max": 0,
        },
        "unprotected_body_or_bubble_edge_single_day_top1": int(
            np.sum((after_top == sd_index) & unprotected_hard)
        ),
    }
    if not collapse["passed"]:
        raise PseudoRefinementR2Error(f"r2 collapse gate failed: {collapse}")

    report_core = {
        "action_counts": dict(action_counts),
        "application": {
            "changed_rows": len(lineage_rows),
            "protected_reviewed_rows": int(protected_array.sum()),
            "top1_shift_count": int(np.sum(before_top != after_top)),
            "unchanged_reviewed_high_value_rows": len(high_labels),
            "unchanged_reviewed_visual_rows": len(visual_reviewed),
        },
        "collapse_gate": collapse,
        "global": {
            "before": before_distribution,
            "after": after_distribution,
            "r1_r5": _agreement_summary(
                before_array, r5_array, candidate_ids=candidate_ids
            ),
            "r1_r7": _agreement_summary(
                before_array, r7_array, candidate_ids=candidate_ids
            ),
            "r5_r7": _agreement_summary(r5_array, r7_array, candidate_ids=candidate_ids),
        },
        "groups": {
            "role": _group_refinement_report(
                before_array,
                after_array,
                r5_array,
                r7_array,
                roles,
                candidate_ids=candidate_ids,
                protected=protected_array,
            ),
            "source_category": _group_refinement_report(
                before_array,
                after_array,
                r5_array,
                r7_array,
                categories,
                candidate_ids=candidate_ids,
                protected=protected_array,
            ),
            "work": _group_refinement_report(
                before_array,
                after_array,
                r5_array,
                r7_array,
                work_ids,
                candidate_ids=candidate_ids,
                protected=protected_array,
                titles=titles,
            ),
        },
        "role_conditioned_prior": prior_report,
        "single_day": {
            "hard_negative_probability_mass_after": float(
                after_array[hard_negative, sd_index].sum()
            ),
            "hard_negative_probability_mass_before": float(
                before_array[hard_negative, sd_index].sum()
            ),
            "protected_hard_negative_top1_after": int(
                np.sum((after_top == sd_index) & hard_negative & protected_array)
            ),
            "specialist_probability_mass_after": float(
                after_array[~hard_negative, sd_index].sum()
            ),
            "specialist_probability_mass_before": float(
                before_array[~hard_negative, sd_index].sum()
            ),
            "specialist_top1_after": int(np.sum((after_top == sd_index) & ~hard_negative)),
            "specialist_top1_before": int(np.sum((before_top == sd_index) & ~hard_negative)),
        },
        "split_boundary": {
            "blind_calibration_rows_promoted": 0,
            "evaluation_rows_promoted": 0,
            "master_test_rows_promoted": 0,
            "master_val_rows_promoted": 0,
            "output_train_pseudo_rows": len(output_rows),
            "qa_rows_promoted": 0,
            "val33_rows_promoted": 0,
        },
        "timing": {"elapsed_seconds": time.perf_counter() - started},
    }
    inputs = {
        "high_value_reviewed": high_binding,
        "inference": inference_binding,
        "pseudo": {
            "manifest_sha256": sha256_file(
                args.refined_r1_dir / refinement.MANIFEST_FILE
            ),
            "pseudo_sha256": sha256_file(
                args.refined_r1_dir / refinement.PSEUDO_FILE
            ),
            "report_sha256": sha256_file(
                args.refined_r1_dir / refinement.REPORT_FILE
            ),
            "row_count": len(source_rows),
        },
    }
    result = _write_loader_bundle(
        destination=args.output_dir,
        output_rows=output_rows,
        lineage_rows=lineage_rows,
        candidate_ids=candidate_ids,
        inputs=inputs,
        report_core=report_core,
    )
    # Re-open through the actual mass21 loader contract after publication.
    validation = refinement.validate_output(args.output_dir)
    if validation.get("loader_compatible_rows") != EXPECTED_PSEUDO_ROWS:
        raise PseudoRefinementR2Error("published r2 loader compatibility drifted")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    infer = commands.add_parser("infer")
    infer.add_argument(
        "--master-manifest",
        type=Path,
        default=Path("datasets/font-matching-master-v3/manifest.jsonl"),
    )
    infer.add_argument(
        "--r5-review",
        type=Path,
        default=Path(
            "artifacts/manga-font-master-v3-label-pass-r5-epoch1-v1/"
            "review-predictions.jsonl"
        ),
    )
    infer.add_argument(
        "--r5-head-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r5-epoch1-qa-v1"),
    )
    infer.add_argument(
        "--hidden-cache-dir",
        type=Path,
        default=Path("artifacts/manga-font-master-v3-siglip2-hidden-cache-v1"),
    )
    infer.add_argument(
        "--query-dataset-npz",
        type=Path,
        default=Path(
            "artifacts/manga-font-student-v8-role-family-dataset-r7-high-value-"
            "agent-001-800-training-only-r1/role-family-dataset.npz"
        ),
    )
    infer.add_argument(
        "--adapter-dir",
        type=Path,
        default=Path(
            "artifacts/experiments/manga-font-v2-r7-interpolated-r3h-full-restart-"
            "alpha-grid-20260811-r1"
        ),
    )
    infer.add_argument(
        "--refined-r1-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-pseudo-refinement-r1"),
    )
    infer.add_argument("--output-dir", type=Path, required=True)
    infer.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    infer.add_argument("--query-batch-size", type=int, default=256)
    infer.add_argument("--adapter-batch-size", type=int, default=512)

    build = commands.add_parser("build")
    build.add_argument("--inference-dir", type=Path, required=True)
    build.add_argument(
        "--refined-r1-dir",
        type=Path,
        default=Path("artifacts/manga-font-v2-pseudo-refinement-r1"),
    )
    build.add_argument(
        "--high-value-labels-dir",
        type=Path,
        default=Path(
            "artifacts/manga-font-v2-high-value-supervised-labels-agent-001-800-"
            "training-only-r1"
        ),
    )
    build.add_argument("--output-dir", type=Path, required=True)

    validate_inference = commands.add_parser("validate-inference")
    validate_inference.add_argument("--output-dir", type=Path, required=True)
    validate_refinement = commands.add_parser("validate-refinement")
    validate_refinement.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "infer":
            result = infer_master(args)
        elif args.command == "build":
            result = build_refinement(args)
        elif args.command == "validate-inference":
            result = validate_inference_output(args.output_dir)
        else:
            result = refinement.validate_output(args.output_dir)
    except (PseudoRefinementR2Error, refinement.PseudoRefinementError, OSError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
