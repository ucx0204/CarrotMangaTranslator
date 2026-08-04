from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    import build_manga_font_legacy15_train_overlay_v1 as legacy_overlay
    import diagnose_manga_font_student_v3_real_knn as d109
    import train_font_matching_siglip_baseline as legacy
except ImportError:  # pragma: no cover - repository-root import
    from scripts import build_manga_font_legacy15_train_overlay_v1 as legacy_overlay
    from scripts import diagnose_manga_font_student_v3_real_knn as d109
    from scripts import train_font_matching_siglip_baseline as legacy


SCHEMA = "manga-font-student-v3-legacy727-knn-diagnostic-v1"
OWNER = SCHEMA
MARKER = f".{OWNER}-owned.json"
REPORT = "diagnostic-report.json"
FILES = frozenset({MARKER, REPORT})
WORK_RE = re.compile(rb'"work_id"\s*:\s*"([0-9a-f-]{36})"')
SAMPLE_RE = re.compile(rb'"sample_id"\s*:\s*"([a-z0-9_-]+)"')
SOURCE_SHA_RE = re.compile(rb'"source_page_sha256"\s*:\s*"([0-9a-f]{64})"')
SPLIT_RE = re.compile(rb'"split"\s*:\s*"(train|val|test)"')
QA_PAGE_RE = re.compile(rb'"id"\s*:\s*"([0-9a-f-]{36})"')
QA_IMAGE_SHA_RE = re.compile(rb'"imageSha256"\s*:\s*"([0-9a-f]{64})"')


class Legacy727KnnDiagnosticError(RuntimeError):
    pass


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise Legacy727KnnDiagnosticError(f"{location}: expected object")
    return value


def _one_match(pattern: re.Pattern[bytes], line: bytes, location: str) -> str:
    matches = {value.decode("ascii") for value in pattern.findall(line)}
    if len(matches) != 1:
        raise Legacy727KnnDiagnosticError(
            f"{location}: expected one stable metadata value, got {len(matches)}"
        )
    return next(iter(matches))


def _scan_raw_finals(
    path: Path, work_split: Mapping[str, str]
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, Any]], dict[str, int]]:
    metadata: dict[str, dict[str, str]] = {}
    parsed_train: dict[str, dict[str, Any]] = {}
    counts = {"train": 0, "val": 0, "test": 0}
    with path.expanduser().resolve().open("rb") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            location = f"raw final line {line_number}"
            work_id = _one_match(WORK_RE, line, location)
            sample_id = _one_match(SAMPLE_RE, line, location)
            source_sha = _one_match(SOURCE_SHA_RE, line, location)
            split = work_split.get(work_id)
            if split not in counts:
                raise Legacy727KnnDiagnosticError(
                    f"{location}: work is absent from canonical split map"
                )
            counts[split] += 1
            if sample_id in metadata:
                raise Legacy727KnnDiagnosticError("duplicate raw final sample")
            metadata[sample_id] = {
                "source_page_sha256": source_sha,
                "split": split,
                "work_id": work_id,
            }
            # Fail closed: non-train lines are never passed to json.loads.
            if split != "train":
                continue
            try:
                row = dict(_mapping(json.loads(line), location))
            except json.JSONDecodeError as error:
                raise Legacy727KnnDiagnosticError(
                    f"{location}: invalid train JSON"
                ) from error
            legacy.validate_record_seal(row, location=location)
            if (
                row.get("sample_id") != sample_id
                or row.get("work_id") != work_id
                or row.get("source_page_sha256") != source_sha
            ):
                raise Legacy727KnnDiagnosticError(
                    f"{location}: regex/JSON train binding drifted"
                )
            parsed_train[sample_id] = row
    if counts != {"train": 734, "val": 207, "test": 259}:
        raise Legacy727KnnDiagnosticError(f"raw final split counts drifted: {counts}")
    return metadata, parsed_train, counts


def _scan_full22_export_metadata(path: Path) -> dict[str, dict[str, str]]:
    metadata: dict[str, dict[str, str]] = {}
    with path.expanduser().resolve().open("rb") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            location = f"full22 export metadata line {line_number}"
            sample_id = _one_match(SAMPLE_RE, line, location)
            split = _one_match(SPLIT_RE, line, location)
            work_id = _one_match(WORK_RE, line, location)
            source_sha = _one_match(SOURCE_SHA_RE, line, location)
            if sample_id in metadata:
                raise Legacy727KnnDiagnosticError("duplicate full22 export sample")
            # Deliberately no json.loads: this includes the burned test30 payload.
            metadata[sample_id] = {
                "source_page_sha256": source_sha,
                "split": split,
                "work_id": work_id,
            }
    return metadata


