from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]


def load_script(name: str, file_name: str):
    specification = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / file_name
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


REVIEW = load_script(
    "build_manga_font_student_calibration_review_tested",
    "build_manga_font_student_calibration_review.py",
)
PROMOTE = load_script(
    "promote_manga_font_student_calibration_finals_tested",
    "promote_manga_font_student_calibration_finals.py",
)


def judgment(preferred_index: int = 0, unrenderable_index: int | None = None) -> dict:
    preferred = REVIEW.EXPECTED_CANDIDATE_IDS[preferred_index]
    acceptable = REVIEW.EXPECTED_CANDIDATE_IDS[(preferred_index + 1) % 22]
    unrenderable = (
        REVIEW.EXPECTED_CANDIDATE_IDS[unrenderable_index]
        if unrenderable_index is not None
        else None
    )
    marginal = [
        candidate_id
        for candidate_id in REVIEW.EXPECTED_CANDIDATE_IDS
        if candidate_id not in {preferred, acceptable, unrenderable}
    ]
    return {
        "preferred": [preferred],
        "acceptable": [acceptable],
        "marginal": marginal,
        "unacceptable": [],
        "unrenderable": [unrenderable] if unrenderable is not None else [],
        "not_reviewed": [],
        "none_acceptable": False,
    }


def reference_final(index: int, unrenderable_index: int | None = None) -> dict:
    sample_id = f"val-{index:03d}"
    return REVIEW.labels.seal_record(
        {
            "consistency": {
                "policy": "intentional_override",
                "reason_code": "emphasis",
            },
            "final_id": f"blind-final-{index:03d}",
            "font_judgment": judgment(index % 3, unrenderable_index),
            "record_type": REVIEW.labels.FINAL_RECORD_TYPE,
            "resolution": {
                "adjudication_evidence": None,
                "catalog_sha256": "a" * 64,
                "catalog_version": "student22-catalog-v1",
                "confidence": 0.95,
                "flags": [],
                "kind": "blind_agreement",
                "notes": "blind reference only",
                "renderer_hash": "b" * 64,
                "resolved_at": "2026-08-02T15:00:00Z",
                "resolver": "blind-ledger",
                "source_label_ids": [
                    f"blind-primary-{index:03d}",
                    f"blind-secondary-{index:03d}",
                ],
            },
            "role": {"confidence": 0.95, "primary": "dialogue"},
            "sample_id": sample_id,
            "schema_version": REVIEW.labels.SCHEMA_VERSION,
            "source_page_sha256": f"{index + 1:064x}",
            "source_style": {
                **{field: None for field in REVIEW.labels.STYLE_FIELDS},
                "unknown_fields": list(REVIEW.labels.STYLE_FIELDS),
            },
            "treatment": {
                "distortion": "none",
                "fill": "solid",
                "orientation": "horizontal",
                "outline": "none",
                "shadow": "none",
            },
            "work_id": f"work-{index % 3}",
        }
    )


def joined_rows(
    count: int, unrenderable_by_row: dict[int, int] | None = None
) -> list[dict]:
    rows = []
    for index in range(count):
        final = reference_final(index, (unrenderable_by_row or {}).get(index))
        rows.append(
            {
                "manifest": {
                    "geometry": {"bbox_px": [1, 2, 20, 30]},
                    "id": final["sample_id"],
                    "page": {
                        "id": f"page-{index}",
                        "source_page_sha256": final["source_page_sha256"],
                    },
                    "split": "val",
                    "views": {name: {"fixture": name} for name in REVIEW.VIEW_NAMES},
                    "work": {"id": final["work_id"], "title": f"Work {index % 3}"},
                },
                "reference": final,
            }
        )
    return rows


class FakeResolved:
    def __init__(self, color: tuple[int, int, int]) -> None:
        self.image = Image.new("RGB", (224, 224), color)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.image.close()


class FakeResolver:
    def __init__(self, _path: Path) -> None:
        pass

    def resolve_view_descriptor(self, _value, *, view_name: str, **_kwargs):
        colors = {
            "raw_224": (235, 235, 235),
            "context_224": (210, 225, 245),
            "glyph_224": (245, 220, 210),
        }
        return FakeResolved(colors[view_name])


