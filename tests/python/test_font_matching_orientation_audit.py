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

    def test_applies_corrected_orientation_and_excludes_bad_crops(self) -> None:
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
            task_by_id = {task["sample_id"]: task for task in tasks}
            responses = []
            for sample_id, orientation, crop_status in (
                ("a", "vertical", "usable"),
                ("b", "mixed", "mixed_hierarchy"),
            ):
                task = task_by_id[sample_id]
                responses.append(
                    {
                        "schema_version": AUDIT.SCHEMA_VERSION,
                        "record_type": AUDIT.RESPONSE_TYPE,
                        "sample_id": sample_id,
                        "primary_assignment_id": task["primary_assignment_id"],
                        "card_sha256": task["card_sha256"],
                        "reviewer": "reviewer-a",
                        "viewed_original": True,
                        "actual_orientation": orientation,
                        "confidence": 0.95,
                        "crop_status": crop_status,
                        "notes": "원문의 실제 글자 흐름과 crop 계층을 확인함",
                    }
                )
            response_path = root / "responses.jsonl"
            write_jsonl(response_path, responses)
            master = root / "master.jsonl"
            write_jsonl(
                master,
                [
                    {
                        "id": sample_id,
                        "metadata": {"orientation": orientation},
                        "provenance": {"qa_overlay": False, "synthetic": False},
                    }
                    for sample_id, orientation in (
                        ("a", "horizontal"),
                        ("b", "vertical"),
                    )
                ],
            )
            output = root / "corrected"

            report = AUDIT.apply_orientation_decisions(
                workspace=workspace,
                response_paths=[response_path],
                inventory_path=inventory,
                master_path=master,
                output_dir=output,
            )

            self.assertEqual(1, report["counts"]["accepted"])
            self.assertEqual(1, report["counts"]["rejected"])
            corrected_master = AUDIT.read_jsonl(
                output / "master.jsonl", location="corrected master"
            )
            self.assertEqual(["a"], [row["id"] for row in corrected_master])
            self.assertEqual("vertical", corrected_master[0]["metadata"]["orientation"])
            corrected_inventory = AUDIT.read_jsonl(
                output / "inventory.jsonl", location="corrected inventory"
            )
            self.assertEqual(["a"], [row["sample_id"] for row in corrected_inventory])
            self.assertEqual(
                report["hashes"]["corrected_master_sha256"],
                corrected_inventory[0]["master_manifest_sha256"],
            )
            self.assertEqual(
                report["hashes"]["corrected_master_sha256"],
                AUDIT.sha256_file(output / "master.jsonl"),
            )

    def test_refuses_to_apply_partial_audit(self) -> None:
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
            response_path = root / "response.jsonl"
            write_jsonl(
                response_path,
                [
                    {
                        "schema_version": AUDIT.SCHEMA_VERSION,
                        "record_type": AUDIT.RESPONSE_TYPE,
                        "sample_id": task["sample_id"],
                        "primary_assignment_id": task["primary_assignment_id"],
                        "card_sha256": task["card_sha256"],
                        "reviewer": "reviewer-a",
                        "viewed_original": True,
                        "actual_orientation": "horizontal",
                        "confidence": 0.9,
                        "crop_status": "usable",
                        "notes": "원본을 확인함",
                    }
                ],
            )
            master = root / "master.jsonl"
            write_jsonl(
                master,
                [
                    {
                        "id": sample_id,
                        "metadata": {"orientation": orientation},
                        "provenance": {"qa_overlay": False, "synthetic": False},
                    }
                    for sample_id, orientation in (
                        ("a", "horizontal"),
                        ("b", "vertical"),
                    )
                ],
            )

            with self.assertRaisesRegex(AUDIT.OrientationAuditError, "incomplete"):
                AUDIT.apply_orientation_decisions(
                    workspace=workspace,
                    response_paths=[response_path],
                    inventory_path=inventory,
                    master_path=master,
                    output_dir=root / "corrected",
                )

    def test_carries_only_tasks_with_identical_card_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory, assignments, manifest, cards_root = self.fixture(root)
            source_workspace = root / "source-workspace"
            AUDIT.build_workspace(
                inventory_path=inventory,
                assignments_path=assignments,
                card_manifest_path=manifest,
                cards_root=cards_root,
                output_dir=source_workspace,
                shards=1,
                expected_samples=2,
            )
            source_tasks = AUDIT.read_jsonl(
                source_workspace / "tasks.jsonl", location="source tasks"
            )
            responses = [
                {
                    "schema_version": AUDIT.SCHEMA_VERSION,
                    "record_type": AUDIT.RESPONSE_TYPE,
                    "sample_id": task["sample_id"],
                    "primary_assignment_id": task["primary_assignment_id"],
                    "card_sha256": task["card_sha256"],
                    "reviewer": "reviewer-a",
                    "viewed_original": True,
                    "actual_orientation": task["declared_orientation"],
                    "confidence": 0.95,
                    "crop_status": "usable",
                    "notes": "원문의 실제 글자 흐름을 확인함",
                }
                for task in source_tasks
            ]
            responses_path = root / "responses.jsonl"
            write_jsonl(responses_path, responses)

            target_inventory = root / "target-inventory.jsonl"
            write_jsonl(target_inventory, [inventory_row("a", "horizontal")])
            target_workspace = root / "target-workspace"
            AUDIT.build_workspace(
                inventory_path=target_inventory,
                assignments_path=assignments,
                card_manifest_path=manifest,
                cards_root=cards_root,
                output_dir=target_workspace,
                shards=1,
                expected_samples=1,
            )
            carried_path = root / "carried.jsonl"
            report_path = root / "carry-report.json"

            report = AUDIT.carry_responses(
                source_workspace=source_workspace,
                target_workspace=target_workspace,
                response_paths=[responses_path],
                output=carried_path,
                report_output=report_path,
            )

            self.assertEqual(1, report["counts"]["carried"])
            self.assertEqual(1, report["counts"]["removed"])
            self.assertTrue(report["complete"])
            validation = AUDIT.validate_responses(
                workspace=target_workspace,
                response_paths=[carried_path],
            )
            self.assertTrue(validation["complete"])

    def test_prepares_hash_bound_responses_from_minimal_visual_decisions(self) -> None:
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
            decisions = root / "decisions.jsonl"
            write_jsonl(
                decisions,
                [
                    {
                        "sample_id": task["sample_id"],
                        "viewed_original": True,
                        "actual_orientation": task["declared_orientation"],
                        "confidence": 0.96,
                        "crop_status": "usable",
                        "notes": "원본 카드의 실제 글자 흐름을 직접 확인함",
                    }
                ],
            )
            responses = root / "responses.jsonl"
            report_path = root / "prepare-report.json"

            report = AUDIT.prepare_responses(
                workspace=workspace,
                decision_paths=[decisions],
                reviewer="orientation-reviewer-a",
                output=responses,
                report_output=report_path,
                allow_partial=True,
            )

            self.assertEqual(1, report["counts"]["prepared"])
            prepared = AUDIT.read_jsonl(responses, location="responses")[0]
            self.assertEqual(
                task["primary_assignment_id"], prepared["primary_assignment_id"]
            )
            self.assertEqual(task["card_sha256"], prepared["card_sha256"])
            validation = AUDIT.validate_responses(
                workspace=workspace,
                response_paths=[responses],
                allow_partial=True,
            )
            self.assertEqual(1, validation["counts"]["responses"])


if __name__ == "__main__":
    unittest.main()
