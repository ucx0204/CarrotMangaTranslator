#!/usr/bin/env python3
"""Train the v1-compatible MangaFont-22 student with tier-aware human gold.

This entry point deliberately leaves ``train_manga_font_student_v1.py``
unchanged so already-sealed v1 checkpoints remain loadable.  It reuses the
pinned model, artifact schema, and ONNX adapter while replacing four training
policies:

* preferred-set partial-label NLL is the primary human objective;
* preferred-or-acceptable set NLL is a lower-weight auxiliary objective;
* early stopping prioritizes variant preferred@1 and true any-hit@3;
* prototype glyphs are stratified by role family, orientation, and geometry.

Human ``test`` rows keep the v1 byte-scanner isolation and are never JSON
deserialized or pixel-resolved.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import tempfile
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

try:
    from scripts import build_manga_font_named_train_review_v1 as train_overlay
    from scripts import build_manga_font_student_human_overlay_v1 as human_overlay
    from scripts import train_manga_font_student_v1 as base
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_named_train_review_v1 as train_overlay
    import build_manga_font_student_human_overlay_v1 as human_overlay
    import train_manga_font_student_v1 as base


EXTENSION_SCHEMA = "manga-font-student-training-extension-v2"
# V2 artifacts are immutable training records.  The named train overlay was
# added after the first val-only v2 checkpoint had already been sealed; keep
# that exact trainer digest readable instead of retroactively invalidating it.
LEGACY_VAL_ONLY_SOURCE_SHA256S = frozenset(
    {"c9753947162e70beb699e40d23b0faeddc4db03d06da64316f163752e113f926"}
)
PROTOTYPE_POLICY = "role-orientation-geometry-stratified-v1"
PREFERRED_CODE = 2.0
ACCEPTABLE_CODE = 1.0
ORDINARY_ROLES = frozenset({"dialogue", "narration", "thought"})
EXPRESSIVE_ROLES = frozenset(
    {"whisper", "aside_balloon_edge", "emphasis_dialogue", "shout", "other"}
)
SFX_ROLES = frozenset(
    {
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
    }
)


class MangaFontStudentV2Error(base.MangaFontStudentError):
    """Raised for v2-only training policy failures."""


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontStudentV2Error(f"{location}: expected object")
    return value


def _tier_ids(example: base.HumanExample) -> tuple[tuple[str, ...], tuple[str, ...]]:
    judgment = _mapping(
        example.row.get("font_judgment"), f"{example.sample_id}.font_judgment"
    )
    try:
        preferred = tuple(str(value) for value in judgment["preferred"])
        acceptable = tuple(str(value) for value in judgment["acceptable"])
    except (KeyError, TypeError) as error:
        raise MangaFontStudentV2Error(
            f"{example.sample_id}: tiered human judgment drifted"
        ) from error
    if len(preferred) != len(set(preferred)) or len(acceptable) != len(set(acceptable)):
        raise MangaFontStudentV2Error(f"{example.sample_id}: duplicate tier candidate")
    if set(preferred) & set(acceptable):
        raise MangaFontStudentV2Error(f"{example.sample_id}: invalid preferred tiers")
    if not (preferred or acceptable):
        if example.none_target != 1.0 or example.positive_indices:
            raise MangaFontStudentV2Error(
                f"{example.sample_id}: empty tiers without none supervision"
            )
        return (), ()
    return preferred, acceptable


def tier_code_target(
    example: base.HumanExample, candidate_ids: Sequence[str]
) -> tuple[float, ...]:
    candidate_index = {value: index for index, value in enumerate(candidate_ids)}
    preferred, acceptable = _tier_ids(example)
    unknown = (set(preferred) | set(acceptable)) - set(candidate_index)
    if unknown:
        raise MangaFontStudentV2Error(
            f"{example.sample_id}: tier candidates escaped vocabulary: {sorted(unknown)}"
        )
    # A legacy gold row may contain only acceptable fonts.  It still carries a
    # positive set, so use that set as the primary partial-label target rather
    # than discarding the row.
    effective_preferred = preferred or acceptable
    values = [0.0] * len(candidate_ids)
    for candidate_id in acceptable:
        values[candidate_index[candidate_id]] = ACCEPTABLE_CODE
    for candidate_id in effective_preferred:
        values[candidate_index[candidate_id]] = PREFERRED_CODE
    expected = frozenset(example.positive_indices)
    actual = frozenset(index for index, value in enumerate(values) if value > 0.0)
    if actual != expected:
        raise MangaFontStudentV2Error(
            f"{example.sample_id}: tier codes differ from sealed positives"
        )
    return tuple(values)


def tiered_partial_label_loss(
    torch: Any,
    logits: Any,
    targets: Any,
    masks: Any,
    *,
    preferred_weight: float,
    acceptable_weight: float,
    normalize_over_all_rows: bool = True,
) -> Any:
    if logits.shape != targets.shape or masks.shape != logits.shape:
        raise MangaFontStudentV2Error("tiered human tensor shape drifted")
    if preferred_weight <= 0.0 or acceptable_weight < 0.0:
        raise MangaFontStudentV2Error("tiered human loss weights are invalid")
    preferred = targets == PREFERRED_CODE
    combined = targets > 0.0
    active = preferred.any(dim=-1)
    if not bool(active.any()):
        return logits.sum() * 0.0
    if bool((preferred & ~masks).any()) or bool((combined & ~masks).any()):
        raise MangaFontStudentV2Error("positive font is masked unrenderable")
    masked_logits = logits.float().masked_fill(~masks, -torch.inf)
    log_probability = torch.nn.functional.log_softmax(masked_logits, dim=-1)
    preferred_log_mass = torch.logsumexp(
        log_probability.masked_fill(~preferred, -torch.inf), dim=-1
    )
    combined_log_mass = torch.logsumexp(
        log_probability.masked_fill(~combined, -torch.inf), dim=-1
    )
    weighted = (
        preferred_weight * -preferred_log_mass[active]
        + acceptable_weight * -combined_log_mass[active]
    ) / (preferred_weight + acceptable_weight)
    denominator = logits.shape[0] if normalize_over_all_rows else int(active.sum().item())
    return weighted.sum() / max(1, denominator)


def _role_family(role: str) -> str:
    if role in ORDINARY_ROLES:
        return "ordinary"
    if role in SFX_ROLES:
        return "sfx"
    if role == "sign_ui_title":
        return "sign"
    if role in EXPRESSIVE_ROLES:
        return "expressive"
    raise MangaFontStudentV2Error(f"unsupported synthetic role: {role}")


def _geometry_kind(augmentation: Mapping[str, Any]) -> str:
    angle = abs(float(augmentation.get("angle_degrees", math.inf)))
    slant = abs(float(augmentation.get("slant", math.inf)))
    stroke = int(augmentation.get("stroke_width_px", -1))
    return "clean" if angle <= 3.0 and slant <= 0.08 and 0 <= stroke <= 1 else "styled"


def prototype_signature(metadata: Mapping[str, Any]) -> tuple[str, str, str]:
    role = str(metadata.get("role"))
    orientation = str(metadata.get("orientation"))
    if orientation not in {"horizontal", "vertical"}:
        raise MangaFontStudentV2Error("prototype orientation is unsupported")
    augmentation = _mapping(metadata.get("augmentation"), "prototype augmentation")
    return _role_family(role), orientation, _geometry_kind(augmentation)


def load_synthetic_train_metadata(
    snapshot: base.SyntheticSnapshot,
) -> dict[str, Mapping[str, Any]]:
    expected = {example.sample_id for example in snapshot.train_examples}
    output: dict[str, Mapping[str, Any]] = {}
    manifest = snapshot.root / "manifest.jsonl"
    with manifest.open("rb") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            if not raw_line.strip():
                continue
            split = base.top_level_string_field_without_deserializing(raw_line, "split")
            if split != "train":
                # In particular, synthetic test labels are not deserialized by
                # this extension and their pixels are never opened by v1.
                continue
            try:
                row = _mapping(json.loads(raw_line), f"synthetic train row {line_number}")
            except json.JSONDecodeError as error:
                raise MangaFontStudentV2Error("synthetic train metadata is invalid") from error
            sample_id = str(row.get("sample_id"))
            if sample_id not in expected or sample_id in output:
                raise MangaFontStudentV2Error("synthetic train metadata inventory drifted")
            prototype_signature(row)
            output[sample_id] = copy.deepcopy(dict(row))
    if set(output) != expected:
        raise MangaFontStudentV2Error("synthetic train metadata is incomplete")
    return output


def select_stratified_prototypes(
    examples: Sequence[base.SyntheticExample],
    *,
    candidate_ids: tuple[str, ...],
    per_font: int,
    metadata: Mapping[str, Mapping[str, Any]],
) -> tuple[tuple[base.SyntheticExample, ...], tuple[dict[str, Any], ...]]:
    if not 12 <= per_font <= 16:
        raise MangaFontStudentV2Error("stratified prototypes-per-font must be 12..16")
    grouped: dict[str, list[base.SyntheticExample]] = {
        value: [] for value in candidate_ids
    }
    for example in examples:
        if example.sample_id not in metadata or example.font_id not in grouped:
            raise MangaFontStudentV2Error("prototype example metadata drifted")
        grouped[example.font_id].append(example)

    target_cycle = tuple(
        (family, orientation, geometry)
        for geometry in ("clean", "styled")
        for family in ("ordinary", "expressive", "sfx", "sign")
        for orientation in ("horizontal", "vertical")
    )
    selected: list[base.SyntheticExample] = []
    bags: list[dict[str, Any]] = []
    for candidate_id in candidate_ids:
        rows = sorted(grouped[candidate_id], key=lambda value: value.sample_id)
        if len(rows) < per_font:
            raise MangaFontStudentV2Error(
                f"{candidate_id}: insufficient prototype candidates"
            )
        remaining = {row.sample_id: row for row in rows}
        chosen: list[base.SyntheticExample] = []
        signature_use: Counter[tuple[str, str, str]] = Counter()
        role_use: Counter[str] = Counter()
        for selection_index in range(per_font):
            target = target_cycle[selection_index % len(target_cycle)]
            candidates = list(remaining.values())

            def selection_key(example: base.SyntheticExample) -> tuple[Any, ...]:
                row = metadata[example.sample_id]
                signature = prototype_signature(row)
                distance = (
                    8 * int(signature[0] != target[0])
                    + 4 * int(signature[1] != target[1])
                    + 2 * int(signature[2] != target[2])
                )
                role = str(row.get("role"))
                text_length = len(str(row.get("text", "")))
                length_bucket = 0 if text_length <= 2 else 1 if text_length <= 7 else 2
                return (
                    distance,
                    signature_use[signature],
                    role_use[role],
                    length_bucket,
                    example.sample_id,
                )

            choice = min(candidates, key=selection_key)
            chosen.append(choice)
            row = metadata[choice.sample_id]
            signature_use[prototype_signature(row)] += 1
            role_use[str(row.get("role"))] += 1
            del remaining[choice.sample_id]
        selected_signatures = [
            prototype_signature(metadata[example.sample_id]) for example in chosen
        ]
        family_counts = Counter(value[0] for value in selected_signatures)
        orientation_counts = Counter(value[1] for value in selected_signatures)
        geometry_counts = Counter(value[2] for value in selected_signatures)
        minimum_family = 2
        minimum_binary = max(4, per_font // 3)
        if (
            any(family_counts[value] < minimum_family for value in ("ordinary", "expressive", "sfx", "sign"))
            or any(orientation_counts[value] < minimum_binary for value in ("horizontal", "vertical"))
            or any(geometry_counts[value] < minimum_binary for value in ("clean", "styled"))
        ):
            raise MangaFontStudentV2Error(
                f"{candidate_id}: stratified prototype coverage is insufficient"
            )
        start = len(selected)
        selected.extend(chosen)
        bags.append(
            {"candidate_id": candidate_id, "count": len(chosen), "start": start}
        )
    return tuple(selected), tuple(bags)


def _materialize_tiered_batch(
    original: Any,
    *,
    candidate_ids: tuple[str, ...],
    torch: Any,
    processor: Any,
    resolver: Any,
    synthetic_examples: Sequence[base.SyntheticExample],
    human_examples: Sequence[base.HumanExample],
    candidate_count: int,
) -> Mapping[str, Any]:
    result = dict(
        original(
            torch=torch,
            processor=processor,
            resolver=resolver,
            synthetic_examples=synthetic_examples,
            human_examples=human_examples,
            candidate_count=candidate_count,
        )
    )
    if tuple(candidate_ids) != tuple(candidate_ids[:candidate_count]) or candidate_count != len(
        candidate_ids
    ):
        raise MangaFontStudentV2Error("materialized candidate order drifted")
    result["human_targets"] = torch.tensor(
        [tier_code_target(example, candidate_ids) for example in human_examples],
        dtype=torch.float32,
    ) if human_examples else torch.empty((0, candidate_count), dtype=torch.float32)
    return result


def metric_priority_key(metrics: Mapping[str, Any]) -> tuple[float, ...]:
    return (
        base.require_probability(
            metrics.get("variant_preferred_at1"), "metrics.variant_preferred_at1"
        ),
        base.require_probability(metrics.get("preferred_at1"), "metrics.preferred_at1"),
        base.require_probability(
            metrics.get("variant_acceptable_hit_at3"),
            "metrics.variant_acceptable_hit_at3",
        ),
        base.require_probability(
            metrics.get("acceptable_hit_at3"), "metrics.acceptable_hit_at3"
        ),
        base.require_probability(metrics.get("acceptable_at1"), "metrics.acceptable_at1"),
        -float(metrics.get("tiered_gold_loss", math.inf)),
    )


def is_better_metrics(
    candidate: Mapping[str, Any], best: Mapping[str, Any] | None, *, min_delta: float
) -> bool:
    if best is None:
        return True
    left = metric_priority_key(candidate)
    right = metric_priority_key(best)
    for candidate_value, best_value in zip(left, right, strict=True):
        if candidate_value > best_value + min_delta:
            return True
        if candidate_value < best_value - min_delta:
            return False
    return False


def _evaluate_human_val_v2(
    *,
    torch: Any,
    student: Any,
    processor: Any,
    resolver: Any,
    examples: Sequence[base.HumanExample],
    candidate_ids: tuple[str, ...],
    prototype_tensor: Any,
    candidate_bags: Sequence[Any],
    batch_size: int,
    preferred_weight: float,
    acceptable_weight: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    student.eval()
    predictions: list[dict[str, Any]] = []
    loss_sum = 0.0
    total_rows = 0
    counters: Counter[str] = Counter()
    variant_counters: Counter[str] = Counter()
    positive_rows = 0
    with torch.inference_mode():
        for offset in range(0, len(examples), batch_size):
            batch_examples = list(examples[offset : offset + batch_size])
            materialized = base._materialize_batch(  # noqa: SLF001
                torch=torch,
                processor=processor,
                resolver=resolver,
                synthetic_examples=(),
                human_examples=batch_examples,
                candidate_count=len(candidate_ids),
            )
            pixels = materialized["pixel_values"].to("cuda", non_blocking=False)
            targets = materialized["human_targets"].to("cuda")
            masks = materialized["human_masks"].to("cuda")
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                flat_embedding, _direct_logits = student(pixels)
                view_embedding = flat_embedding.reshape(
                    len(batch_examples), len(base.VIEW_NAMES), -1
                )
                runtime_outputs = student.runtime_forward(
                    view_embedding, prototype_tensor, candidate_bags
                )
                logits = runtime_outputs["candidate_scores"]
                none_probabilities = torch.sigmoid(runtime_outputs["none_logits"].float())
            active_count = int((targets == PREFERRED_CODE).any(dim=-1).sum().item())
            batch_loss = tiered_partial_label_loss(
                torch,
                logits,
                targets,
                masks,
                preferred_weight=preferred_weight,
                acceptable_weight=acceptable_weight,
                normalize_over_all_rows=False,
            )
            loss_sum += float(batch_loss.item()) * active_count
            total_rows += len(batch_examples)
            masked_logits = logits.float().masked_fill(~masks, -torch.inf)
            probabilities = torch.softmax(masked_logits, dim=-1)
            for index, example in enumerate(batch_examples):
                eligible = tuple(example.eligible_indices)
                order = tuple(
                    sorted(
                        eligible,
                        key=lambda candidate_index: (
                            -float(probabilities[index, candidate_index].item()),
                            candidate_index,
                        ),
                    )
                )
                preferred_ids, acceptable_only_ids = _tier_ids(example)
                candidate_index = {
                    candidate_id: candidate_offset
                    for candidate_offset, candidate_id in enumerate(candidate_ids)
                }
                preferred = {
                    candidate_index[value]
                    for value in (preferred_ids or acceptable_only_ids)
                }
                acceptable = preferred | {
                    candidate_index[value] for value in acceptable_only_ids
                }
                top1 = order[0]
                top3 = set(order[:3])
                has_font_positive = bool(acceptable)
                acceptable_at1 = top1 in acceptable if has_font_positive else None
                preferred_at1 = top1 in preferred if has_font_positive else None
                acceptable_hit3 = bool(acceptable & top3) if has_font_positive else None
                preferred_hit3 = bool(preferred & top3) if has_font_positive else None
                set_recall3 = (
                    len(acceptable & top3) / len(acceptable)
                    if has_font_positive
                    else None
                )
                if has_font_positive:
                    positive_rows += 1
                    counters["acceptable_at1"] += int(bool(acceptable_at1))
                    counters["preferred_at1"] += int(bool(preferred_at1))
                    counters["acceptable_hit_at3"] += int(bool(acceptable_hit3))
                    counters["preferred_hit_at3"] += int(bool(preferred_hit3))
                else:
                    counters["none_rows"] += 1
                    counters["none_correct"] += int(
                        float(none_probabilities[index].item()) >= 0.5
                    )
                role = base.ROLE_VALUES[example.role_index]
                if has_font_positive and role not in ORDINARY_ROLES:
                    variant_counters["rows"] += 1
                    variant_counters["acceptable_at1"] += int(bool(acceptable_at1))
                    variant_counters["preferred_at1"] += int(bool(preferred_at1))
                    variant_counters["acceptable_hit_at3"] += int(bool(acceptable_hit3))
                    variant_counters["preferred_hit_at3"] += int(bool(preferred_hit3))
                core = {
                    "acceptable_at1": acceptable_at1,
                    "acceptable_hit_at3": acceptable_hit3,
                    "acceptable_set_recall_at3": set_recall3,
                    "candidate_probabilities": [
                        {
                            "candidate_id": candidate_ids[candidate_offset],
                            "probability": float(
                                probabilities[index, candidate_offset].item()
                            ),
                        }
                        for candidate_offset in order
                    ],
                    "positive_candidate_ids": [
                        candidate_ids[value] for value in sorted(acceptable)
                    ],
                    "none_probability": float(none_probabilities[index].item()),
                    "preferred_at1": preferred_at1,
                    "preferred_candidate_ids": [
                        candidate_ids[value] for value in sorted(preferred)
                    ],
                    "preferred_hit_at3": preferred_hit3,
                    "ranked_candidate_ids": [
                        candidate_ids[value] for value in order
                    ],
                    # Kept only for readers of the v1 prediction schema.  The
                    # v2 early stopper uses acceptable_hit_at3, not this set recall.
                    "recall_at3": set_recall3,
                    "sample_id": example.sample_id,
                    "schema_version": base.PREDICTION_SCHEMA,
                    "split": "val",
                    "work_id": example.work_id,
                }
                predictions.append(base.seal_record(core))
    variant_rows = variant_counters["rows"]
    if total_rows < 1 or positive_rows < 1 or variant_rows < 1:
        raise MangaFontStudentV2Error("validation requires positive variant rows")
    tiered_loss = loss_sum / positive_rows
    metrics = {
        "acceptable_at1": counters["acceptable_at1"] / positive_rows,
        "acceptable_hit_at3": counters["acceptable_hit_at3"] / positive_rows,
        "evaluated_positive_rows": positive_rows,
        "none_accuracy_at_0_5": (
            counters["none_correct"] / counters["none_rows"]
            if counters["none_rows"]
            else None
        ),
        "none_val_rows": counters["none_rows"],
        "preferred_at1": counters["preferred_at1"] / positive_rows,
        "preferred_hit_at3": counters["preferred_hit_at3"] / positive_rows,
        # Compatibility aliases are explicitly non-authoritative in v2.
        "recall_at3": counters["acceptable_hit_at3"] / positive_rows,
        "soft_listwise_loss": tiered_loss,
        "tiered_gold_loss": tiered_loss,
        "total_val_rows": total_rows,
        "variant_acceptable_at1": variant_counters["acceptable_at1"] / variant_rows,
        "variant_acceptable_hit_at3": (
            variant_counters["acceptable_hit_at3"] / variant_rows
        ),
        "variant_preferred_at1": variant_counters["preferred_at1"] / variant_rows,
        "variant_preferred_hit_at3": (
            variant_counters["preferred_hit_at3"] / variant_rows
        ),
        "variant_val_rows": variant_rows,
    }
    predictions.sort(key=lambda row: str(row["sample_id"]))
    return metrics, predictions


@contextmanager
def patched_v1_training_policy(
    *,
    args: argparse.Namespace,
    candidate_ids: tuple[str, ...],
    metadata: Mapping[str, Mapping[str, Any]],
) -> Iterator[None]:
    names = (
        "_materialize_batch",
        "_human_soft_listwise_loss",
        "select_prototype_examples",
        "_evaluate_human_val",
        "metric_priority_key",
        "is_better_metrics",
    )
    original = {name: getattr(base, name) for name in names}

    def materialize(**kwargs: Any) -> Mapping[str, Any]:
        return _materialize_tiered_batch(
            original["_materialize_batch"], candidate_ids=candidate_ids, **kwargs
        )

    def loss(torch: Any, logits: Any, targets: Any, masks: Any) -> Any:
        return tiered_partial_label_loss(
            torch,
            logits,
            targets,
            masks,
            preferred_weight=args.preferred_loss_weight,
            acceptable_weight=args.acceptable_loss_weight,
        )

    def prototypes(
        examples: Sequence[base.SyntheticExample],
        *,
        candidate_ids: tuple[str, ...],
        per_font: int,
    ) -> tuple[tuple[base.SyntheticExample, ...], tuple[dict[str, Any], ...]]:
        return select_stratified_prototypes(
            examples,
            candidate_ids=candidate_ids,
            per_font=per_font,
            metadata=metadata,
        )

    def evaluate(**kwargs: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return _evaluate_human_val_v2(
            **kwargs,
            preferred_weight=args.preferred_loss_weight,
            acceptable_weight=args.acceptable_loss_weight,
        )

    replacements = {
        "_materialize_batch": materialize,
        "_human_soft_listwise_loss": loss,
        "select_prototype_examples": prototypes,
        "_evaluate_human_val": evaluate,
        "metric_priority_key": metric_priority_key,
        "is_better_metrics": is_better_metrics,
    }
    patched: list[str] = []
    try:
        for name, value in replacements.items():
            setattr(base, name, value)
            patched.append(name)
        yield
    finally:
        for name in reversed(patched):
            setattr(base, name, original[name])


def _rewrite_v2_contract(output: Path, args: argparse.Namespace) -> None:
    contract_path = output / base.CONTRACT_FILE
    report_path = output / base.REPORT_FILE
    marker_path = output / base.OUTPUT_MARKER
    contract = base.read_json(contract_path, location="v2 student contract")
    contract.pop("record_sha256", None)
    objectives = dict(_mapping(contract.get("objectives"), "v2 objectives"))
    objectives.update(
        {
            "human": "tiered_preferred_and_acceptable_partial_label_set_nll",
            "human_acceptable_set_loss_weight": args.acceptable_loss_weight,
            "human_preferred_set_loss_weight": args.preferred_loss_weight,
            "human_preferred_tier_primary": True,
        }
    )
    contract["objectives"] = objectives
    prototype = dict(_mapping(contract.get("prototype_bank"), "v2 prototype bank"))
    prototype["selection_policy"] = PROTOTYPE_POLICY
    prototype["stratification_fields"] = [
        "role_family",
        "orientation",
        "glyph_geometry_clean_or_styled",
    ]
    contract["prototype_bank"] = prototype
    extension = {
        "base_trainer_source_code_sha256": contract["source_code_sha256"],
        "human_val_overlay": copy.deepcopy(args._human_val_overlay),
        "schema_version": EXTENSION_SCHEMA,
        "source_code_sha256": base.sha256_file(Path(__file__).resolve()),
    }
    human_train_overlay = getattr(args, "_human_train_overlay", None)
    if human_train_overlay is not None:
        extension["human_train_overlay"] = copy.deepcopy(human_train_overlay)
    contract["trainer_extension"] = extension
    contract = base.seal_record(contract)
    contract_path.write_bytes(base.json_bytes(contract, pretty=True))

    report = base.read_json(report_path, location="v2 student report")
    report.pop("record_sha256", None)
    checks = dict(_mapping(report.get("checks"), "v2 report checks"))
    checks.update(
        {
            "human_test_labels_deserialized": 0,
            "human_test_pixels_opened": 0,
            "human_train_named_overlay_applied": human_train_overlay is not None,
            "human_val_adjudicated_overlay_applied": True,
            "preferred_tier_preserved": True,
            "prototype_selection_stratified": True,
            "synthetic_test_metadata_validation_inherited_from_v1": True,
        }
    )
    if human_train_overlay is not None:
        checks.update(
            {
                "human_train_named_overlay_preserved_rows": 61,
                "human_train_named_overlay_replaced_rows": 48,
            }
        )
    report["checks"] = checks
    report["early_stopping"] = {
        "metric_priority": [
            "human_val_variant_preferred_at1",
            "human_val_preferred_at1",
            "human_val_variant_acceptable_hit_at3",
            "human_val_acceptable_hit_at3",
            "human_val_acceptable_at1",
            "negative_human_val_tiered_gold_loss",
        ],
        "min_delta": args.min_delta,
        "patience": args.patience,
    }
    report["model_contract_sha256"] = base.sha256_file(contract_path)
    report["training_extension"] = EXTENSION_SCHEMA
    report = base.seal_record(report)
    report_path.write_bytes(base.json_bytes(report, pretty=True))

    marker = {
        "artifacts": {
            name: base.sha256_file(output / name) for name in base.OUTPUT_ARTIFACTS
        },
        "owner": base.OUTPUT_OWNER,
        "safe_replace": True,
        "schema_version": base.OUTPUT_SCHEMA,
    }
    marker_path.write_bytes(base.json_bytes(marker, pretty=True))


def validate_v2_output(output_dir: Path) -> Mapping[str, Any]:
    result = dict(base.validate_output(output_dir))
    contract = base.read_json(
        output_dir.expanduser().resolve() / base.CONTRACT_FILE,
        location="v2 student contract",
    )
    extension = _mapping(contract.get("trainer_extension"), "trainer extension")
    overlay_binding = _mapping(
        extension.get("human_val_overlay"), "trainer extension human val overlay"
    )
    source_sha = extension.get("source_code_sha256")
    allowed_source_shas = {
        base.sha256_file(Path(__file__).resolve()),
        *LEGACY_VAL_ONLY_SOURCE_SHA256S,
    }
    if (
        extension.get("schema_version") != EXTENSION_SCHEMA
        or source_sha not in allowed_source_shas
        or extension.get("base_trainer_source_code_sha256")
        != contract.get("source_code_sha256")
        or overlay_binding.get("status") != "ready_for_val_only_merge"
        or overlay_binding.get("base_train_record_count") < 1
        or overlay_binding.get("val_record_count") < 1
    ):
        raise MangaFontStudentV2Error("v2 trainer extension binding drifted")
    train_overlay_value = extension.get("human_train_overlay")
    if train_overlay_value is not None:
        train_overlay_binding = _mapping(
            train_overlay_value,
            "trainer extension human train overlay",
        )
        if (
            source_sha != base.sha256_file(Path(__file__).resolve())
            or train_overlay_binding.get("status")
            != "ready_for_train_only_merge"
            or train_overlay_binding.get("base_train_record_count") != 109
            or train_overlay_binding.get("replaced_train_record_count") != 48
            or train_overlay_binding.get("preserved_train_record_count") != 61
            or train_overlay_binding.get("val_record_count_unchanged") != 33
            or train_overlay_binding.get("val_rows_modified") != 0
            or train_overlay_binding.get("view_bindings_modified") != 0
        ):
            raise MangaFontStudentV2Error("v2 train overlay binding drifted")
    prototype = _mapping(contract.get("prototype_bank"), "v2 prototype bank")
    if prototype.get("selection_policy") != PROTOTYPE_POLICY:
        raise MangaFontStudentV2Error("v2 prototype selection contract drifted")
    result["training_extension"] = EXTENSION_SCHEMA
    return result


def train_command(args: argparse.Namespace) -> Mapping[str, Any]:
    output = base._safe_output_path(args.output_dir)  # noqa: SLF001
    if output.exists():
        raise MangaFontStudentV2Error("output directory already exists")
    finite_values = (
        args.preferred_loss_weight,
        args.acceptable_loss_weight,
        args.human_fraction,
        args.encoder_lr,
        args.head_lr,
        args.weight_decay,
        args.consistency_weight,
        args.auxiliary_weight,
        args.gradient_clip,
        args.min_delta,
    )
    if (
        args.epochs < 1
        or args.patience < 1
        or args.batch_size < 4
        or args.eval_batch_size < 1
        or not 12 <= args.prototypes_per_font <= 16
        or not 0.05 <= args.human_fraction <= 0.5
        or args.preferred_loss_weight <= 0.0
        or args.acceptable_loss_weight < 0.0
        or args.encoder_lr <= 0.0
        or args.head_lr <= 0.0
        or args.weight_decay < 0.0
        or args.consistency_weight < 0.0
        or args.auxiliary_weight < 0.0
        or args.gradient_clip <= 0.0
        or args.min_delta < 0.0
        or not all(math.isfinite(value) for value in finite_values)
    ):
        raise MangaFontStudentV2Error("v2 optimizer/loss configuration is invalid")
    registry_path = args.catalog_registry.expanduser().resolve()
    registry = base.read_json(registry_path, location="catalog registry")
    registry_record_sha = base.validate_record_seal(
        registry, location="catalog registry"
    )
    registry_sha = base.sha256_file(registry_path)
    synthetic = base.validate_synthetic_input(
        args.synthetic_dir, catalog_registry_sha256=registry_sha
    )
    human = base.validate_human_input(
        args.human_export_dir,
        candidate_ids=synthetic.candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    human, overlay_validation = human_overlay.apply_overlay(
        overlay_dir=args.human_val_overlay_dir,
        base_export_dir=args.human_export_dir,
        finals_dir=args.human_val_finals_dir,
        catalog_registry=registry_path,
        candidate_ids=synthetic.candidate_ids,
    )
    args._human_val_overlay = dict(overlay_validation)
    if args.human_train_overlay_dir is not None:
        human, train_overlay_validation = train_overlay.apply_train_overlay(
            human,
            overlay_dir=args.human_train_overlay_dir,
            catalog_registry=registry_path,
            candidate_ids=synthetic.candidate_ids,
            expected_replacements=48,
        )
        args._human_train_overlay = dict(train_overlay_validation)
    else:
        args._human_train_overlay = None
    metadata = load_synthetic_train_metadata(synthetic)
    with patched_v1_training_policy(
        args=args, candidate_ids=synthetic.candidate_ids, metadata=metadata
    ):
        training = base._train_student(  # noqa: SLF001
            args=args,
            synthetic=synthetic,
            human=human,
            catalog_registry=registry_path,
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.v2-publish-", dir=output.parent)
    )
    temporary.rmdir()
    published = False
    try:
        base._write_owned_output(  # noqa: SLF001
            output_dir=temporary,
            args=args,
            training=training,
            synthetic=synthetic,
            human=human,
            catalog_registry_sha256=registry_sha,
            catalog_registry_record_sha256=registry_record_sha,
        )
        _rewrite_v2_contract(temporary, args)
        validate_v2_output(temporary)
        if output.exists():
            raise MangaFontStudentV2Error("output directory appeared during training")
        os.rename(temporary, output)
        try:
            result = validate_v2_output(output)
        except BaseException:
            # The directory is an owned output created in this invocation; do
            # not leave a partially validated release at the requested path.
            shutil.rmtree(output)
            raise
        published = True
        return result
    finally:
        if not published and temporary.exists():
            shutil.rmtree(temporary)


def preflight_command(args: argparse.Namespace) -> Mapping[str, Any]:
    registry_path = args.catalog_registry.expanduser().resolve()
    registry_sha = base.sha256_file(registry_path)
    synthetic = base.validate_synthetic_input(
        args.synthetic_dir, catalog_registry_sha256=registry_sha
    )
    base.validate_human_input(
        args.human_export_dir,
        candidate_ids=synthetic.candidate_ids,
        catalog_registry_sha256=registry_sha,
    )
    human, overlay_validation = human_overlay.apply_overlay(
        overlay_dir=args.human_val_overlay_dir,
        base_export_dir=args.human_export_dir,
        finals_dir=args.human_val_finals_dir,
        catalog_registry=registry_path,
        candidate_ids=synthetic.candidate_ids,
    )
    train_overlay_validation = None
    if args.human_train_overlay_dir is not None:
        human, train_overlay_validation = train_overlay.apply_train_overlay(
            human,
            overlay_dir=args.human_train_overlay_dir,
            catalog_registry=registry_path,
            candidate_ids=synthetic.candidate_ids,
            expected_replacements=48,
        )
    metadata = load_synthetic_train_metadata(synthetic)
    prototypes, bags = select_stratified_prototypes(
        synthetic.train_examples,
        candidate_ids=synthetic.candidate_ids,
        per_font=args.prototypes_per_font,
        metadata=metadata,
    )
    return {
        "base_train_record_count": len(human.train_examples),
        "candidate_count": len(synthetic.candidate_ids),
        "human_test_labels_deserialized": 0,
        "human_test_pixels_opened": 0,
        "train_overlay": (
            dict(train_overlay_validation)
            if train_overlay_validation is not None
            else None
        ),
        "val_overlay": dict(overlay_validation),
        "prototype_bag_count": len(bags),
        "prototype_count": len(prototypes),
        "status": "ready_for_v2_training",
        "val_record_count": len(human.val_examples),
        "val_used_for_optimizer": False,
    }
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    train = subparsers.add_parser("train")
    train.add_argument("--synthetic-dir", type=Path, required=True)
    train.add_argument("--human-export-dir", type=Path, required=True)
    train.add_argument("--human-val-overlay-dir", type=Path, required=True)
    train.add_argument("--human-val-finals-dir", type=Path, required=True)
    train.add_argument("--human-train-overlay-dir", type=Path)
    train.add_argument("--catalog-registry", type=Path, required=True)
    train.add_argument("--output-dir", type=Path, required=True)
    train.add_argument("--epochs", type=int, default=10)
    train.add_argument("--patience", type=int, default=4)
    train.add_argument("--batch-size", type=int, default=16)
    train.add_argument("--eval-batch-size", type=int, default=16)
    train.add_argument("--human-fraction", type=float, default=0.40)
    train.add_argument("--encoder-lr", type=float, default=1e-5)
    train.add_argument("--head-lr", type=float, default=7.5e-5)
    train.add_argument("--weight-decay", type=float, default=0.01)
    train.add_argument("--consistency-weight", type=float, default=0.03)
    train.add_argument("--auxiliary-weight", type=float, default=0.10)
    train.add_argument("--preferred-loss-weight", type=float, default=1.0)
    train.add_argument("--acceptable-loss-weight", type=float, default=0.25)
    train.add_argument("--prototypes-per-font", type=int, default=16)
    train.add_argument("--gradient-clip", type=float, default=1.0)
    train.add_argument("--min-delta", type=float, default=1e-4)
    train.add_argument("--seed", type=int, default=20260803)
    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--synthetic-dir", type=Path, required=True)
    preflight.add_argument("--human-export-dir", type=Path, required=True)
    preflight.add_argument("--human-val-overlay-dir", type=Path, required=True)
    preflight.add_argument("--human-val-finals-dir", type=Path, required=True)
    preflight.add_argument("--human-train-overlay-dir", type=Path)
    preflight.add_argument("--catalog-registry", type=Path, required=True)
    preflight.add_argument("--prototypes-per-font", type=int, default=16)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "train":
            result = train_command(args)
        elif args.command == "preflight":
            result = preflight_command(args)
        else:
            result = validate_v2_output(args.output_dir)
    except (
        base.MangaFontStudentError,
        human_overlay.HumanValOverlayError,
        train_overlay.NamedTrainReviewError,
    ) as error:
        raise SystemExit(str(error)) from error
    print(base.canonical_json(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