def _scan_qa_metadata(artifacts_root: Path) -> dict[str, Any]:
    roots = sorted(
        path
        for path in artifacts_root.expanduser()
        .resolve()
        .glob("library-full-pipeline-font-qa-v*")
        if path.is_dir()
    )
    page_ids: set[str] = set()
    page_shas: set[str] = set()
    sources: list[dict[str, Any]] = []
    for root in roots:
        for path in sorted((root / "cohorts").glob("*.jsonl")):
            line_count = 0
            with path.open("rb") as handle:
                for line_number, line in enumerate(handle, 1):
                    if not line.strip():
                        continue
                    sha = _one_match(
                        QA_IMAGE_SHA_RE, line, f"QA metadata {path}:{line_number}"
                    )
                    ids = {value.decode("ascii") for value in QA_PAGE_RE.findall(line)}
                    # work/chapter/page IDs all match the UUID pattern; the page ID is
                    # the third UUID in the canonical QA manifest.
                    if len(ids) < 3:
                        raise Legacy727KnnDiagnosticError("QA page metadata drifted")
                    page_shas.add(sha)
                    page_ids.update(ids)
                    line_count += 1
            sources.append(
                {
                    "file": str(path),
                    "record_count": line_count,
                    "sha256": d109.base.sha256_file(path),
                }
            )
    if not sources:
        raise Legacy727KnnDiagnosticError("no library 40-page QA metadata found")
    return {
        "file_count": len(sources),
        "page_or_container_id_count": len(page_ids),
        "source_page_sha256_count": len(page_shas),
        "sources": sources,
        "page_ids": page_ids,
        "page_shas": page_shas,
    }


