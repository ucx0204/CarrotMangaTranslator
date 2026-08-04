from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np


SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import build_font_matching_runtime_artifact as runtime  # noqa: E402
import export_font_matching_runtime_onnx as converter  # noqa: E402


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class ConversionFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.active_catalog = root / "inputs" / "auto-match-active-catalog.json"
        self.trainer_output = root / "trainer"
        self.feature_cache = root / "feature-cache"
        self.source_dir = root / ("7" * 40)
        self.output = root / "conversion"
        self.electron = root / "electron"
        for path in (
            self.active_catalog.parent,
            self.trainer_output,
            self.feature_cache,
            self.source_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        self.active_catalog.write_text("{}", encoding="utf-8")
        self.electron.write_bytes(b"electron")
        self.weights = self.source_dir / "model.safetensors"
        self.weights.write_bytes(b"encoder-source-weights")
        (self.source_dir / "preprocessor_config.json").write_text(
            "{}", encoding="utf-8"
        )
        (self.source_dir / "config.json").write_text(
            json.dumps(
                {
                    "model_type": "siglip",
                    "vision_config": {"hidden_size": 4},
                }
            ),
            encoding="utf-8",
        )
        self.candidate_ids = ("font-a", "font-b")
        self.prototype_features = np.arange(12, dtype=np.float32).reshape(3, 4)
        np.save(self.feature_cache / "prototype-features.npy", self.prototype_features)
        np.save(
            self.feature_cache / "sample-features.npy",
            np.ones((40, 3, 4), dtype=np.float32),
        )
        self.contract = {
            "architecture": {
                "candidate_scoring": runtime.EXPECTED_CANDIDATE_SCORING,
                "feature_dim": 4,
                "hidden_dim": 3,
                "view_dropout": 0.15,
            },
            "encoder": {
                "class": "SiglipVisionModel",
                "fully_frozen": True,
                "model_id": "google/siglip2-base-patch16-224",
                "revision": "7" * 40,
            },
            "hyperparameters": {"head_dropout": 0.1},
            "vocabulary": {
                "candidate_ids": list(self.candidate_ids),
                "roles": list(runtime.EXPECTED_ROLES),
                "style_fields": list(runtime.EXPECTED_STYLE_FIELDS),
                "treatments": {
                    key: list(values)
                    for key, values in runtime.EXPECTED_TREATMENTS.items()
                },
            },
        }
        self.training = {
            "candidate_ids": self.candidate_ids,
            "checkpoint_path": self.trainer_output / "checkpoint.safetensors",
            "checkpoint_sha256": "a" * 64,
            "contract": self.contract,
            "contract_path": self.trainer_output / "model-contract.json",
            "contract_sha256": "b" * 64,
        }
        self.training["checkpoint_path"].write_bytes(b"checkpoint")
        self.training["contract_path"].write_text("{}", encoding="utf-8")
        self.cache_manifest = {
            "artifacts": {
                "prototype-features.npy": {"file": "prototype-features.npy"},
            },
            "sample_index": [
                {
                    "row_index": index,
                    "sample_id": f"sample-{index}",
                    "split": "val" if index < 20 else "train",
                    "view_order": list(converter.trainer.VIEW_NAMES),
                }
                for index in range(40)
            ],
        }
        self.authority = converter.ConversionAuthority(
            active_catalog={"candidate_ids": self.candidate_ids},
            training=self.training,
            contract=self.contract,
            cache_manifest=self.cache_manifest,
            cache_manifest_sha256="c" * 64,
            sample_features=np.ones((40, 3, 4), dtype=np.float32),
            prototype_features=self.prototype_features,
            candidate_bags=(
                {"candidate_id": "font-a", "count": 2, "start": 0},
                {"candidate_id": "font-b", "count": 1, "start": 2},
            ),
            feature_cache_dir=self.feature_cache,
            encoder_source_dir=self.source_dir,
            encoder_source_weights=self.weights,
        )

    def ranker_outputs(self, rows: int = 32) -> dict[str, np.ndarray]:
        output: dict[str, np.ndarray] = {
            "candidate_scores": np.tile(
                np.array([[0.75, -0.25]], dtype=np.float32), (rows, 1)
            ),
            "none_logits": np.full((rows,), -0.5, dtype=np.float32),
            "role_logits": np.tile(
                np.arange(len(runtime.EXPECTED_ROLES), dtype=np.float32),
                (rows, 1),
            ),
            "style_logits": np.zeros(
                (rows, len(runtime.EXPECTED_STYLE_FIELDS)), dtype=np.float32
            ),
            "view_gate_weights": np.tile(
                np.array([[0.2, 0.3, 0.5]], dtype=np.float32), (rows, 1)
            ),
        }
        for field, values in sorted(runtime.EXPECTED_TREATMENTS.items()):
            output[f"treatment_{field}_logits"] = np.zeros(
                (rows, len(values)), dtype=np.float32
            )
        return output


class CandidateBagTests(unittest.TestCase):
    def test_builds_contiguous_bags_in_authoritative_order(self) -> None:
        rows = [
            {"font_id": "a", "row_index": 0},
            {"font_id": "a", "row_index": 1},
            {"font_id": "b", "row_index": 2},
        ]
        self.assertEqual(
            converter.candidate_bags_from_index(rows, ("a", "b")),
            (
                {"candidate_id": "a", "count": 2, "start": 0},
                {"candidate_id": "b", "count": 1, "start": 2},
            ),
        )

    def test_rejects_interleaved_or_missing_prototypes(self) -> None:
        with self.assertRaisesRegex(converter.ConversionError, "contiguous"):
            converter.candidate_bags_from_index(
                [
                    {"font_id": "a", "row_index": 0},
                    {"font_id": "b", "row_index": 1},
                    {"font_id": "a", "row_index": 2},
                ],
                ("a", "b"),
            )
        with self.assertRaisesRegex(converter.ConversionError, "no prototype"):
            converter.candidate_bags_from_index(
                [{"font_id": "a", "row_index": 0}], ("a", "b")
            )


class ParityTests(unittest.TestCase):
    def test_exact_outputs_pass_all_numeric_and_decision_gates(self) -> None:
        encoder = np.tile(np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32), (32, 1))
        ranker = {
            "candidate_scores": np.tile([[1.0, 0.0]], (32, 1)).astype(np.float32),
            "none_logits": np.full(32, -1.0, dtype=np.float32),
            "role_logits": np.tile([[0.0, 1.0]], (32, 1)).astype(np.float32),
        }
        metrics = converter._parity_metrics(
            reference_encoder=encoder,
            actual_encoder=encoder.copy(),
            reference_ranker=ranker,
            actual_ranker={key: value.copy() for key, value in ranker.items()},
            sample_count=32,
        )
        self.assertEqual(metrics["ranker"]["candidate_top1_agreement"], 1.0)
        self.assertEqual(metrics["encoder"]["minimum_cosine_similarity"], 1.0)

    def test_decision_drift_fails_closed_even_when_shapes_match(self) -> None:
        encoder = np.ones((32, 4), dtype=np.float32)
        reference = {
            "candidate_scores": np.tile([[1.0, 0.0]], (32, 1)).astype(np.float32),
            "none_logits": np.ones(32, dtype=np.float32),
            "role_logits": np.tile([[1.0, 0.0]], (32, 1)).astype(np.float32),
        }
        actual = {key: value.copy() for key, value in reference.items()}
        actual["candidate_scores"][:, 0] = 0.0
        actual["candidate_scores"][:, 1] = 1.0
        with self.assertRaisesRegex(converter.ConversionError, "numeric parity"):
            converter._parity_metrics(
                reference_encoder=encoder,
                actual_encoder=encoder.copy(),
                reference_ranker=reference,
                actual_ranker=actual,
                sample_count=32,
            )

    def test_ranker_suite_uses_validation_and_synthetic_without_test_rows(self) -> None:
        manifest = {
            "sample_index": [
                {"split": "val"},
                {"split": "test"},
                *({"split": "train"} for _ in range(38)),
            ]
        }
        authority = SimpleNamespace(
            cache_manifest=manifest,
            sample_features=np.ones((40, 3, 4), dtype=np.float32),
        )
        views, inventory = converter._ranker_parity_inputs(
            authority, sample_count=32, seed=7
        )
        self.assertEqual(views.shape, (32, 3, 4))
        self.assertEqual(inventory["ranker_validation_rows"], 1)
        self.assertEqual(inventory["ranker_synthetic_rows"], 31)


