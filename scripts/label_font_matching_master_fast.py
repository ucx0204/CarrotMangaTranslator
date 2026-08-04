#!/usr/bin/env python3
"""Fast, resumable 22-font pseudo-labeling for the full real crop inventory.

This tool deliberately separates *coverage* from *authority*:

* pass 1 assigns a Korean font to every decodable crop;
* every score and binding needed for later review is retained; and
* pass-1 rows are never marked as human/gold training labels.

The feature stage is sharded so a long GPU run can resume without reopening
already completed source pixels.  The rank stage uses the current full-22
prototype-conditioned model as a fast bootstrap, not as final truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

try:
    import font_matching_catalog_assets as catalog_assets
    import train_font_matching_siglip_baseline as baseline
except ImportError:  # pragma: no cover - import from repository root
    from scripts import font_matching_catalog_assets as catalog_assets  # type: ignore[no-redef]
    from scripts import train_font_matching_siglip_baseline as baseline  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-fast-pseudo-label-v1"
FEATURE_SCHEMA_VERSION = "font-matching-fast-feature-cache-v1"
VIEW_NAMES = ("raw_224", "context_224", "glyph_224")
ROLE_VALUES = baseline.ROLE_VALUES
STYLE_FIELDS = baseline.STYLE_FIELDS
TREATMENT_VALUES = baseline.TREATMENT_VALUES
VARIANT_ROLES = baseline.VARIANT_ROLES
VARIANT_CATEGORIES = frozenset(
    {"bubble_edge", "text_free", "ocr_hard", "page_sound", "ocr_anime_region"}
)


class FastLabelError(ValueError):
    """Raised when a fast-label artifact or binding is invalid."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_sha256(value: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise FastLabelError(f"expected JSON object: {path}")
    return value


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise FastLabelError(f"{path}:{line_number}: expected object")
            yield value


def atomic_write(path: Path, payload: bytes) -> None:
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


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    atomic_write(
        path,
        (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
            "utf-8"
        ),
    )


def _source_category(row: Mapping[str, Any]) -> str:
    metadata = row.get("metadata")
    if not isinstance(metadata, Mapping):
        return "ordinary"
    value = metadata.get("candidate_primary_category") or metadata.get(
        "candidate_category"
    )
    return str(value) if isinstance(value, str) and value else "ordinary"


def _compact_index_row(row_index: int, row: Mapping[str, Any]) -> dict[str, Any]:
    work = row.get("work") if isinstance(row.get("work"), Mapping) else {}
    chapter = row.get("chapter") if isinstance(row.get("chapter"), Mapping) else {}
    page = row.get("page") if isinstance(row.get("page"), Mapping) else {}
    provenance = (
        row.get("provenance") if isinstance(row.get("provenance"), Mapping) else {}
    )
    compact = {
        "chapter_id": str(chapter.get("id") or "unknown-chapter"),
        "chapter_title": str(chapter.get("title") or ""),
        "page_id": str(page.get("id") or "unknown-page"),
        "page_name": str(page.get("name") or ""),
        "row_index": row_index,
        "sample_id": str(row.get("id")),
        "source_category": _source_category(row),
        "source_kind": str(provenance.get("source_kind") or "unknown"),
        "split": str(row.get("split") or "unknown"),
        "work_id": str(work.get("id") or "unknown-work"),
        "work_title": str(work.get("title") or ""),
    }
    compact["record_sha256"] = record_sha256(compact)
    return compact


def _resolver_sample(row: Mapping[str, Any]) -> dict[str, Any]:
    views = row.get("views")
    if not isinstance(views, Mapping):
        raise FastLabelError(f"{row.get('id')}: missing views")
    # Keep the resolver input intentionally narrow.  This still verifies every
    # catalog path/hash while avoiding unrelated master metadata flags.
    return {"sample_id": str(row.get("id")), "source": {"views": dict(views)}}


