from __future__ import annotations

import unittest
from types import SimpleNamespace

import numpy as np

from scripts import export_manga_font_student_hybrid_runtime_onnx as exporter


class HybridPrototypeContractTests(unittest.TestCase):
    def test_packs_legacy_and_candidate_query_prototypes_without_cross_talk(self) -> None:
        legacy = np.arange(352 * exporter.LEGACY_FEATURE_DIM, dtype=np.float32).reshape(
            352, exporter.LEGACY_FEATURE_DIM
        )
        variant = np.zeros(
            (
                22,
                exporter.VARIANT_QUERY_COUNT,
                exporter.VARIANT_QUERY_DIM,
            ),
            dtype=np.float32,
        )
        variant[:, :, 0] = 1
        packed = exporter._pack_prototypes(legacy, variant)  # noqa: SLF001
        self.assertEqual(packed.shape, (352, exporter.FEATURE_DIM))
        np.testing.assert_array_equal(
            packed[:, : exporter.LEGACY_FEATURE_DIM], legacy
        )
        np.testing.assert_array_equal(
            packed[:22, exporter.LEGACY_FEATURE_DIM :], variant.reshape(22, -1)
        )
        self.assertFalse(packed[22:, exporter.LEGACY_FEATURE_DIM :].any())

    def test_rejects_non_normalized_v6_prototypes(self) -> None:
        legacy = np.zeros((352, exporter.LEGACY_FEATURE_DIM), dtype=np.float32)
        variant = np.ones(
            (22, exporter.VARIANT_QUERY_COUNT, exporter.VARIANT_QUERY_DIM),
            dtype=np.float32,
        )
        with self.assertRaisesRegex(
            exporter.HybridRuntimeExportError, "not L2 normalized"
        ):
            exporter._pack_prototypes(legacy, variant)  # noqa: SLF001

    def test_successor_io_keeps_candidate_scores_alias_and_adds_dual_scores(self) -> None:
        authority = SimpleNamespace(
            base=SimpleNamespace(candidate_ids=tuple(f"font-{index}" for index in range(22))),
            packed_prototypes=np.zeros((352, exporter.FEATURE_DIM), dtype=np.float32),
        )
        contract = exporter._io_contract(authority)  # noqa: SLF001
        output_names = [
            row["name"] for row in contract[exporter.RANKER_FILE]["outputs"]
        ]
        self.assertEqual(output_names, list(exporter.RANKER_OUTPUT_NAMES))
        self.assertEqual(
            contract[exporter.ENCODER_FILE]["outputs"][0]["shape"],
            [None, 1280],
        )

    def test_routing_is_complete_disjoint_and_has_no_row_rules(self) -> None:
        routing = exporter._routing_contract()  # noqa: SLF001
        self.assertEqual(routing["body_roles"], ["dialogue", "narration", "thought"])
        self.assertFalse(set(routing["body_roles"]) & set(routing["variant_roles"]))
        self.assertEqual(
            set(routing["body_roles"]) | set(routing["variant_roles"]),
            set(exporter.trainer.ROLE_VALUES),
        )
        self.assertEqual(routing["unknown_role_fallback"], "variant_candidate_scores")
        self.assertFalse(routing["row_specific_rules"])

    def test_runtime_batching_is_exactly_the_parity_qualified_batching(self) -> None:
        self.assertEqual(
            exporter._runtime_batching_contract(),  # noqa: SLF001
            {
                "encoder_batch_size": 2,
                "ranker_batch_size": 16,
                "parity_qualified": True,
            },
        )


