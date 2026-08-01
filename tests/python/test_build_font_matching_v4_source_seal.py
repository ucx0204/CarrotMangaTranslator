from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_v4_source_seal.py"
SPEC = importlib.util.spec_from_file_location("font_matching_v4_source_seal", SCRIPT)
assert SPEC and SPEC.loader
SEAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SEAL
SPEC.loader.exec_module(SEAL)


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir()
        self.master_path = root / "master.jsonl"
        self.inventory_path = root / "inventory.jsonl"
        self.rubric_path = root / "rubric.md"
        self.output = root / "output"
        self.sample_id = "fm_sample_001"
        self.work_id = "work-001"
        self.page_sha = "1" * 64
        self.master = {
            "id": self.sample_id,
            "metadata": {"orientation": "horizontal"},
            "page": {"source_page_sha256": self.page_sha},
            "work": {"id": self.work_id},
        }
        self._write_master([self.master])
        self.rubric_path.write_text("# sealed rubric v4\n", encoding="utf-8")
        self.prior = SEAL.seal(
            {
                "record_type": "manga_font_label_final",
                "role": {"primary": "sfx_impact"},
                "sample_id": self.sample_id,
                "treatment": {
                    "distortion": "wave",
                    "fill": "pattern",
                    "orientation": "horizontal",
                    "outline": "double",
                    "shadow": "none",
                },
            }
        )
        self.inventory = self._inventory_row(self.prior)
        self._write_inventory([self.inventory])

    def _write_master(self, rows: list[dict]) -> None:
        self.master_path.write_text(
            "".join(SEAL.canonical_json(row) + "\n" for row in rows),
            encoding="utf-8",
        )

    def _inventory_row(self, prior: dict) -> dict:
        return SEAL.seal_jsonl(
            {
                "master_manifest_sha256": SEAL.sha256_file(self.master_path),
                "merge_provenance": {
                    "prior_final_record": prior,
                    "prior_final_record_sha256": prior["record_sha256"],
                    "source_master_record_sha256": SEAL.sha256_jsonl_record(
                        self.master
                    ),
                    "visibility": "merge_only_not_reviewer_surface",
                },
                "sample_id": self.sample_id,
                "source_page_sha256": self.page_sha,
                "work_id": self.work_id,
            }
        )

    def _write_inventory(self, rows: list[dict]) -> None:
        self.inventory_path.write_text(
            "".join(SEAL.canonical_json(row) + "\n" for row in rows),
            encoding="utf-8",
        )

    def build(self) -> dict:
        manifest, summary = SEAL.build_manifest(
            master_manifest=self.master_path,
            inventory=self.inventory_path,
            rubric=self.rubric_path,
        )
        report = SEAL.build_report(manifest=manifest, summary=summary)
        SEAL._write_output(output=self.output, manifest=manifest, report=report)
        return SEAL.validate_output(
            master_manifest=self.master_path,
            inventory=self.inventory_path,
            rubric=self.rubric_path,
            output=self.output,
        )


class SourceSealTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.fixture = Fixture(Path(self.temporary.name) / "fixture")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_builds_exact_private_projection_and_validates(self) -> None:
        report = self.fixture.build()
        manifest = json.loads(
            (self.fixture.output / SEAL.MANIFEST_FILE).read_text(encoding="utf-8")
        )
        self.assertEqual(1, report["summary"]["sample_count"])
        self.assertTrue(manifest["development_only"])
        self.assertEqual("sfx_impact", manifest["samples"][0]["sealed_role"])
        self.assertEqual(
            {
                "distortion": True,
                "inverse": False,
                "outline": True,
                "shadow": False,
                "texture": True,
            },
            manifest["samples"][0]["treatment"],
        )
        self.assertEqual(
            SEAL.sha256_file(self.fixture.inventory_path),
            manifest["inputs"]["inventory_sha256"],
        )
        self.assertFalse(report["checks"]["automatic_source_role_inference"])
        self.assertEqual(0, report["checks"]["qa_or_synthetic_pixels_written"])

    def test_rejects_tampered_prior_final_even_when_outer_row_is_resealed(self) -> None:
        row = copy.deepcopy(self.fixture.inventory)
        row.pop("record_sha256")
        row["merge_provenance"]["prior_final_record"]["role"]["primary"] = "dialogue"
        self.fixture._write_inventory([SEAL.seal_jsonl(row)])
        with self.assertRaisesRegex(SEAL.SourceSealError, "prior_final_record.*seal"):
            SEAL.build_manifest(
                master_manifest=self.fixture.master_path,
                inventory=self.fixture.inventory_path,
                rubric=self.fixture.rubric_path,
            )

    def test_rejects_master_projection_mismatch(self) -> None:
        row = copy.deepcopy(self.fixture.inventory)
        row.pop("record_sha256")
        row["work_id"] = "work-other"
        self.fixture._write_inventory([SEAL.seal_jsonl(row)])
        with self.assertRaisesRegex(SEAL.SourceSealError, "work/page binding"):
            SEAL.build_manifest(
                master_manifest=self.fixture.master_path,
                inventory=self.fixture.inventory_path,
                rubric=self.fixture.rubric_path,
            )

    def test_rejects_inventory_sample_absent_from_master(self) -> None:
        extra = copy.deepcopy(self.fixture.master)
        extra["id"] = "fm_sample_002"
        self.fixture._write_master([extra])
        row = self.fixture._inventory_row(self.fixture.prior)
        self.fixture._write_inventory([row])
        with self.assertRaisesRegex(SEAL.SourceSealError, "absent from master"):
            SEAL.build_manifest(
                master_manifest=self.fixture.master_path,
                inventory=self.fixture.inventory_path,
                rubric=self.fixture.rubric_path,
            )

    def test_validate_rejects_output_tamper(self) -> None:
        self.fixture.build()
        report_path = self.fixture.output / SEAL.REPORT_FILE
        report_path.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(SEAL.SourceSealError, "report differs"):
            SEAL.validate_output(
                master_manifest=self.fixture.master_path,
                inventory=self.fixture.inventory_path,
                rubric=self.fixture.rubric_path,
                output=self.fixture.output,
            )

    def test_rejects_unknown_treatment_value(self) -> None:
        prior_core = {
            key: copy.deepcopy(value)
            for key, value in self.fixture.prior.items()
            if key != "record_sha256"
        }
        prior_core["treatment"]["fill"] = "invented"
        prior = SEAL.seal(prior_core)
        self.fixture._write_inventory([self.fixture._inventory_row(prior)])
        with self.assertRaisesRegex(SEAL.SourceSealError, "unsupported value"):
            SEAL.build_manifest(
                master_manifest=self.fixture.master_path,
                inventory=self.fixture.inventory_path,
                rubric=self.fixture.rubric_path,
            )


if __name__ == "__main__":
    unittest.main()
