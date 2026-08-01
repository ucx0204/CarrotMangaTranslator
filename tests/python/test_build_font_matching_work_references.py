from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_work_references.py"
SPEC = importlib.util.spec_from_file_location("work_references", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
REFS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFS)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def final_row(sample_id: str, chapter: int, *, role: str = "dialogue") -> dict:
    core = {
        "schema_version": 1,
        "record_type": "manga_font_label_final",
        "sample_id": sample_id,
        "work_id": "work-a",
        "role": {"primary": role, "confidence": 0.95},
        "consistency": {
            "policy": "inherit_work_anchor",
            "reason_code": "ordinary_dialogue",
        },
        "resolution": {"confidence": 0.9},
        "font_judgment": {"none_acceptable": False},
        "treatment": {"orientation": "vertical"},
        "source_style": {axis: 0.45 + chapter * 0.01 for axis in REFS.STYLE_AXES}
        | {"unknown_fields": []},
    }
    return {
        **core,
        "record_sha256": REFS.sha256_bytes(REFS.canonical_json(core).encode()),
    }


def master_row(sample_id: str, chapter: int) -> dict:
    view = {
        "catalog_id": "fontclip-hard-accepted-v2",
        "file_sha256": "a" * 64,
        "path": f"images/{sample_id}.png",
        "status": "available",
    }
    return {
        "id": sample_id,
        "work": {"id": "work-a"},
        "chapter": {"id": f"chapter-{chapter}"},
        "page": {"id": f"page-{chapter}"},
        "sample_crop_sha256": f"{chapter + 1:064x}",
        "provenance": {
            "qa_overlay": False,
            "synthetic": False,
            "source_catalog_id": "fontclip-hard-accepted-v2",
        },
        "views": {name: dict(view) for name in ("raw_224", "context_224", "glyph_224")},
    }


class WorkReferenceTests(unittest.TestCase):
    def test_builds_three_anonymous_distinct_chapter_references(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / "inventory.jsonl"
            master = root / "master.jsonl"
            finals = root / "finals.jsonl"
            output = root / "references.json"
            report_output = root / "report.json"
            write_jsonl(
                inventory,
                [
                    {
                        "sample_id": "target-a",
                        "work_id": "work-a",
                        "orientation": "vertical",
                    }
                ],
            )
            write_jsonl(master, [master_row(f"reference-{i}", i) for i in range(4)])
            write_jsonl(finals, [final_row(f"reference-{i}", i) for i in range(4)])

            report = REFS.build_references(
                target_inventory=inventory,
                source_master=master,
                final_labels=finals,
                output=output,
                report_output=report_output,
                references_per_target=3,
                require_final_count=4,
            )

            self.assertEqual(1, report["counts"]["targets"])
            self.assertEqual(3, report["counts"]["references"])
            manifest = json.loads(output.read_text(encoding="utf-8"))
            references = manifest["targets"][0]["references"]
            self.assertEqual(3, len(references))
            self.assertEqual(3, len({row["chapter_id"] for row in references}))
            public = json.dumps(manifest, sort_keys=True)
            self.assertNotIn("font_id", public)
            self.assertNotIn("font_label", public)
            self.assertFalse(manifest["safety"]["training_asset"])

    def test_rejects_insufficient_clean_dialogue_pool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / "inventory.jsonl"
            master = root / "master.jsonl"
            finals = root / "finals.jsonl"
            write_jsonl(
                inventory,
                [
                    {
                        "sample_id": "target-a",
                        "work_id": "work-a",
                        "orientation": "vertical",
                    }
                ],
            )
            write_jsonl(master, [master_row("reference-0", 0)])
            write_jsonl(finals, [final_row("reference-0", 0)])

            with self.assertRaisesRegex(REFS.WorkReferenceError, "only 1"):
                REFS.build_references(
                    target_inventory=inventory,
                    source_master=master,
                    final_labels=finals,
                    output=root / "references.json",
                    report_output=root / "report.json",
                )

    def test_rejects_tampered_final_seal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / "inventory.jsonl"
            master = root / "master.jsonl"
            finals = root / "finals.jsonl"
            write_jsonl(
                inventory,
                [
                    {
                        "sample_id": "target-a",
                        "work_id": "work-a",
                        "orientation": "vertical",
                    }
                ],
            )
            write_jsonl(master, [master_row("reference-0", 0)])
            tampered = final_row("reference-0", 0)
            tampered["role"]["confidence"] = 0.1
            write_jsonl(finals, [tampered])

            with self.assertRaisesRegex(REFS.WorkReferenceError, "seal mismatch"):
                REFS.build_references(
                    target_inventory=inventory,
                    source_master=master,
                    final_labels=finals,
                    output=root / "references.json",
                    report_output=root / "report.json",
                )


if __name__ == "__main__":
    unittest.main()
