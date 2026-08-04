from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts import build_manga_font_legacy15_train_overlay_v1 as overlay
from scripts import train_manga_font_student_v1 as trainer


REGISTRY_SHA = "a" * 64


def _legacy_row() -> dict:
    preferred = [overlay.LEGACY15_CANDIDATE_IDS[0]]
    unacceptable = list(overlay.LEGACY15_CANDIDATE_IDS[1:])
    row = {
        "font_judgment": {
            "acceptable": [],
            "marginal": [],
            "none_acceptable": False,
            "not_reviewed": [],
            "preferred": preferred,
            "unacceptable": unacceptable,
            "unrenderable": [],
        },
        "input_bindings": {"catalog_registry_sha256": REGISTRY_SHA},
        "provenance": {
            "approval": "completed_human_final_label",
            "qa_overlay": False,
            "synthetic": False,
        },
        "review_provenance": {},
        "role": {"primary": "sfx_impact"},
        "sample_id": "fm_test_legacy_train",
        "schema_version": trainer.HUMAN_SAMPLE_SCHEMA,
        "source": {"views": {name: {} for name in trainer.VIEW_NAMES}},
        "source_style": {
            **{field: 0.5 for field in trainer.STYLE_FIELDS},
            "unknown_fields": [],
        },
        "split": "train",
        "treatment": {
            field: values[0] for field, values in trainer.TREATMENT_VALUES.items()
        },
        "work_id": "work_train_only",
    }
    return trainer.seal_record(row)


def _write_bundle(root: Path) -> None:
    root.mkdir()
    promoted = overlay._promote_legacy_train_row(  # noqa: SLF001
        _legacy_row(),
        catalog_registry_sha256=REGISTRY_SHA,
        legacy_samples_sha256="b" * 64,
    )
    overlay_path = root / overlay.OVERLAY_FILE
    overlay_path.write_bytes(
        (trainer.canonical_json(promoted) + "\n").encode("utf-8")
    )
    descriptor = overlay._descriptor(overlay_path, record_count=1)  # noqa: SLF001
    bindings = {
        "base_full22_export": {
            "manifest_sha256": "1" * 64,
            "marker_sha256": "2" * 64,
            "report_sha256": "3" * 64,
            "root_name": "strict-full22",
            "samples_sha256": "4" * 64,
            "skipped_test_row_count": 1,
            "train_record_count": 1,
            "train_sample_ids_sha256": "5" * 64,
            "train_work_ids_sha256": "6" * 64,
            "val_record_count": 1,
        },
        "catalog_registry_sha256": REGISTRY_SHA,
        "legacy_export": {
            "manifest_sha256": "7" * 64,
            "marker_sha256": "8" * 64,
            "report_sha256": "9" * 64,
            "root_name": "legacy15",
            "samples_byte_size": 10,
            "samples_record_count": 4,
            "samples_sha256": "b" * 64,
        },
        "legacy_manifest_candidate_count": 15,
        "legacy_non_train_rows_byte_skipped": 2,
        "legacy_test_rows_byte_skipped": 1,
        "legacy_train_rows_json_deserialized": 2,
        "legacy_val_rows_byte_skipped": 1,
        "overlapping_strict_full22_train_rows_preserved": 1,
    }
    bindings["combined_authority_sha256"] = trainer.sha256_bytes(
        trainer.canonical_json(bindings).encode("utf-8")
    )
    manifest = trainer.seal_record(
        {
            "artifacts": {overlay.OVERLAY_FILE: descriptor},
            "bindings": copy.deepcopy(bindings),
            "candidate_ids": list(overlay.FULL22_CANDIDATE_IDS),
            "invariants": {
                "base_full22_train_rows_replaced": 0,
                "legacy_non_train_labels_deserialized": 0,
                "legacy_train_addition_count": 1,
                "label_scope": "legacy15_only",
                "successor_candidate_ids": list(
                    overlay.SUCCESSOR_ONLY_CANDIDATE_IDS
                ),
                "successor_candidates_used_as_negatives": False,
            },
            "record_type": "manga_font_legacy15_train_overlay_manifest",
            "schema_version": overlay.SCHEMA_VERSION,
        }
    )
    manifest_path = root / overlay.MANIFEST_FILE
    manifest_path.write_bytes(trainer.json_bytes(manifest, pretty=True))
    report = trainer.seal_record(
        {
            "artifacts": {overlay.OVERLAY_FILE: descriptor},
            "bindings": copy.deepcopy(bindings),
            "checks": {
                "base_hidden_test_labels_deserialized": 0,
                "base_hidden_test_pixels_opened": 0,
                "legacy_non_train_labels_deserialized": 0,
                "legacy_non_train_pixels_opened": 0,
                "new7_negative_supervision_count": 0,
                "strict_train_overlap_preserved": 1,
                "val_rows_modified": 0,
            },
            "combined_train_record_count": 2,
            "manifest_sha256": trainer.sha256_file(manifest_path),
            "record_type": "manga_font_legacy15_train_overlay_report",
            "schema_version": overlay.SCHEMA_VERSION,
            "train_addition_count": 1,
        }
    )
    report_path = root / overlay.REPORT_FILE
    report_path.write_bytes(trainer.json_bytes(report, pretty=True))
    _refresh_marker(root)


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_sealed(path: Path, row: dict) -> None:
    row.pop("record_sha256", None)
    path.write_bytes(trainer.json_bytes(trainer.seal_record(row), pretty=True))


