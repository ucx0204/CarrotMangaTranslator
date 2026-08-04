#!/usr/bin/env python3
"""Train the stable mass21 head with a sealed five-candidate visual rank loss.

This is a deliberately small wrapper around the fail-closed r3 trainer.  The
original round-2 pseudo probabilities remain weak teacher residuals.  The 1,037
train-safe correction/confirmed decisions in the sealed A/B/C/D visual overlay
are consumed once, when their ordinary real row appears, and can affect only
the five candidates that were actually shown to the reviewer.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

try:
    from scripts import build_manga_font_visual_pseudo_overlay_v1 as overlay_builder
    from scripts import train_manga_font_student_v7_mass21_r3 as r3
except ImportError:  # pragma: no cover - direct execution from scripts/
    import build_manga_font_visual_pseudo_overlay_v1 as overlay_builder
    import train_manga_font_student_v7_mass21_r3 as r3


VISUAL_MODE = "sealed_visual_review_five_candidate_masked_ce_pairwise_v1"
VISUAL_AUTHORITY = overlay_builder.AUTHORITY
EXPECTED_VISUAL_ROWS = 1_037
VISIBLE_CANDIDATES = 5
INVISIBLE_CANDIDATES = 16
SELECTED_SHARE = 0.85
CE_MIX = 0.75
PAIRWISE_MIX = 0.25
ACCEPTABLE_PAIRWISE_WEIGHT = 0.25
QA_SNAPSHOT_SCHEMA = "manga-font-v7-mass21-r5-qa-head-snapshot-v1"


class MangaFontV7Mass21R5Error(r3.MangaFontV7Mass21R3Error):
    """Raised when the visual-review extension crosses a safety boundary."""


@dataclass(frozen=True)
class VisualReviewTarget:
    sample_id: str
    reviewed_font_ids: tuple[str, ...]
    selected_font_id: str
    acceptable_font_ids: tuple[str, ...]
    decision_kind: str
    confidence: float
    decision_sha256: str
    review_item_sha256: str
    original_top1_font_id: str


@dataclass(frozen=True)
class VisualReviewOverlay:
    root: Path
    targets: Mapping[str, VisualReviewTarget]
    candidate_ids: tuple[str, ...]
    manifest_sha256: str
    manifest_record_sha256: str
    report_sha256: str
    pseudo_sha256: str
    original_pseudo_sha256: str
    decision_sources: tuple[Mapping[str, Any], ...]
    correction_rows: int
    confirmed_rows: int

    def binding(self) -> dict[str, Any]:
        return {
            "acceptable_auxiliary": True,
            "authority": VISUAL_AUTHORITY,
            "candidate_ids": list(self.candidate_ids),
            "confirmed_rows": self.confirmed_rows,
            "correction_rows": self.correction_rows,
            "decision_sources": [dict(value) for value in self.decision_sources],
            "human_gold_promotions": 0,
            "human_overlap_rows": 0,
            "invisible_candidates_per_row": INVISIBLE_CANDIDATES,
            "manifest_record_sha256": self.manifest_record_sha256,
            "manifest_sha256": self.manifest_sha256,
            "mode": VISUAL_MODE,
            "original_pseudo_sha256": self.original_pseudo_sha256,
            "oversampling": 0,
            "pseudo_sha256": self.pseudo_sha256,
            "report_sha256": self.report_sha256,
            "test_overlap_rows": 0,
            "train_rows": len(self.targets),
            "training_exposures_per_epoch": 1,
            "val_overlap_rows": 0,
            "visible_candidates_per_row": VISIBLE_CANDIDATES,
        }


@dataclass(frozen=True)
class R5LossWeights(r3.StableLossWeights):
    visual_review: float


_BASE_CONFIGURATION = r3._configuration  # noqa: SLF001
_BASE_SOURCE_FINGERPRINT = r3._source_fingerprint  # noqa: SLF001
_BASE_LOSS_WEIGHTS = r3._loss_weights  # noqa: SLF001
_BASE_OPEN_TRAINING_BATCH = r3._open_training_batch  # noqa: SLF001
_BASE_COMPUTE_LOSSES = r3._compute_losses  # noqa: SLF001
_BASE_WEIGHTING_MANIFEST = r3._weighting_manifest  # noqa: SLF001
_BASE_SOURCE_EXPOSURE_PLAN = r3._source_exposure_plan  # noqa: SLF001
_BASE_WRITE_RUN_CHECKPOINT = r3.r2._write_run_checkpoint  # noqa: SLF001

_ACTIVE_VISUAL_OVERLAY: VisualReviewOverlay | None = None
_ACTIVE_QA_SNAPSHOT_DIR: Path | None = None


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MangaFontV7Mass21R5Error(f"{location}: expected object")
    return value


def _sha(value: Any, location: str) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise MangaFontV7Mass21R5Error(f"{location}: invalid sha256")
    return value


def _load_visual_review_overlay(
    root: Path,
    inputs: r3.v7.mass21.Mass21TrainingInputs,
) -> VisualReviewOverlay:
    resolved = root.expanduser().resolve()
    validation = overlay_builder.validate_output(resolved)
    if (
        validation.get("status")
        != "validated_pseudo_visual_review_not_human_gold"
        or int(validation.get("train_applied_rows", -1)) != EXPECTED_VISUAL_ROWS
    ):
        raise MangaFontV7Mass21R5Error("visual overlay validation/count drifted")
    manifest = _mapping(
        json.loads((resolved / overlay_builder.MANIFEST_FILE).read_text("utf-8")),
        "visual overlay manifest",
    )
    _mapping(
        json.loads((resolved / overlay_builder.REPORT_FILE).read_text("utf-8")),
        "visual overlay report",
    )
    authority = _mapping(manifest.get("authority"), "visual overlay authority")
    counts = _mapping(manifest.get("counts"), "visual overlay counts")
    pseudo_input = _mapping(
        _mapping(manifest.get("inputs"), "visual overlay inputs").get("pseudo"),
        "visual overlay pseudo input",
    )
    candidate_ids = tuple(manifest.get("candidate_ids", ()))
    if (
        candidate_ids != tuple(inputs.projection.active_ids)
        or len(candidate_ids) != r3.v7.mass21.ACTIVE_CANDIDATE_COUNT
        or r3.v7.mass21.RETIRED_FONT_ID in candidate_ids
        or authority.get("label_authority") != VISUAL_AUTHORITY
        or authority.get("human_gold_promotions") != 0
        or authority.get("promotion_allowed") is not False
        or authority.get("training_eligible") is not False
        or int(counts.get("train_applied_rows", -1)) != EXPECTED_VISUAL_ROWS
    ):
        raise MangaFontV7Mass21R5Error("visual overlay authority/vocabulary drifted")
    original_pseudo_sha256 = _sha(pseudo_input.get("sha256"), "original pseudo")
    if inputs.pseudo.source_sha256 != original_pseudo_sha256:
        raise MangaFontV7Mass21R5Error(
            "--pseudo-labels must be the unmodified round-2 source bound by the overlay"
        )

    active = set(candidate_ids)
    real_ids = {entry.sample_id for entry in inputs.real.entries}
    human_ids = set(inputs.human.all_sample_ids)
    targets: dict[str, VisualReviewTarget] = {}
    corrections = 0
    confirmed = 0
    pseudo_path = resolved / overlay_builder.PSEUDO_FILE
    for line_number, row in overlay_builder._iter_jsonl(  # noqa: SLF001
        pseudo_path, overlay_builder.PSEUDO_FILE
    ):
        visual_value = row.get("pseudo_visual_review")
        if visual_value is None:
            continue
        visual = _mapping(visual_value, f"visual row {line_number}")
        sample_id = str(row.get("sample_id", ""))
        reviewed = tuple(visual.get("reviewed_font_ids", ()))
        acceptable = tuple(visual.get("acceptable_font_ids", ()))
        selected = str(visual.get("selected_font_id", ""))
        original_top1 = str(visual.get("original_top1_font_id", ""))
        kind = str(visual.get("decision_kind", ""))
        confidence = float(visual.get("confidence", math.nan))
        if (
            row.get("split") != "train"
            or sample_id not in real_ids
            or sample_id in human_ids
            or sample_id in targets
            or visual.get("authority") != VISUAL_AUTHORITY
            or visual.get("visible_candidates_only") is not True
            or len(reviewed) != VISIBLE_CANDIDATES
            or len(set(reviewed)) != VISIBLE_CANDIDATES
            or not set(reviewed) <= active
            or selected not in reviewed
            or not set(acceptable) <= set(reviewed)
            or selected in acceptable
            or kind not in {"correction", "confirmed"}
            or not 0.0 < confidence <= 1.0
            or (kind == "confirmed" and selected != original_top1)
            or (kind == "correction" and selected == original_top1)
        ):
            raise MangaFontV7Mass21R5Error(
                f"visual row {line_number}: masked target contract drifted"
            )
        target = VisualReviewTarget(
            sample_id=sample_id,
            reviewed_font_ids=reviewed,
            selected_font_id=selected,
            acceptable_font_ids=acceptable,
            decision_kind=kind,
            confidence=confidence,
            decision_sha256=_sha(
                visual.get("decision_sha256"), f"visual row {line_number} decision"
            ),
            review_item_sha256=_sha(
                visual.get("review_item_sha256"), f"visual row {line_number} review"
            ),
            original_top1_font_id=original_top1,
        )
        targets[sample_id] = target
        corrections += kind == "correction"
        confirmed += kind == "confirmed"
    if (
        len(targets) != EXPECTED_VISUAL_ROWS
        or corrections != 537
        or confirmed != 500
        or set(targets) & human_ids
    ):
        raise MangaFontV7Mass21R5Error("visual train coverage/overlap drifted")
    decision_sources = tuple(manifest.get("decision_sources", ()))
    if len(decision_sources) != 12:
        raise MangaFontV7Mass21R5Error("A/B/C/D decision provenance drifted")
    return VisualReviewOverlay(
        root=resolved,
        targets=targets,
        candidate_ids=candidate_ids,
        manifest_sha256=r3.v7.base.sha256_file(
            resolved / overlay_builder.MANIFEST_FILE
        ),
        manifest_record_sha256=_sha(
            manifest.get("record_sha256"), "visual manifest record"
        ),
        report_sha256=r3.v7.base.sha256_file(resolved / overlay_builder.REPORT_FILE),
        pseudo_sha256=r3.v7.base.sha256_file(pseudo_path),
        original_pseudo_sha256=original_pseudo_sha256,
        decision_sources=decision_sources,
        correction_rows=corrections,
        confirmed_rows=confirmed,
    )


def _require_overlay() -> VisualReviewOverlay:
    if _ACTIVE_VISUAL_OVERLAY is None:
        raise MangaFontV7Mass21R5Error("validated visual overlay is not active")
    return _ACTIVE_VISUAL_OVERLAY


@contextmanager
def _activated_visual_overlay(value: VisualReviewOverlay) -> Any:
    global _ACTIVE_VISUAL_OVERLAY
    if _ACTIVE_VISUAL_OVERLAY is not None:
        raise MangaFontV7Mass21R5Error("visual overlay context is already active")
    _ACTIVE_VISUAL_OVERLAY = value
    try:
        yield
    finally:
        _ACTIVE_VISUAL_OVERLAY = None


@contextmanager
def _activated_qa_snapshot_dir(value: Path | None) -> Any:
    global _ACTIVE_QA_SNAPSHOT_DIR
    if _ACTIVE_QA_SNAPSHOT_DIR is not None:
        raise MangaFontV7Mass21R5Error("QA snapshot context is already active")
    _ACTIVE_QA_SNAPSHOT_DIR = value.expanduser().resolve() if value else None
    try:
        yield
    finally:
        _ACTIVE_QA_SNAPSHOT_DIR = None


def _configuration(args: argparse.Namespace) -> dict[str, Any]:
    result = dict(_BASE_CONFIGURATION(args))
    result.update(
        {
            "visual_review_acceptable_pairwise_weight": ACCEPTABLE_PAIRWISE_WEIGHT,
            "visual_review_ce_mix": CE_MIX,
            "visual_review_expected_rows": EXPECTED_VISUAL_ROWS,
            "visual_review_invisible_gradient": 0.0,
            "visual_review_mode": VISUAL_MODE,
            "visual_review_oversampling": args.visual_review_oversampling,
            "visual_review_pairwise_mix": PAIRWISE_MIX,
            "visual_review_selected_share": SELECTED_SHARE,
            "visual_review_weight": args.visual_review_weight,
        }
    )
    return result


def _configuration_sha256(args: argparse.Namespace) -> str:
    return r3.v7.base.sha256_bytes(
        r3.v7.base.canonical_json(_configuration(args)).encode("utf-8")
    )


def _source_fingerprint(args: argparse.Namespace) -> dict[str, Any]:
    result = dict(_BASE_SOURCE_FINGERPRINT(args))
    result["r5_visual_masked_wrapper_sha256"] = r3.v7.base.sha256_file(
        Path(__file__).resolve()
    )
    result["visual_review_overlay"] = _require_overlay().binding()
    return result


def _loss_weights(args: argparse.Namespace) -> R5LossWeights:
    base = _BASE_LOSS_WEIGHTS(args)
    return R5LossWeights(**base.__dict__, visual_review=args.visual_review_weight)


def _source_exposure_plan(
    args: argparse.Namespace, inputs: r3.v7.mass21.Mass21TrainingInputs
) -> dict[str, Any]:
    result = dict(_BASE_SOURCE_EXPOSURE_PLAN(args, inputs))
    result["visual_review"] = {
        "inventory_rows": len(_require_overlay().targets),
        "maximum_exposures_per_row": 1,
        "mean_exposures_per_row": 1.0,
        "minimum_exposures_per_row": 1,
        "oversampling": args.visual_review_oversampling,
        "schedule": r3.SOURCE_SCHEDULE_MODE,
        "slots_per_epoch": len(_require_overlay().targets),
    }
    return result


def _weighting_manifest(inputs: r3.v7.mass21.Mass21TrainingInputs) -> dict[str, Any]:
    result = dict(_BASE_WEIGHTING_MANIFEST(inputs))
    result["visual_review"] = {
        "acceptable_pairwise_weight": ACCEPTABLE_PAIRWISE_WEIGHT,
        "authority": VISUAL_AUTHORITY,
        "ce_mix": CE_MIX,
        "confidence_weighted": True,
        "global_weight": "configuration.visual_review_weight",
        "invisible_candidate_gradient": 0.0,
        "mode": VISUAL_MODE,
        "pairwise_mix": PAIRWISE_MIX,
        "real_loss_denominator": r3.r2.REAL_DENOMINATOR_MODE,
        "selected_share": SELECTED_SHARE,
        "visible_candidates_only": True,
    }
    return result


def _open_training_batch(
    *,
    torch: Any,
    batch: r3.v7.mass21.Mass21EpochBatch,
    inputs: r3.v7.mass21.Mass21TrainingInputs,
    arrays: Mapping[str, Any],
    lookup: r3.v7.HumanLookup,
    master_handle: BinaryIO,
    master_resolver: Any,
    human_resolver: Any,
    encoder: Any,
    processor: Any,
    device: Any,
) -> dict[str, Any]:
    prepared = _BASE_OPEN_TRAINING_BATCH(
        torch=torch,
        batch=batch,
        inputs=inputs,
        arrays=arrays,
        lookup=lookup,
        master_handle=master_handle,
        master_resolver=master_resolver,
        human_resolver=human_resolver,
        encoder=encoder,
        processor=processor,
        device=device,
    )
    binding = _require_overlay()
    candidate_index = {font_id: index for index, font_id in enumerate(binding.candidate_ids)}
    positions: list[int] = []
    masks: list[list[bool]] = []
    acceptable_masks: list[list[bool]] = []
    selected_indices: list[int] = []
    confidence: list[float] = []
    for position, real_index in enumerate(batch.real_indices):
        entry = inputs.real.entries[real_index]
        target = binding.targets.get(entry.sample_id)
        if target is None:
            continue
        visible = set(target.reviewed_font_ids)
        acceptable = set(target.acceptable_font_ids)
        positions.append(position)
        masks.append([font_id in visible for font_id in binding.candidate_ids])
        acceptable_masks.append(
            [font_id in acceptable for font_id in binding.candidate_ids]
        )
        selected_indices.append(candidate_index[target.selected_font_id])
        confidence.append(target.confidence)
    columns = r3.v7.mass21.ACTIVE_CANDIDATE_COUNT
    prepared.update(
        {
            "visual_review_positions": torch.tensor(
                positions, device=device, dtype=torch.long
            ),
            "visual_review_masks": torch.tensor(
                masks, device=device, dtype=torch.bool
            )
            if masks
            else torch.empty((0, columns), device=device, dtype=torch.bool),
            "visual_review_acceptable_masks": torch.tensor(
                acceptable_masks, device=device, dtype=torch.bool
            )
            if acceptable_masks
            else torch.empty((0, columns), device=device, dtype=torch.bool),
            "visual_review_selected_indices": torch.tensor(
                selected_indices, device=device, dtype=torch.long
            ),
            "visual_review_confidence": torch.tensor(
                confidence, device=device, dtype=torch.float32
            ),
        }
    )
    return prepared


def masked_visual_review_loss(
    torch: Any,
    logits: Any,
    visible_masks: Any,
    selected_indices: Any,
    acceptable_masks: Any,
    row_weights: Any,
    *,
    denominator: int,
) -> tuple[Any, Any, Any]:
    rows, candidates = logits.shape
    if (
        logits.ndim != 2
        or candidates != r3.v7.mass21.ACTIVE_CANDIDATE_COUNT
        or visible_masks.shape != logits.shape
        or acceptable_masks.shape != logits.shape
        or selected_indices.shape != (rows,)
        or row_weights.shape != (rows,)
        or denominator < max(rows, 1)
        or not bool(torch.all(visible_masks.sum(dim=-1) == VISIBLE_CANDIDATES))
        or bool(torch.any(acceptable_masks & ~visible_masks))
    ):
        raise MangaFontV7Mass21R5Error("visual masked-loss tensor contract drifted")
    if rows == 0:
        zero = logits.sum() * 0.0
        return zero, zero, zero
    selected_mask = torch.nn.functional.one_hot(
        selected_indices, num_classes=candidates
    ).bool()
    if bool(torch.any(~visible_masks.gather(1, selected_indices[:, None]))) or bool(
        torch.any(acceptable_masks & selected_mask)
    ):
        raise MangaFontV7Mass21R5Error("selected/acceptable visual mask drifted")
    weights = row_weights.float()
    if not bool(torch.isfinite(weights).all()) or bool(torch.any(weights <= 0.0)):
        raise MangaFontV7Mass21R5Error("visual review row weights are invalid")
    scores = logits.float()
    # A finite sentinel avoids 0 * -inf in the soft-label CE while
    # masked_fill still cuts the sixteen invisible-logit gradient paths.
    masked_scores = scores.masked_fill(~visible_masks, torch.finfo(scores.dtype).min)
    acceptable_count = acceptable_masks.sum(dim=-1)
    has_acceptable = acceptable_count > 0
    selected_share = torch.where(
        has_acceptable,
        torch.full_like(weights, SELECTED_SHARE),
        torch.ones_like(weights),
    )
    target = selected_mask.float() * selected_share[:, None]
    target = target + acceptable_masks.float() * (
        torch.where(
            has_acceptable,
            (1.0 - SELECTED_SHARE) / acceptable_count.clamp_min(1).float(),
            torch.zeros_like(weights),
        )[:, None]
    )
    ce_rows = -(target * torch.log_softmax(masked_scores, dim=-1)).sum(dim=-1)
    negatives = visible_masks & ~selected_mask & ~acceptable_masks
    negative_count = negatives.sum(dim=-1).clamp_min(1).float()
    selected_scores = scores.gather(1, selected_indices[:, None])
    selected_pair_rows = (
        torch.nn.functional.softplus(scores - selected_scores) * negatives.float()
    ).sum(dim=-1) / negative_count
    pair_grid = torch.nn.functional.softplus(scores[:, None, :] - scores[:, :, None])
    acceptable_pairs = acceptable_masks[:, :, None] & negatives[:, None, :]
    acceptable_pair_count = acceptable_pairs.sum(dim=(1, 2)).clamp_min(1).float()
    acceptable_pair_rows = (
        pair_grid * acceptable_pairs.float()
    ).sum(dim=(1, 2)) / acceptable_pair_count
    acceptable_pair_rows = torch.where(
        has_acceptable, acceptable_pair_rows, torch.zeros_like(acceptable_pair_rows)
    )
    pair_rows = selected_pair_rows + ACCEPTABLE_PAIRWISE_WEIGHT * acceptable_pair_rows
    ce = (ce_rows * weights).sum() / float(denominator)
    pairwise = (pair_rows * weights).sum() / float(denominator)
    return CE_MIX * ce + PAIRWISE_MIX * pairwise, ce, pairwise


def _compute_losses(
    *,
    torch: Any,
    result: Mapping[str, Any],
    batch: Mapping[str, Any],
    weights: R5LossWeights,
) -> tuple[Any, dict[str, Any]]:
    base_total, components = _BASE_COMPUTE_LOSSES(
        torch=torch, result=result, batch=batch, weights=weights
    )
    positions = batch["visual_review_positions"]
    if int(positions.shape[0]) == 0:
        visual = base_total * 0.0
        visual_ce = visual
        visual_pairwise = visual
    else:
        real_weights = batch["real_weights"].index_select(0, positions)
        confidence = batch["visual_review_confidence"]
        visual, visual_ce, visual_pairwise = masked_visual_review_loss(
            torch,
            result["candidate_scores"][: int(batch["real_count"])].index_select(
                0, positions
            ),
            batch["visual_review_masks"],
            batch["visual_review_selected_indices"],
            batch["visual_review_acceptable_masks"],
            real_weights * confidence,
            denominator=int(batch["real_loss_denominator"]),
        )
    total = base_total + weights.visual_review * visual
    result_components = dict(components)
    result_components.update(
        {
            "total": total,
            "visual_review": visual,
            "visual_review_ce": visual_ce,
            "visual_review_pairwise": visual_pairwise,
            "visual_review_rows": int(positions.shape[0]),
        }
    )
    return total, result_components


def _write_run_checkpoint(
    *, torch: Any, run_state_dir: Path, payload: Mapping[str, Any]
) -> None:
    _BASE_WRITE_RUN_CHECKPOINT(
        torch=torch, run_state_dir=run_state_dir, payload=payload
    )
    root = _ACTIVE_QA_SNAPSHOT_DIR
    if root is None or int(payload.get("next_step", -1)) != 0:
        return
    history = payload.get("history")
    if not isinstance(history, Sequence):
        raise MangaFontV7Mass21R5Error("QA snapshot history is invalid")
    epoch = len(history)
    state = _mapping(payload.get("model_state"), "QA snapshot model state")
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise MangaFontV7Mass21R5Error("QA snapshot directory cannot be linked")
    try:
        from safetensors.torch import save_file
    except ImportError as error:  # pragma: no cover - runtime dependency
        raise MangaFontV7Mass21R5Error("safetensors is required for QA snapshots") from error
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".epoch-{epoch:03d}-", suffix=".safetensors", dir=root
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    target = root / f"epoch-{epoch:03d}-head.safetensors"
    try:
        save_file(
            {name: value.detach().cpu().contiguous() for name, value in state.items()},
            str(temporary),
            metadata={
                "candidate_ids": json.dumps(payload.get("candidate_ids", [])),
                "epoch": str(epoch),
                "purpose": "qa_only_not_automatic_model_selection",
                "schema_version": QA_SNAPSHOT_SCHEMA,
            },
        )
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def _patched_runtime(
    *, prebuilt_inputs: r3.v7.mass21.Mass21TrainingInputs | None = None
) -> Any:
    replacements = {
        "_configuration": _configuration,
        "_configuration_sha256": _configuration_sha256,
        "_source_fingerprint": _source_fingerprint,
        "_loss_weights": _loss_weights,
        "_open_training_batch": _open_training_batch,
        "_compute_losses": _compute_losses,
        "_weighting_manifest": _weighting_manifest,
        "_source_exposure_plan": _source_exposure_plan,
    }
    with r3._patched_runtime(prebuilt_inputs=prebuilt_inputs):  # noqa: SLF001
        modules = (r3, r3.v7, r3.r2)
        previous = {
            (module, name): getattr(module, name)
            for module in modules
            for name in replacements
            if hasattr(module, name)
        }
        previous_write = r3.v7._write_run_checkpoint  # noqa: SLF001
        try:
            for module in modules:
                for name, value in replacements.items():
                    if hasattr(module, name):
                        setattr(module, name, value)
            r3.v7._write_run_checkpoint = _write_run_checkpoint  # noqa: SLF001
            yield
        finally:
            r3.v7._write_run_checkpoint = previous_write  # noqa: SLF001
            for (module, name), value in previous.items():
                setattr(module, name, value)


def _validate_cli_configuration(args: argparse.Namespace) -> None:
    r3._validate_cli_configuration(args)  # noqa: SLF001
    if (
        not math.isfinite(args.visual_review_weight)
        or not 0.0 < args.visual_review_weight <= 1.0
        or args.visual_review_oversampling != 0
    ):
        raise MangaFontV7Mass21R5Error("visual review safety cap was crossed")


def _preflight_plan(
    args: argparse.Namespace,
    inputs: r3.v7.mass21.Mass21TrainingInputs,
) -> dict[str, Any]:
    result = dict(r3._preflight_plan(args, inputs))  # noqa: SLF001
    result.update(
        {
            "preflight_status": "ready_for_v7_mass21_r5_visual_masked_training",
            "qa_epoch_snapshots": {
                "automatic_model_selection": False,
                "epochs": "epoch0_and_each_completed_epoch",
                "format": "safetensors",
                "path": str(args.qa_snapshot_dir.expanduser().resolve()),
            },
            "visual_review_loss": {
                **_require_overlay().binding(),
                "acceptable_pairwise_weight": ACCEPTABLE_PAIRWISE_WEIGHT,
                "ce_mix": CE_MIX,
                "global_weight": args.visual_review_weight,
                "pairwise_mix": PAIRWISE_MIX,
                "selected_share": SELECTED_SHARE,
            },
        }
    )
    return result


def validate_output(output_dir: Path) -> Mapping[str, Any]:
    result = dict(r3.validate_output(output_dir))
    root = output_dir.expanduser().resolve()
    manifest = r3.v7.base.read_json(root / r3.v7.MANIFEST, location="r5 manifest")
    configuration = _mapping(manifest.get("configuration"), "r5 configuration")
    fingerprint = _mapping(manifest.get("source_fingerprint"), "r5 fingerprint")
    visual = _mapping(fingerprint.get("visual_review_overlay"), "r5 visual binding")
    if (
        configuration.get("visual_review_mode") != VISUAL_MODE
        or float(configuration.get("visual_review_weight", math.nan)) <= 0.0
        or float(configuration.get("visual_review_weight", math.nan)) > 1.0
        or int(configuration.get("visual_review_oversampling", -1)) != 0
        or visual.get("authority") != VISUAL_AUTHORITY
        or int(visual.get("train_rows", -1)) != EXPECTED_VISUAL_ROWS
        or int(visual.get("visible_candidates_per_row", -1)) != VISIBLE_CANDIDATES
        or int(visual.get("invisible_candidates_per_row", -1))
        != INVISIBLE_CANDIDATES
        or int(visual.get("human_overlap_rows", -1)) != 0
        or int(visual.get("val_overlap_rows", -1)) != 0
        or int(visual.get("test_overlap_rows", -1)) != 0
        or int(visual.get("oversampling", -1)) != 0
        or fingerprint.get("r5_visual_masked_wrapper_sha256")
        != r3.v7.base.sha256_file(Path(__file__).resolve())
    ):
        raise MangaFontV7Mass21R5Error("published R5 visual contract drifted")
    result["status"] = "validated_v7_mass21_r5_visual_masked_output"
    result["visual_review_rows"] = EXPECTED_VISUAL_ROWS
    return result


def _add_r5_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--visual-review-overlay-dir", type=Path, required=True)
    parser.add_argument("--visual-review-weight", type=float, default=0.25)
    parser.add_argument("--visual-review-oversampling", type=int, default=0)
    parser.add_argument(
        "--qa-snapshot-dir",
        type=Path,
        default=Path("artifacts/manga-font-student-v7-mass21-r5-qa-snapshots-v1"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "dry-smoke", "train"):
        command = commands.add_parser(name)
        r3.v7._add_data_inputs(command)  # noqa: SLF001
        r3.v7._add_training_configuration(command)  # noqa: SLF001
        r3._add_stable_arguments(command)  # noqa: SLF001
        _add_r5_arguments(command)
        if name == "dry-smoke":
            command.set_defaults(
                real_batch_size=2,
                full_human_batch_size=1,
                partial_human_batch_size=1,
                synthetic_batch_size=1,
                resume=False,
            )
            command.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
            command.add_argument("--smoke-steps", type=int, default=1)
            command.add_argument(
                "--run-state-dir",
                type=Path,
                default=Path("artifacts/.v7-mass21-r5-visual-masked-dry-state"),
            )
            command.add_argument(
                "--output-dir",
                type=Path,
                default=Path("artifacts/.v7-mass21-r5-visual-masked-dry-output"),
            )
        elif name == "train":
            command.add_argument("--device", choices=("cuda",), default="cuda")
            command.add_argument(
                "--output-dir",
                type=Path,
                default=Path(
                    "artifacts/manga-font-student-v7-mass21-r5-visual-masked-v1"
                ),
            )
            command.add_argument("--run-state-dir", type=Path)
            command.add_argument("--resume", action="store_true")
    validate = commands.add_parser("validate")
    validate.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = validate_output(args.output_dir)
        else:
            _validate_cli_configuration(args)
            inputs = r3.v7._build_inputs(  # noqa: SLF001
                args, load_cached_arrays=args.command != "preflight"
            )
            visual_overlay = _load_visual_review_overlay(
                args.visual_review_overlay_dir, inputs
            )
            cache_reader = r3._load_master_train_hidden_cache_reader(  # noqa: SLF001
                args, inputs.real
            )
            snapshot_dir = args.qa_snapshot_dir if args.command == "train" else None
            with (
                r3._activated_master_hidden_cache(cache_reader),  # noqa: SLF001
                _activated_visual_overlay(visual_overlay),
                _activated_qa_snapshot_dir(snapshot_dir),
                _patched_runtime(prebuilt_inputs=inputs),
            ):
                if args.command == "preflight":
                    result = _preflight_plan(args, inputs)
                else:
                    if args.command == "train" and args.run_state_dir is None:
                        args.run_state_dir = args.output_dir.with_name(
                            args.output_dir.name + ".run-state"
                        )
                    if args.command == "dry-smoke" and not 1 <= args.smoke_steps <= 4:
                        raise MangaFontV7Mass21R5Error("dry smoke steps must be 1..4")
                    if args.command == "train":
                        result = r3.r2._train(args)  # noqa: SLF001
                    else:
                        result = r3.r2._dry_smoke(  # noqa: SLF001
                            args, steps=args.smoke_steps
                        )
            if args.command == "train":
                result = validate_output(args.output_dir)
    except (
        MangaFontV7Mass21R5Error,
        r3.MangaFontV7Mass21R3Error,
        r3.r2.MangaFontV7Mass21R2Error,
        r3.v7.MangaFontV7Mass21Error,
        r3.v7.mass21.MangaFontMass21DataError,
        r3.v7.catalog_assets.CatalogAssetError,
        overlay_builder.VisualPseudoOverlayError,
        OSError,
    ) as error:
        raise SystemExit(f"manga-font-v7-mass21-r5 error: {error}") from error
    print(r3.v7.base.canonical_json(dict(result)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
