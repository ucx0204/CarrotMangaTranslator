"""Screen a learned soft page-common font prior with the R31 family router."""

from __future__ import annotations

import argparse
import json
from typing import Any, Mapping, Sequence

import numpy as np

try:
    from scripts import screen_manga_font_v3_candidate_interaction_r32 as r32
except ImportError:  # pragma: no cover
    import screen_manga_font_v3_candidate_interaction_r32 as r32


STRENGTHS = (0.5, 1.0, 2.0)
MAXIMUM_DELTA = 4.0
PRODUCTION_PARAMETERS = 74_528
PRODUCTION_MAC = 91_776


def _build_page_model(torch: Any, *, seed: int) -> Any:
    torch.manual_seed(seed)

    class PageCommonRanker(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.page = torch.nn.Linear(1024, 16, bias=False)
            self.candidate_embedding = torch.nn.Embedding(21, 4)
            self.scorer = torch.nn.Sequential(
                torch.nn.LayerNorm(25),
                torch.nn.Linear(25, 16),
                torch.nn.GELU(),
                torch.nn.Linear(16, 1),
            )
            torch.nn.init.zeros_(self.scorer[-1].weight)
            torch.nn.init.zeros_(self.scorer[-1].bias)

        def forward(
            self, page_query: Any, per_query: Any, anchor_body: Any
        ) -> Mapping[str, Any]:
            page = torch.nn.functional.layer_norm(page_query.float(), (1024,))
            hidden = self.page(page)
            candidate_ids = torch.arange(21, device=page.device)
            candidate = self.candidate_embedding(candidate_ids)
            pieces = (
                hidden[:, None, :].expand(-1, 21, -1),
                per_query,
                anchor_body[:, :, None],
                candidate[None, :, :].expand(len(page), -1, -1),
            )
            delta = MAXIMUM_DELTA * torch.tanh(
                self.scorer(torch.cat(pieces, dim=-1)).squeeze(-1)
            )
            return {"delta": delta, "page_scores": anchor_body + delta}

    return PageCommonRanker()


def _group_rows(
    rows: Sequence[Mapping[str, Any]], page_by_sample: Mapping[str, str]
) -> tuple[Mapping[str, Any], ...]:
    pages: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        pages.setdefault(page_by_sample[str(row["sample_id"])], []).append(row)
    groups = []
    for page_id, page_rows in sorted(pages.items()):
        body_rows = tuple(row for row in page_rows if int(row["family_label"]) == 0)
        if len(body_rows) < 2:
            continue
        groups.append(
            {
                "body_rows": body_rows,
                "page_id": page_id,
                "page_rows": tuple(page_rows),
                "work_id": str(page_rows[0]["work_id"]),
            }
        )
    return tuple(groups)


def _group_features(
    torch: Any,
    prepared: Mapping[str, Any],
    groups: Sequence[Mapping[str, Any]],
    *,
    device: Any,
    include_targets: bool = True,
) -> Mapping[str, Any]:
    page_queries = []
    per_queries = []
    anchor_bodies = []
    common_safe = []
    common_preferred = []
    active_groups = []
    cache = prepared["cache"]
    for group in groups:
        page_rows = tuple(group["page_rows"])
        indices = np.asarray([row["row_index"] for row in page_rows], dtype=np.int64)
        local = prepared["local_query"][indices].astype(np.float32, copy=False)
        page = np.mean(local, axis=0)
        page /= max(float(np.linalg.norm(page)), 1e-6)
        if include_targets:
            tensors = r32.r31.r29.r23._tier_tensors(
                torch, tuple(group["body_rows"]), device=device
            )
            safe = tensors["safe_mask"].all(dim=0)
            preferred = tensors["preferred_mask"].all(dim=0)
            if not bool(safe.any()):
                continue
        active_groups.append(group)
        page_queries.append(page)
        per_queries.append(r32._per_query(prepared, indices).mean(axis=0))
        positions = torch.as_tensor(indices, dtype=torch.long)
        anchor_bodies.append(cache["body_candidate_scores"][positions].mean(dim=0))
        if include_targets:
            common_safe.append(safe)
            common_preferred.append(preferred if bool(preferred.any()) else safe)
    if not active_groups:
        raise RuntimeError("no page group has a shared reviewed-safe candidate")
    result = {
        "anchor_body": torch.stack(anchor_bodies).to(device),
        "groups": tuple(active_groups),
        "page_query": torch.as_tensor(np.stack(page_queries), device=device),
        "per_query": torch.as_tensor(np.stack(per_queries), device=device),
    }
    if include_targets:
        result["common_preferred"] = torch.stack(common_preferred).to(device)
        result["common_safe"] = torch.stack(common_safe).to(device)
    return result


def _group_weights(
    groups: Sequence[Mapping[str, Any]], *, torch: Any, device: Any
) -> Any:
    works: dict[str, list[int]] = {}
    for position, group in enumerate(groups):
        works.setdefault(str(group["work_id"]), []).append(position)
    values = np.zeros(len(groups), dtype=np.float32)
    for positions in works.values():
        values[np.asarray(positions, dtype=np.int64)] = 1.0 / (
            len(works) * len(positions)
        )
    return torch.as_tensor(values, device=device)


def _set_loss(torch: Any, scores: Any, mask: Any) -> Any:
    negative = torch.finfo(scores.dtype).min
    numerator = torch.logsumexp(scores.masked_fill(~mask, negative), dim=1)
    denominator = torch.logsumexp(scores, dim=1)
    return denominator - numerator


def _train_family_router(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    fold: Mapping[str, Any],
    *,
    device: Any,
) -> Any:
    fold_index = int(fold["contract"]["fold_index"])
    model = r32.r31._build_model(torch, r32.r31.CELLS[0], seed=33_000 + fold_index).to(
        device
    )
    rows = tuple(fold["train_rows"])
    weights = r32.r31._balanced_weights(rows, torch=torch, device=device)
    labels = torch.as_tensor(
        [row["family_label"] for row in rows], dtype=torch.long, device=device
    )
    base_indices = np.asarray(fold["base_indices"], dtype=np.int64)
    rng = np.random.default_rng(33_000 + fold_index)
    base_indices = np.sort(
        rng.choice(base_indices, size=min(2048, len(base_indices)), replace=False)
    )
    base_local = prepared["local_query"][base_indices].astype(np.float32, copy=False)
    positions = torch.as_tensor(base_indices, dtype=torch.long)
    base_anchor = prepared["cache"]["family_logits"][positions].to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=2e-3)
    for _ in range(24):
        model.train()
        logits = r32.r31._family_logits(
            torch,
            model,
            prepared,
            rows,
            page_by_sample,
            "local",
            device=device,
        )
        direct = torch.sum(
            torch.nn.functional.cross_entropy(logits, labels, reduction="none")
            * weights
        )
        base_output = model(
            torch.as_tensor(base_local, device=device),
            torch.as_tensor(base_local, device=device),
            base_anchor,
        )
        distill = torch.nn.functional.kl_div(
            torch.log_softmax(base_output.float(), dim=1),
            torch.softmax(base_anchor.float(), dim=1),
            reduction="batchmean",
        )
        total = direct + 0.2 * distill
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
    model.eval()
    return model


