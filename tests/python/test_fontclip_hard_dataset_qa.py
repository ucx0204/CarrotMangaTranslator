from __future__ import annotations

import contextlib
import copy
import csv
import hashlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]


def load_script(name: str, relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


POST = load_script(
    "postprocess_fontclip_hard_candidates_for_qa_test",
    "scripts/postprocess_fontclip_hard_candidates.py",
)
HARD_QA = load_script(
    "fontclip_hard_dataset_qa_test_target",
    "scripts/fontclip_hard_dataset_qa.py",
)
RECORDER = load_script(
    "record_fontclip_sheet_review_for_hard_qa_test",
    "scripts/record_fontclip_sheet_review.py",
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(
            json.dumps(
                row,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


class ProcessedHardFixture:
    """Create a tiny, genuinely signed hard-postprocessor output."""

    def __init__(self, root: Path, count: int) -> None:
        self.root = root.resolve()
        self.input = self.root / "input"
        self.library = self.root / "library"
        self.dataset = self.root / "dataset"
        self.rows: list[dict[str, Any]] = []
        for index in range(count):
            self._add_candidate(index)
        self._write_builder_contract()
        summary = POST.run(self._postprocess_args())
        if summary["processed_records"] != count or summary["rejected_records"]:
            raise AssertionError(
                "unit fixture did not survive the real hard postprocessor: "
                f"{summary['processed_records']=}, {summary['rejected_records']=}"
            )

    @property
    def manifest(self) -> Path:
        return self.dataset / POST.MANIFEST_NAME

    @property
    def rejects(self) -> Path:
        return self.dataset / POST.REJECTS_NAME

    @property
    def report(self) -> Path:
        return self.dataset / POST.REPORT_NAME

    @property
    def marker(self) -> Path:
        return self.dataset / POST.MARKER_NAME

    def _source_path(self, index: int) -> Path:
        return (
            self.library
            / "works"
            / "work-fixture"
            / "chapters"
            / f"chapter-{index + 1:02d}"
            / "pages"
            / f"page-{index + 1:03d}.png"
        )

    def _add_candidate(self, index: int) -> None:
        source = self._source_path(index)
        source.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (96, 80), (248, 248, 248))
        draw = ImageDraw.Draw(image)
        # A genuine red page line deliberately remains in the signed real
        # crop. The QA contract forbids diagnostic overlays by provenance, not
        # legitimate red comic pixels.
        draw.line((14, 10, 78, 10), fill=(210, 20, 20), width=1)
        draw.polygon(((25, 22), (34, 18), (42, 47), (33, 52)), fill=(8, 8, 8))
        blue = (20, 70 + (index % 20), 215 - (index % 20))
        draw.polygon(((44, 20), (57, 21), (65, 48), (51, 51)), fill=blue)
        draw.ellipse((66, 52, 69, 55), fill=(10, 10, 10))
        draw.rectangle((75, 28, 78, 38), fill=(0, 0, 0))
        image.save(source, format="PNG")

        sample_id = f"fhc-hard-qa-fixture-{index + 1:04d}"
        bbox = (20, 16, 72, 60)
        crop_bbox = (14, 9, 79, 67)
        crop = image.crop(crop_bbox).convert("RGB")
        raw = self.input / "images" / "raw" / "train" / f"{sample_id}.png"
        clip = self.input / "images" / "clip_224" / "train" / f"{sample_id}.png"
        raw.parent.mkdir(parents=True, exist_ok=True)
        clip.parent.mkdir(parents=True, exist_ok=True)
        crop.save(raw, format="PNG")
        letterbox = Image.new("RGB", (224, 224), "white")
        resized = crop.copy()
        resized.thumbnail((224, 224))
        letterbox.paste(
            resized,
            ((224 - resized.width) // 2, (224 - resized.height) // 2),
        )
        letterbox.save(clip, format="PNG")
        source_bytes = source.read_bytes()
        source_sha = hashlib.sha256(source_bytes).hexdigest()
        self.rows.append(
            {
                "schema_version": 1,
                "id": sample_id,
                "image_path": raw.relative_to(self.input).as_posix(),
                "clip_image_path": clip.relative_to(self.input).as_posix(),
                "asset_file_sha256": {
                    "image_path": sha256_file(raw),
                    "clip_image_path": sha256_file(clip),
                },
                "source_image_path": source.relative_to(self.library).as_posix(),
                "source_page_sha256": source_sha,
                "source_page_content_signature": {
                    "sha256": source_sha,
                    "size": len(source_bytes),
                    "width": image.width,
                    "height": image.height,
                },
                "work_id": "work-fixture",
                "work_title": "QA Fixture Work",
                "chapter_id": f"chapter-{index + 1:02d}",
                "chapter_title": f"Chapter {index + 1}",
                "page_id": f"page-{index + 1:03d}",
                "page_name": source.name,
                "page_size_px": [image.width, image.height],
                "declared_page_size_px": [image.width, image.height],
                "source_dimension_mismatch": False,
                "split": "train",
                "tier": "hard_candidate",
                "provenance": "real_mined",
                "primary_category": "page_sound",
                "categories": ["page_sound", "text_free"],
                "candidate_score": 0.91,
                "candidate_evidence": [{"source": "unit_fixture"}],
                "candidate_source_ids": [f"fixture-source-{index + 1}"],
                "bbox_px": list(bbox),
                "crop_bbox_px": list(crop_bbox),
                "crop_size_px": [crop.width, crop.height],
                "crop_sha256": POST._pixel_sha256(crop),
                "orientation": "horizontal",
                "ocr_text": "ドン",
                "ocr_hints_sha256": None,
                "ocr_coordinate_provenance": {
                    "coordinate_space": "actual_source_pixels"
                },
                "ocr_metadata_skip_reasons": {},
                "detector_model": {
                    "name": "fixture",
                    "sha256": "1" * 64,
                    "labels": ["bubble", "text_bubble", "text_free"],
                },
                "selection_segment_index": 0,
                "work_balance_weight": 1.0,
                "chapter_balance_weight": 1.0,
                "label": None,
            }
        )
        crop.close()
        resized.close()
        letterbox.close()
        image.close()

    def _write_builder_contract(self) -> None:
        input_manifest = self.input / POST.MANIFEST_NAME
        input_manifest.parent.mkdir(parents=True, exist_ok=True)
        canonical_jsonl(input_manifest, self.rows)
        manifest_sha = sha256_file(input_manifest)
        signature = {
            "library_root": str(self.library),
            "configuration": {"max_chapters_per_work": 20},
            "fixture": True,
            "manifest_sha256": manifest_sha,
        }
        marker = {
            "tool": POST.INPUT_TOOL_ID,
            "schema_version": 1,
            "output_root": str(self.input),
            "owned_outputs": [
                POST.STATE_DIR_NAME,
                "images/raw",
                "images/clip_224",
                POST.MANIFEST_NAME,
                POST.INPUT_REPORT_NAME,
            ],
            "signature": signature,
            "signature_sha256": POST._sha256_json(signature),
        }
        report = {
            "tool": POST.INPUT_TOOL_ID,
            "schema_version": 1,
            "run_signature_sha256": marker["signature_sha256"],
            "candidate_records": len(self.rows),
            "unique_crop_sha256": len({str(row["crop_sha256"]) for row in self.rows}),
            "category_memberships": dict(
                sorted(
                    Counter(
                        category for row in self.rows for category in row["categories"]
                    ).items()
                )
            ),
            "by_split": {"train": len(self.rows)},
            "configuration": {"max_chapters_per_work": 20},
            "output_root": str(self.input),
            "library_root": str(self.library),
        }
        (self.input / POST.INPUT_MARKER_NAME).write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        (self.input / POST.INPUT_REPORT_NAME).write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )

    def _postprocess_args(self):
        argv = [
            "--input-root",
            str(self.input),
            "--library-root",
            str(self.library),
            "--output-root",
            str(self.dataset),
            "--quiet",
            "--no-ctd",
            "--minimum-input-candidates",
            "0",
            "--minimum-processed-records",
            "0",
            "--expected-input-manifest-sha256",
            sha256_file(self.input / POST.MANIFEST_NAME),
        ]
        return POST.build_argument_parser().parse_args(argv)

    def records(self) -> list[dict[str, Any]]:
        return read_jsonl(self.manifest)

    def convert_to_reject_only(self) -> dict[str, Any]:
        if len(self.rows) != 1:
            raise AssertionError("reject-only conversion requires one input row")
        parent = self.rows[0]
        reject = {
            "schema_version": 1,
            "id": parent["id"],
            "parent_id": parent["id"],
            "provenance": "real_mined",
            "work_id": parent["work_id"],
            "chapter_id": parent["chapter_id"],
            "page_id": parent["page_id"],
            "split": parent["split"],
            "source_image_path": parent["source_image_path"],
            "bbox_px": parent["bbox_px"],
            "crop_bbox_px": parent["crop_bbox_px"],
            "stage": "unit_reject",
            "failure_reasons": ["unit_reject"],
            "input_line_number": 1,
            "parent_record_sha256": POST._sha256_json(parent),
            "synthetic": False,
        }
        canonical_jsonl(self.manifest, [])
        canonical_jsonl(self.rejects, [reject])
        checkpoints = sorted((self.dataset / POST.STATE_DIR_NAME).glob("*.json"))
        if len(checkpoints) != 1:
            raise AssertionError("expected one fixture checkpoint")
        checkpoint = json.loads(checkpoints[0].read_text(encoding="utf-8"))
        checkpoint["records"] = []
        checkpoint["rejects"] = [reject]
        core = {
            key: checkpoint[key]
            for key in (
                "signature_sha256",
                "page_key",
                "input_bindings",
                "input_binding_sha256",
                "source_page_sha256",
                "records",
                "rejects",
            )
        }
        checkpoint["checkpoint_sha256"] = POST._sha256_json(core)
        checkpoints[0].write_text(
            json.dumps(checkpoint, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        report = json.loads(self.report.read_text(encoding="utf-8"))
        report.update(
            {
                "processed_records": 0,
                "rejected_records": 1,
                "encoded_asset_files": 0,
                "encoded_asset_bytes": 0,
                "by_mask_method": {},
                "by_quality_status": {},
                "by_split": {},
                "by_work": {},
                "category_memberships": {},
                "failure_reasons": {"unit_reject": 1},
            }
        )
        report["outputs"]["manifest_sha256"] = sha256_file(self.manifest)
        report["outputs"]["rejects_sha256"] = sha256_file(self.rejects)
        self.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return reject

    def sync_manifest_rows(self, rows: list[dict[str, Any]]) -> None:
        """Rewrite a deliberate row mutation and keep outer attestations valid."""

        canonical_jsonl(self.manifest, rows)
        records_by_id = {row["id"]: row for row in rows}
        for checkpoint in sorted((self.dataset / POST.STATE_DIR_NAME).glob("*.json")):
            payload = json.loads(checkpoint.read_text(encoding="utf-8"))
            changed = False
            updated = []
            for row in payload["records"]:
                replacement = records_by_id.get(row["id"])
                if replacement is not None:
                    updated.append(copy.deepcopy(replacement))
                    changed = changed or replacement != row
                else:
                    updated.append(row)
            if not changed:
                continue
            payload["records"] = updated
            core = {
                key: payload[key]
                for key in (
                    "signature_sha256",
                    "page_key",
                    "input_bindings",
                    "input_binding_sha256",
                    "source_page_sha256",
                    "records",
                    "rejects",
                )
            }
            payload["checkpoint_sha256"] = POST._sha256_json(core)
            checkpoint.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
        report = json.loads(self.report.read_text(encoding="utf-8"))
        report["outputs"]["manifest_sha256"] = sha256_file(self.manifest)
        self.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def qa_report_path(qa_dir: Path, shard_index: int, shard_count: int) -> Path:
    if shard_count == 1:
        return qa_dir / "hard_dataset_qa_report.json"
    return (
        qa_dir
        / f"hard_dataset_qa_report_shard-{shard_index:03d}-of-{shard_count:03d}.json"
    )


def audit_state_path(qa_dir: Path, shard_index: int, shard_count: int) -> Path:
    if shard_count == 1:
        return qa_dir / "audit_state.json"
    return qa_dir / (f"audit_state_shard-{shard_index:03d}-of-{shard_count:03d}.json")


def run_qa(
    fixture: ProcessedHardFixture,
    qa_dir: Path,
    *,
    audit_all: bool,
    shard_index: int = 0,
    shard_count: int = 1,
    contact_sheet_size: int = 3,
) -> tuple[int, dict[str, Any], str]:
    argv = [
        "--dataset",
        str(fixture.dataset),
        "--library-root",
        str(fixture.library),
        "--qa-dir",
        str(qa_dir),
        "--shard-index",
        str(shard_index),
        "--shard-count",
        str(shard_count),
        "--contact-sheet-size",
        str(contact_sheet_size),
    ]
    if audit_all:
        argv.append("--audit-all")
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        code = HARD_QA.main(argv)
    report_path = qa_report_path(qa_dir, shard_index, shard_count)
    report = (
        json.loads(report_path.read_text(encoding="utf-8"))
        if report_path.is_file()
        else {}
    )
    return code, report, output.getvalue()


class FontClipHardDatasetQaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.one = ProcessedHardFixture(root / "one", 1)
        cls.three = ProcessedHardFixture(root / "three", 3)
        cls.eight = ProcessedHardFixture(root / "eight", 8)
        cls.twenty = ProcessedHardFixture(root / "twenty", 20)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def assert_ok(
        self,
        fixture: ProcessedHardFixture,
        qa_dir: Path,
        *,
        audit_all: bool = False,
        shard_index: int = 0,
        shard_count: int = 1,
        contact_sheet_size: int = 3,
    ) -> dict[str, Any]:
        code, report, output = run_qa(
            fixture,
            qa_dir,
            audit_all=audit_all,
            shard_index=shard_index,
            shard_count=shard_count,
            contact_sheet_size=contact_sheet_size,
        )
        self.assertEqual(code, 0, output or report)
        self.assertTrue(report.get("ok"), report)
        self.assertEqual(report.get("error_count"), 0, report)
        return report

    def assert_fails_with(
        self,
        fixture: ProcessedHardFixture,
        qa_dir: Path,
        code_name: str,
    ) -> dict[str, Any]:
        code, report, output = run_qa(
            fixture,
            qa_dir,
            audit_all=False,
        )
        self.assertEqual(code, 1, output or report)
        self.assertFalse(report.get("ok"), report)
        self.assertGreater(report.get("error_count", 0), 0, report)
        self.assertGreater(report.get("issue_counts", {}).get(code_name, 0), 0, report)
        return report

    def test_report_aggregates_include_processed_quality_failure_reasons(
        self,
    ) -> None:
        record = {
            "processing": {"mask_method": "ctd"},
            "quality": {
                "status": "review",
                "failure_reasons": ["many_components_review"],
            },
            "candidate_metadata": {"categories": ["page_sound"]},
            "split": "train",
            "work_id": "work-unit",
            "source_image_path": "works/work-unit/page.png",
            "assets": {},
        }
        report = {
            "outputs": {
                "manifest_sha256": "1" * 64,
                "rejects_sha256": "2" * 64,
                "synthetic_provenance_spec_sha256": "3" * 64,
            },
            "processed_records": 1,
            "rejected_records": 0,
            "input_rows": 1,
            "encoded_asset_files": 0,
            "encoded_asset_bytes": 0,
            "source_pages": 1,
            "processed_pages_this_run": 1,
            "resumed_pages_this_run": 0,
            "by_mask_method": {"ctd": 1},
            "by_quality_status": {"review": 1},
            "by_split": {"train": 1},
            "by_work": {"work-unit": 1},
            "category_memberships": {"page_sound": 1},
            "failure_reasons": {"many_components_review": 1},
        }
        issues = HARD_QA.IssueCollector()

        HARD_QA.validate_report_aggregates(
            Path("dataset"),
            report,
            [record],
            [],
            manifest_sha="1" * 64,
            rejects_sha="2" * 64,
            synthetic_spec_sha="3" * 64,
            issues=issues,
        )

        self.assertEqual(issues.error_count, 0, issues.details)

    def test_exhaustive_inventory_is_recorder_compatible_and_finalizable(self) -> None:
        qa_dir = self.three.dataset / "qa-review"
        report = self.assert_ok(
            self.three,
            qa_dir,
            audit_all=True,
            contact_sheet_size=3,
        )
        inventories = sorted(qa_dir.glob("fontclip_audit_all_audit_*.json"))
        self.assertEqual(len(inventories), 1)
        inventory_path = inventories[0]
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        parsed = RECORDER.parse_sheet_inventory(inventory_path)
        self.assertEqual(parsed.png_path.name, inventory["sheet"])
        self.assertEqual(len(parsed.items), 3)
        self.assertEqual(
            [item["id"] for item in inventory["items"]],
            list(parsed.ordered_ids),
        )

        for item in inventory["items"]:
            self.assertEqual(item["decision"], "")
            self.assertEqual(item["recrop_bbox_px"], "")
            self.assertEqual(
                item["source_image_path"], item["recrop_contract"]["source_image_path"]
            )
            self.assertEqual(
                item["source_crop_bbox_px"],
                item["recrop_contract"]["current_source_crop_bbox_px"],
            )
            self.assertEqual(
                item["tight_bbox_px"],
                item["recrop_contract"]["current_tight_bbox_px"],
            )
            self.assertEqual(
                item["parent_id"],
                item["recrop_contract"]["reprocess_parent_id"],
            )
            self.assertEqual(item["reprocess_parent_id"], item["parent_id"])
            self.assertEqual(
                item["reprocess_linkage"]["current_processed_id"],
                item["id"],
            )
            self.assertEqual(
                item["recrop_contract"]["coordinate_space"],
                "source_page_pixels_xyxy",
            )
            self.assertEqual(
                item["recrop_contract"]["reprocess_tool"],
                "scripts/postprocess_fontclip_hard_candidates.py",
            )

        artifact = report["sheet_artifacts"][0]
        self.assertEqual(artifact["png_sha256"], sha256_file(parsed.png_path))
        self.assertEqual(artifact["json_sha256"], sha256_file(inventory_path))
        self.assertEqual(
            artifact["ordered_ids_sha256"],
            RECORDER.hash_id_list(parsed.ordered_ids, sort_items=False),
        )

        journal = qa_dir / "review-journal.jsonl"
        record_code = RECORDER.main(
            [
                "--journal",
                str(journal),
                "--sheet-json",
                str(inventory_path),
                "--reviewer",
                "unit-reviewer",
                "--reject",
                "2:mask includes a panel line",
                "--recrop",
                "3:needs a tighter source crop",
                "--recrop-bbox",
                "3:18,14,74,61",
                "--recrop-padding",
                "3:2",
            ]
        )
        self.assertEqual(record_code, 0)
        ledger = qa_dir / "completed-review.csv"
        finalize_code = RECORDER.main(
            [
                "--journal",
                str(journal),
                "--finalize",
                "--qa-dir",
                str(qa_dir),
                "--shard-tag",
                "all",
                "--output-ledger",
                str(ledger),
            ]
        )
        self.assertEqual(finalize_code, 0)
        with ledger.open("r", encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(
            [row["decision"] for row in rows],
            ["pass", "reject", "recrop"],
        )
        self.assertEqual(rows[1]["reject_reason"], "mask includes a panel line")
        self.assertEqual(rows[2]["recrop_bbox_px"], "[18,14,74,61]")
        self.assertEqual(rows[2]["padding_px"], "2")
        marker = json.loads(
            RECORDER.completion_marker_path(ledger).read_text(encoding="utf-8")
        )
        self.assertTrue(marker["completed"])
        self.assertEqual(marker["item_count"], 3)

    def test_every_declared_asset_is_file_hashed(self) -> None:
        record = self.one.records()[0]
        expected = set(HARD_QA.REQUIRED_ASSET_KINDS)
        expected.update(set(record["assets"]) - expected)
        for kind in sorted(expected):
            with self.subTest(kind=kind):
                path = self.one.dataset / record["assets"][kind]["path"]
                original = path.read_bytes()
                try:
                    with Image.open(io.BytesIO(original)) as opened:
                        image = opened.copy()
                    # Re-encode identical pixels with a deliberately different
                    # compression stream. Pixel SHA remains valid; file SHA must fail.
                    image.save(path, format="PNG", compress_level=0)
                    image.close()
                    self.assertNotEqual(
                        sha256_file(path), hashlib.sha256(original).hexdigest()
                    )
                    self.assert_fails_with(
                        self.one,
                        self.one.dataset / f"qa-file-{kind}",
                        "asset_file_sha256_mismatch",
                    )
                finally:
                    path.write_bytes(original)

    def test_pixel_hash_dag_and_provenance_mutations_are_rejected(self) -> None:
        original_manifest = self.one.manifest.read_bytes()
        original_report = self.one.report.read_bytes()
        checkpoints = {
            path: path.read_bytes()
            for path in (self.one.dataset / POST.STATE_DIR_NAME).glob("*.json")
        }
        try:
            rows = self.one.records()
            rows[0]["assets"]["mask"]["pixel_sha256"] = "0" * 64
            self.one.sync_manifest_rows(rows)
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-pixel-descriptor",
                "asset_pixel_sha256_mismatch",
            )

            self.one.manifest.write_bytes(original_manifest)
            self.one.report.write_bytes(original_report)
            for path, payload in checkpoints.items():
                path.write_bytes(payload)
            rows = self.one.records()
            raw_id = rows[0]["assets"]["raw"]["id"]
            rows[0]["assets"]["glyph_224"]["parent_asset_ids"] = [raw_id]
            rows[0]["assets"]["glyph_224"]["parent_asset_id"] = raw_id
            self.one.sync_manifest_rows(rows)
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-dag",
                "asset_dag_invalid",
            )

            self.one.manifest.write_bytes(original_manifest)
            self.one.report.write_bytes(original_report)
            for path, payload in checkpoints.items():
                path.write_bytes(payload)
            rows = self.one.records()
            rows[0]["assets"]["mask"]["provenance"] = "synthetic_composite"
            self.one.sync_manifest_rows(rows)
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-provenance",
                "asset_provenance_invalid",
            )
        finally:
            self.one.manifest.write_bytes(original_manifest)
            self.one.report.write_bytes(original_report)
            for path, payload in checkpoints.items():
                path.write_bytes(payload)

    def test_report_and_marker_tampering_are_rejected(self) -> None:
        original_report = self.one.report.read_bytes()
        original_marker = self.one.marker.read_bytes()
        try:
            report = json.loads(original_report)
            report["outputs"]["manifest_sha256"] = "0" * 64
            self.one.report.write_text(
                json.dumps(report, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-report-tamper",
                "report_hash_mismatch",
            )
        finally:
            self.one.report.write_bytes(original_report)

        try:
            marker = json.loads(original_marker)
            marker["signature"]["tampered"] = True
            self.one.marker.write_text(
                json.dumps(marker, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-marker-tamper",
                "marker_signature_invalid",
            )
        finally:
            self.one.marker.write_bytes(original_marker)

    def test_render_and_inventory_are_byte_deterministic(self) -> None:
        first_dir = self.three.dataset / "qa-determinism-a"
        second_dir = self.three.dataset / "qa-determinism-b"
        self.assert_ok(self.three, first_dir, audit_all=True, contact_sheet_size=2)
        self.assert_ok(self.three, second_dir, audit_all=True, contact_sheet_size=2)
        first = {
            path.name: path.read_bytes()
            for path in first_dir.glob("fontclip_audit_all_audit_*")
            if path.suffix in {".png", ".json"}
        }
        second = {
            path.name: path.read_bytes()
            for path in second_dir.glob("fontclip_audit_all_audit_*")
            if path.suffix in {".png", ".json"}
        }
        self.assertEqual(first.keys(), second.keys())
        self.assertEqual(first, second)

    def test_four_shards_are_disjoint_and_cover_every_processed_id_once(self) -> None:
        expected_ids = {row["id"] for row in self.eight.records()}
        shard_sets: list[set[str]] = []
        for shard_index in range(4):
            qa_dir = self.eight.dataset / f"qa-shard-{shard_index}"
            self.assert_ok(
                self.eight,
                qa_dir,
                audit_all=True,
                shard_index=shard_index,
                shard_count=4,
                contact_sheet_size=2,
            )
            state = json.loads(
                audit_state_path(qa_dir, shard_index, 4).read_text(encoding="utf-8")
            )
            ids = state["ids"]
            self.assertEqual(ids, sorted(ids))
            self.assertEqual(len(ids), len(set(ids)))
            self.assertEqual(state["item_count"], len(ids))
            shard_sets.append(set(ids))
        self.assertEqual(set().union(*shard_sets), expected_ids)
        for left in range(4):
            for right in range(left + 1, 4):
                self.assertFalse(shard_sets[left] & shard_sets[right])

    def test_twenty_chapters_pass_and_twenty_one_is_rejected(self) -> None:
        self.assert_ok(
            self.twenty,
            self.twenty.dataset / "qa-max20",
            audit_all=False,
        )
        original_manifest = self.twenty.manifest.read_bytes()
        original_report = self.twenty.report.read_bytes()
        created: list[Path] = []
        try:
            records = self.twenty.records()
            clone = copy.deepcopy(records[0])
            clone["chapter_id"] = "chapter-21"
            clone["chapter_title"] = "Chapter 21"
            clone["page_id"] = "page-021"
            clone["page_name"] = "page-021.png"
            old_source = self.twenty.library / clone["source_image_path"]
            new_source = (
                self.twenty.library
                / "works"
                / clone["work_id"]
                / "chapters"
                / clone["chapter_id"]
                / "pages"
                / clone["page_name"]
            )
            new_source.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(old_source, new_source)
            created.append(new_source)
            clone["source_image_path"] = new_source.relative_to(
                self.twenty.library
            ).as_posix()
            clone["source_page_asset"]["path"] = clone["source_image_path"]
            clone["parent_id"] = "fhc-hard-qa-fixture-0021"
            clone["root_real_id"] = clone["parent_id"]
            clone["variant_group_id"] = clone["parent_id"]
            clone["parent_record_sha256"] = hashlib.sha256(
                b"chapter-21-parent"
            ).hexdigest()
            clone["lineage"][0]["id"] = clone["parent_id"]
            clone["lineage"][1]["id"] = "pending"
            clone["source_page_asset"]["id"] = HARD_QA.expected_source_asset_id(clone)
            clone["id"] = HARD_QA.expected_processed_id(clone)
            clone["lineage"][1]["id"] = clone["id"]
            new_asset_ids = {
                kind: HARD_QA.expected_asset_id(clone["id"], kind)
                for kind in clone["assets"]
            }
            old_assets = records[0]["assets"]
            for kind, descriptor in clone["assets"].items():
                old_path = self.twenty.dataset / old_assets[kind]["path"]
                new_relative = (
                    f"{HARD_QA.ASSET_DIRECTORIES[kind]}/"
                    f"{clone['split']}/{clone['id']}.png"
                )
                new_path = self.twenty.dataset / new_relative
                new_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(old_path, new_path)
                created.append(new_path)
                descriptor["id"] = new_asset_ids[kind]
                descriptor["path"] = new_relative
                descriptor["root_real_id"] = clone["root_real_id"]
                descriptor["parent_sample_id"] = (
                    clone["parent_id"] if kind == "raw" else clone["id"]
                )
            parents = {
                "raw": [],
                "context": [clone["source_page_asset"]["id"]],
                "mask": [new_asset_ids["raw"]],
                "color_mask": [new_asset_ids["raw"]],
                "glyph_rgba": [new_asset_ids["raw"], new_asset_ids["mask"]],
                "black_on_white": [new_asset_ids["mask"]],
                "white_on_black": [new_asset_ids["mask"]],
                "outline_fill": [new_asset_ids["mask"]],
                "outline_stroke": [new_asset_ids["mask"]],
                "outline_outer_ring": [new_asset_ids["mask"]],
                "glyph_224": [new_asset_ids["glyph_rgba"]],
                "context_224": [new_asset_ids["context"]],
                "deskew_rgba": [new_asset_ids["glyph_rgba"]],
            }
            for kind, descriptor in clone["assets"].items():
                descriptor["parent_asset_ids"] = parents[kind]
                descriptor["parent_asset_id"] = (
                    parents[kind][0] if parents[kind] else None
                )
            aliases = {
                "image_path": "raw",
                "raw_image_path": "raw",
                "clip_image_path": "glyph_224",
                "glyph_224_path": "glyph_224",
                "context_image_path": "context",
                "masked_context_path": "context",
                "glyph_rgba_path": "glyph_rgba",
                "glyph_mask_path": "mask",
                "context_224_path": "context_224",
            }
            for alias, kind in aliases.items():
                clone[alias] = clone["assets"][kind]["path"]
            clone["asset_file_sha256"] = {
                "image_path": clone["assets"]["raw"]["file_sha256"],
                "clip_image_path": clone["assets"]["glyph_224"]["file_sha256"],
            }
            for key in ("mask_paths", "final_image_paths"):
                clone[key] = {
                    kind: clone["assets"][kind]["path"]
                    for kind in (
                        "context",
                        "glyph_rgba",
                        "mask",
                        "glyph_224",
                        "context_224",
                    )
                }
            clone["mask_asset_sha256"] = {
                kind: clone["assets"][kind]["file_sha256"]
                for kind in (
                    "context",
                    "glyph_rgba",
                    "mask",
                    "glyph_224",
                    "context_224",
                )
            }
            records.append(clone)
            canonical_jsonl(self.twenty.manifest, records)
            report = json.loads(original_report)
            report["processed_records"] = 21
            report["input_rows"] = 21
            report["source_pages"] = 21
            report["completed_page_shards"] = 21
            report["by_work"] = {"work-fixture": 21}
            report["by_split"] = {"train": 21}
            report["outputs"]["manifest_sha256"] = sha256_file(self.twenty.manifest)
            self.twenty.report.write_text(
                json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            self.assert_fails_with(
                self.twenty,
                self.twenty.dataset / "qa-max21",
                "max_chapters_per_work_exceeded",
            )
        finally:
            self.twenty.manifest.write_bytes(original_manifest)
            self.twenty.report.write_bytes(original_report)
            for path in reversed(created):
                path.unlink(missing_ok=True)

    def test_diagnostic_overlay_contract_is_forbidden_without_banning_red_ink(
        self,
    ) -> None:
        self.assertNotIn((255, 0, 0), HARD_QA.QA_OVERLAY_COLORS)
        self.assert_ok(
            self.one,
            self.one.dataset / "qa-real-red-is-allowed",
            audit_all=False,
        )
        original_manifest = self.one.manifest.read_bytes()
        original_report = self.one.report.read_bytes()
        checkpoints = {
            path: path.read_bytes()
            for path in (self.one.dataset / POST.STATE_DIR_NAME).glob("*.json")
        }
        try:
            rows = self.one.records()
            rows[0]["processing"]["diagnostic_overlay_written"] = True
            self.one.sync_manifest_rows(rows)
            self.assert_fails_with(
                self.one,
                self.one.dataset / "qa-diagnostic-overlay",
                "diagnostic_overlay_forbidden",
            )
        finally:
            self.one.manifest.write_bytes(original_manifest)
            self.one.report.write_bytes(original_report)
            for path, payload in checkpoints.items():
                path.write_bytes(payload)

    def test_reject_only_source_page_is_still_signed_and_rehashed(self) -> None:
        root = Path(tempfile.mkdtemp(dir=self.temporary.name))
        fixture = ProcessedHardFixture(root / "reject-only", 1)
        fixture.convert_to_reject_only()
        self.assert_ok(
            fixture,
            fixture.dataset / "qa-valid-reject",
            audit_all=False,
        )
        source = fixture._source_path(0)
        with Image.open(source) as opened:
            changed = opened.convert("RGB")
        changed.putpixel((0, 0), (17, 31, 47))
        changed.save(source, format="PNG")
        changed.close()
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-reject-source-tamper",
            "reject_source_signature_mismatch",
        )

    def test_coordinated_semantic_and_malformed_asset_tampering_fails_cleanly(
        self,
    ) -> None:
        def fixture_for(label: str) -> ProcessedHardFixture:
            root = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=self.temporary.name))
            return ProcessedHardFixture(root / "fixture", 1)

        fixture = fixture_for("root")
        rows = fixture.records()
        rows[0]["root_real_id"] = "forged-root"
        rows[0]["variant_group_id"] = "forged-root"
        for descriptor in rows[0]["assets"].values():
            descriptor["root_real_id"] = "forged-root"
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-root",
            "upstream_binding_mismatch",
        )

        fixture = fixture_for("context-transform")
        rows = fixture.records()
        rows[0]["assets"]["context"]["transform"]["bbox_px"] = [0, 0, 1, 1]
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-context-transform",
            "asset_transform_invalid",
        )

        fixture = fixture_for("raw-reencode")
        rows = fixture.records()
        raw_descriptor = rows[0]["assets"]["raw"]
        raw_path = fixture.dataset / raw_descriptor["path"]
        with Image.open(raw_path) as opened:
            raw_image = opened.convert("RGB")
        raw_image.save(raw_path, format="PNG", compress_level=0)
        raw_descriptor["file_sha256"] = sha256_file(raw_path)
        raw_descriptor["file_size_bytes"] = raw_path.stat().st_size
        rows[0]["asset_file_sha256"]["image_path"] = raw_descriptor["file_sha256"]
        raw_image.close()
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-raw-reencode",
            "upstream_binding_mismatch",
        )

        fixture = fixture_for("outline")
        rows = fixture.records()
        mask_path = fixture.dataset / rows[0]["assets"]["mask"]["path"]
        with Image.open(mask_path) as opened:
            mask = opened.convert("L")
        replacements = {
            "outline_fill": mask.copy(),
            "outline_stroke": Image.new("L", mask.size, 0),
        }
        for kind, image in replacements.items():
            path = fixture.dataset / rows[0]["assets"][kind]["path"]
            image.save(path, format="PNG")
            descriptor = rows[0]["assets"][kind]
            descriptor["file_sha256"] = sha256_file(path)
            descriptor["file_size_bytes"] = path.stat().st_size
            descriptor["pixel_sha256"] = POST._pixel_sha256(image)
            image.close()
        mask.close()
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-outline",
            "outline_partition_invalid",
        )

        fixture = fixture_for("unknown-kind")
        rows = fixture.records()
        rows[0]["assets"]["overlay"] = copy.deepcopy(rows[0]["assets"]["raw"])
        rows[0]["assets"]["overlay"]["kind"] = "overlay"
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-unknown-kind",
            "asset_dag_invalid",
        )

        fixture = fixture_for("bad-size")
        rows = fixture.records()
        rows[0]["assets"]["mask"]["file_size_bytes"] = {}
        fixture.sync_manifest_rows(rows)
        self.assert_fails_with(
            fixture,
            fixture.dataset / "qa-bad-size",
            "asset_file_size_invalid",
        )

    def test_nested_review_blocks_regeneration_and_failure_hides_state(self) -> None:
        qa_dir = self.three.dataset / "qa-nested-review"
        self.assert_ok(
            self.three,
            qa_dir,
            audit_all=True,
            contact_sheet_size=3,
        )
        inventory = next(qa_dir.glob("fontclip_audit_all_audit_*.json"))
        png = inventory.with_suffix(".png")
        before_json = inventory.read_bytes()
        before_png = png.read_bytes()
        nested = qa_dir / "nested"
        nested.mkdir()
        journal = nested / "review.jsonl"
        self.assertEqual(
            RECORDER.main(
                [
                    "--journal",
                    str(journal),
                    "--sheet-json",
                    str(inventory),
                    "--reviewer",
                    "nested-reviewer",
                ]
            ),
            0,
        )
        code, report, output = run_qa(
            self.three,
            qa_dir,
            audit_all=True,
            contact_sheet_size=1,
        )
        self.assertEqual(code, 1, output or report)
        self.assertGreater(report["issue_counts"].get("audit_render_failed", 0), 0)
        self.assertFalse((qa_dir / "audit_state.json").exists())
        self.assertEqual(inventory.read_bytes(), before_json)
        self.assertEqual(png.read_bytes(), before_png)
        ledger = qa_dir / "must-not-finalize.csv"
        self.assertNotEqual(
            RECORDER.main(
                [
                    "--journal",
                    str(journal),
                    "--finalize",
                    "--qa-dir",
                    str(qa_dir),
                    "--shard-tag",
                    "all",
                    "--output-ledger",
                    str(ledger),
                ]
            ),
            0,
        )
        self.assertFalse(ledger.exists())


if __name__ == "__main__":
    unittest.main()
