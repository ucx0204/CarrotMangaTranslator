from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace

import torch
from safetensors.torch import save_file

from scripts import export_manga_font_student_v8_runtime_onnx as exporter
from scripts import train_manga_font_student_v8_role_family_adapter as trainer


class MangaFontV8RuntimeExporterTests(unittest.TestCase):
    def test_loader_reconstructs_nondefault_sample_residual_and_fails_closed(self) -> None:
        candidate_ids = ("body", "single-day")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            model = trainer.build_role_family_adapter(
                torch,
                candidate_count=2,
                maximum_family_bias=0.2,
                candidate_residual_hidden_dim=3,
                maximum_sample_residual=0.4,
            )
            checkpoint = root / trainer.CHECKPOINT_FILE
            save_file(model.state_dict(), str(checkpoint))

            def write_manifest(passed: bool) -> None:
                manifest = trainer.seal_record(
                    {
                        "architecture": {
                            "candidate_residual_hidden_dim": 3,
                            "maximum_family_bias": 0.2,
                            "maximum_sample_residual": 0.4,
                        },
                        "candidate_ids": list(candidate_ids),
                        "files": {
                            trainer.CHECKPOINT_FILE: {
                                "byte_size": checkpoint.stat().st_size,
                                "sha256": trainer.sha256_file(checkpoint),
                            }
                        },
                        "quality_gate": {"passed": passed},
                        "schema_version": trainer.SCHEMA_VERSION,
                    }
                )
                (root / trainer.MANIFEST_FILE).write_bytes(
                    trainer.json_bytes(manifest, pretty=True)
                )

            write_manifest(True)
            loaded = exporter.load_adapter(
                adapter_dir=root,
                candidate_ids=candidate_ids,
                allow_failed_quality=False,
            )
            self.assertEqual(3, loaded.sample_candidate_residual[0].out_features)
            self.assertEqual(0.4, loaded.maximum_sample_residual)
            write_manifest(False)
            with self.assertRaisesRegex(
                exporter.MangaFontV8RuntimeExportError, "quality gate failed"
            ):
                exporter.load_adapter(
                    adapter_dir=root,
                    candidate_ids=candidate_ids,
                    allow_failed_quality=False,
                )

    def test_ranker_emits_body_alias_distinct_variant_and_pixel_role(self) -> None:
        adapter = trainer.build_role_family_adapter(torch, candidate_count=2)
        with torch.no_grad():
            adapter.body_query_weight_logits.copy_(
                torch.tensor([12.0, -12.0, -12.0, -12.0])
            )
            adapter.variant_query_weight_logits.copy_(
                torch.tensor([-12.0, 12.0, -12.0, -12.0])
            )
            adapter.body_logit_scale.zero_()
            adapter.variant_logit_scale.zero_()
            adapter.family_head.weight.zero_()
            adapter.family_head.bias.copy_(torch.tensor([2.0, -2.0]))
        authority = SimpleNamespace(
            candidate_bags=(
                {"candidate_id": "body", "start": 0, "count": 1},
                {"candidate_id": "single-day", "start": 1, "count": 1},
            )
        )
        unused_model = SimpleNamespace(
            vision_encoder=torch.nn.Identity(), projection=torch.nn.Identity()
        )
        _encoder, ranker = exporter.make_wrappers(
            authority=authority,
            legacy_student=unused_model,
            vision=torch.nn.Identity(),
            head=SimpleNamespace(),
            adapter=adapter,
        )
        views = torch.zeros((1, 3, exporter.v7.FEATURE_DIM))
        query_offset = exporter.v7.LEGACY_FEATURE_DIM
        views[:, :, query_offset + 0 * trainer.QUERY_DIM + 0] = 1.0
        views[:, :, query_offset + 1 * trainer.QUERY_DIM + 1] = 1.0
        prototypes = torch.zeros((2, exporter.v7.FEATURE_DIM))
        prototypes[0, query_offset + 0 * trainer.QUERY_DIM + 0] = 1.0
        prototypes[1, query_offset + 1 * trainer.QUERY_DIM + 1] = 1.0
        values = ranker(views, prototypes)
        outputs = dict(zip(exporter.v7.RANKER_OUTPUT_NAMES, values, strict=True))
        self.assertTrue(
            torch.equal(outputs["candidate_scores"], outputs["body_candidate_scores"])
        )
        self.assertFalse(
            torch.equal(
                outputs["body_candidate_scores"],
                outputs["variant_candidate_scores"],
            )
        )
        self.assertEqual(
            "dialogue",
            exporter.v7.trainer.ROLE_VALUES[
                int(outputs["role_logits"].argmax(dim=1).item())
            ],
        )
        self.assertGreater(float(outputs["role_logits"].std().detach()), 0.0)


if __name__ == "__main__":
    unittest.main()