class HybridRankerTests(unittest.TestCase):
    def test_ranker_reproduces_exact_three_view_query_aggregation(self) -> None:
        import torch

        candidate_ids = ("font-a", "font-b")

        class NoopVision(torch.nn.Module):
            def forward(self, pixel_values, return_dict=False):  # type: ignore[no-untyped-def]
                batch = pixel_values.shape[0]
                return (
                    torch.zeros((batch, 196, 768)),
                    torch.ones((batch, exporter.LEGACY_FEATURE_DIM)),
                )

        class VariantHead(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.query_weight_logits = torch.nn.Parameter(torch.zeros(4))
                self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))

            def encode(self, tokens):  # type: ignore[no-untyped-def]
                batch = tokens.shape[0]
                values = torch.zeros((batch, 4, 256))
                values[:, :, 0] = 1
                return values, torch.zeros((batch, 4, 196))

        class BodyRanker(torch.nn.Module):
            def forward(self, views, prototypes, bags):  # type: ignore[no-untyped-def]
                batch = views.shape[0]
                body = torch.stack((views[:, 0, 0], views[:, 0, 1]), dim=1)
                return {
                    "candidate_scores": body,
                    "none_logits": torch.zeros(batch),
                    "role_logits": torch.zeros((batch, 14)),
                    "style_logits": torch.zeros((batch, 10)),
                    "treatment_logits": {
                        field: torch.zeros((batch, len(values)))
                        for field, values in exporter.trainer.TREATMENT_VALUES.items()
                    },
                    "view_gate_weights": torch.full((batch, 3), 1 / 3),
                }

        variant_head = VariantHead()
        authority = SimpleNamespace(
            base=SimpleNamespace(
                candidate_ids=candidate_ids,
                candidate_bags=(
                    {"candidate_id": "font-a", "start": 0, "count": 1},
                    {"candidate_id": "font-b", "start": 1, "count": 1},
                ),
            )
        )
        legacy = SimpleNamespace(
            vision_encoder=NoopVision(), projection=torch.nn.Identity()
        )
        _encoder, ranker = exporter._make_wrappers(  # noqa: SLF001
            authority=authority,
            legacy_student=legacy,
            variant_vision=NoopVision(),
            variant_head=variant_head,
            body_ranker=BodyRanker(),
        )
        views = torch.zeros((1, 3, exporter.FEATURE_DIM))
        query_views = views[:, :, exporter.LEGACY_FEATURE_DIM :].reshape(1, 3, 4, 256)
        query_views[0, 0, :, 0] = 1
        query_views[0, 1, :, 1] = 1
        query_views[0, 2, :, 0] = 1
        prototypes = torch.zeros((2, exporter.FEATURE_DIM))
        variant_prototypes = prototypes[:, exporter.LEGACY_FEATURE_DIM :].reshape(
            2, 4, 256
        )
        variant_prototypes[0, :, 0] = 1
        variant_prototypes[1, :, 1] = 1

        outputs = ranker(views, prototypes)
        by_name = dict(zip(exporter.RANKER_OUTPUT_NAMES, outputs, strict=True))
        mean = query_views.mean(dim=1)
        mean = torch.nn.functional.normalize(mean, p=2, dim=-1)
        expected = torch.einsum("bqd,cqd->bcq", mean, variant_prototypes).mean(dim=-1)
        torch.testing.assert_close(by_name["variant_candidate_scores"], expected)
        torch.testing.assert_close(
            by_name["candidate_scores"], by_name["body_candidate_scores"]
        )

    def test_parity_rejects_body_alias_drift(self) -> None:
        encoder = np.ones((2, exporter.FEATURE_DIM), dtype=np.float32)
        encoder /= np.linalg.norm(encoder, axis=1, keepdims=True)
        outputs = _minimal_ranker_outputs()
        outputs["body_candidate_scores"][0, 0] += 1
        actual = {name: value.copy() for name, value in outputs.items()}
        with self.assertRaisesRegex(
            exporter.HybridRuntimeExportError, "alias/variant decision parity"
        ):
            exporter._parity_metrics(  # noqa: SLF001
                reference_encoder=encoder,
                actual_encoder=encoder.copy(),
                reference_ranker=outputs,
                actual_ranker=actual,
            )


def _minimal_ranker_outputs() -> dict[str, np.ndarray]:
    output = {
        "candidate_scores": np.array([[1, 0], [0, 1]], dtype=np.float32),
        "body_candidate_scores": np.array([[1, 0], [0, 1]], dtype=np.float32),
        "variant_candidate_scores": np.array([[0, 1], [1, 0]], dtype=np.float32),
        "none_logits": np.zeros(2, dtype=np.float32),
        "role_logits": np.zeros((2, 14), dtype=np.float32),
        "style_logits": np.zeros((2, 10), dtype=np.float32),
        "view_gate_weights": np.full((2, 3), 1 / 3, dtype=np.float32),
    }
    for field, values in exporter.trainer.TREATMENT_VALUES.items():
        output[f"treatment_{field}_logits"] = np.zeros(
            (2, len(values)), dtype=np.float32
        )
    return output


if __name__ == "__main__":
    unittest.main()
