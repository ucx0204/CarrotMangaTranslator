from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "font_matching_orientation_audit.py"
SPEC = importlib.util.spec_from_file_location("orientation_audit", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def inventory_row(sample_id: str, orientation: str) -> dict:
    return {
        "sample_id": sample_id,
        "work_id": "work-a",
        "chapter_id": f"chapter-{sample_id}",
        "page_id": f"page-{sample_id}",
        "orientation": orientation,
        "provenance": {"qa_overlay": False, "synthetic": False},
    }


def assignment(sample_id: str, stage: str) -> dict:
    return {
        "sample_id": sample_id,
        "stage": stage,
        "assignment_id": f"assignment-{sample_id}-{stage}",
    }


class OrientationAuditTests(unittest.TestCase):
    def fixture(self, root: Path) -> tuple[Path, Path, Path, Path]:
        inventory = root / "inventory.jsonl"
        assignments = root / "assignments.jsonl"
        cards_root = root / "cards-root"
        cards = cards_root / "cards"
        cards.mkdir(parents=True)
        samples = [("a", "horizontal"), ("b", "vertical")]
        write_jsonl(inventory, [inventory_row(*sample) for sample in samples])
        write_jsonl(
            assignments,
            [
                assignment(sample_id, stage)
                for sample_id, _ in samples
                for stage in ("primary", "secondary")
            ],
        )
        manifest_cards = []
        for sample_id, _ in samples:
            card_path = cards / f"{sample_id}.png"
            card_path.write_bytes(f"card-{sample_id}".encode())
            manifest_cards.append(
                {
                    "assignment": {
                        "assignment_id": f"assignment-{sample_id}-primary",
                        "sample_id": sample_id,
                        "stage": "primary",
                    },
                    "artifact": {
                        "file": f"cards/{sample_id}.png",
                        "sha256": AUDIT.sha256_file(card_path),
                        "qa_overlay": True,
                        "watermark": "REVIEW-ONLY",
                    },
                }
            )
        card_manifest = cards_root / "manifest.json"
        write_json(
            card_manifest,
            {
                "qa_overlay": True,
                "training_asset": False,
                "cards": manifest_cards,
            },
        )
        return inventory, assignments, card_manifest, cards_root

    def test_builds_exactly_once_balanced_shards(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory, assignments, manifest, cards_root = self.fixture(root)
            output = root / "workspace"

            report = AUDIT.build_workspace(
                inventory_path=inventory,
                assignments_path=assignments,
                card_manifest_path=manifest,
                cards_root=cards_root,
                output_dir=output,
                shards=2,
                seed="fixture",
                expected_samples=2,
            )

            self.assertEqual(2, report["counts"]["samples"])
            self.assertEqual({"1": 1, "2": 1}, report["counts"]["by_shard"])
            tasks = AUDIT.read_jsonl(output / "tasks.jsonl", location="tasks")
            self.assertEqual({"a", "b"}, {row["sample_id"] for row in tasks})
            self.assertTrue(all("record_sha256" in row for row in tasks))

    def test_validates_original_detail_and_reports_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory, assignments, manifest, cards_root = self.fixture(root)
            workspace = root / "workspace"
            AUDIT.build_workspace(
                inventory_path=inventory,
                assignments_path=assignments,
                card_manifest_path=manifest,
                cards_root=cards_root,
                output_dir=workspace,
                shards=1,
                expected_samples=2,
            )
            tasks = AUDIT.read_jsonl(workspace / "tasks.jsonl", location="tasks")
            responses = []
            for task in tasks:
                responses.append(
                    {
                        "schema_version": AUDIT.SCHEMA_VERSION,
                        "record_type": AUDIT.RESPONSE_TYPE,
                        "sample_id": task["sample_id"],
                        "primary_assignment_id": task["primary_assignment_id"],
                        "card_sha256": task["card_sha256"],
                        "reviewer": "reviewer-a",
                        "viewed_original": True,
                        "actual_orientation": "vertical",
                        "confidence": 0.95,
                        "crop_status": "usable",
                        "notes": "원문의 실제 글자 흐름을 확인함",
                    }
                )
            response_path = root / "responses.jsonl"
            write_jsonl(response_path, responses)

            report = AUDIT.validate_responses(
                workspace=workspace,
                response_paths=[response_path],
            )

            self.assertTrue(report["complete"])
            self.assertEqual(1, report["counts"]["declared_mismatches"])

    def test_rejects_response_not_opened_at_original_detail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory, assignments, manifest, cards_root = self.fixture(root)
            workspace = root / "workspace"
            AUDIT.build_workspace(
                inventory_path=inventory,
                assignments_path=assignments,
                card_manifest_path=manifest,
                cards_root=cards_root,
                output_dir=workspace,
                shards=1,
                expected_samples=2,
            )
            task = AUDIT.read_jsonl(workspace / "tasks.jsonl", location="tasks")[0]
            response = {
                "schema_version": AUDIT.SCHEMA_VERSION,
                "record_type": AUDIT.RESPONSE_TYPE,
                "sample_id": task["sample_id"],
                "primary_assignment_id": task["primary_assignment_id"],
                "card_sha256": task["card_sha256"],
                "reviewer": "reviewer-a",
                "viewed_original": False,
                "actual_orientation": "horizontal",
                "confidence": 0.8,
                "crop_status": "usable",
                "notes": "not actually viewed",
            }
            response_path = root / "response.jsonl"
            write_jsonl(response_path, [response])

            with self.assertRaisesRegex(AUDIT.OrientationAuditError, "mandatory"):
                AUDIT.validate_responses(
                    workspace=workspace,
                    response_paths=[response_path],
                    allow_partial=True,
                )


if __name__ == "__main__":
    unittest.main()