def render_fixture(root: Path):
    canonical = {
        candidate_id: {"font_id": candidate_id, "font_label": f"Label {index:02d}"}
        for index, candidate_id in enumerate(REVIEW.EXPECTED_CANDIDATE_IDS)
    }
    renders = {}
    for index, candidate_id in enumerate(REVIEW.EXPECTED_CANDIDATE_IDS):
        relative = f"images/{candidate_id}.png"
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new(
            "RGB",
            (448, 224),
            ((index * 31) % 220 + 20, (index * 47) % 220 + 20, 245),
        ).save(path)
        renders[(candidate_id, "dialogue-body", "horizontal")] = {
            "artifact": {
                "file": relative,
                "height": 224,
                "sha256": REVIEW.sha256_file(path),
                "width": 448,
            },
            "blind_alias": f"alias-{index:02d}",
            "image_file": relative,
            "probe_id": "dialogue-body",
            "writing_mode": "horizontal",
        }
    return canonical, renders


class StudentCalibrationReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def build_bundle(self, count: int = 2, rows: list[dict] | None = None) -> Path:
        inputs = self.root / f"inputs-{count}"
        inputs.mkdir()
        finals = inputs / "references.jsonl"
        master = inputs / "manifest.jsonl"
        registry = inputs / "registry.json"
        render_manifest = inputs / "render-bank.json"
        for path in (finals, master, registry, render_manifest):
            path.write_text("{}\n", encoding="utf-8")
        canonical, renders = render_fixture(inputs)
        output = self.root / f"review-{count}"
        with (
            mock.patch.object(
                REVIEW, "load_render_bank", return_value=(canonical, renders)
            ),
            mock.patch.object(
                REVIEW,
                "load_val_reference_rows",
                return_value=(
                    rows if rows is not None else joined_rows(count),
                    {
                        "catalog_registry_record_sha256": "1" * 64,
                        "catalog_registry_sha256": "2" * 64,
                        "frozen_split_map_sha256": "3" * 64,
                        "master_manifest_sha256": "4" * 64,
                        "master_report_sha256": "5" * 64,
                        "master_split_map_sha256": "6" * 64,
                    },
                    {
                        "normalized_glyph_isolation": True,
                        "source_page_isolation": True,
                        "split_component_isolation": True,
                        "work_group_isolation": True,
                    },
                ),
            ),
            mock.patch.object(
                REVIEW.catalog_assets, "CatalogAssetResolver", FakeResolver
            ),
        ):
            REVIEW.build_review_bundle(
                finals_path=finals,
                master_manifest_path=master,
                catalog_registry_path=registry,
                render_bank_manifest_path=render_manifest,
                output_dir=output,
                project_root=self.root,
                expected_count=count,
                rows_per_sheet=count,
            )
        return output

    def test_apply_concise_judgments_builds_complete_partition_and_promotes(
        self,
    ) -> None:
        bundle = self.build_bundle(2, rows=joined_rows(2, unrenderable_by_row={0: 21}))
        candidates = REVIEW.EXPECTED_CANDIDATE_IDS
        judgments = {
            "val-000": {
                "preferred": [candidates[3]],
                "acceptable": [candidates[4]],
                "marginal": [candidates[5]],
                "confidence": 0.98,
                "notes": "visual row 1 checked",
            },
            "val-001": {
                "preferred": [candidates[6]],
                "acceptable": [],
                "marginal": [candidates[7], candidates[8]],
            },
        }
        concise = self.root / "judgments.json"
        concise.write_text(json.dumps(judgments), encoding="utf-8")
        decisions = self.root / "completed-decisions.jsonl"

        result = PROMOTE.complete_decisions(
            review_bundle_dir=bundle,
            judgments_path=concise,
            output_path=decisions,
            reviewer="human-font-reviewer",
            reviewed_at="2026-08-03T06:45:00Z",
            default_confidence=0.91,
        )

        self.assertEqual(result["record_count"], 2)
        completed, decision_sha = PROMOTE.load_completed_decisions(
            decisions, REVIEW.validate_review_bundle(bundle)["rows"]
        )
        self.assertEqual(result["decisions_sha256"], decision_sha)
        first = completed["val-000"]
        first_judgment = first["font_judgment"]
        self.assertEqual(first_judgment["preferred"], [candidates[3]])
        self.assertEqual(first_judgment["acceptable"], [candidates[4]])
        self.assertEqual(first_judgment["marginal"], [candidates[5]])
        self.assertEqual(first_judgment["unrenderable"], [candidates[21]])
        self.assertNotIn(candidates[21], first_judgment["unacceptable"])
        self.assertEqual(len(first_judgment["unacceptable"]), 18)
        self.assertEqual(first["decision_status"], "complete")
        self.assertTrue(first["review_sheet_acknowledged"])
        self.assertEqual(first["reviewed_at"], "2026-08-03T06:45:00Z")
        self.assertEqual(completed["val-001"]["confidence"], 0.91)

        promoted = self.root / "promoted-from-concise"
        promoted_result = PROMOTE.build_promoted_output(
            review_bundle_dir=bundle,
            decisions_path=decisions,
            output_dir=promoted,
        )
        self.assertEqual(promoted_result["record_count"], 2)

    def test_apply_concise_jsonl_and_none_acceptable(self) -> None:
        bundle = self.build_bundle(1)
        concise = self.root / "judgments.jsonl"
        concise.write_text(
            json.dumps(
                {
                    "sample_id": "val-000",
                    "preferred": [],
                    "acceptable": [],
                    "marginal": [REVIEW.EXPECTED_CANDIDATE_IDS[0]],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        decisions = self.root / "jsonl-decisions.jsonl"

        PROMOTE.complete_decisions(
            review_bundle_dir=bundle,
            judgments_path=concise,
            output_path=decisions,
            reviewer="reviewer-1",
        )

        completed = json.loads(decisions.read_text(encoding="utf-8"))
        self.assertTrue(completed["font_judgment"]["none_acceptable"])
        self.assertEqual(completed["font_judgment"]["not_reviewed"], [])

    def test_apply_concise_judgments_rejects_unsafe_or_incomplete_inputs(
        self,
    ) -> None:
        bundle = self.build_bundle(1, rows=joined_rows(1, unrenderable_by_row={0: 21}))
        candidates = REVIEW.EXPECTED_CANDIDATE_IDS
        output = self.root / "decisions.jsonl"

        missing = self.root / "missing.json"
        missing.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError, "cover every val sample"
        ):
            PROMOTE.complete_decisions(
                review_bundle_dir=bundle,
                judgments_path=missing,
                output_path=output,
                reviewer="reviewer-1",
            )

        selecting_unrenderable = self.root / "bad-unrenderable.json"
        selecting_unrenderable.write_text(
            json.dumps(
                {
                    "val-000": {
                        "preferred": [candidates[21]],
                        "acceptable": [],
                        "marginal": [],
                    }
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError,
            "original unrenderable candidates cannot be selected",
        ):
            PROMOTE.complete_decisions(
                review_bundle_dir=bundle,
                judgments_path=selecting_unrenderable,
                output_path=output,
                reviewer="reviewer-1",
            )

        extra_tier = self.root / "extra-tier.json"
        extra_tier.write_text(
            json.dumps(
                {
                    "val-000": {
                        "preferred": [candidates[0]],
                        "acceptable": [],
                        "marginal": [],
                        "unrenderable": [],
                    }
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError,
            "expected only preferred/acceptable/marginal",
        ):
            PROMOTE.complete_decisions(
                review_bundle_dir=bundle,
                judgments_path=extra_tier,
                output_path=output,
                reviewer="reviewer-1",
            )

        valid = self.root / "valid.json"
        valid.write_text(
            json.dumps(
                {
                    "val-000": {
                        "preferred": [candidates[0]],
                        "acceptable": [],
                        "marginal": [],
                    }
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError, "outside the immutable"
        ):
            PROMOTE.complete_decisions(
                review_bundle_dir=bundle,
                judgments_path=valid,
                output_path=bundle / "must-not-write.jsonl",
                reviewer="reviewer-1",
            )

    def test_apply_judgments_help_describes_safe_expansion(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            PROMOTE.build_parser().parse_args(["apply-judgments", "--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("original unrenderable", output.getvalue())
        self.assertIn("outside the review bundle", output.getvalue())

    def test_builds_named_22_font_val_review_sheet_and_pending_template(self) -> None:
        output = self.build_bundle(2)

        result = REVIEW.validate_review_bundle(output)
        self.assertEqual(result["record_count"], 2)
        self.assertEqual(result["candidate_count"], 22)
        sheet = output / REVIEW.SHEETS_DIR / "sheet-001.png"
        with Image.open(sheet) as image:
            self.assertEqual(image.width, 430 + 170 * 22)
            self.assertGreater(image.height, 600)
        decisions = [
            json.loads(line)
            for line in (output / REVIEW.DECISION_TEMPLATE_FILE)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertTrue(all(row["decision_status"] == "pending" for row in decisions))
        self.assertTrue(
            all(row["review_sheet_acknowledged"] is False for row in decisions)
        )
        report = json.loads((output / REVIEW.REPORT_FILE).read_text(encoding="utf-8"))
        self.assertEqual(report["boundary"]["split"], "val")
        self.assertEqual(report["boundary"]["test_pixels_opened"], 0)
        self.assertEqual(report["boundary"]["training_eligible_rows"], 0)

    def test_completed_named_decisions_become_primary_or_adjudicated_finals(
        self,
    ) -> None:
        bundle = self.build_bundle(2)
        templates = [
            json.loads(line)
            for line in (bundle / REVIEW.DECISION_TEMPLATE_FILE)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        for row in templates:
            row.update(
                {
                    "confidence": 0.97,
                    "decision_status": "complete",
                    "review_sheet_acknowledged": True,
                    "reviewed_at": "2026-08-02T19:30:00Z",
                    "reviewer": "human-font-reviewer",
                }
            )
        changed = templates[1]["font_judgment"]
        old_preferred = changed["preferred"][0]
        replacement = changed["marginal"].pop(0)
        changed["preferred"] = [replacement]
        changed["marginal"].append(old_preferred)
        decisions = self.root / "decisions.jsonl"
        decisions.write_text(
            "".join(REVIEW.canonical_json(row) + "\n" for row in templates),
            encoding="utf-8",
        )
        output = self.root / "promoted"

        result = PROMOTE.build_promoted_output(
            review_bundle_dir=bundle,
            decisions_path=decisions,
            output_dir=output,
        )

        self.assertEqual(result["resolution_counts"], {"adjudicated": 1, "primary": 1})
        finals = [
            json.loads(line)
            for line in (output / PROMOTE.FINALS_FILE)
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        primary = next(row for row in finals if row["resolution"]["kind"] == "primary")
        adjudicated = next(
            row for row in finals if row["resolution"]["kind"] == "adjudicated"
        )
        self.assertIsNone(primary["resolution"]["adjudication_evidence"])
        self.assertTrue(
            adjudicated["resolution"]["adjudication_evidence"]["font_names_visible"]
        )
        self.assertIn("disagreement_resolved", adjudicated["resolution"]["flags"])
        PROMOTE.validate_promoted_output(output)

    def test_promotion_rejects_pending_and_unknown_non_val_decisions(self) -> None:
        bundle = self.build_bundle(1)
        template = json.loads(
            (bundle / REVIEW.DECISION_TEMPLATE_FILE).read_text(encoding="utf-8")
        )
        pending = self.root / "pending.jsonl"
        pending.write_text(REVIEW.canonical_json(template) + "\n", encoding="utf-8")
        rows = REVIEW.validate_review_bundle(bundle)["rows"]
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError, "pending"
        ):
            PROMOTE.load_completed_decisions(pending, rows)

        unknown = self.root / "unknown.jsonl"
        unknown.write_text(
            '{"sample_id":"test-secret","payload": invalid-test-json}\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            PROMOTE.StudentCalibrationPromotionError, "non-val/unknown"
        ):
            PROMOTE.load_completed_decisions(unknown, rows)

    def test_reference_loader_never_json_parses_non_val_final_rows(self) -> None:
        final = reference_final(0)
        finals = self.root / "references.jsonl"
        finals.write_text(
            '{"sample_id":"test-secret","payload": invalid-test-json}\n'
            + REVIEW.canonical_json(final)
            + "\n",
            encoding="utf-8",
        )
        manifest = joined_rows(1)[0]["manifest"]
        with (
            mock.patch.object(
                REVIEW.calibration,
                "validate_master_inputs",
                return_value=(
                    self.root / "split.json",
                    {"master_manifest_sha256": "a" * 64},
                ),
            ),
            mock.patch.object(
                REVIEW.calibration,
                "load_val_manifest",
                return_value=(
                    {final["sample_id"]: manifest},
                    {
                        "normalized_glyph_isolation": True,
                        "source_page_isolation": True,
                        "split_component_isolation": True,
                        "work_group_isolation": True,
                    },
                ),
            ),
            mock.patch.object(REVIEW, "_read_json", return_value={}),
        ):
            with self.assertRaisesRegex(
                REVIEW.StudentCalibrationReviewError, "at least three works"
            ):
                rows, _, _ = REVIEW.load_val_reference_rows(
                    finals_path=finals,
                    master_manifest_path=self.root / "master.jsonl",
                    catalog_registry_path=self.root / "registry.json",
                    candidate_ids=REVIEW.EXPECTED_CANDIDATE_IDS,
                    expected_count=1,
                )
                self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