class SourceAuthorityTests(unittest.TestCase):
    def test_sparse_official_siglip_config_resolves_canonical_dimension(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            revision = "7" * 40
            source = Path(raw_root) / revision
            source.mkdir()
            (source / "model.safetensors").write_bytes(b"weights")
            (source / "preprocessor_config.json").write_text("{}", encoding="utf-8")
            sparse_config = {
                "model_type": "siglip",
                "vision_config": {"model_type": "siglip_vision_model"},
            }
            (source / "config.json").write_text(
                json.dumps(sparse_config), encoding="utf-8"
            )
            contract = {
                "architecture": {"feature_dim": 768},
                "encoder": {"revision": revision},
            }

            weights, loaded_config = converter._validate_encoder_source(
                source, contract=contract
            )

            self.assertEqual(weights, source / "model.safetensors")
            self.assertEqual(loaded_config, sparse_config)

    def test_sparse_siglip_resolved_dimension_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            revision = "7" * 40
            source = Path(raw_root) / revision
            source.mkdir()
            (source / "model.safetensors").write_bytes(b"weights")
            (source / "preprocessor_config.json").write_text("{}", encoding="utf-8")
            (source / "config.json").write_text(
                json.dumps(
                    {
                        "model_type": "siglip",
                        "vision_config": {"model_type": "siglip_vision_model"},
                    }
                ),
                encoding="utf-8",
            )
            contract = {
                "architecture": {"feature_dim": 4},
                "encoder": {"revision": revision},
            }

            with self.assertRaisesRegex(
                converter.ConversionError, "resolved encoder source feature dimension"
            ):
                converter._validate_encoder_source(source, contract=contract)

    def test_explicit_siglip_dimension_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            revision = "7" * 40
            source = Path(raw_root) / revision
            source.mkdir()
            (source / "model.safetensors").write_bytes(b"weights")
            (source / "preprocessor_config.json").write_text("{}", encoding="utf-8")
            (source / "config.json").write_text(
                json.dumps(
                    {
                        "model_type": "siglip",
                        "vision_config": {"hidden_size": 4},
                    }
                ),
                encoding="utf-8",
            )
            contract = {
                "architecture": {"feature_dim": 768},
                "encoder": {"revision": revision},
            }

            with self.assertRaisesRegex(
                converter.ConversionError, "explicit encoder source feature dimension"
            ):
                converter._validate_encoder_source(source, contract=contract)

    def test_encoder_source_must_be_the_sealed_revision_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            source = root / "wrong-revision"
            source.mkdir()
            (source / "model.safetensors").write_bytes(b"weights")
            (source / "preprocessor_config.json").write_text("{}", encoding="utf-8")
            (source / "config.json").write_text(
                json.dumps(
                    {
                        "model_type": "siglip",
                        "vision_config": {"hidden_size": 4},
                    }
                ),
                encoding="utf-8",
            )
            contract = {
                "architecture": {"feature_dim": 4},
                "encoder": {"revision": "7" * 40},
            }
            with self.assertRaisesRegex(
                converter.ConversionError, "immutable revision"
            ):
                converter._validate_encoder_source(source, contract=contract)

    def test_training_authority_rejection_is_not_bypassed(self) -> None:
        with (
            mock.patch.object(
                converter.runtime,
                "load_active_catalog",
                return_value={"candidate_ids": ("font-a",)},
            ),
            mock.patch.object(
                converter.runtime,
                "_load_training_bundle",
                side_effect=runtime.RuntimeArtifactError("provisional trainer"),
            ),
        ):
            with self.assertRaisesRegex(
                converter.ConversionError, "provisional trainer"
            ):
                converter.load_conversion_authority(
                    active_catalog_path=Path("active.json"),
                    trainer_output=Path("trainer"),
                    feature_cache=Path("cache"),
                    encoder_source_dir=Path("encoder"),
                )


class OwnedBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = ConversionFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _patches(self) -> list[mock._patch]:
        fixture = self.fixture
        encoder_reference = np.tile(
            np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32), (32, 1)
        )
        ranker_reference = fixture.ranker_outputs()
        expected_io = runtime._expected_onnx_io(
            contract=fixture.contract,
            prototype_count=3,
            candidate_count=2,
        )

        def fake_export(**kwargs: object) -> None:
            Path(kwargs["encoder_path"]).write_bytes(b"encoder-onnx")
            Path(kwargs["ranker_path"]).write_bytes(b"ranker-onnx")

        def fake_runtime_inspection(path: Path) -> dict[str, object]:
            return expected_io[Path(path).name]

        return [
            mock.patch.object(
                converter, "load_conversion_authority", return_value=fixture.authority
            ),
            mock.patch.object(
                converter, "_load_torch_models", return_value=(object(), object())
            ),
            mock.patch.object(
                converter, "_make_export_wrappers", return_value=(object(), object())
            ),
            mock.patch.object(
                converter, "_export_onnx_graphs", side_effect=fake_export
            ),
            mock.patch.object(
                converter,
                "_inspect_graph_file",
                return_value={"opset": converter.OPSET_VERSION},
            ),
            mock.patch.object(
                converter.runtime,
                "_inspect_onnx_contract",
                side_effect=fake_runtime_inspection,
            ),
            mock.patch.object(
                converter,
                "_synthetic_encoder_inputs",
                return_value=np.zeros((32, 4), dtype=np.float32),
            ),
            mock.patch.object(
                converter,
                "_ranker_parity_inputs",
                return_value=(
                    np.zeros((32, 3, 4), dtype=np.float32),
                    {"ranker_validation_rows": 16, "ranker_synthetic_rows": 16},
                ),
            ),
            mock.patch.object(
                converter,
                "_run_reference_models",
                return_value=(encoder_reference, ranker_reference),
            ),
            mock.patch.object(
                converter,
                "_run_cpu_ort",
                return_value=(
                    encoder_reference.copy(),
                    {key: value.copy() for key, value in ranker_reference.items()},
                    {
                        "package": "onnxruntime",
                        "version": "fixture",
                        "execution_provider": "CPUExecutionProvider",
                    },
                ),
            ),
            mock.patch.object(
                converter,
                "_run_electron_wasm",
                return_value=(
                    encoder_reference.copy(),
                    {key: value.copy() for key, value in ranker_reference.items()},
                    {
                        "all_outputs_finite": True,
                        "electron_version": converter._pinned_electron_version(),
                        "host": "electron-main",
                        "package": runtime.TARGET_ORT_PACKAGE,
                        "version": runtime.TARGET_ORT_VERSION,
                    },
                ),
            ),
        ]

    def _build(self, *, replace: bool = False) -> dict[str, object]:
        patches = self._patches()
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        return dict(
            converter.build_conversion_output(
                active_catalog_path=self.fixture.active_catalog,
                trainer_output=self.fixture.trainer_output,
                feature_cache=self.fixture.feature_cache,
                encoder_source_dir=self.fixture.source_dir,
                output_dir=self.fixture.output,
                electron_path=self.fixture.electron,
                replace_owned_output=replace,
            )
        )

    def test_build_emits_exact_owned_assets_consumable_by_runtime_builder(self) -> None:
        result = self._build()
        self.assertEqual(result["status"], "valid_runtime_conversion")
        self.assertEqual(
            {path.name for path in self.fixture.output.iterdir()},
            converter.OUTPUT_FILES,
        )
        report = json.loads(
            (self.fixture.output / converter.PARITY_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(report["target_runtime"]["parity"]["sample_count"], 32)
        self.assertEqual(
            report["evidence"]["sample_inventory"]["ranker_validation_rows"], 16
        )

    def test_existing_output_and_hash_tamper_fail_closed(self) -> None:
        self._build()
        with self.assertRaisesRegex(converter.ConversionError, "output exists"):
            converter.build_conversion_output(
                active_catalog_path=self.fixture.active_catalog,
                trainer_output=self.fixture.trainer_output,
                feature_cache=self.fixture.feature_cache,
                encoder_source_dir=self.fixture.source_dir,
                output_dir=self.fixture.output,
                electron_path=self.fixture.electron,
            )
        (self.fixture.output / converter.RANKER_FILE).write_bytes(b"tampered")
        with (
            mock.patch.object(
                converter,
                "load_conversion_authority",
                return_value=self.fixture.authority,
            ),
            mock.patch.object(converter, "_inspect_graph_file"),
        ):
            with self.assertRaisesRegex(converter.ConversionError, "hash mismatch"):
                converter.validate_conversion_output(
                    active_catalog_path=self.fixture.active_catalog,
                    trainer_output=self.fixture.trainer_output,
                    feature_cache=self.fixture.feature_cache,
                    encoder_source_dir=self.fixture.source_dir,
                    output_dir=self.fixture.output,
                )

    def test_post_publish_failure_restores_previous_owned_conversion(self) -> None:
        self._build()
        previous_ranker = (self.fixture.output / converter.RANKER_FILE).read_bytes()
        staging = self.fixture.root / "replacement-staging"
        shutil.copytree(self.fixture.output, staging)
        (staging / converter.RANKER_FILE).write_bytes(b"replacement")
        marker = json.loads((staging / converter.MARKER_FILE).read_text("utf-8"))
        marker["artifacts"][converter.RANKER_FILE] = converter.sha256_file(
            staging / converter.RANKER_FILE
        )
        (staging / converter.MARKER_FILE).write_bytes(
            converter.json_bytes(marker, pretty=True)
        )
        with self.assertRaisesRegex(converter.ConversionError, "post publish"):
            converter._commit_owned_directory(
                staging=staging,
                target=self.fixture.output,
                validate_published=lambda _: (_ for _ in ()).throw(
                    converter.ConversionError("post publish")
                ),
            )
        self.assertEqual(
            (self.fixture.output / converter.RANKER_FILE).read_bytes(),
            previous_ranker,
        )


@unittest.skipUnless(
    os.name == "nt"
    and importlib.util.find_spec("onnx") is not None
    and converter._default_electron_path().is_file(),
    "requires the Windows Electron/WASM conversion environment",
)
class ElectronWasmIntegrationTests(unittest.TestCase):
    def test_toy_dynamic_graphs_execute_in_the_pinned_electron_wasm(self) -> None:
        import torch

        class Encoder(torch.nn.Module):
            def forward(self, pixel_values: object) -> object:
                rgb = pixel_values.mean(dim=(2, 3))
                combined = torch.cat([rgb, rgb.mean(dim=1, keepdim=True)], dim=1)
                return torch.nn.functional.normalize(combined, p=2, dim=-1)

        class Ranker(torch.nn.Module):
            def forward(
                self, views: object, prototype_features: object
            ) -> tuple[object, ...]:
                batch = views.shape[0]
                base = views.mean(dim=(1, 2)) + prototype_features.mean() * 1e-4
                gate = torch.softmax(views.mean(dim=2), dim=1)

                def expand(width: int) -> object:
                    return base.unsqueeze(1).expand(batch, width)

                return (
                    expand(2),
                    base,
                    expand(14),
                    expand(10),
                    expand(8),
                    expand(6),
                    expand(4),
                    expand(5),
                    expand(5),
                    gate,
                )

        names = (
            "candidate_scores",
            "none_logits",
            "role_logits",
            "style_logits",
            "treatment_distortion_logits",
            "treatment_fill_logits",
            "treatment_orientation_logits",
            "treatment_outline_logits",
            "treatment_shadow_logits",
            "view_gate_weights",
        )
        rng = np.random.default_rng(19)
        pixels = rng.normal(size=(4, 3, 224, 224)).astype(np.float32)
        views = rng.normal(size=(4, 3, 4)).astype(np.float32)
        prototypes = rng.normal(size=(3, 4)).astype(np.float32)
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            encoder_path = root / converter.ENCODER_FILE
            ranker_path = root / converter.RANKER_FILE
            torch.onnx.export(
                Encoder(),
                (torch.zeros((1, 3, 224, 224), dtype=torch.float32),),
                str(encoder_path),
                input_names=["pixel_values"],
                output_names=["image_features"],
                dynamic_axes={
                    "pixel_values": {0: "batch"},
                    "image_features": {0: "batch"},
                },
                opset_version=converter.OPSET_VERSION,
                dynamo=False,
                external_data=False,
            )
            torch.onnx.export(
                Ranker(),
                (
                    torch.zeros((2, 3, 4), dtype=torch.float32),
                    torch.ones((3, 4), dtype=torch.float32),
                ),
                str(ranker_path),
                input_names=["views", "prototype_features"],
                output_names=list(names),
                dynamic_axes={
                    "views": {0: "batch"},
                    **{name: {0: "batch"} for name in names},
                },
                opset_version=converter.OPSET_VERSION,
                dynamo=False,
                external_data=False,
            )
            encoder_output, ranker_output, evidence = converter._run_electron_wasm(
                encoder_path=encoder_path,
                ranker_path=ranker_path,
                encoder_inputs=pixels,
                ranker_views=views,
                prototype_features=prototypes,
                encoder_batch_size=2,
                ranker_batch_size=2,
                output_names=names,
                electron_path=converter._default_electron_path(),
                timeout_seconds=60,
            )
        self.assertEqual(encoder_output.shape, (4, 4))
        self.assertEqual(ranker_output["candidate_scores"].shape, (4, 2))
        self.assertEqual(evidence["host"], "electron-main")
        self.assertEqual(evidence["version"], runtime.TARGET_ORT_VERSION)


if __name__ == "__main__":
    unittest.main()
