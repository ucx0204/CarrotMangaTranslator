from __future__ import annotations

import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "build_font_matching_font_signal_recrop_repair.py"
SPEC = importlib.util.spec_from_file_location("font_signal_recrop_repair", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REPAIR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = REPAIR
SPEC.loader.exec_module(REPAIR)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(REPAIR.jsonl_bytes(rows))


def v3_seal(row: dict[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(row)
    output.pop("record_sha256", None)
    output["record_sha256"] = REPAIR.repair.sha256_bytes(
        (REPAIR.canonical_json(output) + "\n").encode("utf-8")
    )
    return output


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.library = root / "library"
        self.human = root / "human.jsonl"
        self.audit = root / "audit.jsonl"
        self.master = root / "master.jsonl"
        self.plan = root / "plan.jsonl"
        self.output = root / "output"
        self.sample_ids = ("fm_repairable", "fm_terminal")
        pages = {
            sample_id: self._page(sample_id, index)
            for index, sample_id in enumerate(self.sample_ids)
        }
        masters = [
            self._master(sample_id, pages[sample_id]) for sample_id in self.sample_ids
        ]
        audits = [
            self._audit(sample_id, masters[index])
            for index, sample_id in enumerate(self.sample_ids)
        ]
        human = [
            self._human(sample_id, audits[index])
            for index, sample_id in enumerate(self.sample_ids)
        ]
        plans = [
            self._plan(self.sample_ids[0], action="recrop"),
            self._plan(self.sample_ids[1], action="terminal_replacement"),
        ]
        write_jsonl(self.master, masters)
        write_jsonl(self.audit, audits)
        write_jsonl(self.human, human)
        write_jsonl(self.plan, plans)

    def _page(self, sample_id: str, index: int) -> Path:
        path = (
            self.library
            / "works"
            / f"work-{index}"
            / "chapters"
            / f"chapter-{index}"
            / "pages"
            / f"{sample_id}.png"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (120, 100), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 18, 31, 70), fill="black")
        draw.rectangle((38, 22, 49, 70), fill="black")
        if index:
            draw.rectangle((54, 25, 95, 65), fill=(200, 10, 10))
        image.save(path, format="PNG", optimize=False)
        return path

    def _locator(self, page: Path) -> dict[str, Any]:
        return {
            "path": page.relative_to(self.library).as_posix(),
            "file_sha256": REPAIR.sha256_file(page),
            "provenance": "real_preserved",
            "resolution_contract": "resolve against caller-supplied library_root",
            "size_bytes": page.stat().st_size,
            "size_px": [120, 100],
            "storage_root": "library_root",
        }

    def _master(self, sample_id: str, page: Path) -> dict[str, Any]:
        index = self.sample_ids.index(sample_id)
        locator = self._locator(page)
        geometry = {
            "bbox_px": [20, 18, 50, 71],
            "crop_bbox_px": [18, 16, 52, 73],
            "final_bbox_px": [16, 14, 54, 75],
            "mask_tight_bbox_px": [20, 18, 49, 70],
            "page_size_px": [120, 100],
        }
        return {
            "schema_version": 1,
            "catalog_version": 1,
            "id": sample_id,
            "work": {"id": f"work-{index}", "title": f"work-{index}"},
            "chapter": {"id": f"chapter-{index}", "title": f"chapter-{index}"},
            "page": {
                "id": f"page-{index}",
                "name": page.name,
                "source_page_sha256": locator["file_sha256"],
                "source_locator": locator,
            },
            "geometry": geometry,
            "split": "train",
            "provenance": {
                "approval": "exhaustive_manual_visual_review",
                "qa_overlay": False,
                "synthetic": False,
                "source_catalog_id": "fixture",
                "source_id": f"source-{sample_id}",
            },
        }

    def _audit(self, sample_id: str, master: dict[str, Any]) -> dict[str, Any]:
        return v3_seal(
            {
                "schema_version": "font-matching-catalog-delta-review-inputs-v3",
                "record_type": "font_signal_identifiability_audit",
                "sample_id": sample_id,
                "work_id": master["work"]["id"],
                "chapter_id": master["chapter"]["id"],
                "page_id": master["page"]["id"],
                "source_page_sha256": master["page"]["source_page_sha256"],
                "audit_order": self.sample_ids.index(sample_id) + 1,
                "status": "pending_human_audit",
                "trigger_codes": ["fixture"],
                "unknown_style_fields": ["weight"],
                "evidence": {
                    "geometry": copy.deepcopy(master["geometry"]),
                    "views": {},
                    "source_page_locator": copy.deepcopy(
                        master["page"]["source_locator"]
                    ),
                },
                "decision_contract": {
                    "allowed_human_outcomes": [
                        "font_signal_present",
                        "font_signal_absent",
                        "needs_recrop",
                        "uncertain",
                    ],
                    "automatic_absent_classification_allowed": False,
                    "new_candidate_review_blocked_until_resolved": True,
                },
                "provenance": {
                    "qa_overlay": False,
                    "synthetic": False,
                    "training_sample_record_sha256": "a" * 64,
                    "prior_final_record_sha256": "b" * 64,
                },
                "review_surface": {
                    "font_names_visible": False,
                    "prior_tiers_visible": False,
                    "split_visible": False,
                    "model_suggestions_visible": False,
                },
            }
        )

    def _human(self, sample_id: str, audit: dict[str, Any]) -> dict[str, Any]:
        return {
            "sample_id": sample_id,
            "source_audit_record_sha256": audit["record_sha256"],
            "outcome": "needs_recrop",
            "rationale": "fixture needs a complete block",
            "reviewer": "fixture-human",
            "reviewed_at": "2026-08-01T00:00:00Z",
            "decision_source": "human_visual_review",
            "evidence_checked": ["source_page", "raw_224"],
        }

    def _plan(self, sample_id: str, *, action: str) -> dict[str, Any]:
        recrop = action == "recrop"
        return {
            "schema_version": REPAIR.SCHEMA_VERSION,
            "record_type": "font_signal_recrop_repair_plan",
            "sample_id": sample_id,
            "action": action,
            "recrop_bbox_px": [15, 12, 60, 80] if recrop else None,
            "orientation": "vertical" if recrop else None,
            "target_semantics": (
                "one_complete_single_style_text_block" if recrop else None
            ),
            "terminal_category": "promo_overlay" if not recrop else None,
            "rationale": "fixture direct source-page proposal",
            "reviewer": "fixture-proposer",
            "reviewed_at": "2026-08-01T01:00:00Z",
            "viewed_original": True,
            "source_pixels": "hash_verified_library_page_only",
        }

    def argv(self, command: str) -> list[str]:
        return [
            command,
            "--human-review",
            str(self.human),
            "--font-signal-audit-v3",
            str(self.audit),
            "--master-v3",
            str(self.master),
            "--proposal-plan",
            str(self.plan),
            "--library-root",
            str(self.library),
            "--output-root",
            str(self.output),
            "--expected-targets",
            "2",
        ]


class FontSignalRecropRepairTests(unittest.TestCase):
    def test_builds_review_only_exact_page_previews_and_validates_determinism(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, REPAIR.main(fixture.argv("build")))
                self.assertEqual(0, REPAIR.main(fixture.argv("validate")))

            report = json.loads(
                (fixture.output / REPAIR.REPORT_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(2, report["counts"]["targets"])
            self.assertEqual(
                {"recrop": 1, "terminal_replacement": 1},
                report["counts"]["actions"],
            )
            self.assertEqual(0, report["safety"]["qa_overlays_used_as_pixels"])
            self.assertFalse(report["next_step"]["training_eligible"])
            proposals = [
                json.loads(line)
                for line in (fixture.output / REPAIR.PROPOSALS_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertTrue(
                all(
                    row["status"] == "pending_direct_visual_review" for row in proposals
                )
            )
            self.assertTrue(all(row["promotion_allowed"] is False for row in proposals))
            for row in proposals:
                preview = row["direct_preview"]
                self.assertFalse(preview["qa_overlay"])
                self.assertFalse(preview["synthetic"])
                self.assertEqual(
                    "direct_hash_verified_library_page_crop", preview["pixel_source"]
                )
            ledger = (fixture.output / REPAIR.LEDGER_FILE).read_text(encoding="utf-8")
            self.assertIn("allowed_decisions", ledger)
            self.assertNotIn(",accept_proposal,", ledger)

    def test_validation_rejects_tampered_direct_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, REPAIR.main(fixture.argv("build")))
            preview = fixture.output / REPAIR.PREVIEW_DIR / "fm_repairable.png"
            preview.write_bytes(preview.read_bytes() + b"tamper")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("validate")))

    def test_rejects_audit_seal_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            rows = [
                json.loads(line)
                for line in fixture.audit.read_text(encoding="utf-8").splitlines()
            ]
            rows[0]["status"] = "tampered"
            write_jsonl(fixture.audit, rows)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))

    def test_rejects_plan_target_drift_and_unsafe_library_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            plans = [
                json.loads(line)
                for line in fixture.plan.read_text(encoding="utf-8").splitlines()
            ]
            write_jsonl(fixture.plan, plans[:1])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            masters = [
                json.loads(line)
                for line in fixture.master.read_text(encoding="utf-8").splitlines()
            ]
            audits = [
                json.loads(line)
                for line in fixture.audit.read_text(encoding="utf-8").splitlines()
            ]
            masters[0]["page"]["source_locator"]["path"] = "../escape.png"
            audits[0]["evidence"]["source_page_locator"]["path"] = "../escape.png"
            audits[0] = v3_seal(audits[0])
            write_jsonl(fixture.master, masters)
            write_jsonl(fixture.audit, audits)
            human = [
                json.loads(line)
                for line in fixture.human.read_text(encoding="utf-8").splitlines()
            ]
            human[0]["source_audit_record_sha256"] = audits[0]["record_sha256"]
            write_jsonl(fixture.human, human)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))


if __name__ == "__main__":
    unittest.main()