def _refresh_marker(root: Path) -> None:
    marker = {
        "artifacts": {
            overlay.MANIFEST_FILE: trainer.sha256_file(root / overlay.MANIFEST_FILE),
            overlay.OVERLAY_FILE: trainer.sha256_file(root / overlay.OVERLAY_FILE),
            overlay.REPORT_FILE: trainer.sha256_file(root / overlay.REPORT_FILE),
        },
        "owner": overlay.OWNER,
        "safe_replace": True,
        "schema_version": overlay.SCHEMA_VERSION,
    }
    (root / overlay.MARKER_FILE).write_bytes(trainer.json_bytes(marker, pretty=True))


def _reseal_manifest_and_report(root: Path, manifest: dict, report: dict) -> None:
    manifest_path = root / overlay.MANIFEST_FILE
    _write_sealed(manifest_path, manifest)
    report["manifest_sha256"] = trainer.sha256_file(manifest_path)
    _write_sealed(root / overlay.REPORT_FILE, report)
    _refresh_marker(root)


class Legacy15TrainOverlayTests(unittest.TestCase):
    def test_candidate_partition_is_exact_15_plus_7(self) -> None:
        self.assertEqual(len(overlay.LEGACY15_CANDIDATE_IDS), 15)
        self.assertEqual(len(overlay.SUCCESSOR_ONLY_CANDIDATE_IDS), 7)
        self.assertEqual(
            set(overlay.LEGACY15_CANDIDATE_IDS)
            | set(overlay.SUCCESSOR_ONLY_CANDIDATE_IDS),
            set(overlay.FULL22_CANDIDATE_IDS),
        )
        self.assertFalse(
            set(overlay.LEGACY15_CANDIDATE_IDS)
            & set(overlay.SUCCESSOR_ONLY_CANDIDATE_IDS)
        )

    def test_promotion_masks_every_successor_candidate(self) -> None:
        promoted = overlay._promote_legacy_train_row(  # noqa: SLF001
            _legacy_row(),
            catalog_registry_sha256=REGISTRY_SHA,
            legacy_samples_sha256="b" * 64,
        )
        example = overlay.validate_partial_human_row(
            promoted,
            candidate_ids=overlay.FULL22_CANDIDATE_IDS,
            catalog_registry_sha256=REGISTRY_SHA,
            location="test promoted row",
        )
        self.assertEqual(
            promoted["font_judgment"]["not_reviewed"],
            list(overlay.SUCCESSOR_ONLY_CANDIDATE_IDS),
        )
        self.assertEqual(example.positive_indices, (0,))
        self.assertEqual(example.eligible_indices, tuple(range(15)))
        self.assertFalse(
            promoted["provenance"]["legacy15_train_overlay"][
                "successor_candidates_used_as_negatives"
            ]
        )

    def test_successor_candidate_cannot_leak_into_negative_tier(self) -> None:
        promoted = overlay._promote_legacy_train_row(  # noqa: SLF001
            _legacy_row(),
            catalog_registry_sha256=REGISTRY_SHA,
            legacy_samples_sha256="b" * 64,
        )
        drifted = copy.deepcopy(promoted)
        drifted.pop("record_sha256")
        leaked = drifted["font_judgment"]["not_reviewed"].pop()
        drifted["font_judgment"]["unacceptable"].append(leaked)
        drifted = trainer.seal_record(drifted)
        with self.assertRaises(overlay.Legacy15TrainOverlayError):
            overlay.validate_partial_human_row(
                drifted,
                candidate_ids=overlay.FULL22_CANDIDATE_IDS,
                catalog_registry_sha256=REGISTRY_SHA,
                location="test leaked negative",
            )

    def test_partial_row_rejects_candidate_order_drift(self) -> None:
        promoted = overlay._promote_legacy_train_row(  # noqa: SLF001
            _legacy_row(),
            catalog_registry_sha256=REGISTRY_SHA,
            legacy_samples_sha256="b" * 64,
        )
        wrong_order = tuple(reversed(overlay.FULL22_CANDIDATE_IDS))
        with self.assertRaises(overlay.Legacy15TrainOverlayError):
            overlay.validate_partial_human_row(
                promoted,
                candidate_ids=wrong_order,
                catalog_registry_sha256=REGISTRY_SHA,
                location="test order drift",
            )

    def test_minimal_sealed_bundle_validates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "overlay"
            _write_bundle(root)
            result = overlay.validate_overlay(
                root,
                catalog_registry_sha256=REGISTRY_SHA,
            )
            self.assertEqual(result["record_count"], 1)
            self.assertEqual(result["new7_negative_supervision_count"], 0)

    def test_report_binding_drift_is_rejected_even_when_resealed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "overlay"
            _write_bundle(root)
            report_path = root / overlay.REPORT_FILE
            report = _read(report_path)
            report["bindings"]["legacy_train_rows_json_deserialized"] = 99
            _write_sealed(report_path, report)
            _refresh_marker(root)
            with self.assertRaises(overlay.Legacy15TrainOverlayError):
                overlay.validate_overlay(root, catalog_registry_sha256=REGISTRY_SHA)

    def test_combined_authority_drift_is_rejected_when_fully_resealed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "overlay"
            _write_bundle(root)
            manifest = _read(root / overlay.MANIFEST_FILE)
            report = _read(root / overlay.REPORT_FILE)
            manifest["bindings"]["combined_authority_sha256"] = "0" * 64
            report["bindings"]["combined_authority_sha256"] = "0" * 64
            _reseal_manifest_and_report(root, manifest, report)
            with self.assertRaises(overlay.Legacy15TrainOverlayError):
                overlay.validate_overlay(root, catalog_registry_sha256=REGISTRY_SHA)

    def test_resealed_fake_legacy_lineage_is_rejected(self) -> None:
        promoted = overlay._promote_legacy_train_row(  # noqa: SLF001
            _legacy_row(),
            catalog_registry_sha256=REGISTRY_SHA,
            legacy_samples_sha256="b" * 64,
        )
        drifted = copy.deepcopy(promoted)
        drifted.pop("record_sha256")
        drifted["provenance"]["legacy15_train_overlay"][
            "source_legacy_train_record_sha256"
        ] = "c" * 64
        drifted["review_provenance"]["legacy15_train_overlay"][
            "source_legacy_train_record_sha256"
        ] = "c" * 64
        drifted = trainer.seal_record(drifted)
        with self.assertRaisesRegex(
            overlay.Legacy15TrainOverlayError, "source lineage drifted"
        ):
            overlay.validate_partial_human_row(
                drifted,
                candidate_ids=overlay.FULL22_CANDIDATE_IDS,
                catalog_registry_sha256=REGISTRY_SHA,
                location="test fake source lineage",
                legacy_samples_sha256="b" * 64,
            )


if __name__ == "__main__":
    unittest.main()
