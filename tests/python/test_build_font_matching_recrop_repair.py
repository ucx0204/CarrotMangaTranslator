from __future__ import annotations

import copy
import hashlib
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
SCRIPT = SCRIPTS / "build_font_matching_recrop_repair.py"
SPEC = importlib.util.spec_from_file_location("font_matching_recrop_repair", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REPAIR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = REPAIR
SPEC.loader.exec_module(REPAIR)
LABELS = REPAIR.labels


FONT_IDS = ("font-a", "font-b", "font-c")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(REPAIR.canonical_json(row) + "\n" for row in rows),
        encoding="utf-8",
    )


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def final_row(sample_id: str, *, work_id: str, page_sha: str) -> dict[str, Any]:
    return LABELS.seal_record(
        {
            "schema_version": 1,
            "record_type": "manga_font_label_final",
            "final_id": f"final-{sample_id}",
            "sample_id": sample_id,
            "work_id": work_id,
            "source_page_sha256": page_sha,
            "role": {"primary": "sfx_impact", "confidence": 0.96},
            "source_style": {
                field: 0.5 for field in LABELS.STYLE_FIELDS
            }
            | {"unknown_fields": []},
            "treatment": {
                "orientation": "mixed",
                "outline": "none",
                "shadow": "none",
                "fill": "solid",
                "distortion": "none",
            },
            "font_judgment": {
                "preferred": [],
                "acceptable": [],
                "marginal": [FONT_IDS[0]],
                "unacceptable": list(FONT_IDS[1:]),
                "unrenderable": [],
                "not_reviewed": [],
                "none_acceptable": True,
            },
            "consistency": {
                "policy": "intentional_override",
                "reason_code": "sfx_role_palette",
            },
            "resolution": {
                "kind": "primary",
                "resolver": "fixture",
                "resolved_at": "2026-08-01T00:00:00Z",
                "source_label_ids": [f"label-{sample_id}"],
                "catalog_version": "fixture-catalog-v1",
                "catalog_sha256": "a" * 64,
                "renderer_hash": "b" * 64,
                "confidence": 0.95,
                "flags": ["none_acceptable_confirmed"],
                "notes": "",
                "adjudication_evidence": None,
            },
        }
    )


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.library = root / "library"
        self.master = root / "master.jsonl"
        self.rejected = root / "rejected.jsonl"
        self.finals = root / "finals.jsonl"
        self.proposals = root / "proposals.jsonl"
        self.output = root / "repair-output"
        self.processed = root / "repair-processed"
        self.orientation_id = "fm_orientation_defect"
        self.rescue_id = "fm_rescue_defect"
        self.orientation_work = "work-orientation"
        self.rescue_work = "work-rescue"
        orientation_page = self._page(
            self.orientation_work, "chapter-a", "page-a", "orientation.png"
        )
        rescue_page = self._page(
            self.rescue_work, "chapter-b", "page-b", "rescue.png"
        )
        self.page_paths = {
            self.orientation_id: orientation_page,
            self.rescue_id: rescue_page,
        }
        self.master_rows = [
            self._master_row(
                self.orientation_id,
                self.orientation_work,
                "chapter-a",
                "page-a",
                orientation_page,
                source_catalog="fontclip-hard-accepted-v2",
                candidate_metadata={
                    "categories": ["ocr_hard"],
                    "candidate_score": 1.0,
                    "candidate_evidence": [],
                    "ocr_text": "また",
                    "detector_model": None,
                },
            ),
            self._master_row(
                self.rescue_id,
                self.rescue_work,
                "chapter-b",
                "page-b",
                rescue_page,
                source_catalog="fontclip-accepted-v1",
                candidate_metadata=None,
            ),
        ]
        write_jsonl(self.master, self.master_rows)
        rejected = REPAIR.seal(
            {
                "schema_version": "font-matching-orientation-audit-v1",
                "record_type": "font_matching_orientation_applied_decision",
                "sample_id": self.orientation_id,
                "accepted": False,
                "orientation": "vertical",
                "orientation_changed": False,
                "audit": {
                    "actual_orientation": "vertical",
                    "card_sha256": "c" * 64,
                    "confidence": 0.99,
                    "crop_status": "needs_recrop",
                    "declared_orientation": "vertical",
                    "notes": "fixture crop is loose",
                    "primary_assignment_id": "fmra-fixture",
                    "reviewer": "fixture-orientation-reviewer",
                    "schema_version": "font-matching-orientation-audit-v1",
                    "task_record_sha256": "d" * 64,
                    "viewed_original": True,
                },
            }
        )
        write_jsonl(self.rejected, [rejected])
        write_jsonl(
            self.finals,
            [
                final_row(
                    self.rescue_id,
                    work_id=self.rescue_work,
                    page_sha=file_sha(rescue_page),
                )
            ],
        )
        self.proposal_rows = [
            self._proposal(
                self.orientation_id,
                action="recrop",
                bbox=[15, 14, 47, 69],
                orientation="vertical",
            ),
            self._proposal(
                self.rescue_id,
                action="replace",
                bbox=None,
                orientation=None,
            ),
        ]
        write_jsonl(self.proposals, self.proposal_rows)

    def _page(
        self, work_id: str, chapter_id: str, page_id: str, name: str
    ) -> Path:
        path = (
            self.library
            / "works"
            / work_id
            / "chapters"
            / chapter_id
            / "pages"
            / name
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (96, 112), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((22, 20, 38, 61), fill="black")
        draw.rectangle((26, 65, 42, 72), fill="black")
        image.save(path, format="PNG", optimize=False)
        return path

    def _master_row(
        self,
        sample_id: str,
        work_id: str,
        chapter_id: str,
        page_id: str,
        page_path: Path,
        *,
        source_catalog: str,
        candidate_metadata: dict[str, Any] | None,
    ) -> dict[str, Any]:
        relative = page_path.relative_to(self.library).as_posix()
        page_sha = file_sha(page_path)
        return {
            "schema_version": 1,
            "catalog_version": 1,
            "id": sample_id,
            "work": {"id": work_id, "title": work_id},
            "chapter": {"id": chapter_id, "title": chapter_id},
            "page": {
                "id": page_id,
                "name": page_path.name,
                "source_page_sha256": page_sha,
                "source_locator": {
                    "path": relative,
                    "file_sha256": page_sha,
                    "size_px": [96, 112],
                },
            },
            "split": "train",
            "geometry": {
                "bbox_px": [20, 18, 40, 64],
                "crop_bbox_px": [18, 16, 42, 66],
                "final_bbox_px": [18, 16, 43, 74],
                "page_size_px": [96, 112],
            },
            "metadata": {
                "orientation": "vertical",
                "ocr_text": "また",
                "candidate_metadata": candidate_metadata,
            },
            "groups": {"root": f"{source_catalog}:{sample_id}"},
            "provenance": {
                "approval": "exhaustive_manual_visual_review",
                "qa_overlay": False,
                "synthetic": False,
                "source_catalog_id": source_catalog,
                "source_id": f"source-{sample_id}",
            },
            "sample_crop_sha256": "e" * 64,
            "work_balance_weight": 1.0,
        }

    def _proposal(
        self,
        sample_id: str,
        *,
        action: str,
        bbox: list[int] | None,
        orientation: str | None,
    ) -> dict[str, Any]:
        current = [20, 18, 40, 64]
        preview_bbox = bbox if bbox is not None else current
        with Image.open(self.page_paths[sample_id]) as opened:
            preview = opened.convert("RGB").crop(tuple(preview_bbox))
        try:
            preview_sha = REPAIR.sha256_bytes(REPAIR.hard_audit.encode_png(preview))
        finally:
            preview.close()
        is_rescue = sample_id == self.rescue_id
        return REPAIR.seal(
            {
                "schema_version": (
                    "font-matching-rescue-recrop-proposal-v1"
                    if is_rescue
                    else "font-matching-orientation-recrop-proposal-v1"
                ),
                "record_type": (
                    "font_matching_rescue_recrop_proposal"
                    if is_rescue
                    else "font_matching_orientation_recrop_proposal"
                ),
                "sample_id": sample_id,
                "action": action,
                "recrop_bbox_px": bbox,
                "actual_orientation": orientation,
                "note": "fixture direct original-page review",
                "source_page_path": str(self.page_paths[sample_id].resolve()),
                "source_page_sha256": file_sha(self.page_paths[sample_id]),
                "current_bbox_px": current,
                "preview_bbox_px": preview_bbox,
                "preview_crop_sha256": preview_sha,
                "reviewer": "fixture-recrop-reviewer",
                "reviewed_at": "2026-08-01T00:00:00Z",
            }
        )

    def argv(self, command: str, *, output: Path | None = None) -> list[str]:
        return [
            command,
            "--master-manifest",
            str(self.master),
            "--orientation-rejected",
            str(self.rejected),
            "--final-labels",
            str(self.finals),
            "--proposal",
            str(self.proposals),
            "--library-root",
            str(self.library),
            "--output-root",
            str(output or self.output),
            "--repair-processed-root",
            str(self.processed),
            "--expected-orientation-targets",
            "1",
            "--expected-rescue-targets",
            "1",
            "--expected-total-targets",
            "2",
        ]


class RecropRepairTests(unittest.TestCase):
    def test_builds_and_validates_a_sealed_real_page_queue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, REPAIR.main(fixture.argv("build")))
                self.assertEqual(0, REPAIR.main(fixture.argv("validate")))

            report = json.loads(
                (fixture.output / REPAIR.REPORT_FILE).read_text(encoding="utf-8")
            )
            self.assertEqual(2, report["counts"]["targets"])
            self.assertEqual(1, report["counts"]["recrops"])
            self.assertEqual(1, report["counts"]["replacements"])
            self.assertEqual(1, report["counts"]["invalidated_prior_finals"])
            self.assertEqual(
                "master.geometry.bbox_px",
                report["inputs"]["current_bbox_semantics"],
            )
            command = report["postprocess_command"]
            manifest_pin = command[command.index("--expected-input-manifest-sha256") + 1]
            self.assertEqual(
                report["outputs"]["queue"]["manifest_sha256"], manifest_pin
            )
            manifest = [
                json.loads(line)
                for line in (
                    fixture.output / REPAIR.QUEUE_DIR / "manifest.jsonl"
                ).read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(1, len(manifest))
            self.assertTrue(manifest[0]["id"].startswith("fhcr_"))
            self.assertFalse(manifest[0]["manual_recrop"]["synthetic"])
            self.assertFalse(
                manifest[0]["manual_recrop"]["diagnostic_overlay_written"]
            )
            supersession = [
                json.loads(line)
                for line in (fixture.output / REPAIR.SUPERSESSION_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(2, len(supersession))
            self.assertTrue(
                all(row["parent_excluded_from_training"] for row in supersession)
            )
            for name in (
                REPAIR.DEFECT_EVIDENCE_FILE,
                REPAIR.PROPOSAL_RECORDS_FILE,
                REPAIR.PARENT_RECORDS_FILE,
            ):
                rows = [
                    json.loads(line)
                    for line in (fixture.output / name)
                    .read_text(encoding="utf-8")
                    .splitlines()
                ]
                self.assertEqual(2, len(rows))
            proposal_snapshots = [
                json.loads(line)
                for line in (fixture.output / REPAIR.PROPOSAL_RECORDS_FILE)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertTrue(
                all(not any(key.startswith("_") for key in row) for row in proposal_snapshots)
            )

    def test_validation_detects_tampered_queue_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, REPAIR.main(fixture.argv("build")))
            raw = next((fixture.output / REPAIR.QUEUE_DIR / "images" / "raw").rglob("*.png"))
            raw.write_bytes(raw.read_bytes() + b"tamper")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("validate")))

    def test_rejects_preview_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.proposal_rows)
            changed[0]["preview_crop_sha256"] = "f" * 64
            changed[0] = REPAIR.seal(changed[0])
            write_jsonl(fixture.proposals, changed)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_rejects_noop_recrop_and_unowned_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.proposal_rows)
            current = [20, 18, 40, 64]
            changed[0] = fixture._proposal(
                fixture.orientation_id,
                action="recrop",
                bbox=current,
                orientation="vertical",
            )
            write_jsonl(fixture.proposals, changed)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.output.mkdir()
            (fixture.output / "foreign.txt").write_text("mine", encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertEqual(
                "mine", (fixture.output / "foreign.txt").read_text(encoding="utf-8")
            )

    def test_requires_exact_target_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            write_jsonl(fixture.proposals, fixture.proposal_rows[:1])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_rejects_unknown_proposal_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.proposal_rows)
            changed[0]["schema_version"] = "unknown-proposal-v1"
            changed[0] = REPAIR.seal(changed[0])
            write_jsonl(fixture.proposals, changed)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_rejects_valid_contract_bound_to_the_wrong_defect_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.proposal_rows)
            changed[1]["schema_version"] = REPAIR.ORIENTATION_PROPOSAL_CONTRACT[0]
            changed[1]["record_type"] = REPAIR.ORIENTATION_PROPOSAL_CONTRACT[1]
            changed[1] = REPAIR.seal(changed[1])
            write_jsonl(fixture.proposals, changed)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_rejects_prior_final_identity_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = final_row(
                fixture.rescue_id,
                work_id="wrong-work",
                page_sha=file_sha(fixture.page_paths[fixture.rescue_id]),
            )
            write_jsonl(fixture.finals, [changed])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_rejects_unbound_parent_source_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.master_rows)
            changed[0]["provenance"]["source_id"] = ""
            write_jsonl(fixture.master, changed)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(2, REPAIR.main(fixture.argv("build")))
            self.assertFalse(fixture.output.exists())

    def test_refuses_output_inside_the_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            unsafe = fixture.library / "generated-repair"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    2, REPAIR.main(fixture.argv("build", output=unsafe))
                )
            self.assertFalse(unsafe.exists())


if __name__ == "__main__":
    unittest.main()
