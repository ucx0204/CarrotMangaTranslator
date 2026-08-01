from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_font_matching_work_profiles.py"
SPEC = importlib.util.spec_from_file_location("work_profiles", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROFILES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILES)


CANDIDATES = ("font-a", "font-b", "seoul-namsan-vertical")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def final_row(
    sample_id: str,
    *,
    work_id: str = "work-a",
    role: str = "dialogue",
    preferred: str = "font-a",
    acceptable: tuple[str, ...] = (),
    consistency: str = "inherit_work_anchor",
) -> dict:
    remaining = [
        candidate
        for candidate in CANDIDATES
        if candidate != preferred and candidate not in acceptable
    ]
    core = {
        "schema_version": 1,
        "record_type": "manga_font_label_final",
        "sample_id": sample_id,
        "work_id": work_id,
        "role": {"primary": role, "confidence": 0.97},
        "consistency": {"policy": consistency, "reason_code": "fixture"},
        "resolution": {
            "catalog_version": "fixture-catalog-v1",
            "catalog_sha256": "b" * 64,
            "confidence": 0.95,
            "renderer_hash": "c" * 64,
            "resolved_at": "2026-08-01T00:00:00Z",
        },
        "font_judgment": {
            "preferred": [preferred],
            "acceptable": list(acceptable),
            "marginal": [],
            "unacceptable": remaining,
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        },
    }
    return {
        **core,
        "record_sha256": PROFILES.sha256_bytes(PROFILES.canonical_json(core).encode()),
    }


class WorkProfileBuilderTests(unittest.TestCase):
    def build(self, root: Path, rows: list[dict], **kwargs) -> tuple[dict, list[dict]]:
        finals = root / "finals.jsonl"
        output = root / "profiles.jsonl"
        report_output = root / "report.json"
        write_jsonl(finals, rows)
        report = PROFILES.build_profiles(
            final_labels=finals,
            output=output,
            report_output=report_output,
            runtime_catalog_version="catalog-v2",
            runtime_model_version="model-v2",
            runtime_renderer_hash="a" * 64,
            vertical_only_font_ids=frozenset({"seoul-namsan-vertical"}),
            **kwargs,
        )
        records = [
            json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()
        ]
        return report, records

    def test_builds_clear_dialogue_anchor_without_genre_or_title(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rows = [final_row(f"sample-{index:02d}") for index in range(20)]

            report, records = self.build(Path(directory), rows, expected_finals=20)

            profile = records[0]["profile"]
            self.assertEqual("font-a", profile["dialogueAnchor"]["primaryFontId"])
            self.assertEqual(20, profile["dialogueAnchor"]["evidenceCount"])
            self.assertIsNone(profile["genrePrior"])
            self.assertNotIn(
                "seoul-namsan-vertical",
                profile["orientationPolicy"]["horizontalAllowedFontIds"],
            )
            self.assertEqual(0, report["counts"]["null_dialogue_anchors"])
            self.assertFalse(report["safety"]["work_titles_used"])

    def test_ambiguous_or_sparse_dialogue_abstains(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rows = [
                final_row(
                    f"sample-{index:02d}",
                    preferred="font-a" if index % 2 == 0 else "font-b",
                )
                for index in range(20)
            ]

            _, records = self.build(Path(directory), rows)

            self.assertIsNone(records[0]["profile"]["dialogueAnchor"])
            self.assertEqual(0, records[0]["profile"]["confidence"])

        with tempfile.TemporaryDirectory() as directory:
            rows = [final_row(f"sparse-{index}") for index in range(19)]
            _, records = self.build(Path(directory), rows)
            self.assertIsNone(records[0]["profile"]["dialogueAnchor"])

    def test_builds_role_palette_separately_from_body_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rows = [final_row(f"body-{index}") for index in range(20)] + [
                final_row(
                    f"sfx-{index}",
                    role="sfx_impact",
                    preferred="font-b",
                    acceptable=("font-a",),
                    consistency="intentional_override",
                )
                for index in range(3)
            ]

            _, records = self.build(Path(directory), rows)

            profile = records[0]["profile"]
            self.assertEqual("font-a", profile["dialogueAnchor"]["primaryFontId"])
            self.assertEqual("sfx_impact", profile["rolePalettes"][0]["role"])
            self.assertEqual(
                ["font-b", "font-a"],
                profile["rolePalettes"][0]["allowedFontIds"],
            )
            self.assertGreater(profile["confidence"], 0)

    def test_rejects_mixed_source_render_contracts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            rows = [final_row(f"sample-{index:02d}") for index in range(20)]
            changed = {
                **rows[-1],
                "resolution": {
                    **rows[-1]["resolution"],
                    "renderer_hash": "d" * 64,
                },
            }
            core = {
                key: value for key, value in changed.items() if key != "record_sha256"
            }
            rows[-1] = {
                **core,
                "record_sha256": PROFILES.sha256_bytes(
                    PROFILES.canonical_json(core).encode()
                ),
            }

            with self.assertRaisesRegex(
                PROFILES.WorkProfileError, "source catalog and renderer contract"
            ):
                self.build(Path(directory), rows)


if __name__ == "__main__":
    unittest.main()