def _page_deltas(
    torch: Any,
    model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    *,
    device: Any,
) -> Mapping[str, Any]:
    groups = _group_rows(rows, page_by_sample)
    if not groups:
        return {}
    features = _group_features(
        torch, prepared, groups, device=device, include_targets=False
    )
    output = model(
        features["page_query"], features["per_query"], features["anchor_body"]
    )
    return {
        str(group["page_id"]): output["delta"][position]
        for position, group in enumerate(features["groups"])
    }


def _evaluate(
    torch: Any,
    family_model: Any,
    page_model: Any,
    prepared: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    page_by_sample: Mapping[str, str],
    strength: float,
    *,
    device: Any,
) -> Mapping[str, float]:
    indices = np.asarray([row["row_index"] for row in rows], dtype=np.int64)
    positions = torch.as_tensor(indices, dtype=torch.long)
    cache = prepared["cache"]
    family = r32.r31._family_logits(
        torch,
        family_model,
        prepared,
        rows,
        page_by_sample,
        "local",
        device=device,
    )
    body = cache["body_candidate_scores"][positions].to(device).clone()
    deltas = _page_deltas(
        torch,
        page_model,
        prepared,
        rows,
        page_by_sample,
        device=device,
    )
    for position, row in enumerate(rows):
        page_id = page_by_sample[str(row["sample_id"])]
        if page_id in deltas:
            body[position] += strength * deltas[page_id]
    return r32._metrics(
        torch,
        {
            "body_candidate_scores": body,
            "family_logits": family,
            "variant_candidate_scores": cache["variant_candidate_scores"][positions].to(
                device
            ),
        },
        prepared,
        rows,
        page_by_sample,
    )


