from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from scripts import font_matching_labels as labels


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "analyze_font_matching_catalog_ceiling.py"
SPEC = importlib.util.spec_from_file_location("catalog_ceiling", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CEILING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CEILING)

CANDIDATES = ("font-a", "font-b", "font-c")


def final_row(
    sample_id: str,
    *,
    role: str = "dialogue",
    none_acceptable: bool = False,
    work_id: str = "work-a",
    renderer_hash: str = "c" * 64,
) -> dict:
    if none_acceptable:
        preferred: list[str] = []
        acceptable: list[str] = []
        marginal = ["font-a"]
        unacceptable = ["font-b", "font-c"]
        flags = ["none_acceptable_confirmed"]
    else:
        preferred = ["font-a"]
        acceptable = ["font-b"]
        marginal = []
        unacceptable = ["font-c"]
        flags = []
    consistency = (
        {"policy": "inherit_work_anchor", "reason_code": "ordinary_dialogue"}
        if role == "dialogue"
        else {"policy": "intentional_override", "reason_code": "sfx_role_palette"}
    )
    return labels.seal_record(
        {
            "schema_version": 1,
            "record_type": "manga_font_label_final",
            "final_id": f"final-{sample_id}",
            "sample_id": sample_id,
            "work_id": work_id,
            "source_page_sha256": "a" * 64,
            "role": {"primary": role, "confidence": 0.95},
            "source_style": {field: 0.5 for field in labels.STYLE_FIELDS}
            | {"unknown_fields": []},
            "treatment": {
                "orientation": "horizontal",
                "outline": "none",
                "shadow": "none",
                "fill": "solid",
                "distortion": "none",
            },
            "font_judgment": {
                "preferred": preferred,
                "acceptable": acceptable,
                "marginal": marginal,
                "unacceptable": unacceptable,
                "unrenderable": [],
                "not_reviewed": [],
                "none_acceptable": none_acceptable,
            },
            "consistency": consistency,
            "resolution": {
                "kind": "primary",
                "resolver": "fixture-resolver",
                "resolved_at": "2026-08-01T00:00:00Z",
                "source_label_ids": [f"label-{sample_id}"],
                "catalog_version": "fixture-catalog-v1",
                "catalog_sha256": "b" * 64,
                "renderer_hash": renderer_hash,
                "confidence": 0.95,
                "flags": flags,
                "notes": "",
                "adjudication_evidence": None,
            },
        }
    )


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


class CatalogCeilingTests(unittest.TestCase):
    def analyze(self, rows: list[dict], **kwargs) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            finals = root / "finals.jsonl"
            write_jsonl(finals, rows)
            return CEILING.analyze(
                final_labels=finals,
                output=root / "report.json",
                expected_finals=len(rows),
                **kwargs,
            )

    def test_passes_frozen_dialogue_and_sfx_point_rate_ceilings(self) -> None:
        rows = [
            final_row(f"dialogue-{index}", none_acceptable=index == 0)
            for index in range(10)
        ] + [
            final_row(
                f"sfx-{index}",
                role="sfx_impact",
                none_acceptable=index == 0,
                work_id="work-b",
            )
            for index in range(4)
        ]

        report = self.analyze(rows)

        self.assertTrue(report["gates"]["all_pass"])
        self.assertEqual(
            0.1, report["cohorts"]["ordinary_dialogue"]["none_acceptable_rate"]
        )
        self.assertEqual(0.25, report["cohorts"]["hard_sfx"]["none_acceptable_rate"])
        self.assertEqual("proceed_to_v2_calibration", report["decision"])

    def test_fails_before_training_when_sfx_catalog_ceiling_is_exceeded(self) -> None:
        rows = [final_row(f"dialogue-{index}") for index in range(10)] + [
            final_row(
                f"sfx-{index}",
                role="sfx_comic",
                none_acceptable=index < 2,
                work_id="work-b",
            )
            for index in range(4)
        ]

        report = self.analyze(rows)

        self.assertFalse(report["gates"]["all_pass"])
        self.assertFalse(report["gates"]["hard_sfx"]["pass"])
        self.assertEqual("expand_catalog_before_training", report["decision"])

    def test_rejects_mixed_renderer_contract_and_wrong_final_count(self) -> None:
        rows = [final_row("dialogue-0"), final_row("sfx-0", role="sfx_motion")]
        with self.assertRaisesRegex(CEILING.CatalogCeilingError, "expected 3"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                finals = root / "finals.jsonl"
                write_jsonl(finals, rows)
                CEILING.analyze(
                    final_labels=finals,
                    output=root / "report.json",
                    expected_finals=3,
                )

        rows[-1] = final_row("sfx-0", role="sfx_motion", renderer_hash="d" * 64)
        with self.assertRaisesRegex(
            CEILING.CatalogCeilingError, "catalog and renderer contract"
        ):
            self.analyze(rows)


if __name__ == "__main__":
    unittest.main()
