from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "finalize_font_matching_catalog_transition_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "finalize_font_matching_catalog_transition_v5_tested", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {SCRIPT}")
TRANSITION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRANSITION
SPEC.loader.exec_module(TRANSITION)


CANDIDATES = tuple(f"font-{index:02d}" for index in range(22))
PRIOR = CANDIDATES[:15]
DELTA = CANDIDATES[15:]


def sha(label: str) -> str:
    return TRANSITION.sha256_bytes(label.encode("utf-8"))


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.write_bytes(TRANSITION.json_bytes(value, pretty=True))


def provisional() -> dict[str, Any]:
    disposition = TRANSITION.seal(
        {
            "schema_version": TRANSITION.ledger.V5_CATALOG_DISPOSITION_SCHEMA_VERSION,
            "record_type": TRANSITION.ledger.V5_CATALOG_DISPOSITION_RECORD_TYPE,
            "workspace_contract_record_sha256": sha("workspace"),
            "calibration_report_record_sha256": sha("calibration"),
            "source_catalog_sha256": sha("font-manifest"),
            "source_render_bank_sha256": sha("render-manifest"),
            "entries": [
                {
                    "acceptable_count": 0 if index == 2 else 1,
                    "action": (
                        "deleted_safe_zero"
                        if index == 2
                        else "pending_full22_utility_audit"
                    ),
                    "active_release_eligible": False,
                    "all_unrenderable": False,
                    "blind_alias": f"alias-{index}",
                    "candidate_id": candidate_id,
                    "deployable_opportunity_count": 4,
                    "marginal_count": 0,
                    "preferred_count": 0,
                    "reason_code": "fixture",
                    "replacement_state": "pending",
                    "safe_count": 0 if index == 2 else 1,
                    "terminal": False,
                    "unacceptable_count": 3 if index == 2 else 2,
                    "unrenderable_count": 0,
                }
                for index, candidate_id in enumerate(DELTA)
            ],
        }
    )
    catalog = TRANSITION.seal(
        {
            "schema_version": TRANSITION.ledger.V5_PROVISIONAL_CATALOG_SCHEMA_VERSION,
            "record_type": TRANSITION.ledger.V5_PROVISIONAL_CATALOG_RECORD_TYPE,
            "workspace_contract_record_sha256": sha("workspace"),
            "catalog_disposition_record_sha256": disposition["record_sha256"],
            "prior_candidate_count": 15,
            "prior_candidate_ids": list(PRIOR),
        }
    )
    return {"disposition": disposition, "catalog": catalog}


def utility_report(*, ambiguous: bool = False) -> dict[str, Any]:
    rows = []
    for candidate_id in CANDIDATES:
        if candidate_id in PRIOR:
            kind = "legacy_15"
            human = {
                "deployable_opportunity_count": 4,
                "legacy_gap_p1_rescue_count": 0,
                "preferred_count": 1,
                "safe_count": 1,
                "unique_p1_safe_count": 0,
                "unrenderable_count": 0,
            }
        else:
            index = DELTA.index(candidate_id)
            safe = 0 if index == 2 else 1
            unique = 1 if index not in {1, 2, 3} else 0
            legacy_gap = 1 if index == 1 else 0
            if index == 3 and not ambiguous:
                legacy_gap = 1
            kind = "challenger_7"
            human = {
                "deployable_opportunity_count": 4,
                "legacy_gap_p1_rescue_count": legacy_gap,
                "preferred_count": 0,
                "safe_count": safe,
                "unique_p1_safe_count": unique,
                "unrenderable_count": 0,
            }
        rows.append(
            {
                "candidate_id": candidate_id,
                "candidate_kind": kind,
                "metrics": {"human": human},
            }
        )
    return TRANSITION.seal(
        {
            "candidate_ids": list(CANDIDATES),
            "candidates": rows,
            "record_type": TRANSITION.utility.RECORD_TYPE,
            "schema_version": TRANSITION.utility.SCHEMA_VERSION,
        }
    )


def font_manifest() -> dict[str, Any]:
    return {
        "schema_version": "font-face-manifest-v1",
        "deterministic": True,
        "family_count": 22,
        "face_count": 22,
        "families": [
            {
                "font_id": candidate_id,
                "faces": [
                    {
                        "face_id": f"{candidate_id}:face",
                        "file": f"fonts/{candidate_id}.ttf",
                        "byte_size": 10,
                        "sha256": sha(f"face-{candidate_id}"),
                    }
                ],
            }
            for candidate_id in CANDIDATES
        ],
    }


