from __future__ import annotations

import numpy as np

from scripts import refine_manga_font_v2_pseudo_labels_r2 as subject


IDS = ("font-a", "font-b", subject.SINGLE_DAY_ID)


def test_role_prior_removes_single_day_from_body_rows() -> None:
    labels = {
        "body": {
            "candidate_labels": {
                "positive_candidate_ids": ["font-a", subject.SINGLE_DAY_ID],
                "preferred_candidate_ids": [subject.SINGLE_DAY_ID],
            },
            "family": "body",
            "role": "dialogue",
        },
        "variant": {
            "candidate_labels": {
                "positive_candidate_ids": [subject.SINGLE_DAY_ID],
                "preferred_candidate_ids": [subject.SINGLE_DAY_ID],
            },
            "family": "variant",
            "role": "sfx_impact",
        },
    }

    priors, report = subject.build_role_priors(labels, IDS)

    assert np.isclose(priors["dialogue"].sum(), 1.0)
    assert priors["dialogue"][-1] == 0.0
    assert priors["sfx_impact"][-1] > 0.0
    assert report["body_single_day_removed"] is True


def test_r7_only_top1_shift_is_reverted_to_anchor() -> None:
    decision = subject.conservative_ensemble(
        anchor=[0.36, 0.35, 0.29],
        r5=[0.50, 0.40, 0.10],
        r7=[0.01, 0.98, 0.01],
        role_prior=[0.01, 0.98, 0.01],
        candidate_ids=IDS,
        role="emphasis_dialogue",
        source_category="text_free",
        r5_confidence=0.50,
        r7_single_day_allowed=False,
    )

    assert int(decision.probabilities.argmax()) == 0
    assert decision.top1_guard == "unsupported_shift_reverted_to_anchor"
    assert decision.weights["r7"] < decision.weights["r1"]


def test_r5_r7_consensus_can_change_top1_without_gold_promotion() -> None:
    decision = subject.conservative_ensemble(
        anchor=[0.45, 0.44, 0.11],
        r5=[0.10, 0.85, 0.05],
        r7=[0.10, 0.85, 0.05],
        role_prior=[0.20, 0.70, 0.10],
        candidate_ids=IDS,
        role="emphasis_dialogue",
        source_category="text_free",
        r5_confidence=0.85,
        r7_single_day_allowed=False,
    )

    assert int(decision.probabilities.argmax()) == 1
    assert decision.agreement == "r5_r7_consensus"
    assert decision.top1_guard == "r5_r7_consensus_shift_allowed"


def test_body_single_day_is_a_hard_negative_even_when_anchor_top1() -> None:
    decision = subject.conservative_ensemble(
        anchor=[0.10, 0.10, 0.80],
        r5=[0.10, 0.10, 0.80],
        r7=[0.10, 0.10, 0.80],
        role_prior=[0.60, 0.40, 0.00],
        candidate_ids=IDS,
        role="dialogue",
        source_category="ordinary",
        r5_confidence=0.80,
        r7_single_day_allowed=True,
    )

    assert int(decision.probabilities.argmax()) != 2
    assert decision.single_day_multiplier == 0.02
    assert decision.top1_guard == "single_day_anchor_overridden_by_hard_negative"


def test_specialist_single_day_positive_is_preserved() -> None:
    decision = subject.conservative_ensemble(
        anchor=[0.10, 0.10, 0.80],
        r5=[0.10, 0.10, 0.80],
        r7=[0.10, 0.10, 0.80],
        role_prior=[0.10, 0.10, 0.80],
        candidate_ids=IDS,
        role="sfx_impact",
        source_category="page_sound",
        r5_confidence=0.80,
        r7_single_day_allowed=True,
    )

    assert int(decision.probabilities.argmax()) == 2
    assert decision.single_day_multiplier == 1.0
    assert decision.single_day_policy == "specialist_positive_preserved"


def test_distribution_reports_every_candidate_and_collapse_inputs() -> None:
    probabilities = np.asarray([[0.7, 0.2, 0.1], [0.1, 0.8, 0.1]])

    report = subject._distribution(probabilities, IDS)  # noqa: SLF001

    assert report["row_count"] == 2
    assert report["unique_top1_fonts"] == 2
    assert set(report["font_top1"]) == set(IDS)
    assert report["font_top1"]["font-a"]["count"] == 1
    assert report["max_top1_share"] == 0.5
