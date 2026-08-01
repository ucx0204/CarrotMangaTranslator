from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "revise_font_matching_recrop_proposals.py"
SPEC = importlib.util.spec_from_file_location("font_matching_recrop_revision", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REVISION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = REVISION
SPEC.loader.exec_module(REVISION)


def prior_proposal() -> dict[str, object]:
    return REVISION.seal(
        {
            "schema_version": "font-matching-orientation-recrop-proposal-v1",
            "record_type": "font_matching_orientation_recrop_proposal",
            "sample_id": "fm-parent",
            "action": "recrop",
            "actual_orientation": "vertical",
            "current_bbox_px": [20, 30, 40, 60],
            "recrop_bbox_px": [18, 28, 44, 66],
            "preview_bbox_px": [18, 28, 44, 66],
            "preview_crop_sha256": "a" * 64,
            "source_page_path": "works/w/chapters/c/pages/p.png",
            "source_page_sha256": "b" * 64,
            "reviewer": "first-reviewer",
            "reviewed_at": "2026-08-01T00:00:00Z",
            "note": "first proposal",
        }
    )


def intake() -> dict[str, object]:
    return {
        "successor_candidate_id": "fhcr-parent",
        "successor_candidate_record_sha256": "c" * 64,
    }


def decision(
    value: str,
    *,
    bbox: tuple[int, int, int, int] | None = None,
    padding: int = 0,
) -> SimpleNamespace:
    return SimpleNamespace(
        decision=value,
        reject_reason="bad crop" if value == "reject" else "",
        recrop_bbox_px=bbox,
        padding_px=padding,
        reviewer="recheck-reviewer",
        reviewed_at="2026-08-01T01:02:03Z",
        notes="tightened after direct source-page review",
        shard_tag="shard-000-of-004",
        sheet="sheet.png",
        cell_index=3,
        ledger_path="completed_shard-000-of-004.csv",
        ledger_sha256="d" * 64,
    )


class ProposalRevisionTests(unittest.TestCase):
    def revision_args(self, image: Image.Image) -> dict[str, object]:
        return {
            "sample_id": "fm-parent",
            "prior": prior_proposal(),
            "intake": intake(),
            "parent": {},
            "decoded": image,
            "current_bbox": (20, 30, 40, 60),
            "terminal_kind": "processed_successor",
            "terminal_record": {"id": "fhp-child"},
            "terminal_record_sha256": "e" * 64,
            "prior_proposals_sha256": "f" * 64,
            "repair_report_sha256": "1" * 64,
            "queue_manifest_sha256": "2" * 64,
        }

    def test_recrop_expands_padding_and_seals_direct_preview(self) -> None:
        image = Image.new("RGB", (100, 120), "white")
        try:
            args = self.revision_args(image)
            row = REVISION._revised_from_decision(
                **args,
                decision=decision("recrop", bbox=(10, 20, 30, 40), padding=3),
            )
        finally:
            image.close()
        self.assertEqual(row["action"], "recrop")
        self.assertEqual(row["recrop_bbox_px"], [7, 17, 33, 43])
        self.assertEqual(row["preview_bbox_px"], [7, 17, 33, 43])
        self.assertEqual(row["revision"]["recheck"]["padding_px"], 3)
        self.assertFalse(row["revision"]["synthetic"])
        self.assertFalse(row["revision"]["qa_overlay"])
        REVISION.repair.validate_seal(row, "revised proposal")

    def test_recheck_reject_becomes_replacement_without_orientation(self) -> None:
        image = Image.new("RGB", (100, 120), "white")
        try:
            row = REVISION._revised_from_decision(
                **self.revision_args(image),
                decision=decision("reject"),
            )
        finally:
            image.close()
        self.assertEqual(row["action"], "replace")
        self.assertIsNone(row["actual_orientation"])
        self.assertIsNone(row["recrop_bbox_px"])
        self.assertEqual(row["preview_bbox_px"], [20, 30, 40, 60])
        self.assertIn("bad crop", row["note"])
        REVISION.repair.validate_seal(row, "replacement proposal")

    def test_postprocess_reject_becomes_replacement_with_machine_lineage(self) -> None:
        image = Image.new("RGB", (100, 120), "white")
        args = self.revision_args(image)
        args["terminal_kind"] = "postprocess_reject"
        args["terminal_record"] = {
            "id": "fhcr-parent",
            "failure_reasons": ["mask_empty"],
        }
        try:
            row = REVISION._revised_from_decision(**args, decision=None)
        finally:
            image.close()
        self.assertEqual(row["action"], "replace")
        self.assertIn("mask_empty", row["note"])
        self.assertEqual(row["revision"]["terminal_kind"], "postprocess_reject")
        self.assertIsNone(row["revision"]["recheck"])

    def test_noop_recheck_recrop_is_rejected(self) -> None:
        image = Image.new("RGB", (100, 120), "white")
        try:
            with self.assertRaisesRegex(REVISION.ProposalRevisionError, "no-op"):
                REVISION._revised_from_decision(
                    **self.revision_args(image),
                    decision=decision("recrop", bbox=(18, 28, 44, 66), padding=0),
                )
        finally:
            image.close()

    def test_terminal_partition_accepts_successor_xor_reject(self) -> None:
        processed_record = {
            "id": "fhp-one",
            "assets": {"raw": {"parent_sample_id": "fhcr-one"}},
        }
        marker = {
            "signature": {"input_builder_attestation": {"manifest_sha256": "a" * 64}}
        }
        dataset = SimpleNamespace(
            records_by_id={"fhp-one": processed_record},
            result=SimpleNamespace(
                marker=marker,
                rejects=[{"id": "fhcr-two", "parent_id": "fhcr-two"}],
            ),
        )
        audit = SimpleNamespace(
            decisions={"fhp-one": decision("pass")},
            binding={},
            frozen_files={},
        )
        with (
            mock.patch.object(
                REVISION.hard_audit,
                "validate_processed_dataset",
                return_value=dataset,
            ),
            mock.patch.object(
                REVISION.hard_audit,
                "validate_audit_bundle",
                return_value=audit,
            ),
        ):
            result = REVISION._load_terminal_outcomes(
                processed_root=Path("processed"),
                library_root=Path("library"),
                ledgers=[Path(f"ledger-{index}.csv") for index in range(4)],
                queue_rows={"fhcr-one": {}, "fhcr-two": {}},
                queue_manifest_sha256="a" * 64,
            )
        self.assertEqual(set(result["processed_by_candidate"]), {"fhcr-one"})
        self.assertEqual(set(result["rejects_by_candidate"]), {"fhcr-two"})

    def test_terminal_partition_rejects_missing_outcome(self) -> None:
        marker = {
            "signature": {"input_builder_attestation": {"manifest_sha256": "a" * 64}}
        }
        dataset = SimpleNamespace(
            records_by_id={},
            result=SimpleNamespace(marker=marker, rejects=[]),
        )
        audit = SimpleNamespace(decisions={}, binding={}, frozen_files={})
        with (
            mock.patch.object(
                REVISION.hard_audit,
                "validate_processed_dataset",
                return_value=dataset,
            ),
            mock.patch.object(
                REVISION.hard_audit,
                "validate_audit_bundle",
                return_value=audit,
            ),
        ):
            with self.assertRaisesRegex(
                REVISION.ProposalRevisionError, "exactly one terminal outcome"
            ):
                REVISION._load_terminal_outcomes(
                    processed_root=Path("processed"),
                    library_root=Path("library"),
                    ledgers=[Path(f"ledger-{index}.csv") for index in range(4)],
                    queue_rows={"fhcr-missing": {}},
                    queue_manifest_sha256="a" * 64,
                )

    def test_validate_tree_detects_managed_file_tamper(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proposal = prior_proposal()
            (root / REVISION.PROPOSALS_FILE).write_bytes(
                REVISION.jsonl_bytes([proposal])
            )
            (root / REVISION.REVISIONS_FILE).write_bytes(b"")
            report = REVISION.seal(
                {
                    "schema_version": REVISION.SCHEMA_VERSION,
                    "record_type": "font_matching_recrop_proposal_revision_report",
                    "counts": {"targets": 1, "revisions": 0},
                    "outputs": {
                        "proposals_sha256": REVISION.sha256_file(
                            root / REVISION.PROPOSALS_FILE
                        ),
                        "revisions_sha256": REVISION.sha256_file(
                            root / REVISION.REVISIONS_FILE
                        ),
                    },
                }
            )
            (root / REVISION.REPORT_FILE).write_bytes(
                REVISION.json_bytes(report, pretty=True)
            )
            marker = {
                "schema_version": REVISION.SCHEMA_VERSION,
                "owner": REVISION.OWNER,
                "safe_replace": False,
                "declared_root": str(root),
                "managed_files": REVISION._managed_files(root),
            }
            (root / REVISION.MARKER_FILE).write_bytes(
                REVISION.json_bytes(marker, pretty=True)
            )
            REVISION.validate_tree(root)
            (root / REVISION.PROPOSALS_FILE).write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(
                REVISION.ProposalRevisionError, "stale proposal revision artifact"
            ):
                REVISION.validate_tree(root)


if __name__ == "__main__":
    unittest.main()