def render_manifest() -> dict[str, Any]:
    candidates = [
        {
            "display_id": f"{candidate_id}/face/w400/normal",
            "face_id": f"{candidate_id}:face",
            "font_id": candidate_id,
        }
        for candidate_id in CANDIDATES
    ]
    renders = [
        {
            "artifact": {
                "byte_size": 10,
                "file": f"images/{candidate_id}.png",
                "sha256": sha(f"image-{candidate_id}"),
            },
            "candidate_display_id": f"{candidate_id}/face/w400/normal",
            "render_id": f"render-{candidate_id}",
        }
        for candidate_id in CANDIDATES
    ]
    return {
        "schema_version": "font-render-bank-v1",
        "specification_sha256": sha("source-spec"),
        "inputs": [{"path": "source", "sha256": sha("font-manifest")}],
        "source_contract": {
            "schema_version": "font-face-manifest-v1",
            "manifest_sha256": sha("font-manifest"),
        },
        "generation": {
            "limit": None,
            "partial": False,
            "complete_against_production_assets": True,
            "rendered_count": 22,
        },
        "family_count": 22,
        "face_count": 22,
        "candidate_count": 22,
        "rendered_candidate_count": 22,
        "candidates": candidates,
        "renders": renders,
    }


class CatalogTransitionTests(unittest.TestCase):
    def derive(
        self,
        *,
        utility: Mapping[str, Any] | None = None,
        resolution_path: Path | None = None,
    ) -> dict[str, Any]:
        return TRANSITION.derive_transition(
            provisional=provisional(),
            utility_report=utility or utility_report(),
            source_font_manifest=font_manifest(),
            source_font_sha256=sha("font-manifest"),
            source_render_manifest=render_manifest(),
            source_render_sha256=sha("render-manifest"),
            resolution_path=resolution_path,
        )

    def test_formal_unique_and_legacy_gap_evidence_retains_while_safe_zero_deletes(
        self,
    ) -> None:
        result = self.derive()
        disposition = result["disposition"]
        final_catalog = result["final_catalog"]
        actions = {row["candidate_id"]: row["action"] for row in disposition["entries"]}
        self.assertEqual(actions[DELTA[0]], TRANSITION.RETAIN_ACTION)
        self.assertEqual(actions[DELTA[1]], TRANSITION.RETAIN_ACTION)
        self.assertEqual(actions[DELTA[2]], TRANSITION.SAFE_ZERO_ACTION)
        self.assertNotIn(DELTA[2], final_catalog["candidate_ids"])
        self.assertEqual(final_catalog["candidate_count"], 21)
        self.assertEqual(result["font_manifest"]["family_count"], 21)
        self.assertEqual(result["render_manifest"]["candidate_count"], 21)
        self.assertEqual(
            result["render_manifest"]["source_contract"]["manifest_sha256"],
            TRANSITION.sha256_bytes(
                TRANSITION.json_bytes(result["font_manifest"], pretty=True)
            ),
        )
        TRANSITION.validate_seal(disposition, location="disposition")
        TRANSITION.validate_seal(final_catalog, location="final catalog")

    def test_safe_positive_without_p1_rescue_requires_exact_sealed_resolution(
        self,
    ) -> None:
        report = utility_report(ambiguous=True)
        with self.assertRaisesRegex(TRANSITION.CatalogTransitionError, "unresolved"):
            self.derive(utility=report)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "resolution.json"
            resolution = TRANSITION.seal(
                {
                    "schema_version": TRANSITION.RESOLUTION_SCHEMA,
                    "record_type": TRANSITION.RESOLUTION_RECORD_TYPE,
                    "utility_record_sha256": report["record_sha256"],
                    "provisional_catalog_record_sha256": provisional()["catalog"][
                        "record_sha256"
                    ],
                    "decisions": [
                        {
                            "action": TRANSITION.REDUNDANT_ACTION,
                            "candidate_id": DELTA[3],
                            "rationale": "Independent final review found no distinct P1 utility.",
                        }
                    ],
                }
            )
            write_json(path, resolution)
            result = self.derive(utility=report, resolution_path=path)
            actions = {
                row["candidate_id"]: row["action"]
                for row in result["disposition"]["entries"]
            }
            self.assertEqual(actions[DELTA[3]], TRANSITION.REDUNDANT_ACTION)
            self.assertNotIn(DELTA[3], result["final_catalog"]["candidate_ids"])

    def test_deployment_failure_and_provisional_metric_drift_fail_closed(self) -> None:
        report = utility_report()
        report["candidates"][15]["metrics"]["human"]["deployable_opportunity_count"] = 0
        with self.assertRaisesRegex(
            TRANSITION.CatalogTransitionError, "evidence differ"
        ):
            self.derive(utility=report)

        changed = utility_report()
        changed["candidates"][15]["metrics"]["human"]["safe_count"] = 2
        with self.assertRaisesRegex(
            TRANSITION.CatalogTransitionError, "evidence differ"
        ):
            self.derive(utility=changed)


if __name__ == "__main__":
    unittest.main()
