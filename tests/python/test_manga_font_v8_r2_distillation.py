from __future__ import annotations

import numpy as np
import torch

from scripts import build_manga_font_v8_r2_distillation_bundle as bundle
from scripts import train_manga_font_student_v8_role_family_adapter as trainer


def test_bundle_keeps_reviewed_and_heldout_rows_at_zero_weight() -> None:
    candidate_ids = np.asarray(["font-a", "font-b", "single-day"])
    sample_ids = np.asarray(["ordinary", "visual", "heldout", "human", "sfx"])
    dataset_arrays = {
        "candidate_ids": candidate_ids,
        "font_authority": np.asarray(["none", "visual", "none", "human", "none"]),
        "sample_ids": sample_ids,
        "split": np.asarray([0, 0, 1, 0, 0], dtype=np.int8),
    }
    categories = np.asarray(
        ["ordinary", "bubble_edge", "text_free", "ordinary", "page_sound"]
    )
    roles = np.asarray(
        ["dialogue", "aside_balloon_edge", "emphasis_dialogue", "dialogue", "sfx_impact"]
    )
    inference_arrays = {
        "sample_ids": sample_ids,
        "source_categories": categories,
        "roles": roles,
    }
    probabilities = {
        "ordinary": [0.8, 0.19, 0.01],
        "visual": [0.7, 0.2, 0.1],
        "heldout": [0.2, 0.7, 0.1],
        "human": [0.8, 0.1, 0.1],
        "sfx": [0.05, 0.05, 0.9],
    }
    pseudo_rows = {
        sample_id: {
            "candidate_ids": candidate_ids.tolist(),
            "probabilities": probabilities[sample_id],
            "source_category": str(categories[index]),
            "weight": 0.8,
        }
        for index, sample_id in enumerate(sample_ids.tolist())
    }

    arrays, summary = bundle.build_target_arrays(
        dataset_arrays, pseudo_rows, inference_arrays
    )

    assert np.flatnonzero(arrays["distillation_weights"] > 0).tolist() == [0, 4]
    assert np.isclose(arrays["distillation_weights"][0], 0.8 * 0.45)
    assert arrays["single_day_negative"].tolist() == [True, False, False, False, False]
    assert arrays["specialist_single_day_positive"].tolist() == [False, False, False, False, True]
    assert summary["protected_r2_source_rows"] == 2
    assert summary["heldout_or_reviewed_weight_nonzero"] == 0


def test_auxiliary_distillation_has_anchor_and_single_day_gradients() -> None:
    body = torch.tensor([[1.0, 0.0, 0.9], [0.1, 0.0, -0.1]], requires_grad=True)
    variant = torch.tensor([[0.5, 0.0, 0.2], [0.0, 0.1, 0.0]], requires_grad=True)
    family = torch.tensor([[1.0, -1.0], [0.0, 0.0]], requires_grad=True)
    outputs = {
        "body_candidate_scores": body,
        "variant_candidate_scores": variant,
        "family_logits": family,
    }
    anchor = {
        "body_candidate_probabilities": torch.softmax(
            body.detach() + torch.tensor([0.2, 0.0, -0.1]), dim=1
        ),
        "variant_candidate_probabilities": torch.softmax(
            variant.detach() + torch.tensor([-0.1, 0.2, 0.0]), dim=1
        ),
        "family_probabilities": torch.softmax(
            family.detach() + torch.tensor([0.2, -0.2]), dim=1
        ),
    }
    parts = trainer.role_family_auxiliary_distillation_loss(
        torch,
        outputs,
        family_labels=torch.tensor([0, 1]),
        target_probabilities=torch.tensor(
            [[0.80, 0.19, 0.01], [0.05, 0.05, 0.90]]
        ),
        distillation_weights=torch.tensor([0.5, 1.0]),
        single_day_negative=torch.tensor([True, False]),
        specialist_single_day_positive=torch.tensor([False, True]),
        single_day_index=2,
        anchor_probabilities=anchor,
    )
    total = sum(parts.values())
    total.backward()

    assert float(parts["pseudo_kl"].detach()) > 0.0
    assert float(parts["anchor_output"].detach()) > 0.0
    assert float(parts["pseudo_single_day_negative"].detach()) > 0.0
    assert float(parts["pseudo_single_day_positive"].detach()) > 0.0
    assert body.grad is not None and float(body.grad.abs().sum()) > 0.0
    assert variant.grad is not None and float(variant.grad.abs().sum()) > 0.0
    assert family.grad is not None and float(family.grad.abs().sum()) > 0.0


def test_parameter_anchor_tracks_only_trainable_parameters() -> None:
    model = torch.nn.Sequential(torch.nn.Linear(2, 2), torch.nn.Linear(2, 1))
    model[1].weight.requires_grad_(False)
    model[1].bias.requires_grad_(False)
    anchor = {name: value.detach().clone() for name, value in model.state_dict().items()}
    with torch.no_grad():
        model[0].weight.add_(1.0)

    loss = trainer.parameter_anchor_loss(torch, model, anchor)

    assert float(loss.detach()) > 0.0
    loss.backward()
    assert model[0].weight.grad is not None
    assert model[1].weight.grad is None