def _train_fold(
    torch: Any,
    prepared: Mapping[str, Any],
    page_by_sample: Mapping[str, str],
    fold: Mapping[str, Any],
    *,
    device: Any,
) -> Mapping[str, Any]:
    fold_index = int(fold["contract"]["fold_index"])
    train_rows = tuple(fold["train_rows"])
    heldout_rows = tuple(fold["heldout_rows"])
    groups = _group_rows(train_rows, page_by_sample)
    features = _group_features(torch, prepared, groups, device=device)
    if len(features["groups"]) < 20:
        raise RuntimeError("insufficient page-common training groups")
    weights = _group_weights(features["groups"], torch=torch, device=device)
    page_model = _build_page_model(torch, seed=33_000 + fold_index).to(device)
    optimizer = torch.optim.AdamW(page_model.parameters(), lr=8e-4, weight_decay=1e-4)
    for _ in range(32):
        page_model.train()
        output = page_model(
            features["page_query"], features["per_query"], features["anchor_body"]
        )
        preferred = _set_loss(
            torch, output["page_scores"], features["common_preferred"]
        )
        safe = _set_loss(torch, output["page_scores"], features["common_safe"])
        loss = torch.sum((0.65 * preferred + 0.35 * safe) * weights)
        total = loss + 0.01 * output["delta"].square().mean()
        optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(page_model.parameters(), 2.0)
        optimizer.step()
    page_model.eval()
    family_model = _train_family_router(
        torch, prepared, page_by_sample, fold, device=device
    )
    anchor = r32._metrics(
        torch,
        r32._anchor_output(prepared, heldout_rows, device=device),
        prepared,
        heldout_rows,
        page_by_sample,
    )
    return {
        str(strength): r32._delta(
            _evaluate(
                torch,
                family_model,
                page_model,
                prepared,
                heldout_rows,
                page_by_sample,
                strength,
                device=device,
            ),
            anchor,
        )
        for strength in STRENGTHS
    }


def screen(device_name: str) -> Mapping[str, Any]:
    import torch

    prepared = r32.r31.r29._prepare(torch)
    page_by_sample = r32.r31._page_map(prepared)
    device = torch.device(device_name)
    folds = [
        _train_fold(torch, prepared, page_by_sample, fold, device=device)
        for fold in prepared["folds"]
    ]
    results = {}
    for strength in STRENGTHS:
        key = str(strength)
        metrics = tuple(fold[key] for fold in folds)
        names = tuple(metrics[0])
        results[key] = {
            "oof_delta": {
                name: float(np.mean([metric[name] for metric in metrics]))
                for name in names
            },
            "worst_work_preferred_delta": min(
                metric["preferred_top1_accuracy"] for metric in metrics
            ),
            "worst_work_safe_delta": min(
                metric["safe_top1_accuracy"] for metric in metrics
            ),
        }
    model = _build_page_model(torch, seed=33_000)
    parameters = 32_962 + sum(int(value.numel()) for value in model.parameters())
    page_input = 16 + 4 + 1 + 4
    new_mac = 1024 * 32 + 2 * 32 + 32 * 2
    new_mac += 1024 * 16 + 21 * (page_input * 16 + 16)
    return {
        "architecture": {
            "estimated_total_mac_ratio": (PRODUCTION_MAC + new_mac) / PRODUCTION_MAC,
            "estimated_total_parameter_ratio": (PRODUCTION_PARAMETERS + parameters)
            / PRODUCTION_PARAMETERS,
            "new_parameter_count": parameters,
        },
        "results": results,
        "status": "r33_page_common_ranker_screen",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("screen", nargs="?")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    print(json.dumps(screen(args.device), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
