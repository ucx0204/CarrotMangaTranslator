from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from scripts import interpolate_manga_font_student_v8_role_family_adapters as interpolation


class MangaFontAdapterInterpolationTests(unittest.TestCase):
    def test_default_alpha_grid_is_exact_and_bounded(self) -> None:
        values = interpolation.parse_alpha_grid(interpolation.DEFAULT_ALPHA_GRID)
        self.assertEqual(11, len(values))
        self.assertEqual(0.0, values[0])
        self.assertEqual(0.5, values[-1])
        self.assertEqual(tuple(round(index * 0.05, 2) for index in range(11)), values)

    def test_alpha_grid_rejects_duplicates_order_and_nonfinite(self) -> None:
        for value in ("0,.1,.1", ".2,.1", "nan", "1.1", ""):
            with self.subTest(value=value):
                with self.assertRaises(interpolation.MangaFontAdapterInterpolationError):
                    interpolation.parse_alpha_grid(value)

    def test_interpolate_states_reproduces_endpoints_and_midpoint(self) -> None:
        base = {"weight": np.asarray([0.0, 2.0], dtype=np.float32)}
        target = {"weight": np.asarray([4.0, 6.0], dtype=np.float32)}
        np.testing.assert_array_equal(base["weight"], interpolation.interpolate_states(base, target, 0)["weight"])
        np.testing.assert_array_equal(target["weight"], interpolation.interpolate_states(base, target, 1)["weight"])
        np.testing.assert_array_equal(
            np.asarray([1.0, 3.0], dtype=np.float32),
            interpolation.interpolate_states(base, target, 0.25)["weight"],
        )

    def test_interpolate_states_fails_closed_on_contract_drift(self) -> None:
        good = {"weight": np.asarray([1.0], dtype=np.float32)}
        invalid = (
            ({"other": np.asarray([1.0], dtype=np.float32)}, "keys"),
            ({"weight": np.asarray([[1.0]], dtype=np.float32)}, "contract"),
            ({"weight": np.asarray([1.0], dtype=np.float64)}, "contract"),
            ({"weight": np.asarray([math.nan], dtype=np.float32)}, "non-finite"),
        )
        for target, message in invalid:
            with self.subTest(message=message):
                with self.assertRaisesRegex(
                    interpolation.MangaFontAdapterInterpolationError, message
                ):
                    interpolation.interpolate_states(good, target, 0.5)

    def test_selection_score_uses_only_four_declared_candidate_metrics(self) -> None:
        all_metrics = {
            "acceptable_at1": 0.8,
            "preferred_at1": 0.6,
            "family_accuracy": 0.0,
            "diagnostic": 999,
        }
        visual_metrics = {
            "acceptable_at1": 0.7,
            "preferred_at1": 0.5,
            "family_accuracy": 1.0,
            "diagnostic": -999,
        }
        self.assertAlmostEqual(
            0.65, interpolation.selection_score(all_metrics, visual_metrics)
        )

    def test_choose_alpha_excludes_failed_safety_and_has_stable_tie_break(self) -> None:
        rows = [
            {
                "alpha": 0.1,
                "selection_score": 0.8,
                "quality_gate_passed": False,
                "all_metrics": {"acceptable_at1": 0.9},
                "visual_metrics": {"acceptable_at1": 0.9},
            },
            {
                "alpha": 0.25,
                "selection_score": 0.7,
                "quality_gate_passed": True,
                "all_metrics": {"acceptable_at1": 0.8},
                "visual_metrics": {"acceptable_at1": 0.75},
            },
            {
                "alpha": 0.3,
                "selection_score": 0.7,
                "quality_gate_passed": True,
                "all_metrics": {"acceptable_at1": 0.8},
                "visual_metrics": {"acceptable_at1": 0.75},
            },
        ]
        self.assertEqual(0.25, interpolation.choose_alpha(rows)["alpha"])
        with self.assertRaisesRegex(
            interpolation.MangaFontAdapterInterpolationError, "no alpha"
        ):
            interpolation.choose_alpha(rows[:1])

    def test_published_validation_requires_diagnostics_to_be_nonselection(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "role-family-adapter.safetensors").write_bytes(b"checkpoint")
            (root / "manifest.json").write_bytes(b"manifest")
            state = {"weight": np.asarray([1.0], dtype=np.float32)}
            manifest = {
                "authority": {
                    "automatic_release_authority": False,
                    "exporter_candidate": True,
                },
                "dataset": {"sha256": "d" * 64},
                "interpolation_selection": {
                    "routing_authority": interpolation.SELECTION_ROUTING_AUTHORITY,
                    "selected_alpha": 0.25,
                    "selection_metric_name": interpolation.SELECTION_METRIC_NAME,
                },
                "post_selection_diagnostics": {
                    "adjudicated_val33": {"selection_used": False},
                    "new_high_value_181": {"selection_used": True},
                },
            }
            with (
                mock.patch.object(
                    interpolation.trainer,
                    "load_initial_adapter_state",
                    return_value=(state, manifest),
                ),
                mock.patch.object(interpolation, "_read_json", return_value=manifest),
                mock.patch.object(interpolation.trainer, "validate_record_seal"),
            ):
                with self.assertRaisesRegex(
                    interpolation.MangaFontAdapterInterpolationError,
                    "authority/selection",
                ):
                    interpolation._validate_published(  # noqa: SLF001
                        output_dir=root,
                        expected_state=state,
                        candidate_ids=("font",),
                        source_query_head=root / "head",
                        architecture={},
                        dataset_sha256="d" * 64,
                    )


if __name__ == "__main__":
    unittest.main()
