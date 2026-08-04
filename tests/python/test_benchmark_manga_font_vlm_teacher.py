from __future__ import annotations

import json

import pytest

from scripts import benchmark_manga_font_vlm_teacher as benchmark


FONT_IDS = tuple(f"font-{index:02d}" for index in range(22))
CODES = tuple(f"C{index:02d}" for index in range(1, 23))


def test_candidate_shuffle_is_deterministic_and_sample_specific() -> None:
    first = benchmark.shuffled_font_ids(FONT_IDS, "sample-a", "seed")
    repeated = benchmark.shuffled_font_ids(FONT_IDS, "sample-a", "seed")
    second_sample = benchmark.shuffled_font_ids(FONT_IDS, "sample-b", "seed")

    assert first == repeated
    assert set(first) == set(FONT_IDS)
    assert first != second_sample


def test_parse_ranking_requires_an_exact_permutation() -> None:
    valid = json.dumps({"ranked_codes": list(CODES)})
    assert benchmark.parse_ranking(valid, CODES) == list(CODES)

    duplicate = json.dumps({"ranked_codes": [*CODES[:-1], CODES[0]]})
    with pytest.raises(benchmark.BenchmarkError, match="exact permutation"):
        benchmark.parse_ranking(duplicate, CODES)


def test_parse_ranking_accepts_a_json_fence_only() -> None:
    fenced = "```json\n" + json.dumps({"ranked_codes": list(CODES)}) + "\n```"
    assert benchmark.parse_ranking(fenced, CODES) == list(CODES)


def test_request_schema_binds_all_neutral_codes() -> None:
    schema = benchmark.request_schema(CODES)
    ranked = schema["json_schema"]["schema"]["properties"]["ranked_codes"]

    assert ranked["items"]["enum"] == list(CODES)
    assert ranked["minItems"] == 22
    assert ranked["maxItems"] == 22


def test_pilot_gate_uses_predeclared_global_and_variant_thresholds() -> None:
    passed = benchmark.pilot_gate(
        {
            "global": {
                "parse_rate": 1.0,
                "preferred_at_1": 0.25,
                "acceptable_or_preferred_at_1": 0.5,
            },
            "variant": {
                "preferred_at_1": 0.2,
                "acceptable_or_preferred_at_1": 0.5,
            },
        }
    )
    failed = benchmark.pilot_gate(
        {
            "global": {
                "parse_rate": 1.0,
                "preferred_at_1": 0.249,
                "acceptable_or_preferred_at_1": 0.5,
            },
            "variant": {
                "preferred_at_1": 0.2,
                "acceptable_or_preferred_at_1": 0.5,
            },
        }
    )

    assert passed["passed"] is True
    assert failed["passed"] is False


def test_extract_message_text_does_not_promote_hidden_reasoning() -> None:
    response = {
        "choices": [
            {
                "message": {
                    "content": json.dumps({"ranked_codes": list(CODES)}),
                    "reasoning_content": "untrusted hidden reasoning",
                }
            }
        ]
    }

    assert (
        benchmark.extract_message_text(response)
        == response["choices"][0]["message"]["content"]
    )
