from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

from PIL import Image


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


QA_FIXTURE = load_script(
    "_fontclip_hard_qa_fixture_for_adjudicator_test",
    "tests/python/test_fontclip_hard_dataset_qa.py",
)
ADJ = load_script(
    "_adjudicate_fontclip_hard_audit_test_target",
    "scripts/adjudicate_fontclip_hard_audit.py",
)


def read_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def quiet_call(function, *args, **kwargs):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        result = function(*args, **kwargs)
    return result, output.getvalue()


def build_completed_ledgers(
    *,
    dataset: Path,
    library: Path,
    qa_dir: Path,
    decisions: dict[str, tuple[str, str]],
    reviewer: str,
    review_dir: Path | None = None,
) -> list[Path]:
    qa_dir.mkdir(parents=True, exist_ok=True)
    completed_dir = qa_dir if review_dir is None else review_dir
    completed_dir.mkdir(parents=True, exist_ok=True)
    for shard_index in range(ADJ.REQUIRED_AUDIT_SHARDS):
        args = ADJ.HARD_QA.build_argument_parser().parse_args(
            [
                "--dataset",
                str(dataset),
                "--library-root",
                str(library),
                "--qa-dir",
                str(qa_dir),
                "--audit-all",
                "--shard-index",
                str(shard_index),
                "--shard-count",
                str(ADJ.REQUIRED_AUDIT_SHARDS),
                "--contact-sheet-size",
                "2",
                "--quiet",
            ]
        )
        (code, report), output = quiet_call(ADJ.HARD_QA.run, args)
        if code != 0:
            raise AssertionError(output or report)

    ledgers: list[Path] = []
    for shard_index in range(ADJ.REQUIRED_AUDIT_SHARDS):
        tag = ADJ.HARD_QA.shard_tag(
            shard_index,
            ADJ.REQUIRED_AUDIT_SHARDS,
        )
        inventories = sorted(qa_dir.glob(f"fontclip_audit_{tag}_audit_*.json"))
        journal = completed_dir / f"journal-{tag}.jsonl"
        if not inventories:
            journal.write_bytes(b"")
        for inventory_path in inventories:
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            argv = [
                "--journal",
                str(journal),
                "--sheet-json",
                str(inventory_path),
                "--reviewer",
                reviewer,
            ]
            for item in inventory["items"]:
                item_id = str(item["id"])
                decision, detail = decisions.get(item_id, ("pass", ""))
                cell = int(item["cell_index"])
                if decision == "reject":
                    argv.extend(["--reject", f"{cell}:{detail}"])
                elif decision == "recrop":
                    argv.extend(
                        [
                            "--recrop",
                            f"{cell}:{detail}",
                            "--recrop-bbox",
                            f"{cell}:20,16,72,60",
                            "--recrop-padding",
                            f"{cell}:8",
                        ]
                    )
            code, output = quiet_call(ADJ.RECORDER.main, argv)
            if code != 0:
                raise AssertionError(output)
        ledger = completed_dir / f"completed-{tag}.csv"
        code, output = quiet_call(
            ADJ.RECORDER.main,
            [
                "--journal",
                str(journal),
                "--finalize",
                "--qa-dir",
                str(qa_dir),
                "--shard-tag",
                tag,
                "--output-ledger",
                str(ledger),
            ],
        )
        if code != 0:
            raise AssertionError(output)
        ledgers.append(ledger)
    return ledgers


class FontClipHardAdjudicationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve()
        cls.fixture = QA_FIXTURE.ProcessedHardFixture(
            cls.root / "original-fixture",
            8,
        )
        original_records = cls.fixture.records()
        cls.pass_id = str(original_records[0]["id"])
        cls.reject_id = str(original_records[1]["id"])
        cls.recrop_id = str(original_records[2]["id"])
        cls.initial_qa = cls.fixture.dataset / "qa-initial"
        cls.initial_ledgers = build_completed_ledgers(
            dataset=cls.fixture.dataset,
            library=cls.fixture.library,
            qa_dir=cls.initial_qa,
            decisions={
                cls.reject_id: ("reject", "panel line contaminated the mask"),
                cls.recrop_id: ("recrop", "expand source crop and reprocess"),
            },
            reviewer="initial-unit-reviewer",
        )
        cls.preparation = cls.root / "adjudication-prepared"
        cls.repair_processed = cls.root / "repair-processed"
        prepare_args = ADJ.build_argument_parser().parse_args(
            [
                "prepare",
                "--dataset",
                str(cls.fixture.dataset),
                "--library-root",
                str(cls.fixture.library),
                *sum(
                    (["--ledger", str(path)] for path in cls.initial_ledgers),
                    [],
                ),
                "--output-root",
                str(cls.preparation),
                "--repair-processed-root",
                str(cls.repair_processed),
            ]
        )
        cls.prepare_summary = ADJ.run(prepare_args)

        queue = cls.preparation / ADJ.REPAIR_QUEUE_NAME
        post_args = QA_FIXTURE.POST.build_argument_parser().parse_args(
            [
                "--input-root",
                str(queue),
                "--library-root",
                str(cls.fixture.library),
                "--output-root",
                str(cls.repair_processed),
                "--expected-input-manifest-sha256",
                ADJ.sha256_file(queue / "manifest.jsonl"),
                "--minimum-input-candidates",
                "1",
                "--minimum-processed-records",
                "0",
                "--no-ctd",
                "--quiet",
            ]
        )
        cls.repair_summary = QA_FIXTURE.POST.run(post_args)
        if (
            cls.repair_summary["processed_records"] != 1
            or cls.repair_summary["rejected_records"]
        ):
            raise AssertionError(cls.repair_summary)

        cls.recheck_qa = cls.repair_processed / ADJ.RECHECK_QA_DIR_NAME
        recheck_args = ADJ.build_argument_parser().parse_args(
            [
                "build-recheck",
                "--adjudication-root",
                str(cls.preparation),
                "--repair-processed-root",
                str(cls.repair_processed),
                "--library-root",
                str(cls.fixture.library),
                "--qa-dir",
                str(cls.recheck_qa),
                "--contact-sheet-size",
                "2",
                "--quiet",
            ]
        )
        cls.recheck_summary = ADJ.run(recheck_args)
        cls.recheck_ledgers = build_completed_ledgers(
            dataset=cls.repair_processed,
            library=cls.fixture.library,
            qa_dir=cls.recheck_qa,
            decisions={},
            reviewer="successor-unit-reviewer",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def final_args(self, output: Path):
        return ADJ.build_argument_parser().parse_args(
            [
                "finalize",
                "--adjudication-root",
                str(self.preparation),
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                "--repair-processed-root",
                str(self.repair_processed),
                *sum(
                    (["--recheck-ledger", str(path)] for path in self.recheck_ledgers),
                    [],
                ),
                "--output-root",
                str(output),
            ]
        )

    def test_prepare_creates_fresh_real_only_repair_queue(self) -> None:
        self.assertEqual(self.prepare_summary["repair_candidates"], 1)
        queue = self.preparation / ADJ.REPAIR_QUEUE_NAME
        rows = read_jsonl(queue / "manifest.jsonl")
        self.assertEqual(len(rows), 1)
        queue_marker = json.loads(
            (queue / ".fontclip-hard-candidates.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            queue_marker["owned_outputs"],
            ADJ.REPAIR_QUEUE_OWNED_OUTPUTS,
        )
        self.assertFalse((queue / ".fontclip-hard-candidate-pages").exists())
        row = rows[0]
        self.assertEqual(row["provenance"], "real_mined")
        self.assertFalse(row["manual_recrop"]["synthetic"])
        self.assertFalse(row["manual_recrop"]["diagnostic_overlay_written"])
        self.assertEqual(
            row["manual_recrop"]["parent_processed_id"],
            self.recrop_id,
        )
        for forbidden in (
            "glyph_mask_path",
            "mask_paths",
            "mask_asset_sha256",
            "mask_tight_bbox_px",
        ):
            self.assertNotIn(forbidden, row)
        source = self.fixture.library.joinpath(
            *PurePosixPath(row["source_image_path"]).parts
        )
        with Image.open(source) as opened:
            expected = opened.convert("RGB").crop(tuple(row["crop_bbox_px"]))
        with Image.open(queue / row["image_path"]) as opened:
            actual = opened.convert("RGB")
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(ADJ.pixel_sha256(actual), row["crop_sha256"])
        expected.close()
        actual.close()

    def test_square_recrop_inherits_parent_orientation(self) -> None:
        source_record = self.fixture.records()[0]
        decision = ADJ.ReviewDecision(
            item_id=str(source_record["id"]),
            decision="recrop",
            reject_reason="",
            recrop_bbox_px=(20, 16, 64, 60),
            padding_px=0,
            reviewer="orientation-unit-reviewer",
            reviewed_at="2026-08-01T00:00:00Z",
            notes="square source-page bbox",
            shard_tag="shard-000-of-004",
            sheet="orientation-unit-sheet.png",
            cell_index=1,
            ledger_path="orientation-unit-ledger.csv",
            ledger_sha256="a" * 64,
        )

        candidate, _lineage = ADJ.build_repair_candidate(
            source_record,
            decision,
            queue_physical_root=None,
            queue_declared_root=self.root / "orientation-unit-queue",
            library_root=self.fixture.library,
            write_assets=False,
        )

        x1, y1, x2, y2 = candidate["bbox_px"]
        self.assertEqual(x2 - x1, y2 - y1)
        self.assertEqual(source_record["orientation"], "horizontal")
        self.assertEqual(candidate["orientation"], source_record["orientation"])

    def test_recrop_rejects_invalid_parent_orientation(self) -> None:
        source_record = {
            **self.fixture.records()[0],
            "orientation": "square",
        }
        decision = ADJ.ReviewDecision(
            item_id=str(source_record["id"]),
            decision="recrop",
            reject_reason="",
            recrop_bbox_px=(20, 16, 64, 60),
            padding_px=0,
            reviewer="orientation-unit-reviewer",
            reviewed_at="2026-08-01T00:00:00Z",
            notes="invalid parent orientation",
            shard_tag="shard-000-of-004",
            sheet="orientation-unit-sheet.png",
            cell_index=1,
            ledger_path="orientation-unit-ledger.csv",
            ledger_sha256="a" * 64,
        )

        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "parent processed orientation must be",
        ):
            ADJ.build_repair_candidate(
                source_record,
                decision,
                queue_physical_root=None,
                queue_declared_root=self.root / "invalid-orientation-unit-queue",
                library_root=self.fixture.library,
                write_assets=False,
            )

    def test_repair_id_ignores_review_timestamp_and_ledger_path(self) -> None:
        validated = ADJ.validate_processed_dataset(
            self.fixture.dataset,
            self.fixture.library,
        )
        original = validated.records_by_id[self.recrop_id]
        decision = ADJ.validate_audit_bundle(
            self.initial_ledgers,
            dataset=validated,
        ).decisions[self.recrop_id]
        changed = ADJ.ReviewDecision(
            **{
                **decision.__dict__,
                "reviewed_at": "2030-01-01T00:00:00Z",
                "ledger_path": "C:/different/review.csv",
                "ledger_sha256": "f" * 64,
            }
        )
        self.assertEqual(
            ADJ._repair_candidate_id(original, decision),
            ADJ._repair_candidate_id(original, changed),
        )

    def test_tampered_ledger_is_rejected_by_completion_hash(self) -> None:
        ledger = self.initial_ledgers[0]
        original = ledger.read_bytes()
        try:
            ledger.write_bytes(original + b"\n")
            dataset = ADJ.validate_processed_dataset(
                self.fixture.dataset,
                self.fixture.library,
            )
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "invalid completed-ledger marker",
            ):
                ADJ.validate_audit_bundle(
                    self.initial_ledgers,
                    dataset=dataset,
                )
        finally:
            ledger.write_bytes(original)

    def test_reviews_subdirectory_keeps_qa_artifacts_at_parent(self) -> None:
        qa_dir = self.fixture.dataset / "qa-nested-reviews"
        review_dir = qa_dir / "reviews"
        ledgers = build_completed_ledgers(
            dataset=self.fixture.dataset,
            library=self.fixture.library,
            qa_dir=qa_dir,
            review_dir=review_dir,
            decisions={},
            reviewer="nested-review-dir-reviewer",
        )
        dataset = ADJ.validate_processed_dataset(
            self.fixture.dataset,
            self.fixture.library,
        )

        audit = ADJ.validate_audit_bundle(ledgers, dataset=dataset)

        self.assertEqual(len(audit.decisions), len(dataset.records_by_id))
        for shard in audit.binding["shards"]:
            self.assertEqual(Path(shard["qa_dir"]), qa_dir.resolve())
            self.assertEqual(Path(shard["review_dir"]), review_dir.resolve())
            self.assertEqual(Path(shard["state"]).parent, qa_dir.resolve())
            self.assertEqual(Path(shard["qa_report"]).parent, qa_dir.resolve())
            self.assertEqual(Path(shard["ledger"]).parent, review_dir.resolve())
            self.assertEqual(
                Path(shard["completion_marker"]).parent,
                review_dir.resolve(),
            )
            self.assertEqual(Path(shard["journal"]).parent, review_dir.resolve())

    def test_manifest_order_may_differ_from_audit_record_order(self) -> None:
        fixture = QA_FIXTURE.ProcessedHardFixture(
            self.root / "manifest-order-fixture",
            8,
        )
        reversed_rows = list(reversed(fixture.records()))
        fixture.sync_manifest_rows(reversed_rows)
        qa_dir = fixture.dataset / "qa"
        ledgers = build_completed_ledgers(
            dataset=fixture.dataset,
            library=fixture.library,
            qa_dir=qa_dir,
            decisions={},
            reviewer="manifest-order-reviewer",
        )
        dataset = ADJ.validate_processed_dataset(
            fixture.dataset,
            fixture.library,
        )
        audit_order = [
            str(record["id"])
            for record in sorted(
                dataset.result.records,
                key=ADJ.HARD_QA.record_order_key,
            )
        ]

        self.assertEqual(dataset.result.global_ids, [row["id"] for row in reversed_rows])
        self.assertNotEqual(dataset.result.global_ids, audit_order)
        audit = ADJ.validate_audit_bundle(ledgers, dataset=dataset)
        self.assertEqual(len(audit.decisions), len(reversed_rows))
        expected_order_sha = ADJ.HARD_QA.hash_ids(audit_order, sort_items=False)
        for shard in audit.binding["shards"]:
            state = json.loads(Path(shard["state"]).read_text(encoding="utf-8"))
            self.assertEqual(
                state["hard_qa"]["global_ordered_ids_sha256"],
                expected_order_sha,
            )

    def test_tampered_state_manifest_binding_is_rejected(self) -> None:
        marker = json.loads(
            ADJ.RECORDER.completion_marker_path(self.initial_ledgers[0]).read_text(
                encoding="utf-8"
            )
        )
        tag = marker["shard_tag"]
        state = self.initial_qa / f"audit_state_{tag}.json"
        original = state.read_bytes()
        try:
            payload = json.loads(original)
            payload["primary_manifest_sha256"] = "0" * 64
            state.write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )
            dataset = ADJ.validate_processed_dataset(
                self.fixture.dataset,
                self.fixture.library,
            )
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "audit state is not bound",
            ):
                ADJ.validate_audit_bundle(
                    self.initial_ledgers,
                    dataset=dataset,
                )
        finally:
            state.write_bytes(original)

    def test_same_pixel_sheet_reencode_invalidates_review(self) -> None:
        inventory = next(self.initial_qa.glob("fontclip_audit_*_audit_*.json"))
        png = inventory.with_suffix(".png")
        original = png.read_bytes()
        try:
            with Image.open(io.BytesIO(original)) as opened:
                buffer = io.BytesIO()
                opened.save(buffer, format="PNG", optimize=True)
            replacement = buffer.getvalue()
            if replacement == original:
                replacement += b"\0"
            png.write_bytes(replacement)
            dataset = ADJ.validate_processed_dataset(
                self.fixture.dataset,
                self.fixture.library,
            )
            with self.assertRaisesRegex(
                ValueError,
                "no longer matches current sheet artifacts",
            ):
                ADJ.validate_audit_bundle(
                    self.initial_ledgers,
                    dataset=dataset,
                )
        finally:
            png.write_bytes(original)

    def test_missing_fourth_shard_is_rejected(self) -> None:
        dataset = ADJ.validate_processed_dataset(
            self.fixture.dataset,
            self.fixture.library,
        )
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "exactly 4 completed ledgers",
        ):
            ADJ.validate_audit_bundle(
                self.initial_ledgers[:3],
                dataset=dataset,
            )

    def test_invalid_bool_padding_and_non_utc_time_are_rejected(self) -> None:
        base = {
            "id": "fhp_" + "a" * 24,
            "decision": "recrop",
            "reject_reason": "",
            "recrop_bbox_px": [1, 2, 10, 20],
            "padding_px": True,
            "reviewer": "unit",
            "reviewed_at": "2026-07-31T00:00:00Z",
            "notes": "fix",
            "cell_index": 1,
        }
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "padding_px must be an integer",
        ):
            ADJ._validate_decision_semantics(
                base,
                shard_tag="shard-000-of-004",
                sheet="sheet.png",
                ledger_path=Path("ledger.csv"),
                ledger_sha256="1" * 64,
            )
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "ending in Z",
        ):
            ADJ._validate_decision_semantics(
                {
                    **base,
                    "padding_px": 2,
                    "reviewed_at": "2026-07-31T09:00:00+09:00",
                },
                shard_tag="shard-000-of-004",
                sheet="sheet.png",
                ledger_path=Path("ledger.csv"),
                ledger_sha256="1" * 64,
            )

    def test_recrop_cannot_finalize_without_repair_recheck(self) -> None:
        args = ADJ.build_argument_parser().parse_args(
            [
                "finalize",
                "--adjudication-root",
                str(self.preparation),
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                "--output-root",
                str(self.root / "must-not-finalize"),
            ]
        )
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "--repair-processed-root is required",
        ):
            ADJ.run(args)
        self.assertFalse((self.root / "must-not-finalize").exists())

    def test_final_dataset_contains_only_passes_and_rechecked_successor(self) -> None:
        output = self.root / "final-accepted"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            summary = ADJ.run(self.final_args(output))
        self.assertEqual(summary["accepted_records"], 7)
        self.assertEqual(summary["accepted_rechecked_successors"], 1)
        records = read_jsonl(output / ADJ.FINAL_MANIFEST_NAME)
        ids = {str(row["id"]) for row in records}
        self.assertNotIn(self.reject_id, ids)
        self.assertNotIn(self.recrop_id, ids)
        successor = next(
            row for row in records if row["adjudication"]["manual_recrop"] is True
        )
        self.assertTrue(successor["adjudication"]["successor_recheck_passed"])
        self.assertEqual(
            successor["adjudication"]["root_original_processed_id"],
            self.recrop_id,
        )
        for record in records:
            self.assertFalse(record["synthetic"])
            self.assertIsNone(record["synthetic_provenance"])
            for descriptor in record["assets"].values():
                path = output / descriptor["path"]
                self.assertTrue(path.is_file())
                self.assertEqual(
                    ADJ.sha256_file(path),
                    descriptor["file_sha256"],
                )
                self.assertFalse("qa" in Path(descriptor["path"]).parts)
        marker = json.loads(
            (output / ADJ.FINAL_MARKER_NAME).read_text(encoding="utf-8")
        )
        self.assertTrue(marker["completed"])
        self.assertEqual(marker["counts"]["synthetic"], 0)
        policy = json.loads(
            (output / ADJ.FINAL_POLICY_NAME).read_text(encoding="utf-8")
        )
        self.assertFalse(policy["synthetic_allowed"])
        rejects = read_jsonl(output / ADJ.FINAL_REJECTS_NAME)
        self.assertEqual(len(rejects), 1)
        self.assertEqual(rejects[0]["id"], self.reject_id)
        overwrite_args = self.final_args(output)
        overwrite_args.overwrite = True
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            overwritten = ADJ.run(overwrite_args)
        self.assertEqual(overwritten["accepted_records"], 7)
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())
        retained = list(output.parent.glob(f".{output.name}.backup-*"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(Path(overwritten["retained_previous_output"]), retained[0])
        self.assertTrue((retained[0] / ADJ.FINAL_MARKER_NAME).is_file())

    def test_finalization_refuses_to_mark_fewer_than_five_thousand(self) -> None:
        output = self.root / "below-production-minimum"
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "below the required minimum of 5000",
        ):
            ADJ.run(self.final_args(output))
        self.assertFalse(output.exists())

    def test_final_population_rejects_duplicate_lineage_or_real_crop(self) -> None:
        records = self.fixture.records()
        first = ADJ._decorate_accepted_original(
            records[0],
            ADJ.validate_audit_bundle(
                self.initial_ledgers,
                dataset=ADJ.validate_processed_dataset(
                    self.fixture.dataset,
                    self.fixture.library,
                ),
            ).decisions[str(records[0]["id"])],
        )
        duplicate_root = json.loads(json.dumps(records[1]))
        duplicate_root["root_real_id"] = first["root_real_id"]
        duplicate_root["assets"] = {
            key: {
                **value,
                "id": f"{value['id']}-duplicate-root",
                "path": value["path"].replace(
                    str(records[1]["id"]),
                    f"{records[1]['id']}-duplicate-root",
                ),
            }
            for key, value in duplicate_root["assets"].items()
        }
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "root lineage appears more than once",
        ):
            ADJ._validate_final_population([first, duplicate_root])

        duplicate_crop = json.loads(json.dumps(records[1]))
        duplicate_crop["crop_sha256"] = first["crop_sha256"]
        duplicate_crop["assets"] = {
            key: {
                **value,
                "id": f"{value['id']}-duplicate-crop",
                "path": value["path"].replace(
                    str(records[1]["id"]),
                    f"{records[1]['id']}-duplicate-crop",
                ),
            }
            for key, value in duplicate_crop["assets"].items()
        }
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "duplicate final real crop",
        ):
            ADJ._validate_final_population([first, duplicate_crop])

    def test_coordinated_preparation_lineage_tamper_is_rejected(self) -> None:
        lineage_path = self.preparation / ADJ.RECROP_LINEAGE_NAME
        marker_path = self.preparation / ADJ.PREP_MARKER_NAME
        original_lineage = lineage_path.read_bytes()
        original_marker = marker_path.read_bytes()
        try:
            rows = read_jsonl(lineage_path)
            rows[0]["bbox_px"][0] += 1
            lineage_path.write_bytes(ADJ.jsonl_bytes(rows))
            marker = json.loads(original_marker)
            marker["outputs"][ADJ.RECROP_LINEAGE_NAME] = ADJ.sha256_file(lineage_path)
            marker_path.write_bytes(ADJ.json_bytes(marker))
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "recrop lineage does not exactly match",
            ):
                with mock.patch.object(
                    ADJ,
                    "MINIMUM_ACCEPTED_RECORDS",
                    1,
                ):
                    ADJ.run(
                        self.final_args(
                            self.root / "tampered-lineage-must-not-finalize"
                        )
                    )
        finally:
            lineage_path.write_bytes(original_lineage)
            marker_path.write_bytes(original_marker)
        self.assertFalse((self.root / "tampered-lineage-must-not-finalize").exists())

    def test_coordinated_same_chapter_source_substitution_is_rejected(self) -> None:
        preparation = self.root / "source-substitution-preparation"
        repair = self.root / "source-substitution-repair"
        prepare_args = ADJ.build_argument_parser().parse_args(
            [
                "prepare",
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                *sum(
                    (["--ledger", str(path)] for path in self.initial_ledgers),
                    [],
                ),
                "--output-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
            ]
        )
        ADJ.run(prepare_args)
        queue = preparation / ADJ.REPAIR_QUEUE_NAME
        candidate = read_jsonl(queue / "manifest.jsonl")[0]
        original_source = self.fixture.library.joinpath(
            *PurePosixPath(candidate["source_image_path"]).parts
        )
        substituted_source = original_source.with_name("other.png")
        with Image.open(original_source) as opened:
            substituted_page = opened.convert("RGB").transpose(
                Image.Transpose.FLIP_LEFT_RIGHT
            )
        substituted_page.save(substituted_source, format="PNG")
        source_bytes = substituted_source.read_bytes()
        crop = substituted_page.crop(tuple(candidate["crop_bbox_px"])).convert("RGB")
        raw_bytes = ADJ.encode_png(crop)
        clip = ADJ.letterbox_rgb(crop)
        try:
            clip_bytes = ADJ.encode_png(clip)
        finally:
            clip.close()
        (queue / candidate["image_path"]).write_bytes(raw_bytes)
        (queue / candidate["clip_image_path"]).write_bytes(clip_bytes)
        source_relative = substituted_source.relative_to(
            self.fixture.library
        ).as_posix()
        source_sha = ADJ.sha256_bytes(source_bytes)
        crop_sha = ADJ.pixel_sha256(crop)
        candidate.update(
            {
                "source_image_path": source_relative,
                "source_page_sha256": source_sha,
                "source_page_content_signature": {
                    "sha256": source_sha,
                    "size": len(source_bytes),
                    "width": substituted_page.width,
                    "height": substituted_page.height,
                },
                "page_name": substituted_source.name,
                "crop_sha256": crop_sha,
                "asset_file_sha256": {
                    "image_path": ADJ.sha256_bytes(raw_bytes),
                    "clip_image_path": ADJ.sha256_bytes(clip_bytes),
                },
            }
        )
        candidate["manual_recrop"]["crop_sha256"] = crop_sha
        crop.close()
        substituted_page.close()

        lineage_path = preparation / ADJ.RECROP_LINEAGE_NAME
        lineage = read_jsonl(lineage_path)
        lineage[0].update(
            {
                "repair_candidate_record_sha256": ADJ.sha256_json(candidate),
                "source_image_path": source_relative,
                "source_page_sha256": source_sha,
                "crop_sha256": crop_sha,
            }
        )
        lineage_path.write_bytes(ADJ.jsonl_bytes(lineage))
        marker_path = preparation / ADJ.PREP_MARKER_NAME
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        old_binding = marker["repair_queue"]
        queue_binding = ADJ.write_repair_queue_contract(
            queue_physical_root=queue,
            queue_declared_root=queue,
            library_root=self.fixture.library,
            candidates=[candidate],
            preparation_signature_sha256=marker["preparation_signature_sha256"],
        )
        report_path = preparation / ADJ.PREP_REPORT_NAME
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["repair_queue"] = queue_binding
        report["postprocess_command"] = report["postprocess_command"].replace(
            old_binding["manifest_sha256"],
            queue_binding["manifest_sha256"],
        )
        report_path.write_bytes(ADJ.json_bytes(report))
        marker["repair_queue"] = queue_binding
        marker["outputs"].update(
            {
                ADJ.RECROP_LINEAGE_NAME: ADJ.sha256_file(lineage_path),
                ADJ.PREP_REPORT_NAME: ADJ.sha256_file(report_path),
                f"{ADJ.REPAIR_QUEUE_NAME}/manifest.jsonl": queue_binding[
                    "manifest_sha256"
                ],
                f"{ADJ.REPAIR_QUEUE_NAME}/.fontclip-hard-candidates.json": (
                    queue_binding["marker_sha256"]
                ),
                f"{ADJ.REPAIR_QUEUE_NAME}/report.json": queue_binding["report_sha256"],
            }
        )
        marker_path.write_bytes(ADJ.json_bytes(marker))

        post_args = QA_FIXTURE.POST.build_argument_parser().parse_args(
            [
                "--input-root",
                str(queue),
                "--library-root",
                str(self.fixture.library),
                "--output-root",
                str(repair),
                "--expected-input-manifest-sha256",
                queue_binding["manifest_sha256"],
                "--minimum-input-candidates",
                "1",
                "--minimum-processed-records",
                "0",
                "--no-ctd",
                "--quiet",
            ]
        )
        QA_FIXTURE.POST.run(post_args)
        recheck_args = ADJ.build_argument_parser().parse_args(
            [
                "build-recheck",
                "--adjudication-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
                "--library-root",
                str(self.fixture.library),
                "--quiet",
            ]
        )
        try:
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "exact source-page derivation",
            ):
                ADJ.run(recheck_args)
        finally:
            substituted_source.unlink(missing_ok=True)

    def test_postprocess_reject_is_excluded_while_survivor_is_rechecked(
        self,
    ) -> None:
        records = self.fixture.records()
        second_recrop_id = str(records[3]["id"])
        qa_dir = self.fixture.dataset / "qa-mixed-outcome-initial"
        ledgers = build_completed_ledgers(
            dataset=self.fixture.dataset,
            library=self.fixture.library,
            qa_dir=qa_dir,
            decisions={
                self.reject_id: ("reject", "known bad mask"),
                self.recrop_id: ("recrop", "force processing reject"),
                second_recrop_id: ("recrop", "surviving manual recrop"),
            },
            reviewer="mixed-outcome-initial-reviewer",
        )
        preparation = self.root / "mixed-outcome-preparation"
        repair = self.root / "mixed-outcome-repair"
        prepare_args = ADJ.build_argument_parser().parse_args(
            [
                "prepare",
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                *sum((["--ledger", str(path)] for path in ledgers), []),
                "--output-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
            ]
        )
        ADJ.run(prepare_args)
        queue = preparation / ADJ.REPAIR_QUEUE_NAME
        post_args = QA_FIXTURE.POST.build_argument_parser().parse_args(
            [
                "--input-root",
                str(queue),
                "--library-root",
                str(self.fixture.library),
                "--output-root",
                str(repair),
                "--expected-input-manifest-sha256",
                ADJ.sha256_file(queue / "manifest.jsonl"),
                "--minimum-input-candidates",
                "2",
                "--minimum-processed-records",
                "0",
                "--no-ctd",
                "--quiet",
            ]
        )
        original_builder = QA_FIXTURE.POST._build_processed_record

        def selective_reject(item, *builder_args, **builder_kwargs):
            manual = item.row.get("manual_recrop", {})
            if manual.get("parent_processed_id") == self.recrop_id:
                raise QA_FIXTURE.POST.RecoverableMaskError("unit_forced_repair_reject")
            return original_builder(item, *builder_args, **builder_kwargs)

        with mock.patch.object(
            QA_FIXTURE.POST,
            "_build_processed_record",
            side_effect=selective_reject,
        ):
            post_summary = QA_FIXTURE.POST.run(post_args)
        self.assertEqual(post_summary["processed_records"], 1)
        self.assertEqual(post_summary["rejected_records"], 1)

        recheck_qa = repair / "qa-mixed-recheck"
        recheck_args = ADJ.build_argument_parser().parse_args(
            [
                "build-recheck",
                "--adjudication-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
                "--library-root",
                str(self.fixture.library),
                "--qa-dir",
                str(recheck_qa),
                "--contact-sheet-size",
                "2",
                "--quiet",
            ]
        )
        recheck_summary = ADJ.run(recheck_args)
        self.assertEqual(recheck_summary["successors"], 1)
        self.assertEqual(recheck_summary["repair_postprocess_rejected"], 1)
        recheck_ledgers = build_completed_ledgers(
            dataset=repair,
            library=self.fixture.library,
            qa_dir=recheck_qa,
            decisions={},
            reviewer="mixed-outcome-successor-reviewer",
        )
        final = self.root / "mixed-outcome-final"
        final_args = ADJ.build_argument_parser().parse_args(
            [
                "finalize",
                "--adjudication-root",
                str(preparation),
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                "--repair-processed-root",
                str(repair),
                *sum(
                    (["--recheck-ledger", str(path)] for path in recheck_ledgers),
                    [],
                ),
                "--output-root",
                str(final),
            ]
        )
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            summary = ADJ.run(final_args)
        self.assertEqual(summary["accepted_records"], 6)
        self.assertEqual(summary["accepted_rechecked_successors"], 1)
        rejects = read_jsonl(final / ADJ.FINAL_REJECTS_NAME)
        by_stage = {str(row["id"]): row["stage"] for row in rejects}
        self.assertEqual(
            by_stage,
            {
                self.reject_id: "initial_exhaustive_review",
                self.recrop_id: "repair_postprocess_reject",
            },
        )
        repair_reject = next(row for row in rejects if row["id"] == self.recrop_id)
        self.assertEqual(
            repair_reject["repair_postprocess_failure_reasons"],
            ["unit_forced_repair_reject"],
        )

    def test_all_postprocess_rejects_need_no_empty_recheck_ledgers(self) -> None:
        preparation = self.root / "all-rejected-preparation"
        repair = self.root / "all-rejected-repair"
        prepare_args = ADJ.build_argument_parser().parse_args(
            [
                "prepare",
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                *sum(
                    (["--ledger", str(path)] for path in self.initial_ledgers),
                    [],
                ),
                "--output-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
            ]
        )
        ADJ.run(prepare_args)
        queue = preparation / ADJ.REPAIR_QUEUE_NAME
        post_args = QA_FIXTURE.POST.build_argument_parser().parse_args(
            [
                "--input-root",
                str(queue),
                "--library-root",
                str(self.fixture.library),
                "--output-root",
                str(repair),
                "--expected-input-manifest-sha256",
                ADJ.sha256_file(queue / "manifest.jsonl"),
                "--minimum-input-candidates",
                "1",
                "--minimum-processed-records",
                "0",
                "--no-ctd",
                "--quiet",
            ]
        )
        with mock.patch.object(
            QA_FIXTURE.POST,
            "_build_processed_record",
            side_effect=QA_FIXTURE.POST.RecoverableMaskError(
                "unit_all_repair_rejected"
            ),
        ):
            post_summary = QA_FIXTURE.POST.run(post_args)
        self.assertEqual(post_summary["processed_records"], 0)
        self.assertEqual(post_summary["rejected_records"], 1)
        recheck_args = ADJ.build_argument_parser().parse_args(
            [
                "build-recheck",
                "--adjudication-root",
                str(preparation),
                "--repair-processed-root",
                str(repair),
                "--library-root",
                str(self.fixture.library),
                "--quiet",
            ]
        )
        recheck_summary = ADJ.run(recheck_args)
        self.assertEqual(recheck_summary["phase"], "recheck_not_required")
        self.assertEqual(recheck_summary["repair_postprocess_rejected"], 1)
        final = self.root / "all-rejected-final"
        final_args = ADJ.build_argument_parser().parse_args(
            [
                "finalize",
                "--adjudication-root",
                str(preparation),
                "--dataset",
                str(self.fixture.dataset),
                "--library-root",
                str(self.fixture.library),
                "--repair-processed-root",
                str(repair),
                "--output-root",
                str(final),
            ]
        )
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            summary = ADJ.run(final_args)
        self.assertEqual(summary["accepted_records"], 6)
        self.assertEqual(summary["accepted_rechecked_successors"], 0)
        rejects = read_jsonl(final / ADJ.FINAL_REJECTS_NAME)
        self.assertEqual(
            {row["stage"] for row in rejects},
            {"initial_exhaustive_review", "repair_postprocess_reject"},
        )

    def test_forged_overwrite_marker_cannot_delete_unknown_file(self) -> None:
        victim = self.root / "forged-overwrite-victim"
        staging = self.root / "forged-overwrite-staging"
        victim.mkdir()
        staging.mkdir()
        user_file = victim / "user.txt"
        user_file.write_text("must survive", encoding="utf-8")
        (victim / ADJ.FINAL_MARKER_NAME).write_bytes(
            ADJ.json_bytes(
                {
                    "tool": ADJ.TOOL_ID,
                    "schema_version": ADJ.SCHEMA_VERSION,
                    "phase": "finalized",
                    "completed": True,
                    "output_root": str(victim),
                }
            )
        )
        with self.assertRaisesRegex(
            ADJ.HardAdjudicationError,
            "exact finalized ownership contract",
        ):
            ADJ._commit_directory(
                staging,
                victim,
                marker_name=ADJ.FINAL_MARKER_NAME,
                expected_tool=ADJ.TOOL_ID,
                overwrite=True,
            )
        self.assertEqual(user_file.read_text(encoding="utf-8"), "must survive")
        self.assertTrue(staging.is_dir())

    def test_overwrite_race_rolls_back_original_output(self) -> None:
        output = self.root / "old-output-race-original"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        staging = self.root / "race-valid-staging"
        shutil.copytree(output, staging)
        original_validator = ADJ._validate_owned_output_inventory
        injected = False

        def racing_validator(physical_root, **kwargs):
            nonlocal injected
            result = original_validator(physical_root, **kwargs)
            if physical_root.resolve() == output.resolve() and not injected:
                injected = True
                (output / "raced-user-file.txt").write_text(
                    "preserve me",
                    encoding="utf-8",
                )
            return result

        with mock.patch.object(
            ADJ,
            "_validate_owned_output_inventory",
            side_effect=racing_validator,
        ):
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "unknown or missing",
            ):
                ADJ._commit_directory(
                    staging,
                    output,
                    marker_name=ADJ.FINAL_MARKER_NAME,
                    expected_tool=ADJ.TOOL_ID,
                    overwrite=True,
                )
        self.assertEqual(
            (output / "raced-user-file.txt").read_text(encoding="utf-8"),
            "preserve me",
        )
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())
        self.assertTrue(staging.is_dir())
        self.assertEqual(
            list(output.parent.glob(f".{output.name}.backup-*")),
            [],
        )
        (output / "raced-user-file.txt").unlink()

    def test_staging_race_rolls_back_original_output(self) -> None:
        output = self.root / "staging-race-original"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        staging = self.root / "staging-race-new-tree"
        shutil.copytree(output, staging)
        original_validator = ADJ._validate_owned_output_inventory
        injected = False

        def racing_validator(physical_root, **kwargs):
            nonlocal injected
            result = original_validator(physical_root, **kwargs)
            if physical_root.resolve() == staging.resolve() and not injected:
                injected = True
                (staging / "raced-staging-file.txt").write_text(
                    "untrusted late write",
                    encoding="utf-8",
                )
            return result

        with mock.patch.object(
            ADJ,
            "_validate_owned_output_inventory",
            side_effect=racing_validator,
        ):
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "unknown or missing",
            ):
                ADJ._commit_directory(
                    staging,
                    output,
                    marker_name=ADJ.FINAL_MARKER_NAME,
                    expected_tool=ADJ.TOOL_ID,
                    overwrite=True,
                )
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())
        self.assertFalse((output / "raced-staging-file.txt").exists())
        self.assertEqual(
            (staging / "raced-staging-file.txt").read_text(encoding="utf-8"),
            "untrusted late write",
        )
        self.assertEqual(
            list(output.parent.glob(f".{output.name}.backup-*")),
            [],
        )

    def test_existing_output_fails_before_staging_copy(self) -> None:
        output = self.root / "preflight-existing-output"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        with mock.patch.object(ADJ, "_new_staging") as new_staging:
            with self.assertRaisesRegex(FileExistsError, "use --overwrite"):
                with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
                    ADJ.run(self.final_args(output))
        new_staging.assert_not_called()

    def test_valid_owned_overwrite_retains_recoverable_backup(self) -> None:
        output = self.root / "valid-overwrite-original"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        staging = self.root / "valid-overwrite-staging"
        shutil.copytree(output, staging)
        ADJ._commit_directory(
            staging,
            output,
            marker_name=ADJ.FINAL_MARKER_NAME,
            expected_tool=ADJ.TOOL_ID,
            overwrite=True,
        )
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())
        self.assertFalse(staging.exists())
        backups = list(output.parent.glob(f".{output.name}.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / ADJ.FINAL_MARKER_NAME).is_file())

    def test_late_backup_file_is_preserved_after_successful_overwrite(self) -> None:
        output = self.root / "late-backup-race-original"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        staging = self.root / "late-backup-race-staging"
        shutil.copytree(output, staging)
        original_validator = ADJ._validate_owned_output_inventory
        backup_validations = 0

        def racing_validator(physical_root, **kwargs):
            nonlocal backup_validations
            result = original_validator(physical_root, **kwargs)
            if physical_root.name.startswith(f".{output.name}.backup-"):
                backup_validations += 1
                if backup_validations == 2:
                    (physical_root / "late-user-file.txt").write_text(
                        "must remain recoverable",
                        encoding="utf-8",
                    )
            return result

        with mock.patch.object(
            ADJ,
            "_validate_owned_output_inventory",
            side_effect=racing_validator,
        ):
            ADJ._commit_directory(
                staging,
                output,
                marker_name=ADJ.FINAL_MARKER_NAME,
                expected_tool=ADJ.TOOL_ID,
                overwrite=True,
            )
        backups = list(output.parent.glob(f".{output.name}.backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(
            (backups[0] / "late-user-file.txt").read_text(encoding="utf-8"),
            "must remain recoverable",
        )
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())

    def test_finalize_preserves_failed_staging_with_late_unknown_file(self) -> None:
        output = self.root / "finalize-staging-race-original"
        with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
            ADJ.run(self.final_args(output))
        overwrite_args = self.final_args(output)
        overwrite_args.overwrite = True
        original_validator = ADJ._validate_owned_output_inventory
        injected = False

        def racing_validator(physical_root, **kwargs):
            nonlocal injected
            result = original_validator(physical_root, **kwargs)
            if (
                physical_root.name.startswith(f".{output.name}.staging-")
                and not injected
            ):
                injected = True
                (physical_root / "late-staging-user-file.txt").write_text(
                    "preserve failed staging",
                    encoding="utf-8",
                )
            return result

        with mock.patch.object(
            ADJ,
            "_validate_owned_output_inventory",
            side_effect=racing_validator,
        ):
            with self.assertRaisesRegex(
                ADJ.HardAdjudicationError,
                "unknown or missing",
            ):
                with mock.patch.object(ADJ, "MINIMUM_ACCEPTED_RECORDS", 1):
                    ADJ.run(overwrite_args)
        failed_staging = list(output.parent.glob(f".{output.name}.staging-*"))
        self.assertEqual(len(failed_staging), 1)
        self.assertEqual(
            (failed_staging[0] / "late-staging-user-file.txt").read_text(
                encoding="utf-8"
            ),
            "preserve failed staging",
        )
        self.assertFalse((output / "late-staging-user-file.txt").exists())
        self.assertTrue((output / ADJ.FINAL_MARKER_NAME).is_file())

    def test_default_minimum_gate_is_five_thousand(self) -> None:
        self.assertEqual(ADJ.MINIMUM_ACCEPTED_RECORDS, 5000)


if __name__ == "__main__":
    unittest.main()
