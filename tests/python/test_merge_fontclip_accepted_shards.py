from __future__ import annotations

import copy
import csv
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "merge_fontclip_accepted_shards.py"
SPEC = importlib.util.spec_from_file_location(
    "merge_fontclip_accepted_shards", SCRIPT_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load merge script: {SCRIPT_PATH}")
MERGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MERGE
SPEC.loader.exec_module(MERGE)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_png(path: Path, color: tuple[int, int, int], size=(4, 4)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path, format="PNG", optimize=False)


def crop_pixel_sha(path: Path) -> str:
    return MERGE._crop_pixel_sha256(path)[0]


def pass_event(
    item_id: str, ledger: Path, ledger_sha: str, *, decision: str = "pass"
) -> dict:
    return {
        "audit_schema_version": 1,
        "decision": decision,
        "decision_ledger": ledger.name,
        "decision_ledger_sha256": ledger_sha,
        "decision_row": 2,
        "item_id": item_id,
        "kind": "manual_visual_audit",
        "notes": None,
        "reject_reason": None,
        "reviewed_at": "2026-01-01T00:00:00Z",
        "reviewer": "unit-test",
    }


class MergeFixture:
    def __init__(self, root: Path, *, declared_shards: int = 1) -> None:
        self.root = root
        self.datasets = root / "datasets"
        self.dataset = self.datasets / "fontclip-source-v1"
        self.library = root / "library"
        self.output = self.datasets / "fontclip-accepted-v1"
        self.stage0 = self.dataset / "audits" / "stage-0"
        self.stage1 = self.dataset / "audits" / "stage-1"
        self.declared_shards = declared_shards
        self._build()

    def _raw_record(
        self,
        item_id: str,
        image_path: str,
        clip_path: str,
        source_path: str,
        bbox: list[int],
    ) -> dict:
        physical = self.dataset / Path(*Path(image_path).parts)
        with Image.open(physical) as image:
            crop_size = list(image.size)
        return {
            "schema_version": 1,
            "id": item_id,
            "image_path": image_path.replace("\\", "/"),
            "clip_image_path": clip_path.replace("\\", "/"),
            "source_image_path": source_path,
            "source_page_path": source_path,
            "work_id": "work-1",
            "work_title": "Work",
            "chapter_id": "chapter-1",
            "chapter_title": "Chapter",
            "page_id": "page-1",
            "page_name": "001.png",
            "split": "train",
            "tier": "A",
            "provenance": "unit-test",
            "orientation": "vertical",
            "bbox_px": list(bbox),
            "crop_bbox_px": list(bbox),
            "crop_size_px": crop_size,
            "crop_sha256": crop_pixel_sha(physical),
        }

    def _mask_fields(
        self,
        base: Path,
        item_id: str,
        *,
        high_precision: bool,
    ) -> dict:
        kind_to_folder = {
            "context": "masked_context",
            "context_224": "masked_context_224",
            "glyph_224": "masked_glyph_224",
            "glyph_rgba": "masked_glyph_rgba",
            "mask": "masked_mask",
        }
        paths: dict[str, str] = {}
        hashes: dict[str, str] = {}
        for index, (kind, folder) in enumerate(kind_to_folder.items()):
            relative = f"images/{folder}/train/{item_id}-{index}.png"
            physical = base / Path(*Path(relative).parts)
            write_png(physical, (30 + index, 40 + index, 50 + index))
            paths[kind] = relative
            hashes[kind] = sha256_file(physical)
        reasons = [] if high_precision else ["border_contact_ratio_above_0_02"]
        return {
            "mask_schema_version": 2,
            "mask_paths": dict(paths),
            "final_image_paths": dict(paths),
            "masked_context_path": paths["context"],
            "context_224_path": paths["context_224"],
            "glyph_224_path": paths["glyph_224"],
            "glyph_rgba_path": paths["glyph_rgba"],
            "glyph_mask_path": paths["mask"],
            "mask_asset_sha256": hashes,
            "mask_high_precision": high_precision,
            "mask_quality_gate": {
                "name": "strict_high_precision_v1",
                "passed": high_precision,
                "reasons": reasons,
            },
        }

    def _write_ledger(self, path: Path, rows: list[tuple[str, str]]) -> str:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["id", "decision"])
            writer.writeheader()
            for item_id, decision in rows:
                writer.writerow({"id": item_id, "decision": decision})
        return sha256_file(path)

    def _summary(
        self,
        root: Path,
        *,
        input_manifest: Path,
        input_count: int,
        ledger: Path,
        ledger_sha: str,
        accepted: int,
        generated: int,
        pending_original: int,
        require_complete: bool,
    ) -> dict:
        return {
            "audit_schema_version": 1,
            "dry_run": False,
            "dataset_root": str(self.dataset),
            "library_root": str(self.library),
            "input_manifests": [str(input_manifest)],
            "decision_ledgers": [{"path": str(ledger), "sha256": ledger_sha}],
            "input_records": input_count,
            "decisions": input_count - pending_original,
            "accepted_records": accepted,
            "generated_recrops": generated,
            "recrop_rechecks": generated,
            "pending_original_decisions": pending_original,
            "pending_recrop_decisions": generated,
            "pending_mask_enrichment": generated,
            "require_complete": require_complete,
            "output_root": str(root),
            "final_manifest": "final_accepted_manifest.jsonl",
            "rejected_ledger": "rejected_ledger.jsonl",
            "recrop_recheck_manifest": "recrop_recheck_manifest.jsonl",
            "recrop_recheck_ledger_csv": "recrop_recheck_ledger.csv",
            "recrop_recheck_ledger_jsonl": "recrop_recheck_ledger.jsonl",
        }

    def _build(self) -> None:
        self.dataset.mkdir(parents=True)
        self.library.mkdir(parents=True)
        source_rel = "works/work-1/chapters/chapter-1/pages/001.png"
        write_png(self.library / Path(*Path(source_rel).parts), (200, 200, 200), (8, 8))

        raw_a_path = "images/raw/train/fc_a.png"
        clip_a_path = "images/clip_224/train/fc_a.png"
        raw_b_path = "images/raw/train/fc_b.png"
        clip_b_path = "images/clip_224/train/fc_b.png"
        write_png(self.dataset / raw_a_path, (10, 20, 30))
        write_png(self.dataset / clip_a_path, (11, 21, 31), (224, 224))
        write_png(self.dataset / raw_b_path, (60, 70, 80))
        write_png(self.dataset / clip_b_path, (61, 71, 81), (224, 224))
        raw_a = self._raw_record(
            "fc_a", raw_a_path, clip_a_path, source_rel, [0, 0, 4, 4]
        )
        raw_b = self._raw_record(
            "fc_b", raw_b_path, clip_b_path, source_rel, [4, 0, 8, 4]
        )
        root_masked_a = dict(raw_a)
        root_masked_a.update(self._mask_fields(self.dataset, "fc_a", high_precision=True))
        root_masked_b = dict(raw_b)
        root_masked_b.update(self._mask_fields(self.dataset, "fc_b", high_precision=False))
        write_jsonl(self.dataset / "manifest.jsonl", [raw_a, raw_b])
        write_jsonl(
            self.dataset / "manifest_masked.jsonl",
            [root_masked_a, root_masked_b],
        )

        for stage in (self.stage0, self.stage1):
            stage.mkdir(parents=True)
            (stage / ".fontclip-audit").write_text(
                MERGE.AUDIT_MARKER_CONTENT, encoding="utf-8"
            )

        ledger0 = self.dataset / "qa" / "reviews" / "shard-000-of-001.csv"
        ledger0_sha = self._write_ledger(
            ledger0, [("fc_a", "pass"), ("fc_b", "recrop")]
        )
        write_json(
            ledger0.with_suffix(".csv.complete.json"),
            {
                "schema_version": 1,
                "marker_type": MERGE.COMPLETION_MARKER_TYPE,
                "completed": True,
                "ledger": ledger0.name,
                "ledger_sha256": ledger0_sha,
                "item_count": 2,
                "ordered_ids_sha256": MERGE._hash_id_list(["fc_a", "fc_b"]),
                "shard_tag": f"shard-000-of-{self.declared_shards:03d}",
            },
        )
        accepted_a = copy.deepcopy(raw_a)
        accepted_a["audit_status"] = "accepted"
        accepted_a["audit_history"] = [pass_event("fc_a", ledger0, ledger0_sha)]

        child_raw_rel = "audits/stage-0/manual_recrops/images/raw/train/frc_b.png"
        child_clip_rel = (
            "audits/stage-0/manual_recrops/images/clip_224/train/frc_b.png"
        )
        write_png(self.dataset / child_raw_rel, (90, 100, 110))
        write_png(self.dataset / child_clip_rel, (91, 101, 111), (224, 224))
        child = self._raw_record(
            "frc_b",
            child_raw_rel,
            child_clip_rel,
            source_rel,
            [4, 0, 7, 4],
        )
        child["audit_status"] = "pending_recheck"
        child["needs_mask_enrichment"] = True
        child["manual_recrop"] = {"supersedes_id": "fc_b", "source_image_path": source_rel}
        child["audit_history"] = [
            pass_event("fc_b", ledger0, ledger0_sha, decision="recrop"),
            {
                "audit_schema_version": 1,
                "bbox_px": [4, 0, 7, 4],
                "item_id": "frc_b",
                "kind": "manual_recrop_generated",
                "padding_px": 0,
                "supersedes_id": "fc_b",
            },
        ]
        write_jsonl(self.stage0 / "final_accepted_manifest.jsonl", [accepted_a])
        write_jsonl(self.stage0 / "recrop_recheck_manifest.jsonl", [child])
        write_jsonl(self.stage0 / "rejected_ledger.jsonl", [])
        summary0 = self._summary(
            self.stage0,
            input_manifest=self.dataset / "manifest.jsonl",
            input_count=2,
            ledger=ledger0,
            ledger_sha=ledger0_sha,
            accepted=1,
            generated=1,
            pending_original=0,
            require_complete=False,
        )
        write_json(self.stage0 / "audit_summary.json", summary0)

        child_masked = copy.deepcopy(child)
        child_masked.update(
            self._mask_fields(self.stage0, "frc_b", high_precision=False)
        )
        child_masked["needs_mask_enrichment"] = True
        child_masked["mask_enrichment_status"] = "required_after_manual_recrop"
        write_jsonl(self.stage0 / "manifest_masked.jsonl", [child_masked])

        ledger1 = self.stage1 / "final.csv"
        ledger1_sha = self._write_ledger(ledger1, [("frc_b", "pass")])
        accepted_b = copy.deepcopy(child_masked)
        accepted_b["audit_status"] = "accepted"
        accepted_b["recheck_decision"] = "pending"
        accepted_b["audit_history"].append(
            pass_event("frc_b", ledger1, ledger1_sha)
        )
        write_jsonl(self.stage1 / "final_accepted_manifest.jsonl", [accepted_b])
        write_jsonl(self.stage1 / "recrop_recheck_manifest.jsonl", [])
        write_jsonl(self.stage1 / "rejected_ledger.jsonl", [])
        summary1 = self._summary(
            self.stage1,
            input_manifest=self.stage0 / "manifest_masked.jsonl",
            input_count=1,
            ledger=ledger1,
            ledger_sha=ledger1_sha,
            accepted=1,
            generated=0,
            pending_original=0,
            require_complete=True,
        )
        summary1["recrop_rechecks"] = 0
        summary1["pending_recrop_decisions"] = 0
        summary1["pending_mask_enrichment"] = 0
        write_json(self.stage1 / "audit_summary.json", summary1)

    def args(self, *, dry_run: bool, allow_partial: bool = False):
        argv = [
            "--dataset-root",
            str(self.dataset),
            "--library-root",
            str(self.library),
            "--output-root",
            str(self.output),
            "--shard",
            "shard-000",
            str(self.stage0),
            str(self.stage1),
        ]
        if dry_run:
            argv.append("--dry-run")
        if allow_partial:
            argv.append("--allow-partial-shards")
        return MERGE.build_argument_parser().parse_args(argv)

    def add_followup_completion_marker(self) -> Path:
        summary = json.loads(
            (self.stage1 / "audit_summary.json").read_text(encoding="utf-8")
        )
        ledger = Path(summary["decision_ledgers"][0]["path"])
        with ledger.open("r", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        marker = ledger.with_suffix(ledger.suffix + ".complete.json")
        write_json(
            marker,
            {
                "schema_version": 1,
                "marker_type": MERGE.COMPLETION_MARKER_TYPE,
                "completed": True,
                "ledger": ledger.name,
                "ledger_sha256": sha256_file(ledger),
                "item_count": len(rows),
                "ordered_ids_sha256": MERGE._hash_id_list(
                    row["id"] for row in rows
                ),
                "shard_tag": "all",
            },
        )
        return marker


class FontclipAcceptedMergeTests(unittest.TestCase):
    def setUp(self) -> None:
        MERGE._sha256_file.cache_clear()
        MERGE._crop_pixel_sha256.cache_clear()
        MERGE._asset_bases_cached.cache_clear()
        MERGE._asset_candidates_cached.cache_clear()
        MERGE._source_page_cached.cache_clear()

    def test_standalone_merge_hydrates_masks_and_normalizes_stale_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            summary = MERGE.run(fixture.args(dry_run=False))

            self.assertEqual(summary["accepted_records"], 2)
            self.assertEqual(summary["reviewed_records"], 2)
            self.assertEqual(summary["rejected_records"], 0)
            self.assertEqual(summary["high_precision_records"], 1)
            self.assertEqual(summary["mask_reject_records"], 1)
            rows = read_jsonl(fixture.output / "manifest_masked.jsonl")
            self.assertEqual({row["id"] for row in rows}, {"fc_a", "frc_b"})
            for row in rows:
                self.assertEqual(row["mask_enrichment_status"], "complete")
                self.assertFalse(row["needs_mask_enrichment"])
                self.assertEqual(set(row["mask_paths"]), set(MERGE.MASK_PATH_TO_TOP_LEVEL))
                for path in row["mask_paths"].values():
                    self.assertTrue((fixture.output / path).is_file())
            recrop = next(row for row in rows if row["id"] == "frc_b")
            self.assertEqual(recrop["recheck_decision"], "pass")
            reject = read_jsonl(fixture.output / "mask_rejects.jsonl")
            self.assertEqual(reject[0]["row"]["id"], "frc_b")
            self.assertEqual(reject[0]["stage"], "high_precision_gate")
            self.assertEqual(
                sha256_file(fixture.output / "manifest.jsonl"),
                summary["manifest_sha256"],
            )

    def test_dry_run_is_non_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            summary = MERGE.run(fixture.args(dry_run=True))
            self.assertTrue(summary["dry_run"])
            self.assertFalse(fixture.output.exists())

    def test_partial_shard_set_is_allowed_only_for_explicit_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary), declared_shards=2)
            with self.assertRaisesRegex(
                MERGE.MergeValidationError, "refusing partial merge"
            ):
                MERGE.run(fixture.args(dry_run=True))
            summary = MERGE.run(
                fixture.args(dry_run=True, allow_partial=True)
            )
            self.assertTrue(summary["partial_shard_validation"])
            args = fixture.args(dry_run=False)
            args.allow_partial_shards = True
            with self.assertRaisesRegex(
                MERGE.MergeValidationError, "permitted only with --dry-run"
            ):
                MERGE.run(args)

    def test_broken_recrop_chain_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            child = read_jsonl(fixture.stage0 / "manifest_masked.jsonl")[0]
            child["id"] = "frc_wrong"
            write_jsonl(fixture.stage0 / "manifest_masked.jsonl", [child])
            with self.assertRaises(MERGE.MergeValidationError):
                MERGE.run(fixture.args(dry_run=True))

    def test_followup_all_marker_requires_exact_signed_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            marker = fixture.add_followup_completion_marker()
            summary = MERGE.run(fixture.args(dry_run=True))
            self.assertEqual(summary["accepted_records"], 2)

            value = json.loads(marker.read_text(encoding="utf-8"))
            value["ordered_ids_sha256"] = "0" * 64
            write_json(marker, value)
            with self.assertRaisesRegex(
                MERGE.MergeValidationError,
                "ordered decision IDs do not match marker",
            ):
                MERGE.run(fixture.args(dry_run=True))

    def test_all_marker_cannot_be_used_as_a_primary_shard(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            marker = (
                fixture.dataset
                / "qa"
                / "reviews"
                / "shard-000-of-001.csv.complete.json"
            )
            value = json.loads(marker.read_text(encoding="utf-8"))
            value["shard_tag"] = "all"
            write_json(marker, value)
            with self.assertRaisesRegex(
                MERGE.MergeValidationError,
                "primary shard_tag must be shard-NNN-of-NNN",
            ):
                MERGE.run(fixture.args(dry_run=True))

    def test_followup_input_must_preserve_crop_and_lineage_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            child = read_jsonl(fixture.stage0 / "manifest_masked.jsonl")[0]
            child["manual_recrop"]["supersedes_id"] = "fc_substituted"
            write_jsonl(fixture.stage0 / "manifest_masked.jsonl", [child])
            with self.assertRaisesRegex(
                MERGE.MergeValidationError,
                "changed manual_recrop.supersedes_id",
            ):
                MERGE.run(fixture.args(dry_run=True))

    def test_different_content_at_two_candidate_bases_is_ambiguous(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = MergeFixture(Path(temporary))
            child = read_jsonl(fixture.stage0 / "manifest_masked.jsonl")[0]
            relative = child["glyph_224_path"]
            write_png(fixture.dataset / relative, (255, 0, 0))
            MERGE._sha256_file.cache_clear()
            with self.assertRaisesRegex(
                MERGE.MergeValidationError, "ambiguous across stage ancestors"
            ):
                MERGE.run(fixture.args(dry_run=True))

    def test_duplicate_crop_hash_is_rejected(self) -> None:
        first = {
            "id": "fc_one",
            "crop_sha256": "1" * 64,
            "image_path": "images/raw/train/fc_one.png",
            "clip_image_path": "images/clip_224/train/fc_one.png",
            "source_image_path": "works/a.png",
            "crop_bbox_px": [0, 0, 1, 1],
            "audit_history": [
                {
                    "kind": "manual_visual_audit",
                    "item_id": "fc_one",
                    "decision": "pass",
                }
            ],
        }
        second = copy.deepcopy(first)
        second.update(
            {
                "id": "fc_two",
                "image_path": "images/raw/train/fc_two.png",
                "clip_image_path": "images/clip_224/train/fc_two.png",
                "crop_bbox_px": [1, 0, 2, 1],
            }
        )
        second["audit_history"][0]["item_id"] = "fc_two"
        with self.assertRaisesRegex(
            MERGE.MergeValidationError, "duplicate crop_sha256"
        ):
            MERGE._validate_merged_uniqueness([first, second])

    def test_duplicate_lineage_root_is_rejected(self) -> None:
        first = {
            "id": "frc_one",
            "crop_sha256": "1" * 64,
            "image_path": "images/raw/train/frc_one.png",
            "clip_image_path": "images/clip_224/train/frc_one.png",
            "source_image_path": "works/a.png",
            "crop_bbox_px": [0, 0, 1, 1],
            "audit_history": [
                {
                    "kind": "manual_visual_audit",
                    "item_id": "fc_root",
                    "decision": "recrop",
                },
                {
                    "kind": "manual_recrop_generated",
                    "item_id": "frc_one",
                    "supersedes_id": "fc_root",
                },
                {
                    "kind": "manual_visual_audit",
                    "item_id": "frc_one",
                    "decision": "pass",
                },
            ],
        }
        second = copy.deepcopy(first)
        second.update(
            {
                "id": "frc_two",
                "crop_sha256": "2" * 64,
                "image_path": "images/raw/train/frc_two.png",
                "clip_image_path": "images/clip_224/train/frc_two.png",
                "crop_bbox_px": [1, 0, 2, 1],
            }
        )
        second["audit_history"][1]["item_id"] = "frc_two"
        second["audit_history"][2]["item_id"] = "frc_two"
        with self.assertRaisesRegex(
            MERGE.MergeValidationError, "duplicate lineage_root"
        ):
            MERGE._validate_merged_uniqueness([first, second])

    def test_unsafe_asset_path_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            MERGE.MergeValidationError, "unsafe asset path"
        ):
            MERGE._safe_relative_asset_path(
                "../outside.png", location="unit-test"
            )


if __name__ == "__main__":
    unittest.main()