def _load_master_rows(path: Path, splits: frozenset[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in iter_jsonl(path):
        split = str(row.get("split") or "")
        if split not in splits:
            continue
        sample_id = str(row.get("id") or "")
        if not sample_id or sample_id in seen:
            raise FastLabelError(f"invalid or duplicate master sample id: {sample_id!r}")
        seen.add(sample_id)
        rows.append(row)
    if not rows:
        raise FastLabelError("no master rows selected")
    return rows


def _shard_core(
    *,
    shard_index: int,
    start: int,
    rows: Sequence[Mapping[str, Any]],
    master_sha256: str,
) -> dict[str, Any]:
    ids = [str(row.get("id")) for row in rows]
    return {
        "end_row_exclusive": start + len(rows),
        "master_manifest_sha256": master_sha256,
        "row_count": len(rows),
        "sample_ids_sha256": sha256_bytes("\n".join(ids).encode("utf-8")),
        "schema_version": FEATURE_SCHEMA_VERSION,
        "shard_index": shard_index,
        "start_row": start,
        "view_names": list(VIEW_NAMES),
    }


def _existing_shard_is_valid_without_model(
    *,
    feature_path: Path,
    index_path: Path,
    metadata_path: Path,
    expected_core: Mapping[str, Any],
    feature_dim: int,
) -> bool:
    if not (feature_path.is_file() and index_path.is_file() and metadata_path.is_file()):
        return False
    metadata = read_json(metadata_path)
    for key, value in expected_core.items():
        if metadata.get(key) != value:
            return False
    if metadata.get("feature_dim") != feature_dim:
        return False
    if metadata.get("feature_sha256") != sha256_file(feature_path):
        return False
    if metadata.get("index_sha256") != sha256_file(index_path):
        return False
    try:
        feature = np.load(feature_path, mmap_mode="r", allow_pickle=False)
    except (OSError, ValueError):
        return False
    return feature.shape == (
        int(expected_core["row_count"]),
        len(VIEW_NAMES),
        feature_dim,
    ) and feature.dtype == np.float16


def extract_command(args: argparse.Namespace) -> int:
    master_manifest = args.master_manifest.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    shard_dir = output_dir / "feature-shards"
    shard_dir.mkdir(parents=True, exist_ok=True)
    splits = frozenset(part.strip() for part in args.splits.split(",") if part.strip())
    if not splits or not splits <= {"train", "val", "test"}:
        raise FastLabelError("splits must be a comma-separated subset of train,val,test")
    rows = _load_master_rows(master_manifest, splits)
    master_sha256 = sha256_file(master_manifest)
    resolver = catalog_assets.CatalogAssetResolver(args.catalog_registry)
    extractor = baseline.FrozenSiglipExtractor(device=args.device, fp16=args.fp16)
    feature_dim = extractor.feature_dim
    shard_records: list[dict[str, Any]] = []
    shard_count = math.ceil(len(rows) / args.shard_size)
    for shard_index in range(shard_count):
        start = shard_index * args.shard_size
        shard_rows = rows[start : start + args.shard_size]
        stem = f"shard-{shard_index:05d}"
        feature_path = shard_dir / f"{stem}.npy"
        index_path = shard_dir / f"{stem}.jsonl"
        metadata_path = shard_dir / f"{stem}.json"
        core = _shard_core(
            shard_index=shard_index,
            start=start,
            rows=shard_rows,
            master_sha256=master_sha256,
        )
        if _existing_shard_is_valid_without_model(
            feature_path=feature_path,
            index_path=index_path,
            metadata_path=metadata_path,
            expected_core=core,
            feature_dim=feature_dim,
        ):
            metadata = read_json(metadata_path)
            shard_records.append(metadata)
            print(f"feature shard {shard_index + 1}/{shard_count}: reuse", flush=True)
            continue

        features = np.empty(
            (len(shard_rows), len(VIEW_NAMES), feature_dim), dtype=np.float32
        )
        images: list[Any] = []
        positions: list[tuple[int, int]] = []

        def flush() -> None:
            if not images:
                return
            try:
                encoded = extractor.encode(images)
                for encoded_row, (sample_index, view_index) in zip(encoded, positions):
                    features[sample_index, view_index] = encoded_row
            finally:
                for image in images:
                    image.close()
                images.clear()
                positions.clear()

        for local_index, row in enumerate(shard_rows):
            sample = _resolver_sample(row)
            for view_index, view_name in enumerate(VIEW_NAMES):
                with resolver.resolve_sample_view(sample, view_name) as resolved:
                    images.append(resolved.image.copy())
                    positions.append((local_index, view_index))
                if len(images) >= args.image_batch_size:
                    flush()
        flush()
        if not np.isfinite(features).all():
            raise FastLabelError(f"{stem}: non-finite feature")

        index_rows = [_compact_index_row(start + i, row) for i, row in enumerate(shard_rows)]
        index_payload = b"".join(
            (canonical_json(row) + "\n").encode("utf-8") for row in index_rows
        )
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{feature_path.name}.", suffix=".tmp", dir=feature_path.parent
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with temporary.open("wb") as handle:
                np.save(handle, features.astype(np.float16), allow_pickle=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, feature_path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        atomic_write(index_path, index_payload)
        metadata = dict(core)
        metadata.update(
            {
                "feature_dim": feature_dim,
                "feature_file": feature_path.relative_to(output_dir).as_posix(),
                "feature_sha256": sha256_file(feature_path),
                "index_file": index_path.relative_to(output_dir).as_posix(),
                "index_sha256": sha256_file(index_path),
            }
        )
        metadata["record_sha256"] = record_sha256(metadata)
        atomic_json(metadata_path, metadata)
        shard_records.append(metadata)
        print(
            f"feature shard {shard_index + 1}/{shard_count}: encoded {len(shard_rows)}",
            flush=True,
        )

    manifest = {
        "catalog_registry_sha256": resolver.registry_sha256,
        "encoder": {
            "class": baseline.ENCODER_CLASS,
            "feature_dim": feature_dim,
            "model_id": baseline.ENCODER_ID,
            "revision": baseline.ENCODER_REVISION,
        },
        "master_manifest": str(master_manifest),
        "master_manifest_sha256": master_sha256,
        "row_count": len(rows),
        "schema_version": FEATURE_SCHEMA_VERSION,
        "shards": shard_records,
        "splits": sorted(splits),
        "view_names": list(VIEW_NAMES),
    }
    manifest["record_sha256"] = record_sha256(manifest)
    atomic_json(output_dir / "feature-manifest.json", manifest)
    print(canonical_json({"completed": True, "rows": len(rows), "shards": shard_count}))
    return 0


def _softmax(values: np.ndarray, axis: int = -1) -> np.ndarray:
    shifted = values - np.max(values, axis=axis, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / np.sum(exponent, axis=axis, keepdims=True)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -40.0, 40.0)))


def _candidate_bags(
    prototype_manifest: Mapping[str, Any], candidate_ids: Sequence[str]
) -> tuple[list[np.ndarray], list[Any]]:
    import torch

    rows = prototype_manifest.get("prototype_index")
    if not isinstance(rows, list):
        raise FastLabelError("prototype cache lacks prototype_index")
    by_font: dict[str, list[int]] = {candidate: [] for candidate in candidate_ids}
    for row_index, row in enumerate(rows):
        if not isinstance(row, Mapping) or row.get("row_index") != row_index:
            raise FastLabelError("prototype index order drifted")
        font_id = str(row.get("font_id") or "")
        if font_id in by_font:
            by_font[font_id].append(row_index)
    if any(not by_font[candidate] for candidate in candidate_ids):
        missing = [candidate for candidate in candidate_ids if not by_font[candidate]]
        raise FastLabelError(f"prototype bags missing candidates: {missing}")
    numpy_bags = [np.asarray(by_font[candidate], dtype=np.int64) for candidate in candidate_ids]
    torch_bags = [torch.tensor(bag, dtype=torch.long) for bag in numpy_bags]
    return numpy_bags, torch_bags


def _direct_reference_scores(
    *,
    features: np.ndarray,
    prototypes: np.ndarray,
    bags: Sequence[np.ndarray],
    view_weights: np.ndarray,
) -> np.ndarray:
    similarities = np.einsum("bvd,pd->bvp", features, prototypes, optimize=True)
    per_candidate: list[np.ndarray] = []
    scale = 10.0
    for bag in bags:
        selected = similarities[:, :, bag] * scale
        maximum = np.max(selected, axis=2, keepdims=True)
        lme = (
            np.log(np.mean(np.exp(selected - maximum), axis=2))
            + maximum.squeeze(2)
        ) / scale
        per_candidate.append(lme)
    stacked = np.stack(per_candidate, axis=2)
    return np.sum(stacked * view_weights[:, :, None], axis=1)


def _top_entries(
    candidate_ids: Sequence[str], probabilities: np.ndarray, scores: np.ndarray, count: int
) -> list[dict[str, Any]]:
    order = np.argsort(-probabilities)[:count]
    return [
        {
            "font_id": candidate_ids[int(index)],
            "probability": round(float(probabilities[index]), 8),
            "rank": rank + 1,
            "score": round(float(scores[index]), 8),
        }
        for rank, index in enumerate(order)
    ]


def _review_priority(
    *,
    category: str,
    ranker_margin: float,
    ranker_top1: str,
    direct_top1: str,
    variant_probability: float,
) -> tuple[int, list[str]]:
    reasons: list[str] = []
    is_variant = category in VARIANT_CATEGORIES or variant_probability >= 0.45
    if is_variant:
        reasons.append("variant_or_nonballoon_text")
    if ranker_margin < 0.08:
        reasons.append("small_top1_margin")
    if ranker_top1 != direct_top1:
        reasons.append("ranker_reference_disagreement")
    if is_variant and (ranker_margin < 0.08 or ranker_top1 != direct_top1):
        return 0, reasons
    if is_variant or ranker_margin < 0.15 or ranker_top1 != direct_top1:
        return 1, reasons
    return 2, reasons or ["ordinary_high_margin"]


def rank_command(args: argparse.Namespace) -> int:
    import torch

    feature_root = args.feature_dir.resolve()
    feature_manifest = read_json(feature_root / "feature-manifest.json")
    model_contract = read_json(args.model_contract)
    prototype_manifest = read_json(args.prototype_cache / "manifest.json")
    candidate_ids_raw = (model_contract.get("vocabulary") or {}).get("candidate_ids")
    if not isinstance(candidate_ids_raw, list) or len(candidate_ids_raw) != 22:
        raise FastLabelError("rank pass requires a full 22-candidate model")
    candidate_ids = tuple(str(value) for value in candidate_ids_raw)
    prototypes = np.load(
        args.prototype_cache / "prototype-features.npy", allow_pickle=False
    ).astype(np.float32)
    prototypes /= np.linalg.norm(prototypes, axis=1, keepdims=True).clip(min=1e-8)
    numpy_bags, torch_bags_cpu = _candidate_bags(prototype_manifest, candidate_ids)

    hyperparameters = model_contract.get("hyperparameters") or {}
    model = baseline.build_ranker(
        feature_dim=int(feature_manifest["encoder"]["feature_dim"]),
        hidden_dim=int(hyperparameters.get("hidden_dim", 256)),
        view_dropout=float(hyperparameters.get("view_dropout", 0.0)),
        head_dropout=float(hyperparameters.get("head_dropout", 0.0)),
    )
    state = baseline.load_checkpoint(args.checkpoint)
    model.load_state_dict(state, strict=True)
    device = "cuda" if args.device == "auto" and torch.cuda.is_available() else args.device
    if device == "auto":
        device = "cpu"
    model.to(device).eval()
    prototype_tensor = torch.from_numpy(prototypes).to(device)
    torch_bags = [bag.to(device) for bag in torch_bags_cpu]
    calibration = model_contract.get("calibration") or {}
    temperature = float(args.temperature or calibration.get("temperature") or 1.0)
    if not math.isfinite(temperature) or temperature <= 0:
        raise FastLabelError("temperature must be positive")

    output_path = args.output.resolve()
    report_path = args.report.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
    )
    counts = Counter()
    font_counts = Counter()
    category_counts = Counter()
    disagreement_count = 0
    margin_values: list[float] = []
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            shards = feature_manifest.get("shards")
            if not isinstance(shards, list):
                raise FastLabelError("feature manifest lacks shards")
            for shard_number, shard in enumerate(shards, 1):
                feature_path = feature_root / str(shard["feature_file"])
                index_path = feature_root / str(shard["index_file"])
                if sha256_file(feature_path) != shard.get("feature_sha256"):
                    raise FastLabelError(f"feature shard hash drifted: {feature_path}")
                if sha256_file(index_path) != shard.get("index_sha256"):
                    raise FastLabelError(f"index shard hash drifted: {index_path}")
                features_all = np.load(feature_path, allow_pickle=False).astype(np.float32)
                norms = np.linalg.norm(features_all, axis=2, keepdims=True).clip(min=1e-8)
                features_all /= norms
                index_rows = list(iter_jsonl(index_path))
                if len(index_rows) != len(features_all):
                    raise FastLabelError("feature/index row count mismatch")
                for start in range(0, len(index_rows), args.batch_size):
                    stop = min(len(index_rows), start + args.batch_size)
                    feature_batch = features_all[start:stop]
                    with torch.inference_mode():
                        result = model(
                            torch.from_numpy(feature_batch).to(device),
                            prototype_tensor,
                            torch_bags,
                        )
                    candidate_scores = result["candidate_scores"].float().cpu().numpy()
                    probabilities = _softmax(candidate_scores / temperature, axis=1)
                    none_probability = _sigmoid(
                        result["none_logits"].float().cpu().numpy()
                    )
                    role_probabilities = _softmax(
                        result["role_logits"].float().cpu().numpy(), axis=1
                    )
                    style_values = _sigmoid(
                        result["style_logits"].float().cpu().numpy()
                    )
                    view_weights = result["view_gate_weights"].float().cpu().numpy()
                    treatment_probabilities = {
                        field: _softmax(logits.float().cpu().numpy(), axis=1)
                        for field, logits in result["treatment_logits"].items()
                    }
                    direct_scores = _direct_reference_scores(
                        features=feature_batch,
                        prototypes=prototypes,
                        bags=numpy_bags,
                        view_weights=view_weights,
                    )
                    direct_probabilities = _softmax(direct_scores / 0.10, axis=1)

                    for offset, index_row in enumerate(index_rows[start:stop]):
                        order = np.argsort(-probabilities[offset])
                        top1_index = int(order[0])
                        top2_index = int(order[1])
                        top1 = candidate_ids[top1_index]
                        direct_index = int(np.argmax(direct_probabilities[offset]))
                        direct_top1 = candidate_ids[direct_index]
                        margin = float(
                            probabilities[offset, top1_index]
                            - probabilities[offset, top2_index]
                        )
                        variant_probability = float(
                            sum(
                                role_probabilities[offset, ROLE_VALUES.index(role)]
                                for role in VARIANT_ROLES
                            )
                        )
                        category = str(index_row["source_category"])
                        priority, reasons = _review_priority(
                            category=category,
                            ranker_margin=margin,
                            ranker_top1=top1,
                            direct_top1=direct_top1,
                            variant_probability=variant_probability,
                        )
                        role_order = np.argsort(-role_probabilities[offset])[:3]
                        treatment = {}
                        for field, values in TREATMENT_VALUES.items():
                            treatment_index = int(
                                np.argmax(treatment_probabilities[field][offset])
                            )
                            treatment[field] = {
                                "confidence": round(
                                    float(
                                        treatment_probabilities[field][offset, treatment_index]
                                    ),
                                    8,
                                ),
                                "value": values[treatment_index],
                            }
                        core = {
                            "candidate_count": len(candidate_ids),
                            "chapter_id": index_row["chapter_id"],
                            "chapter_title": index_row["chapter_title"],
                            "direct_reference": {
                                "selected_font_id": direct_top1,
                                "top5": _top_entries(
                                    candidate_ids,
                                    direct_probabilities[offset],
                                    direct_scores[offset],
                                    5,
                                ),
                            },
                            "label_authority": "pseudo_not_gold",
                            "label_status": "pseudo_fast_pass_1",
                            "none_probability": round(float(none_probability[offset]), 8),
                            "page_id": index_row["page_id"],
                            "page_name": index_row["page_name"],
                            "pass_number": 1,
                            "ranker": {
                                "selected_font_id": top1,
                                "top1_margin": round(margin, 8),
                                "top5": _top_entries(
                                    candidate_ids,
                                    probabilities[offset],
                                    candidate_scores[offset],
                                    5,
                                ),
                            },
                            "review": {
                                "priority": priority,
                                "reasons": reasons,
                                "status": "pending",
                            },
                            "role": {
                                "top3": [
                                    {
                                        "confidence": round(
                                            float(role_probabilities[offset, role_index]), 8
                                        ),
                                        "role": ROLE_VALUES[int(role_index)],
                                    }
                                    for role_index in role_order
                                ],
                                "variant_probability": round(variant_probability, 8),
                            },
                            "sample_id": index_row["sample_id"],
                            "schema_version": SCHEMA_VERSION,
                            "selected_font_id": top1,
                            "selection_source": "full22_ranker_top1",
                            "source_category": category,
                            "source_kind": index_row["source_kind"],
                            "source_row_index": index_row["row_index"],
                            "split": index_row["split"],
                            "style": {
                                field: round(float(style_values[offset, style_index]), 8)
                                for style_index, field in enumerate(STYLE_FIELDS)
                            },
                            "training_eligible": False,
                            "treatment": treatment,
                            "view_gate_weights": {
                                view: round(float(view_weights[offset, view_index]), 8)
                                for view_index, view in enumerate(VIEW_NAMES)
                            },
                            "work_id": index_row["work_id"],
                            "work_title": index_row["work_title"],
                        }
                        core["record_sha256"] = record_sha256(core)
                        output.write(canonical_json(core) + "\n")
                        counts[f"priority_{priority}"] += 1
                        font_counts[top1] += 1
                        category_counts[category] += 1
                        disagreement_count += int(top1 != direct_top1)
                        margin_values.append(margin)
                print(
                    f"rank shard {shard_number}/{len(shards)}: {len(index_rows)} rows",
                    flush=True,
                )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, output_path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise

    row_count = sum(font_counts.values())
    report = {
        "bindings": {
            "checkpoint_sha256": sha256_file(args.checkpoint),
            "feature_manifest_sha256": sha256_file(
                feature_root / "feature-manifest.json"
            ),
            "model_contract_sha256": sha256_file(args.model_contract),
            "prototype_cache_manifest_sha256": sha256_file(
                args.prototype_cache / "manifest.json"
            ),
        },
        "candidate_count": len(candidate_ids),
        "candidate_ids": list(candidate_ids),
        "coverage": 1.0 if row_count else 0.0,
        "direct_reference_disagreement_count": disagreement_count,
        "direct_reference_disagreement_rate": disagreement_count / max(1, row_count),
        "font_usage": dict(sorted(font_counts.items())),
        "label_authority": "pseudo_not_gold",
        "margin": {
            "mean": float(np.mean(margin_values)) if margin_values else None,
            "median": float(np.median(margin_values)) if margin_values else None,
            "p10": float(np.quantile(margin_values, 0.10)) if margin_values else None,
            "p90": float(np.quantile(margin_values, 0.90)) if margin_values else None,
        },
        "output_file": output_path.name,
        "output_sha256": sha256_file(output_path),
        "review_priority_counts": dict(sorted(counts.items())),
        "row_count": row_count,
        "schema_version": SCHEMA_VERSION,
        "source_category_counts": dict(sorted(category_counts.items())),
        "temperature": temperature,
        "training_eligible_rows": 0,
    }
    report["record_sha256"] = record_sha256(report)
    atomic_json(report_path, report)
    print(canonical_json({"completed": True, "coverage": report["coverage"], "rows": row_count}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract = subparsers.add_parser("extract", help="extract resumable full-master features")
    extract.add_argument("--master-manifest", type=Path, required=True)
    extract.add_argument("--catalog-registry", type=Path, required=True)
    extract.add_argument("--output-dir", type=Path, required=True)
    extract.add_argument("--splits", default="train,val,test")
    extract.add_argument("--shard-size", type=int, default=256)
    extract.add_argument("--image-batch-size", type=int, default=192)
    extract.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    extract.add_argument("--fp16", action=argparse.BooleanOptionalAction, default=True)
    extract.set_defaults(func=extract_command)

    rank = subparsers.add_parser("rank", help="assign a fast pass-1 font to every row")
    rank.add_argument("--feature-dir", type=Path, required=True)
    rank.add_argument("--model-contract", type=Path, required=True)
    rank.add_argument("--checkpoint", type=Path, required=True)
    rank.add_argument("--prototype-cache", type=Path, required=True)
    rank.add_argument("--output", type=Path, required=True)
    rank.add_argument("--report", type=Path, required=True)
    rank.add_argument("--batch-size", type=int, default=1024)
    rank.add_argument("--temperature", type=float)
    rank.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    rank.set_defaults(func=rank_command)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, "shard_size", 1) < 1:
        raise FastLabelError("shard size must be positive")
    if getattr(args, "image_batch_size", 1) < 1 or getattr(args, "batch_size", 1) < 1:
        raise FastLabelError("batch size must be positive")
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
