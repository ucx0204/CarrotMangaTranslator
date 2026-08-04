from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "label_manga_font_student_v7_mass21_pass.py"


def load_script():
    specification = importlib.util.spec_from_file_location(
        "label_manga_font_student_v7_mass21_pass_tested", SCRIPT
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


LABELER = load_script()


def candidates() -> tuple[str, ...]:
    return LABELER.mass21.candidate_projection(
        LABELER.mass21.legacy15.FULL22_CANDIDATE_IDS
    ).active_ids


def master_row(sample_id: str, *, split: str, row_index: int):
    return LABELER.legacy_pass.MasterRow(
        row_index=row_index,
        row_sha256=f"{row_index + 1:064x}",
        sample_id=sample_id,
        split=split,
        work_id="work-1",
        work_title="작품 하나",
        chapter_id="chapter-1",
        chapter_title="1화",
        page_id=f"page-{sample_id}",
        page_name=f"{sample_id}.png",
        source_category="page_sound" if row_index else "ordinary",
        source_kind="hard",
        resolver_sample={"sample_id": sample_id, "source": {"views": {}}},
    )


def model_outputs() -> tuple[np.ndarray, np.ndarray]:
    scores = np.linspace(-1.0, 1.0, len(candidates()), dtype=np.float32)
    view_scores = np.stack(
        (
            scores,
            scores[::-1],
            scores + np.linspace(0.0, 0.2, len(scores), dtype=np.float32),
        )
    )
    return scores, view_scores


def raw_visual_features() -> dict[str, object]:
    core = {
        "base_model_id": LABELER.base.MODEL_ID,
        "base_model_revision": LABELER.base.MODEL_REVISION,
        "kind": "live_pinned_siglip2_raw_pixels",
        "processor_use_fast": LABELER.base.PROCESSOR_USE_FAST,
        "view_order": list(LABELER.VIEW_NAMES),
    }
    return {
        **core,
        "contract_sha256": LABELER.sha256_bytes(
            LABELER.canonical_json(core).encode("utf-8")
        ),
    }


class CacheFakeImage:
    def __init__(self, value: int) -> None:
        self.value = value

    def close(self) -> None:
        return None


class CacheFakeEncoder:
    def encode(self, images: tuple[CacheFakeImage, ...]) -> np.ndarray:
        result = np.empty(
            (
                len(images),
                LABELER.hidden_cache.PATCH_COUNT,
                LABELER.hidden_cache.HIDDEN_SIZE,
            ),
            dtype="<f2",
        )
        for index, image in enumerate(images):
            result[index].fill(float(image.value + 1))
        return result

    def close(self) -> None:
        return None


def build_mock_hidden_cache(
    root: Path, rows: list[object]
) -> tuple[Path, object, dict[str, object]]:
    cache = LABELER.hidden_cache
    bindings = tuple(
        cache.MasterRowBinding(
            cache_index=index,
            master_row_index=row.row_index,
            line_number=index + 1,
            byte_offset=index * 100,
            byte_length=100,
            sample_id=row.sample_id,
            split=row.split,
            work_id=row.work_id,
            source_catalog_id="catalog-a",
            master_line_sha256=f"{index + 1:064x}",
            view_contract_sha256=f"{index + 101:064x}",
        )
        for index, row in enumerate(rows)
    )
    payload = cache._index_payload(bindings)
    counts = {
        name: sum(row.split == name for row in rows)
        for name in ("train", "val", "test")
    }
    plan = cache.MasterCachePlan(
        master_dir=root / "master",
        manifest_path=root / "master" / "manifest.jsonl",
        catalog_registry=root / "registry.json",
        source_bindings={
            "catalog_registry_record_sha256": "a" * 64,
            "catalog_registry_sha256": "b" * 64,
            "master_manifest_sha256": "c" * 64,
            "master_report_sha256": "d" * 64,
            "master_split_map_sha256": "e" * 64,
        },
        rows=bindings,
        master_total_rows=len(bindings),
        master_split_counts=counts,
        selected_split_counts=counts,
        max_samples=None,
        sample_index_payload=payload,
        sample_index_sha256=cache._sha256_bytes(payload),
        sample_order_sha256=cache._sha256_bytes(
            "\n".join(row.sample_id for row in bindings).encode("utf-8")
        ),
    )
    output = root / "hidden-cache"
    cache.build_cache(
        plan=plan,
        output_dir=output,
        shard_size=1,
        image_batch_size=3,
        device="cuda",
        resume=False,
        encoder_factory=CacheFakeEncoder,
        image_loader=lambda binding, _handle: tuple(
            CacheFakeImage(binding.cache_index * 3 + view)
            for view in range(cache.VIEW_COUNT)
        ),
    )
    validation = dict(cache.validate_cache_against_plan(output, plan=plan))
    return output, plan, validation


class MangaFontV7Mass21PassTests(unittest.TestCase):
    def test_completed_v7_r2_uses_r2_validator_and_active21_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in (LABELER.v7.MANIFEST, LABELER.v7.BEST_HEAD, LABELER.v7.PROTOTYPES):
                (root / name).write_bytes(b"fixture")
            prototype = np.zeros((len(candidates()), 4, 256), dtype=np.float32)
            with (
                mock.patch.object(LABELER.v7r2, "validate_output") as validate_r2,
                mock.patch.object(
                    LABELER.base,
                    "read_json",
                    return_value={"candidate_ids": list(candidates())},
                ),
                mock.patch.object(
                    LABELER, "_load_safetensors", return_value={"head": "fixture"}
                ),
                mock.patch.object(LABELER, "_read_prototypes", return_value=prototype),
            ):
                artifacts = LABELER.load_model_artifacts(root, source_kind="v7-r2")

        validate_r2.assert_called_once_with(root.resolve())
        self.assertEqual("v7-r2", artifacts.source_kind)
        self.assertEqual("v7_r2_completed", artifacts.bindings["source_kind"])
        self.assertEqual(candidates(), artifacts.candidate_ids)
        self.assertTrue(artifacts.promotion_source_allowed)

    def test_completed_v7_r3_uses_stable_validator_and_exact_seals(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            head_path = root / LABELER.v7.BEST_HEAD
            prototype_path = root / LABELER.v7.PROTOTYPES
            head_path.write_bytes(b"sealed-r3-head")
            prototype_path.write_bytes(b"sealed-r3-prototypes")
            source_fingerprint = {
                "r3_checkpoint_sha256": "a" * 64,
                "r3_report_sha256": "b" * 64,
            }
            manifest = LABELER.seal_record(
                {
                    "candidate_ids": list(candidates()),
                    "distillation": {
                        "teacher_checkpoint_sha256": source_fingerprint[
                            "r3_checkpoint_sha256"
                        ]
                    },
                    "files": {
                        LABELER.v7.BEST_HEAD: {
                            "byte_size": head_path.stat().st_size,
                            "file": LABELER.v7.BEST_HEAD,
                            "sha256": LABELER.sha256_file(head_path),
                        },
                        LABELER.v7.PROTOTYPES: {
                            "byte_size": prototype_path.stat().st_size,
                            "file": LABELER.v7.PROTOTYPES,
                            "sha256": LABELER.sha256_file(prototype_path),
                        },
                    },
                    "record_type": "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest",
                    "schema_version": LABELER.v7r3.SCHEMA,
                    "source_fingerprint": source_fingerprint,
                }
            )
            (root / LABELER.v7.MANIFEST).write_bytes(
                LABELER.base.json_bytes(manifest, pretty=True)
            )
            prototype = np.zeros((len(candidates()), 4, 256), dtype=np.float32)
            with (
                mock.patch.object(
                    LABELER.v7r3,
                    "validate_output",
                    return_value={
                        "status": "validated_v7_mass21_r3_teacher_stable_output"
                    },
                ) as validate_r3,
                mock.patch.object(
                    LABELER, "_load_safetensors", return_value={"head": "r3"}
                ),
                mock.patch.object(LABELER, "_read_prototypes", return_value=prototype),
            ):
                artifacts = LABELER.load_model_artifacts(root, source_kind="v7-r3")

            validate_r3.assert_called_once_with(root.resolve())
            self.assertEqual("v7-r3", artifacts.source_kind)
            self.assertEqual(
                LABELER.V7_R3_MODEL_SOURCE, artifacts.bindings["source_kind"]
            )
            self.assertEqual(candidates(), artifacts.candidate_ids)
            self.assertEqual(
                LABELER.sha256_file(head_path), artifacts.bindings["best_head_sha256"]
            )
            self.assertEqual(
                manifest["record_sha256"],
                artifacts.bindings["manifest_record_sha256"],
            )
            self.assertEqual(
                source_fingerprint, artifacts.bindings["source_fingerprint"]
            )
            LABELER._validate_v7_r3_model_bindings(
                artifacts.bindings, location="test R3 bindings"
            )
            self.assertTrue(artifacts.promotion_source_allowed)
            parsed = LABELER.build_parser().parse_args(
                [
                    "label",
                    "--model-source",
                    "v7-r3",
                    "--output-dir",
                    str(root / "labels"),
                ]
            )
            self.assertEqual("v7-r3", parsed.model_source)

    def test_completed_v7_r3_rejects_teacher_fingerprint_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in (LABELER.v7.BEST_HEAD, LABELER.v7.PROTOTYPES):
                (root / name).write_bytes(name.encode("utf-8"))
            manifest = LABELER.seal_record(
                {
                    "candidate_ids": list(candidates()),
                    "distillation": {"teacher_checkpoint_sha256": "c" * 64},
                    "files": {
                        name: {
                            "byte_size": (root / name).stat().st_size,
                            "file": name,
                            "sha256": LABELER.sha256_file(root / name),
                        }
                        for name in (LABELER.v7.BEST_HEAD, LABELER.v7.PROTOTYPES)
                    },
                    "record_type": "manga_font_student_v7_mass21_r3_teacher_stable_training_manifest",
                    "schema_version": LABELER.v7r3.SCHEMA,
                    "source_fingerprint": {
                        "r3_checkpoint_sha256": "a" * 64,
                        "r3_report_sha256": "b" * 64,
                    },
                }
            )
            (root / LABELER.v7.MANIFEST).write_bytes(
                LABELER.base.json_bytes(manifest, pretty=True)
            )
            with (
                mock.patch.object(
                    LABELER.v7r3,
                    "validate_output",
                    return_value={
                        "status": "validated_v7_mass21_r3_teacher_stable_output"
                    },
                ),
                self.assertRaisesRegex(
                    LABELER.MangaFontV7PassError, "teacher source binding"
                ),
            ):
                LABELER.load_model_artifacts(root, source_kind="v7-r3")

    def test_r3_fixture_projection_path_remains_available(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in (
                LABELER.r3.REPORT,
                LABELER.r3.CHECKPOINT,
                LABELER.r3.PROTOTYPES,
            ):
                (root / name).write_bytes(b"fixture")
            source_ids = tuple(LABELER.mass21.legacy15.FULL22_CANDIDATE_IDS)
            source_prototypes = np.arange(
                len(source_ids) * LABELER.v7.QUERY_COUNT * LABELER.v7.QUERY_DIM,
                dtype=np.float32,
            ).reshape(
                len(source_ids), LABELER.v7.QUERY_COUNT, LABELER.v7.QUERY_DIM
            )
            with (
                mock.patch.object(LABELER.r3, "validate_output") as validate_fixture,
                mock.patch.object(
                    LABELER.base,
                    "read_json",
                    return_value={"candidate_ids": list(source_ids)},
                ),
                mock.patch.object(
                    LABELER,
                    "_read_prototypes",
                    return_value=source_prototypes,
                ),
                mock.patch.object(
                    LABELER, "_load_safetensors", return_value={"head": "fixture"}
                ),
            ):
                artifacts = LABELER.load_model_artifacts(
                    root, source_kind="r3-fixture"
                )

            validate_fixture.assert_called_once_with(root.resolve())
            self.assertEqual(candidates(), artifacts.candidate_ids)
            self.assertNotIn(
                LABELER.mass21.RETIRED_FONT_ID, artifacts.candidate_ids
            )
            self.assertEqual(
                (len(candidates()), LABELER.v7.QUERY_COUNT, LABELER.v7.QUERY_DIM),
                artifacts.prototypes.shape,
            )
            self.assertFalse(artifacts.promotion_source_allowed)

    def test_probability_evidence_is_absolute_and_bounded(self) -> None:
        uniform = np.full(
            len(candidates()), 1.0 / len(candidates()), dtype=np.float32
        )
        view_uniform = np.stack((uniform, uniform, uniform))
        peaked = np.zeros(len(candidates()), dtype=np.float32)
        peaked[3] = 1.0
        view_peaked = np.stack((peaked, peaked, peaked))

        uniform_result = LABELER.probability_evidence(uniform, view_uniform)
        peaked_result = LABELER.probability_evidence(peaked, view_peaked)

        self.assertAlmostEqual(1.0, uniform_result["entropy"], places=5)
        self.assertAlmostEqual(0.0, peaked_result["entropy"], places=5)
        self.assertGreater(peaked_result["confidence"], uniform_result["confidence"])
        for result in (uniform_result, peaked_result):
            self.assertGreaterEqual(result["confidence"], 0.0)
            self.assertLessEqual(result["confidence"], 1.0)
            self.assertGreaterEqual(result["weight"], 0.0)
            self.assertLessEqual(result["weight"], 1.0)

    def test_dense_previous_ensemble_preserves_probability_simplex(self) -> None:
        current = np.zeros(len(candidates()), dtype=np.float32)
        current[0] = 1.0
        previous = np.zeros(len(candidates()), dtype=np.float32)
        previous[1] = 1.0

        combined = LABELER.ensemble_probabilities(
            current, previous, previous_weight=0.25
        )

        self.assertAlmostEqual(0.75, float(combined[0]), places=6)
        self.assertAlmostEqual(0.25, float(combined[1]), places=6)
        self.assertAlmostEqual(1.0, float(combined.sum()), places=6)

    def test_train_record_is_mass21_compatible_and_nonvisual_free(self) -> None:
        scores, view_scores = model_outputs()
        review, pseudo = LABELER.build_records(
            master_row("sample-train", split="train", row_index=0),
            candidate_ids=candidates(),
            scores=scores,
            view_scores=view_scores,
            temperature=1.0,
            previous=None,
            previous_weight=0.35,
            round_number=2,
            teacher_bindings={"checkpoint_sha256": "a" * 64},
            model_source_kind="r3-fixture",
        )

        self.assertIsNotNone(pseudo)
        assert pseudo is not None
        self.assertEqual(LABELER.mass21.PSEUDO_SCHEMA, pseudo["schema_version"])
        self.assertEqual(list(candidates()), pseudo["candidate_ids"])
        self.assertNotIn(LABELER.mass21.RETIRED_FONT_ID, pseudo["candidate_ids"])
        self.assertAlmostEqual(1.0, sum(pseudo["probabilities"]), places=5)
        self.assertFalse(pseudo["training_eligible"])
        self.assertFalse(review["promotion_allowed"])
        self.assertEqual(0.0, review["gugi_probability"])
        self.assertTrue(
            all(value == 0.0 for value in review["family_logit_influence"].values())
        )
        LABELER.validate_record_seal(review, location="test review")
        LABELER.validate_record_seal(pseudo, location="test pseudo")

    def test_test_record_never_emits_training_target(self) -> None:
        scores, view_scores = model_outputs()
        review, pseudo = LABELER.build_records(
            master_row("sample-test", split="test", row_index=1),
            candidate_ids=candidates(),
            scores=scores,
            view_scores=view_scores,
            temperature=1.0,
            previous=None,
            previous_weight=0.35,
            round_number=2,
            teacher_bindings={"checkpoint_sha256": "a" * 64},
            model_source_kind="v7",
        )

        self.assertIsNone(pseudo)
        self.assertFalse(review["training_eligible"])
        self.assertFalse(review["promotion_allowed"])

    def test_shard_restart_and_merged_validator(self) -> None:
        rows = [
            master_row("sample-train", split="train", row_index=0),
            master_row("sample-test", split="test", row_index=1),
        ]
        scores, view_scores = model_outputs()
        reviews = []
        pseudos = []
        visual_features = raw_visual_features()
        artifacts = LABELER.ModelArtifacts(
            source_kind="r3-fixture",
            source_dir=Path("model"),
            candidate_ids=candidates(),
            checkpoint_state={},
            prototypes=np.zeros((len(candidates()), 4, 256), dtype=np.float32),
            bindings={"checkpoint_sha256": "a" * 64},
            promotion_source_allowed=False,
        )
        teacher_bindings = LABELER._teacher_bindings(
            artifacts=artifacts,
            master_manifest_sha256="b" * 64,
            previous_pseudo_sha256=None,
            round_number=2,
            visual_features=visual_features,
        )
        for row in rows:
            review, pseudo = LABELER.build_records(
                row,
                candidate_ids=candidates(),
                scores=scores,
                view_scores=view_scores,
                temperature=1.0,
                previous=None,
                previous_weight=0.35,
                round_number=2,
                teacher_bindings=teacher_bindings,
                model_source_kind="r3-fixture",
            )
            reviews.append(review)
            if pseudo is not None:
                pseudos.append(pseudo)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sealed-pass-output"
            marker_core = {
                "master_manifest_sha256": "b" * 64,
                "model_bindings": dict(artifacts.bindings),
                "owner": LABELER.OWNER,
                "previous_pseudo_sha256": None,
                "promotion_source_allowed": False,
                "round": 2,
                "safe_replace": True,
                "schema_version": LABELER.SCHEMA,
                "source_code_sha256": LABELER.sha256_file(SCRIPT),
                "visual_features": visual_features,
            }
            root = LABELER._ensure_output(output, marker_core)
            marker = LABELER.base.read_json(root / LABELER.MARKER, location="marker")
            paths = LABELER._shard_paths(root, 0)
            core = LABELER._shard_core(
                0, rows, marker_sha256=marker["record_sha256"]
            )
            LABELER._write_shard(
                paths, core=core, reviews=reviews, pseudos=pseudos
            )
            self.assertTrue(LABELER._valid_shard(paths, core=core, rows=rows))
            previous = LABELER.PreviousTargets(None, None, {})
            LABELER._merge_and_report(
                root=root,
                rows=rows,
                shard_paths=[paths],
                marker=marker,
                artifacts=artifacts,
                previous=previous,
                elapsed_seconds=0.1,
            )

            result = LABELER.validate_output(root)

            self.assertEqual(2, result["review_rows"])
            self.assertEqual(1, result["pseudo_train_rows"])
            paths[0].write_text("corrupt\n", encoding="utf-8")
            self.assertFalse(LABELER._valid_shard(paths, core=core, rows=rows))

    def test_cached_tokens_match_raw_head_path_without_encoder_or_processor(self) -> None:
        import torch

        generator = np.random.default_rng(7)
        hidden = generator.normal(
            size=(2, len(LABELER.VIEW_NAMES), LABELER.v7.PATCH_COUNT, LABELER.v7.HIDDEN_SIZE)
        ).astype("<f2")

        class FakeHead:
            def __init__(self) -> None:
                self.query_weight_logits = torch.zeros(LABELER.v7.QUERY_COUNT)
                self.logit_scale = torch.tensor(0.0)

            def encode(self, tokens):
                base_values = tokens.float().mean(dim=1)[:, : LABELER.v7.QUERY_DIM]
                queries = torch.stack(
                    [base_values + query * 0.01 for query in range(LABELER.v7.QUERY_COUNT)],
                    dim=1,
                )
                queries = torch.nn.functional.normalize(queries, p=2, dim=-1)
                return queries, torch.zeros(1)

        prototype_values = generator.normal(
            size=(len(candidates()), LABELER.v7.QUERY_COUNT, LABELER.v7.QUERY_DIM)
        ).astype(np.float32)
        prototypes = torch.nn.functional.normalize(
            torch.from_numpy(prototype_values), p=2, dim=-1
        )

        class FakeProcessor:
            def __call__(self, **kwargs):
                return {"pixel_values": torch.zeros((len(kwargs["images"]), 1))}

        class FakeVision:
            def __call__(self, *, pixel_values):
                del pixel_values
                return types.SimpleNamespace(
                    last_hidden_state=torch.from_numpy(
                        hidden.reshape(-1, LABELER.v7.PATCH_COUNT, LABELER.v7.HIDDEN_SIZE)
                    )
                )

        raw_runtime = LABELER.Runtime(
            torch=torch,
            processor=FakeProcessor(),
            encoder=FakeVision(),
            head=FakeHead(),
            prototypes=prototypes,
            candidate_ids=candidates(),
            device=torch.device("cpu"),
            amp_dtype=None,
        )
        cached_runtime = LABELER.Runtime(
            torch=torch,
            processor=None,
            encoder=None,
            head=FakeHead(),
            prototypes=prototypes,
            candidate_ids=candidates(),
            device=torch.device("cpu"),
            amp_dtype=None,
        )
        raw = LABELER.infer_images(raw_runtime, [object()] * 6)
        cached = LABELER.infer_hidden_states(cached_runtime, hidden)
        np.testing.assert_array_equal(raw["scores"], cached["scores"])
        np.testing.assert_array_equal(raw["view_scores"], cached["view_scores"])
        with self.assertRaisesRegex(LABELER.MangaFontV7PassError, "pooled"):
            LABELER.infer_hidden_states(
                cached_runtime,
                np.zeros((2, len(LABELER.VIEW_NAMES), LABELER.v7.HIDDEN_SIZE), dtype="<f2"),
            )

    def test_bounded_sealed_cache_reader_binds_prefix_order_and_reads_patch_tokens(self) -> None:
        rows = [
            master_row("sample-train", split="train", row_index=0),
            master_row("sample-test", split="test", row_index=1),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, _plan, validation = build_mock_hidden_cache(root, rows)
            with mock.patch.object(
                LABELER.hidden_cache, "validate_cache", return_value=validation
            ):
                reader = LABELER.load_hidden_cache_reader(
                    output,
                    master_dir=root / "master",
                    catalog_registry=root / "registry.json",
                    rows=rows,
                    master_manifest_sha256="c" * 64,
                )
            values = reader.read_rows(rows)
            self.assertEqual(values.shape, (2, 3, 196, 768))
            self.assertEqual(values.dtype, np.dtype("<f2"))
            self.assertEqual(float(values[0, 0, 0, 0]), 1.0)
            self.assertEqual(float(values[1, 2, 0, 0]), 6.0)

            with (
                mock.patch.object(
                    LABELER.hidden_cache, "validate_cache", return_value=validation
                ),
                self.assertRaisesRegex(
                    LABELER.MangaFontV7PassError, "identity/order"
                ),
            ):
                LABELER.load_hidden_cache_reader(
                    output,
                    master_dir=root / "master",
                    catalog_registry=root / "registry.json",
                    rows=list(reversed(rows)),
                    master_manifest_sha256="c" * 64,
                )

    def test_cached_runtime_does_not_load_siglip_encoder_or_processor(self) -> None:
        import torch

        class MinimalHead(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.query_weight_logits = torch.nn.Parameter(
                    torch.zeros(LABELER.v7.QUERY_COUNT)
                )
                self.logit_scale = torch.nn.Parameter(torch.tensor(0.0))

        source_head = MinimalHead()
        artifacts = LABELER.ModelArtifacts(
            source_kind="v7-r2",
            source_dir=Path("model"),
            candidate_ids=candidates(),
            checkpoint_state=source_head.state_dict(),
            prototypes=np.ones(
                (len(candidates()), LABELER.v7.QUERY_COUNT, LABELER.v7.QUERY_DIM),
                dtype=np.float32,
            ),
            bindings={"checkpoint_sha256": "a" * 64},
            promotion_source_allowed=True,
        )
        with (
            mock.patch.object(
                LABELER.base,
                "_load_training_dependencies",
                side_effect=AssertionError("visual dependency path was called"),
            ) as visual_loader,
            mock.patch.object(
                LABELER.v6, "build_font_query_head", return_value=MinimalHead()
            ),
        ):
            runtime = LABELER.build_runtime(
                artifacts,
                device_name="cpu",
                amp_name="none",
                load_visual_encoder=False,
            )
        visual_loader.assert_not_called()
        self.assertIsNone(runtime.processor)
        self.assertIsNone(runtime.encoder)

    def test_bounded_label_command_uses_cache_without_resolver_or_visual_encoder(self) -> None:
        rows = [
            master_row("sample-train", split="train", row_index=0),
            master_row("sample-test", split="test", row_index=1),
        ]
        binding = LABELER.HiddenCacheBinding(
            root=Path("hidden-cache"),
            build_contract_sha256="1" * 64,
            cache_identity_sha256="2" * 64,
            manifest_sha256="3" * 64,
            master_manifest_sha256="c" * 64,
            model_contract_sha256="4" * 64,
            row_count=2,
            sample_index_sha256="5" * 64,
            sample_order_sha256="6" * 64,
            selected_prefix_order_sha256="7" * 64,
            view_contract_sha256="8" * 64,
        )

        class FakeReader:
            def __init__(self) -> None:
                self.binding = binding

            def read_rows(self, selected):
                return np.zeros(
                    (len(selected), 3, LABELER.v7.PATCH_COUNT, LABELER.v7.HIDDEN_SIZE),
                    dtype="<f2",
                )

        source_fingerprint = {"r3_checkpoint_sha256": "1" * 64}
        r3_bindings = LABELER._sealed_model_bindings(
            {
                "best_head_sha256": "a" * 64,
                "checkpoint_sha256": "a" * 64,
                "manifest_record_sha256": "b" * 64,
                "manifest_sha256": "c" * 64,
                "prototypes_sha256": "d" * 64,
                "source_fingerprint": source_fingerprint,
                "source_fingerprint_sha256": LABELER.sha256_bytes(
                    LABELER.canonical_json(source_fingerprint).encode("utf-8")
                ),
                "source_kind": LABELER.V7_R3_MODEL_SOURCE,
                "teacher_checkpoint_sha256": "1" * 64,
                "training_schema_version": LABELER.v7r3.SCHEMA,
            }
        )
        artifacts = LABELER.ModelArtifacts(
            source_kind="v7-r3",
            source_dir=Path("model"),
            candidate_ids=candidates(),
            checkpoint_state={},
            prototypes=np.zeros((len(candidates()), 4, 256), dtype=np.float32),
            bindings=r3_bindings,
            promotion_source_allowed=True,
        )
        score_row, view_score_row = model_outputs()
        runtime = types.SimpleNamespace(candidate_ids=candidates())
        with tempfile.TemporaryDirectory() as temporary:
            args = Namespace(
                amp_dtype="bf16",
                batch_size=2,
                catalog_registry=Path("registry.json"),
                device="cuda",
                hidden_cache_dir=Path("hidden-cache"),
                master_dir=Path("master"),
                max_samples=2,
                model_dir=Path("model"),
                model_source="v7-r3",
                output_dir=Path(temporary) / "output",
                previous_pseudo=None,
                previous_weight=0.35,
                round=2,
                shard_size=2,
                temperature=1.0,
            )
            with (
                mock.patch.object(
                    LABELER, "load_model_artifacts", return_value=artifacts
                ),
                mock.patch.object(
                    LABELER, "_validate_master_contract", return_value="c" * 64
                ),
                mock.patch.object(
                    LABELER.legacy_pass,
                    "load_master_rows",
                    return_value=(rows, "c" * 64),
                ),
                mock.patch.object(LABELER.mass21, "MASTER_TOTAL_ROWS", 2),
                mock.patch.object(
                    LABELER, "load_hidden_cache_reader", return_value=FakeReader()
                ),
                mock.patch.object(
                    LABELER, "build_runtime", return_value=runtime
                ) as runtime_builder,
                mock.patch.object(
                    LABELER.catalog_assets,
                    "CatalogAssetResolver",
                    side_effect=AssertionError("raw resolver must not be created"),
                ) as resolver,
                mock.patch.object(
                    LABELER,
                    "infer_hidden_states",
                    return_value={
                        "scores": np.stack((score_row, score_row)),
                        "view_scores": np.stack((view_score_row, view_score_row)),
                    },
                ),
            ):
                result = LABELER.label(args)
        resolver.assert_not_called()
        runtime_builder.assert_called_once_with(
            artifacts,
            device_name="cuda",
            amp_name="bf16",
            load_visual_encoder=False,
        )
        self.assertEqual(result["review_rows"], 2)
        self.assertEqual(result["pseudo_train_rows"], 1)
        self.assertEqual(
            result["visual_feature_kind"],
            "sealed_siglip2_last_hidden_state_patch_tokens",
        )


if __name__ == "__main__":
    unittest.main()