def _validate_legacy_model(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    model_root = root.expanduser().resolve()
    expected = {
        ".font-matching-siglip-baseline-owned.json",
        "checkpoint.safetensors",
        "model-contract.json",
        "predictions-val.jsonl",
        "report.json",
    }
    if (
        not model_root.is_dir()
        or {path.name for path in model_root.iterdir()} != expected
    ):
        raise Legacy727KnnDiagnosticError("legacy baseline inventory drifted")
    marker = legacy._read_json(  # noqa: SLF001
        model_root / ".font-matching-siglip-baseline-owned.json",
        location="legacy baseline marker",
    )
    if (
        marker.get("owner") != legacy.OUTPUT_OWNER
        or marker.get("schema_version") != legacy.TRAINER_SCHEMA_VERSION
        or marker.get("safe_replace") is not True
    ):
        raise Legacy727KnnDiagnosticError("legacy baseline marker drifted")
    artifacts = _mapping(marker.get("artifacts"), "legacy baseline marker artifacts")
    for name in expected - {".font-matching-siglip-baseline-owned.json"}:
        if artifacts.get(name) != legacy.sha256_file(model_root / name):
            raise Legacy727KnnDiagnosticError(
                f"legacy baseline artifact hash drifted: {name}"
            )
    contract = legacy._read_json(  # noqa: SLF001
        model_root / "model-contract.json", location="legacy model contract"
    )
    report = legacy._read_json(  # noqa: SLF001
        model_root / "report.json", location="legacy model report"
    )
    legacy.validate_record_seal(contract, location="legacy model contract")
    legacy.validate_record_seal(report, location="legacy model report")
    return dict(contract), dict(report)


def _load_legacy_features(cache_dir: Path) -> Any:
    manifest = legacy._read_json(  # noqa: SLF001
        cache_dir.expanduser().resolve() / "manifest.json",
        location="legacy feature cache manifest",
    )
    contract = _mapping(manifest.get("contract"), "legacy feature cache contract")
    inventory = _mapping(contract.get("inventory"), "legacy feature cache inventory")
    if inventory.get("test_pixel_count") != 0 or inventory.get("splits") != [
        "train",
        "val",
    ]:
        raise Legacy727KnnDiagnosticError("legacy feature cache test boundary drifted")
    return legacy.load_feature_cache(cache_dir=cache_dir, expected_contract=contract)


def _load_historical_sealed_v3_inputs(
    cache_dir: Path, sweep_dir: Path
) -> tuple[dict[str, Any], dict[str, np.ndarray], dict[str, Any]]:
    """Validate immutable artifacts without binding them to today's evolved source."""

    cache_root = cache_dir.expanduser().resolve()
    sweep_root = sweep_dir.expanduser().resolve()
    if {path.name for path in cache_root.iterdir()} != set(d109.sweep.CACHE_FILES):
        raise Legacy727KnnDiagnosticError("v3 cache inventory drifted")
    cache_marker = d109.base.read_json(
        cache_root / d109.sweep.CACHE_MARKER, location="v3 cache marker"
    )
    contract = d109.base.read_json(
        cache_root / d109.sweep.CACHE_CONTRACT, location="v3 cache contract"
    )
    d109.base.validate_record_seal(contract, location="v3 cache contract")
    if (
        cache_marker.get("owner") != d109.sweep.CACHE_OWNER
        or cache_marker.get("schema_version") != d109.sweep.CACHE_SCHEMA
        or cache_marker.get("safe_replace") is not True
        or contract.get("schema_version") != d109.sweep.CACHE_SCHEMA
    ):
        raise Legacy727KnnDiagnosticError("v3 cache metadata drifted")
    cache_artifacts = _mapping(
        cache_marker.get("artifacts"), "v3 cache marker artifacts"
    )
    for name in (d109.sweep.CACHE_ARRAYS, d109.sweep.CACHE_CONTRACT):
        if cache_artifacts.get(name) != d109.base.sha256_file(cache_root / name):
            raise Legacy727KnnDiagnosticError(f"v3 cache hash drifted: {name}")
    array_descriptor = _mapping(contract.get("arrays"), "v3 cache arrays")
    if (
        array_descriptor.get("sha256")
        != d109.base.sha256_file(cache_root / d109.sweep.CACHE_ARRAYS)
        or array_descriptor.get("byte_size")
        != (cache_root / d109.sweep.CACHE_ARRAYS).stat().st_size
    ):
        raise Legacy727KnnDiagnosticError("v3 cache array binding drifted")
    expected_arrays = _mapping(
        array_descriptor.get("contract"), "v3 cache array contract"
    )
    with np.load(cache_root / d109.sweep.CACHE_ARRAYS, allow_pickle=False) as source:
        if set(source.files) != set(expected_arrays):
            raise Legacy727KnnDiagnosticError("v3 cache array inventory drifted")
        arrays = {name: np.array(source[name], copy=True) for name in source.files}
    for name, value in arrays.items():
        descriptor = _mapping(expected_arrays[name], f"v3 cache array {name}")
        if (
            list(value.shape) != descriptor.get("shape")
            or str(value.dtype) != descriptor.get("dtype")
            or (value.dtype.kind == "f" and not np.isfinite(value).all())
        ):
            raise Legacy727KnnDiagnosticError(f"v3 cache array drifted: {name}")

    if {path.name for path in sweep_root.iterdir()} != set(d109.sweep.SWEEP_FILES):
        raise Legacy727KnnDiagnosticError("v3 sweep inventory drifted")
    sweep_marker = d109.base.read_json(
        sweep_root / d109.sweep.SWEEP_MARKER, location="v3 sweep marker"
    )
    head_report = d109.base.read_json(
        sweep_root / d109.sweep.SWEEP_REPORT, location="v3 sweep report"
    )
    d109.base.validate_record_seal(head_report, location="v3 sweep report")
    if (
        sweep_marker.get("owner") != d109.sweep.SWEEP_OWNER
        or sweep_marker.get("schema_version") != d109.sweep.SWEEP_SCHEMA
        or sweep_marker.get("safe_replace") is not True
        or head_report.get("schema_version") != d109.sweep.SWEEP_SCHEMA
    ):
        raise Legacy727KnnDiagnosticError("v3 sweep metadata drifted")
    sweep_artifacts = _mapping(
        sweep_marker.get("artifacts"), "v3 sweep marker artifacts"
    )
    for name in (d109.sweep.SWEEP_CHECKPOINT, d109.sweep.SWEEP_REPORT):
        if sweep_artifacts.get(name) != d109.base.sha256_file(sweep_root / name):
            raise Legacy727KnnDiagnosticError(f"v3 sweep hash drifted: {name}")
    cache_boundary = _mapping(contract.get("boundaries"), "v3 cache boundaries")
    sweep_boundary = _mapping(head_report.get("boundaries"), "v3 sweep boundaries")
    if (
        cache_boundary.get("human_test_labels_deserialized") != 0
        or cache_boundary.get("human_test_pixels_opened") != 0
        or cache_boundary.get("synthetic_test_pixels_opened") != 0
        or cache_boundary.get("train_val_identity_overlap") != 0
        or cache_boundary.get("val_used_for_optimizer") is not False
        or sweep_boundary.get("hidden_test_labels_deserialized") != 0
        or sweep_boundary.get("hidden_test_pixels_opened") != 0
        or sweep_boundary.get("val_used_for_optimizer") is not False
        or contract.get("candidate_ids") != head_report.get("candidate_ids")
        or head_report.get("cache_contract_sha256")
        != d109.base.sha256_file(cache_root / d109.sweep.CACHE_CONTRACT)
    ):
        raise Legacy727KnnDiagnosticError("v3 sealed boundary drifted")
    return dict(contract), arrays, dict(head_report)


def _legacy_hidden(*, torch: Any, ranker: Any, features: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        views = torch.from_numpy(features)
        normalized = ranker.view_norm(views.float())
        weights = torch.softmax(ranker.view_gate(normalized).squeeze(-1), dim=1)
        gated = (normalized * weights.unsqueeze(-1)).sum(dim=1)
        hidden = ranker.sample_projection(
            torch.cat([gated, normalized.reshape(normalized.shape[0], -1)], dim=1)
        )
    return d109._unit(hidden.detach().cpu().numpy())  # noqa: SLF001


def _authority_knn_scores(
    *,
    train_features: np.ndarray,
    query_features: np.ndarray,
    positive: np.ndarray,
    authority: np.ndarray,
    neighbors: int,
    temperature: float,
) -> tuple[np.ndarray, np.ndarray]:
    similarities = query_features @ train_features.T
    nearest = np.argsort(-similarities, axis=1, kind="stable")[:, :neighbors]
    selected = np.take_along_axis(similarities, nearest, axis=1)
    weights = np.exp((selected - selected.max(axis=1, keepdims=True)) / temperature)
    numerator = np.asarray(
        [
            (weights[row, :, None] * positive[nearest[row]]).sum(axis=0)
            for row in range(query_features.shape[0])
        ],
        dtype=np.float32,
    )
    denominator = np.asarray(
        [
            (weights[row, :, None] * authority[nearest[row]]).sum(axis=0)
            for row in range(query_features.shape[0])
        ],
        dtype=np.float32,
    )
    available = denominator > 1e-9
    scores = np.divide(
        numerator,
        denominator,
        out=np.zeros_like(numerator),
        where=available,
    )
    return scores, available


def _memory_zscore(
    scores: np.ndarray, available: np.ndarray, val_masks: np.ndarray
) -> np.ndarray:
    visible = available & val_masks
    masked = np.where(visible, scores, np.nan)
    mean = np.nanmean(masked, axis=1, keepdims=True)
    std = np.maximum(np.nanstd(masked, axis=1, keepdims=True), 1e-6)
    return np.where(visible, (scores - mean) / std, 0.0)


def _selection_key(trial: Mapping[str, Any]) -> tuple[Any, ...]:
    metrics = _mapping(trial.get("metrics"), "trial metrics")
    return (
        float(metrics["variant_preferred_at1"]),
        float(metrics["variant_acceptable_at1"]),
        float(metrics["preferred_at1"]),
        float(metrics["acceptable_at1"]),
        int(metrics["top1_unique_candidate_count"]),
        -float(metrics["top1_max_candidate_share"]),
        -int(trial["trial"]),
    )


def run_diagnostic(args: argparse.Namespace) -> Mapping[str, Any]:
    if not args.test30_known_opened:
        raise Legacy727KnnDiagnosticError(
            "this audit requires an explicit acknowledgement that test30 is burned"
        )
    output = args.output_dir.expanduser().resolve()
    if output.exists():
        raise Legacy727KnnDiagnosticError("diagnostic output already exists")
    split_map = d109.base.read_json(
        args.master_split_map.expanduser().resolve(), location="master split map"
    )
    work_split = _mapping(split_map.get("work_assignments"), "work assignments")
    final_meta, parsed_train_finals, final_counts = _scan_raw_finals(
        args.raw_finals, work_split
    )
    full22_meta = _scan_full22_export_metadata(
        args.full22_export_dir.expanduser().resolve() / "samples.jsonl"
    )
    test30 = {
        sample_id: metadata
        for sample_id, metadata in full22_meta.items()
        if metadata["split"] == "test"
    }
    val33_ids = {
        sample_id
        for sample_id, metadata in full22_meta.items()
        if metadata["split"] == "val"
    }
    train109_ids = {
        sample_id
        for sample_id, metadata in full22_meta.items()
        if metadata["split"] == "train"
    }
    test30_overlap = set(test30) & set(final_meta)
    if (
        len(test30) != 30
        or len(test30_overlap) != 30
        or len(val33_ids & set(final_meta)) != 33
        or len(train109_ids & set(final_meta)) != 109
    ):
        raise Legacy727KnnDiagnosticError("final/full22 cohort overlap drifted")

    contract, arrays, head_report = _load_historical_sealed_v3_inputs(
        args.cache_dir, args.sweep_dir
    )
    candidate_ids = tuple(str(value) for value in contract["candidate_ids"])
    registry_sha = d109.base.sha256_file(args.catalog_registry.expanduser().resolve())
    overlay_validation = legacy_overlay.validate_overlay(
        args.legacy_overlay_dir,
        candidate_ids=candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    overlay_root = args.legacy_overlay_dir.expanduser().resolve()
    overlay_rows = [
        json.loads(line)
        for line in (overlay_root / legacy_overlay.OVERLAY_FILE)
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    feature_cache = _load_legacy_features(args.legacy_feature_cache_dir)
    feature_index = {
        str(row["sample_id"]): dict(row)
        for row in feature_cache.manifest["sample_index"]
    }
    base_train_ids = [str(row["sample_id"]) for row in contract["human_train"]]
    val_ids = [str(row["sample_id"]) for row in contract["human_val"]]
    if any(
        sample_id not in feature_index or feature_index[sample_id]["split"] != "train"
        for sample_id in base_train_ids
    ) or any(
        sample_id not in feature_index or feature_index[sample_id]["split"] != "val"
        for sample_id in val_ids
    ):
        raise Legacy727KnnDiagnosticError("base train/val feature join drifted")
    qa = _scan_qa_metadata(args.artifacts_root)
    base_qa_overlap = {
        final_meta[sample_id]["source_page_sha256"] for sample_id in base_train_ids
    } & qa["page_shas"]
    if base_qa_overlap:
        raise Legacy727KnnDiagnosticError("base train109 overlaps 40-page QA")
    feature_available_overlay = [
        row for row in overlay_rows if row["sample_id"] in feature_index
    ]
    missing_overlay = [
        row for row in overlay_rows if row["sample_id"] not in feature_index
    ]
    qa_excluded_overlay = [
        row
        for row in feature_available_overlay
        if row["source"]["source_page_sha256"] in qa["page_shas"]
    ]
    joined_overlay = [
        row
        for row in feature_available_overlay
        if row["source"]["source_page_sha256"] not in qa["page_shas"]
    ]
    if (
        len(joined_overlay) != 587
        or len(missing_overlay) != 30
        or len(qa_excluded_overlay) != 1
    ):
        raise Legacy727KnnDiagnosticError("legacy overlay feature join drifted")
    joined_ids = [*base_train_ids, *(row["sample_id"] for row in joined_overlay)]
    if len(joined_ids) != 696 or len(set(joined_ids)) != 696:
        raise Legacy727KnnDiagnosticError("combined memory identity drifted")
    train_features = np.stack(
        [
            feature_cache.sample_features[feature_index[sample_id]["row_index"]]
            for sample_id in joined_ids
        ]
    )
    val_features = np.stack(
        [
            feature_cache.sample_features[feature_index[sample_id]["row_index"]]
            for sample_id in val_ids
        ]
    )
    positive = np.zeros((len(joined_ids), len(candidate_ids)), dtype=np.float32)
    authority = np.zeros_like(positive, dtype=bool)
    positive[: len(base_train_ids)] = (
        arrays["human_train_targets"] >= d109.v3.ACCEPTABLE_CODE
    )
    authority[: len(base_train_ids)] = arrays["human_train_masks"].astype(bool)
    candidate_index = {
        candidate: index for index, candidate in enumerate(candidate_ids)
    }
    for row_index, row in enumerate(joined_overlay, len(base_train_ids)):
        judgment = _mapping(row.get("font_judgment"), "overlay font judgment")
        for tier in ("preferred", "acceptable"):
            for candidate in judgment[tier]:
                positive[row_index, candidate_index[candidate]] = 1.0
        for tier in ("preferred", "acceptable", "marginal", "unacceptable"):
            for candidate in judgment[tier]:
                authority[row_index, candidate_index[candidate]] = True
    if authority[len(base_train_ids) :, 15:].any():
        raise Legacy727KnnDiagnosticError("successor candidate became legacy negative")

    legacy_contract, _legacy_report = _validate_legacy_model(args.legacy_model_dir)
    architecture = _mapping(legacy_contract.get("architecture"), "legacy architecture")
    hyperparameters = _mapping(
        legacy_contract.get("hyperparameters"), "legacy hyperparameters"
    )
    torch, ranker = d109._load_ranker(  # noqa: SLF001
        candidate_count=len(candidate_ids),
        sweep_dir=args.sweep_dir,
        head_report=head_report,
    )
    legacy_ranker = legacy.build_ranker(
        feature_dim=int(architecture["feature_dim"]),
        hidden_dim=int(architecture["hidden_dim"]),
        view_dropout=float(architecture["view_dropout"]),
        head_dropout=float(hyperparameters["head_dropout"]),
    )
    legacy_ranker.load_state_dict(
        legacy.load_checkpoint(
            args.legacy_model_dir.expanduser().resolve() / "checkpoint.safetensors"
        ),
        strict=True,
    )
    legacy_ranker.requires_grad_(False)
    legacy_ranker.eval()
    bags = tuple(
        torch.arange(int(record["start"]), int(record["start"]) + int(record["count"]))
        for record in contract["prototype_bags"]
    )
    with torch.no_grad():
        outputs = ranker(
            torch.from_numpy(arrays["human_val_embeddings"]),
            torch.from_numpy(arrays["prototype_features"]),
            bags,
        )
        head_scores = outputs["candidate_scores"].detach().cpu().numpy()
    representations = {
        "legacy_frozen_encoder_raw_mean_unit_768": (
            d109._raw_mean(train_features),  # noqa: SLF001
            d109._raw_mean(val_features),  # noqa: SLF001
        ),
        "legacy_baseline_hidden_unit_256": (
            _legacy_hidden(torch=torch, ranker=legacy_ranker, features=train_features),
            _legacy_hidden(torch=torch, ranker=legacy_ranker, features=val_features),
        ),
    }
    val_targets = arrays["human_val_targets"]
    val_masks = arrays["human_val_masks"].astype(bool)
    val_roles = arrays["human_val_role"]
    head_z = d109._masked_zscore(head_scores, val_masks)  # noqa: SLF001
    trials: list[dict[str, Any]] = []

    def append_trial(
        method: str, config: Mapping[str, Any], scores: np.ndarray
    ) -> None:
        trials.append(
            {
                "config": dict(config),
                "method": method,
                "metrics": d109._metrics(  # noqa: SLF001
                    scores,
                    targets=val_targets,
                    masks=val_masks,
                    roles=val_roles,
                    candidate_ids=candidate_ids,
                ),
                "trial": len(trials) + 1,
            }
        )

    append_trial("sealed_head_baseline", {}, head_scores)
    for representation, (memory_train, memory_val) in representations.items():
        for neighbors in (15, 25, 50, 100):
            memory_scores, available = _authority_knn_scores(
                train_features=memory_train,
                query_features=memory_val,
                positive=positive,
                authority=authority,
                neighbors=neighbors,
                temperature=0.15,
            )
            memory_z = _memory_zscore(memory_scores, available, val_masks)
            for alpha in (0.25, 0.50):
                append_trial(
                    "partial22_authority_masked_knn_fusion",
                    {
                        "fusion_alpha": alpha,
                        "neighbors": neighbors,
                        "representation": representation,
                        "temperature": 0.15,
                    },
                    ((1.0 - alpha) * head_z) + (alpha * memory_z),
                )
    selected = max(trials, key=_selection_key)
    baseline = trials[0]
    memory_page_shas = {
        str(row["source"]["source_page_sha256"]) for row in joined_overlay
    }
    memory_page_shas.update(
        final_meta[sample_id]["source_page_sha256"] for sample_id in base_train_ids
    )
    qa_overlap = memory_page_shas & qa["page_shas"]
    if qa_overlap:
        raise Legacy727KnnDiagnosticError("40-page QA source leaked into memory")
    best_metrics = selected["metrics"]
    target = 0.50
    report = d109.base.seal_record(
        {
            "boundaries": {
                "candidate_or_tier_order_used_as_supervision": False,
                "feature_cache_test_pixel_count": 0,
                "full22_export_rows_json_deserialized_for_overlap_audit": 0,
                "hidden_test_labels_deserialized_by_this_diagnostic": 0,
                "hidden_test_pixels_opened": 0,
                "legacy_non_train_final_rows_json_deserialized": 0,
                "legacy_test_final_rows_byte_scanned": final_counts["test"],
                "legacy_train_final_rows_json_deserialized": len(parsed_train_finals),
                "legacy_val_final_rows_byte_scanned": final_counts["val"],
                "optimizer_instances_created": 0,
                "source_image_pixels_opened": 0,
                "successor_candidate_negative_supervision_count_from_legacy_rows": 0,
                "test30_known_opened_outside_this_diagnostic": True,
                "val_used_for_gradient_or_weight_updates": False,
            },
            "cohort_overlap_audit": {
                "final1200_by_strict_work_split": final_counts,
                "full22_test30_exact_sample_overlap_with_final1200": len(
                    test30_overlap
                ),
                "full22_train109_exact_sample_overlap_with_final1200": len(
                    train109_ids & set(final_meta)
                ),
                "full22_val33_exact_sample_overlap_with_final1200": len(
                    val33_ids & set(final_meta)
                ),
                "library_40_page_qa_file_count": qa["file_count"],
                "library_40_page_qa_memory_source_sha256_overlap": len(qa_overlap),
                "library_40_page_qa_source_page_sha256_count": qa[
                    "source_page_sha256_count"
                ],
                "test30_final_evaluation_claim_allowed": False,
                "test30_rotation_required": True,
            },
            "conclusion": {
                "closes_variant_preferred_target": float(
                    best_metrics["variant_preferred_at1"]
                )
                >= target,
                "deployment_compatible": False,
                "deployment_incompatibility": (
                    "the 697-row diagnostic uses a sealed legacy 768-d encoder "
                    "feature cache, while the current v3 runtime ranker consumes "
                    "256-d successor encoder embeddings"
                ),
                "recommendation": (
                    "do not ship this memory path; use the sealed 618-row overlay "
                    "inside current-encoder v3 finetuning, then evaluate a newly "
                    "rotated sealed cohort because test30 is burned"
                ),
                "status": "useful_train_signal_but_does_not_close_variant_gap",
                "target_variant_preferred_at1": target,
                "variant_preferred_gap": target
                - float(best_metrics["variant_preferred_at1"]),
            },
            "head_baseline": baseline,
            "memory": {
                "base_full22_train_rows": len(base_train_ids),
                "combined_feature_rows": len(joined_ids),
                "legacy_overlay_feature_missing_rows": len(missing_overlay),
                "legacy_overlay_feature_rows": len(joined_overlay),
                "legacy_overlay_qa_excluded_rows": len(qa_excluded_overlay),
                "legacy_overlay_sealed_rows": len(overlay_rows),
                "new7_authority_rows": len(base_train_ids),
                "overlay_validation": overlay_validation,
            },
            "record_type": "manga_font_student_v3_legacy727_knn_diagnostic",
            "schema_version": SCHEMA,
            "selected_diagnostic": selected,
            "selection": {
                "objective": [
                    "variant_preferred_at1",
                    "variant_acceptable_at1",
                    "preferred_at1",
                    "acceptable_at1",
                    "top1_unique_candidate_count",
                    "negative_top1_max_candidate_share",
                    "earlier_trial",
                ],
                "policy": "bounded-fixed-grid-validation-selection-v1",
                "tier_semantics": (
                    "preferred and acceptable are unordered positive sets; "
                    "legacy rows expose only legacy15 authority and never make "
                    "the successor seven candidates negatives"
                ),
                "trial_count": len(trials),
                "validation_is_research_selection_not_deployment_evidence": True,
            },
            "source_code_sha256": d109.base.sha256_file(Path(__file__).resolve()),
            "sources": {
                "full22_export_samples_sha256": d109.base.sha256_file(
                    args.full22_export_dir.expanduser().resolve() / "samples.jsonl"
                ),
                "legacy_feature_cache_manifest_sha256": feature_cache.manifest_sha256,
                "legacy_model_checkpoint_sha256": d109.base.sha256_file(
                    args.legacy_model_dir.expanduser().resolve()
                    / "checkpoint.safetensors"
                ),
                "legacy_overlay_manifest_sha256": d109.base.sha256_file(
                    overlay_root / legacy_overlay.MANIFEST_FILE
                ),
                "legacy_overlay_rows_sha256": d109.base.sha256_file(
                    overlay_root / legacy_overlay.OVERLAY_FILE
                ),
                "master_split_map_sha256": d109.base.sha256_file(
                    args.master_split_map.expanduser().resolve()
                ),
                "raw_finals_sha256": d109.base.sha256_file(
                    args.raw_finals.expanduser().resolve()
                ),
                "v3_cache_contract_sha256": d109.base.sha256_file(
                    args.cache_dir.expanduser().resolve() / d109.sweep.CACHE_CONTRACT
                ),
                "v3_head_checkpoint_sha256": d109.base.sha256_file(
                    args.sweep_dir.expanduser().resolve() / d109.sweep.SWEEP_CHECKPOINT
                ),
            },
            "trials": trials,
        }
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent)
    )
    published = False
    try:
        (staging / REPORT).write_bytes(d109.base.json_bytes(report, pretty=True))
        marker = {
            "artifacts": {REPORT: d109.base.sha256_file(staging / REPORT)},
            "owner": OWNER,
            "safe_replace": True,
            "schema_version": SCHEMA,
        }
        (staging / MARKER).write_bytes(d109.base.json_bytes(marker, pretty=True))
        validate_diagnostic(staging)
        if output.exists():
            raise Legacy727KnnDiagnosticError("diagnostic output appeared")
        os.rename(staging, output)
        published = True
        return validate_diagnostic(output)
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging)


def validate_diagnostic(output_dir: Path) -> Mapping[str, Any]:
    root = output_dir.expanduser().resolve()
    if not root.is_dir() or {path.name for path in root.iterdir()} != set(FILES):
        raise Legacy727KnnDiagnosticError("diagnostic inventory drifted")
    marker = d109.base.read_json(root / MARKER, location="diagnostic marker")
    report = d109.base.read_json(root / REPORT, location="diagnostic report")
    d109.base.validate_record_seal(report, location="diagnostic report")
    if (
        marker.get("owner") != OWNER
        or marker.get("schema_version") != SCHEMA
        or marker.get("safe_replace") is not True
        or report.get("schema_version") != SCHEMA
        or report.get("source_code_sha256")
        != d109.base.sha256_file(Path(__file__).resolve())
        or _mapping(marker.get("artifacts"), "diagnostic artifacts")
        != {REPORT: d109.base.sha256_file(root / REPORT)}
    ):
        raise Legacy727KnnDiagnosticError("diagnostic metadata drifted")
    boundary = _mapping(report.get("boundaries"), "diagnostic boundaries")
    overlap = _mapping(report.get("cohort_overlap_audit"), "cohort overlap")
    if (
        boundary.get("legacy_non_train_final_rows_json_deserialized") != 0
        or boundary.get("hidden_test_labels_deserialized_by_this_diagnostic") != 0
        or boundary.get("hidden_test_pixels_opened") != 0
        or boundary.get("source_image_pixels_opened") != 0
        or boundary.get("optimizer_instances_created") != 0
        or boundary.get(
            "successor_candidate_negative_supervision_count_from_legacy_rows"
        )
        != 0
        or boundary.get("val_used_for_gradient_or_weight_updates") is not False
        or overlap.get("full22_test30_exact_sample_overlap_with_final1200") != 30
        or overlap.get("library_40_page_qa_memory_source_sha256_overlap") != 0
        or overlap.get("test30_final_evaluation_claim_allowed") is not False
        or overlap.get("test30_rotation_required") is not True
    ):
        raise Legacy727KnnDiagnosticError("diagnostic governance boundary drifted")
    selected = _mapping(report.get("selected_diagnostic"), "selected diagnostic")
    metrics = _mapping(selected.get("metrics"), "selected metrics")
    return {
        "deployment_compatible": False,
        "global_acceptable_at1": metrics.get("acceptable_at1"),
        "global_preferred_at1": metrics.get("preferred_at1"),
        "memory_rows": report["memory"]["combined_feature_rows"],
        "output_dir": str(root),
        "status": report["conclusion"]["status"],
        "test30_rotation_required": True,
        "top1_max_candidate_share": metrics.get("top1_max_candidate_share"),
        "top1_unique_candidate_count": metrics.get("top1_unique_candidate_count"),
        "variant_acceptable_at1": metrics.get("variant_acceptable_at1"),
        "variant_preferred_at1": metrics.get("variant_preferred_at1"),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Strict train-only legacy727 kNN signal and overlap diagnostic"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--artifacts-root", type=Path, required=True)
    run.add_argument("--cache-dir", type=Path, required=True)
    run.add_argument("--catalog-registry", type=Path, required=True)
    run.add_argument("--full22-export-dir", type=Path, required=True)
    run.add_argument("--legacy-feature-cache-dir", type=Path, required=True)
    run.add_argument("--legacy-model-dir", type=Path, required=True)
    run.add_argument("--legacy-overlay-dir", type=Path, required=True)
    run.add_argument("--master-split-map", type=Path, required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    run.add_argument("--raw-finals", type=Path, required=True)
    run.add_argument("--sweep-dir", type=Path, required=True)
    run.add_argument("--test30-known-opened", action="store_true")
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    result = (
        run_diagnostic(args)
        if args.command == "run"
        else validate_diagnostic(args.output_dir)
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
