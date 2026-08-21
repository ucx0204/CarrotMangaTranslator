"""Fast work-LOGO screen for a materially larger page-conditioned font ranker.

This is intentionally a screening tool, not a promotion/export producer.  It
keeps the frozen production encoder and anchor ranker, then trains a new
68k-parameter context head which sees the local visual query, a soft
family-weighted page visual query available at runtime, and the anchor outputs.  The head
jointly updates family routing plus both 21-font branches.  Total estimated
ranker compute stays below the explicitly allowed 2x production budget.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import train_manga_font_v3_candidate_tristate_r23_logo as r23
except ImportError:  # pragma: no cover
    import train_manga_font_v3_candidate_tristate_r23_logo as r23


CONTROL_MANIFEST = Path(
    "artifacts/manga-font-v3-candidate-tristate-r23-logo-"
    "isolated-lambda1-seed20260820-v1/manifest.json"
)
PRODUCTION_PARAMETERS = 74_528
PRODUCTION_MAC = 91_776
HIDDEN_WIDTH = 32
MAXIMUM_DELTA = 4.0
MARGINAL_WEIGHT = 0.25


def _read_json(path: Path) -> Mapping[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def _read_jsonl(path: Path) -> list[Mapping[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"expected JSONL object: {path}")
            rows.append(value)
    return rows


def _normalize_rows(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    return values / np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-6)


def _prepare(torch: Any) -> Mapping[str, Any]:
    manifest = _read_json(CONTROL_MANIFEST)
    args = r23._configuration_args(manifest)
    context = r23._load_context(args, torch)
    ledger = r23.reconstruct_tier_ledger(
        args.source_label_dir, context, enforce_real=True
    )
    folds = r23.build_logo_folds(context, ledger, enforce_real=True)
    cache = r23.build_candidate_cache(
        torch,
        context=context,
        device=torch.device("cpu"),
        batch_size=int(args.evaluation_batch_size),
    )

    views = context["arrays"]["query_views"].astype(np.float32)
    local_query = _normalize_rows(np.mean(views, axis=1).reshape(len(views), -1))
    page_query = local_query.copy()

    label_rows = _read_jsonl(Path(args.source_label_dir) / r23.SOURCE_LABEL_FILE)
    page_by_sample: dict[str, str] = {}
    for label in label_rows:
        identity = label.get("identity")
        if not isinstance(identity, dict):
            raise ValueError("training label identity is missing")
        page_by_sample[str(label["sample_id"])] = str(identity["page_id"])

    grouped: dict[str, list[int]] = {}
    for row in ledger["rows"]:
        grouped.setdefault(page_by_sample[str(row["sample_id"])], []).append(
            int(row["row_index"])
        )
    family_probabilities = torch.softmax(cache["family_logits"].float(), dim=1).numpy()
    for indices in grouped.values():
        selected = np.asarray(indices, dtype=np.int64)
        queries = local_query[selected]
        probabilities = family_probabilities[selected]
        family_means = []
        for family_index in range(2):
            weights = probabilities[:, family_index : family_index + 1]
            weighted = np.sum(queries * weights, axis=0, keepdims=True)
            weighted /= max(float(np.sum(weights)), 1e-6)
            family_means.append(_normalize_rows(weighted)[0])
        means = np.stack(family_means, axis=0)
        page_query[selected] = _normalize_rows(probabilities @ means)

    return {
        "args": args,
        "cache": cache,
        "context": context,
        "folds": folds,
        "ledger": ledger,
        "local_query": local_query,
        "page_query": page_query,
    }


def _build_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PageConditionedDirectRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.input = torch.nn.Linear(1024 + 1024 + 44, HIDDEN_WIDTH)
            self.output = torch.nn.Linear(HIDDEN_WIDTH, 44)
            torch.nn.init.zeros_(self.output.weight)
            torch.nn.init.zeros_(self.output.bias)

        def forward(
            self,
            local_query: Any,
            page_query: Any,
            anchor_family: Any,
            anchor_body: Any,
            anchor_variant: Any,
        ) -> Mapping[str, Any]:
            local = torch.nn.functional.layer_norm(local_query.float(), (1024,))
            page = torch.nn.functional.layer_norm(page_query.float(), (1024,))
            anchor = torch.cat(
                (anchor_family.float(), anchor_body.float(), anchor_variant.float()),
                dim=1,
            )
            anchor = torch.nn.functional.layer_norm(anchor, (44,))
            hidden = torch.nn.functional.gelu(
                self.input(torch.cat((local, page, anchor), dim=1))
            )
            delta = MAXIMUM_DELTA * torch.tanh(self.output(hidden))
            return {
                "family_logits": anchor_family + delta[:, :2],
                "body_candidate_scores": anchor_body + delta[:, 2:23],
                "variant_candidate_scores": anchor_variant + delta[:, 23:44],
                "delta": delta,
            }

    return PageConditionedDirectRanker()


def _outputs(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    indices: np.ndarray,
    *,
    device: Any,
) -> Mapping[str, Any]:
    cache = prepared["cache"]
    rows = np.asarray(indices, dtype=np.int64)
    positions = torch.as_tensor(rows, dtype=torch.long)
    return model(
        torch.as_tensor(prepared["local_query"][rows], device=device),
        torch.as_tensor(prepared["page_query"][rows], device=device),
        cache["family_logits"][positions].to(device),
        cache["body_candidate_scores"][positions].to(device),
        cache["variant_candidate_scores"][positions].to(device),
    )


def _row_metrics(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    *,
    device: Any,
) -> Mapping[str, float]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    output = _outputs(torch, model, prepared, indices, device=device)
    tensors = r23._tier_tensors(torch, rows, device=device)
    predicted_family = output["family_logits"].argmax(dim=1)
    scores = torch.where(
        predicted_family[:, None] == 0,
        output["body_candidate_scores"],
        output["variant_candidate_scores"],
    )
    top1 = scores.argmax(dim=1)
    safe = tensors["safe_mask"].gather(1, top1[:, None]).squeeze(1)
    preferred_rows = tensors["preferred_mask"].any(dim=1)
    preferred = tensors["preferred_mask"].gather(1, top1[:, None]).squeeze(1)
    unacceptable = tensors["unacceptable_mask"].gather(1, top1[:, None]).squeeze(1)
    reviewed = (
        tensors["safe_mask"] | tensors["marginal_mask"] | tensors["unacceptable_mask"]
    )
    unreviewed = ~reviewed.gather(1, top1[:, None]).squeeze(1)
    family = tensors["family_labels"]
    single_day = tuple(prepared["context"]["candidate_ids"]).index("single-day")
    unsafe_sd = tensors["single_day_safety_negative"] & (top1 == single_day)
    unsafe_count = int(tensors["single_day_safety_negative"].sum().item())
    return {
        "family_accuracy": float((predicted_family == family).float().mean().item()),
        "preferred_top1_accuracy": float(
            preferred[preferred_rows].float().mean().item()
        ),
        "safe_top1_accuracy": float(safe.float().mean().item()),
        "single_day_unsafe_top1_rate": float(
            unsafe_sd.sum().item() / max(1, unsafe_count)
        ),
        "unacceptable_top1_rate": float(unacceptable.float().mean().item()),
        "unreviewed_top1_rate": float(unreviewed.float().mean().item()),
    }


def _base_drift(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    indices: np.ndarray,
    *,
    device: Any,
) -> Mapping[str, float]:
    output = _outputs(torch, model, prepared, indices, device=device)
    cache = prepared["cache"]
    positions = torch.as_tensor(indices, dtype=torch.long)
    anchor_family = cache["family_logits"][positions].to(device)
    anchor_body = cache["body_candidate_scores"][positions].to(device)
    anchor_variant = cache["variant_candidate_scores"][positions].to(device)
    kl = 0.0
    for actual, anchor in (
        (output["family_logits"], anchor_family),
        (output["body_candidate_scores"], anchor_body),
        (output["variant_candidate_scores"], anchor_variant),
    ):
        kl = kl + torch.nn.functional.kl_div(
            torch.log_softmax(actual.float(), dim=1),
            torch.softmax(anchor.float(), dim=1),
            reduction="batchmean",
        )
    return {
        "family_top1_agreement": float(
            (output["family_logits"].argmax(1) == anchor_family.argmax(1))
            .float()
            .mean()
            .item()
        ),
        "body_top1_agreement": float(
            (output["body_candidate_scores"].argmax(1) == anchor_body.argmax(1))
            .float()
            .mean()
            .item()
        ),
        "variant_top1_agreement": float(
            (output["variant_candidate_scores"].argmax(1) == anchor_variant.argmax(1))
            .float()
            .mean()
            .item()
        ),
        "kl": float((kl / 3.0).detach().item()),
    }


def _train_fold(
    torch: Any,
    prepared: Mapping[str, Any],
    fold: Mapping[str, Any],
    *,
    device: Any,
    epochs: int,
    learning_rate: float,
) -> Mapping[str, Any]:
    fold_index = int(fold["contract"]["fold_index"])
    model = _build_model(torch, seed=20260829 + fold_index).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=1e-4
    )
    anchor_train = _row_metrics(
        torch, model, prepared, fold["train_rows"], device=device
    )
    anchor_heldout = _row_metrics(
        torch, model, prepared, fold["heldout_rows"], device=device
    )
    best_state = None
    best_key = None
    best_epoch = 0
    best_train = anchor_train
    best_base = _base_drift(torch, model, prepared, fold["base_indices"], device=device)

    for epoch in range(1, epochs + 1):
        model.train()
        order, weights, _ = r23._direct_schedule(fold, prepared["args"], epoch=epoch)
        source = tuple(fold["train_rows"])
        rows = tuple(source[int(position)] for position in order.tolist())
        indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
        output = _outputs(torch, model, prepared, indices, device=device)
        tensors = r23._tier_tensors(torch, rows, device=device)
        routed = torch.where(
            tensors["family_labels"][:, None] == 0,
            output["body_candidate_scores"],
            output["variant_candidate_scores"],
        )
        row_weights = torch.as_tensor(weights, dtype=torch.float32, device=device)
        candidate_loss, _ = r23.weighted_candidate_set_loss(
            torch,
            routed,
            preferred_mask=tensors["preferred_mask"],
            safe_mask=tensors["safe_mask"],
            marginal_mask=tensors["marginal_mask"],
            unacceptable_mask=tensors["unacceptable_mask"],
            single_day_safety_negative=tensors["single_day_safety_negative"],
            marginal_weight=MARGINAL_WEIGHT,
            row_weights=row_weights,
        )
        family_loss = torch.nn.functional.cross_entropy(
            output["family_logits"], tensors["family_labels"], reduction="none"
        )
        family_loss = torch.sum(family_loss * row_weights)
        safety = r23._single_day_safety_losses(
            torch,
            output,
            safe_mask=tensors["safe_mask"],
            family_labels=tensors["family_labels"],
            safety_negative=tensors["single_day_safety_negative"],
            row_weights=row_weights,
            single_day_index=tuple(prepared["context"]["candidate_ids"]).index(
                "single-day"
            ),
        )

        base_indices = np.asarray(fold["base_indices"], dtype=np.int64)
        base_output = _outputs(torch, model, prepared, base_indices, device=device)
        cache = prepared["cache"]
        positions = torch.as_tensor(base_indices, dtype=torch.long)
        distill = 0.0
        for actual, name in (
            (base_output["family_logits"], "family_logits"),
            (base_output["body_candidate_scores"], "body_candidate_scores"),
            (base_output["variant_candidate_scores"], "variant_candidate_scores"),
        ):
            anchor = cache[name][positions].to(device)
            distill = distill + torch.nn.functional.kl_div(
                torch.log_softmax(actual.float(), dim=1),
                torch.softmax(anchor.float(), dim=1),
                reduction="batchmean",
            )
        distill = distill / 3.0
        total = (
            candidate_loss
            + 0.5 * family_loss
            + r23.SINGLE_DAY_BODY_HARD_NEGATIVE_WEIGHT * safety["body_hard_negative"]
            + r23.SINGLE_DAY_SUPERVISED_HARD_NEGATIVE_WEIGHT
            * safety["supervised_hard_negative"]
            + 0.75 * distill
            + 0.001 * output["delta"].square().mean()
        )
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()

        model.eval()
        train_metrics = _row_metrics(
            torch, model, prepared, fold["train_rows"], device=device
        )
        base_metrics = _base_drift(
            torch, model, prepared, fold["base_indices"], device=device
        )
        safe_delta = (
            train_metrics["safe_top1_accuracy"] - anchor_train["safe_top1_accuracy"]
        )
        preferred_delta = (
            train_metrics["preferred_top1_accuracy"]
            - anchor_train["preferred_top1_accuracy"]
        )
        key = (
            min(safe_delta, preferred_delta),
            safe_delta + preferred_delta,
            train_metrics["family_accuracy"],
            -train_metrics["unacceptable_top1_rate"],
            -base_metrics["kl"],
            -epoch,
        )
        if best_key is None or key > best_key:
            best_key = key
            best_epoch = epoch
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
            best_train = train_metrics
            best_base = base_metrics

    if best_state is None:
        raise RuntimeError("no trained epoch was selected")
    model.load_state_dict(best_state)
    heldout = _row_metrics(torch, model, prepared, fold["heldout_rows"], device=device)
    return {
        "anchor_heldout": anchor_heldout,
        "anchor_train": anchor_train,
        "base_drift": best_base,
        "best_epoch": best_epoch,
        "heldout": heldout,
        "heldout_work_id": str(fold["heldout_work_id"]),
        "train": best_train,
    }


def _delta(
    candidate: Mapping[str, float], anchor: Mapping[str, float]
) -> Mapping[str, float]:
    return {key: float(candidate[key] - anchor[key]) for key in candidate}


def screen(*, device_name: str, epochs: int, learning_rate: float) -> Mapping[str, Any]:
    import torch

    prepared = _prepare(torch)
    device = torch.device(device_name)
    folds = [
        _train_fold(
            torch,
            prepared,
            fold,
            device=device,
            epochs=epochs,
            learning_rate=learning_rate,
        )
        for fold in prepared["folds"]
    ]
    heldout_keys = tuple(folds[0]["heldout"])
    anchor = {
        key: float(np.mean([fold["anchor_heldout"][key] for fold in folds]))
        for key in heldout_keys
    }
    candidate = {
        key: float(np.mean([fold["heldout"][key] for fold in folds]))
        for key in heldout_keys
    }
    train_delta = {
        key: float(
            np.mean([fold["train"][key] - fold["anchor_train"][key] for fold in folds])
        )
        for key in heldout_keys
    }
    parameter_count = (1024 + 1024 + 44) * HIDDEN_WIDTH + HIDDEN_WIDTH
    parameter_count += HIDDEN_WIDTH * 44 + 44
    mac = (1024 + 1024 + 44) * HIDDEN_WIDTH + HIDDEN_WIDTH * 44
    return {
        "architecture": {
            "estimated_total_mac_ratio": (PRODUCTION_MAC + mac) / PRODUCTION_MAC,
            "estimated_total_parameter_ratio": (PRODUCTION_PARAMETERS + parameter_count)
            / PRODUCTION_PARAMETERS,
            "hidden_width": HIDDEN_WIDTH,
            "new_parameter_count": parameter_count,
            "page_context": "same-page_anchor-soft-family-weighted-mean-query",
        },
        "configuration": {
            "device": device_name,
            "epochs": epochs,
            "learning_rate": learning_rate,
            "marginal_weight": MARGINAL_WEIGHT,
            "maximum_delta": MAXIMUM_DELTA,
        },
        "folds": folds,
        "oof": {
            "anchor": anchor,
            "candidate": candidate,
            "delta": _delta(candidate, anchor),
        },
        "status": "r29_page_conditioned_direct_screen_complete",
        "training_delta_mean": train_delta,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    args = parser.parse_args()
    result = screen(
        device_name=args.device,
        epochs=int(args.epochs),
        learning_rate=float(args.learning_rate),
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
