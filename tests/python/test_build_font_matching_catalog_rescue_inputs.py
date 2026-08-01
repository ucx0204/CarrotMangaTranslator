from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "build_font_matching_catalog_rescue_inputs.py"
SPEC = importlib.util.spec_from_file_location("font_catalog_rescue_inputs", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RESCUE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RESCUE
SPEC.loader.exec_module(RESCUE)
LABELS = RESCUE.labels


LEGACY_FONT_IDS = ("font-old-a", "font-old-b", "font-old-c")
NEW_FONT_IDS = ("font-new-a", "font-new-b")
ALL_FONT_IDS = (*LEGACY_FONT_IDS, *NEW_FONT_IDS)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps(
                row,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for row in rows
        ),
        encoding="utf-8",
    )


def decode_jsonl(payload: bytes) -> list[dict[str, Any]]:
    return [json.loads(line) for line in payload.decode("utf-8").splitlines()]


def final_row(
    sample_id: str,
    *,
    work_id: str,
    source_page_sha256: str,
    catalog_sha256: str,
    none_acceptable: bool,
) -> dict[str, Any]:
    if none_acceptable:
        judgment = {
            "preferred": [],
            "acceptable": [],
            "marginal": [LEGACY_FONT_IDS[0]],
            "unacceptable": list(LEGACY_FONT_IDS[1:]),
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": True,
        }
        flags = ["none_acceptable_confirmed"]
        role = "sfx_impact"
        consistency = {
            "policy": "intentional_override",
            "reason_code": "sfx_role_palette",
        }
    else:
        judgment = {
            "preferred": [LEGACY_FONT_IDS[0]],
            "acceptable": [LEGACY_FONT_IDS[1]],
            "marginal": [],
            "unacceptable": [LEGACY_FONT_IDS[2]],
            "unrenderable": [],
            "not_reviewed": [],
            "none_acceptable": False,
        }
        flags = []
        role = "dialogue"
        consistency = {
            "policy": "inherit_work_anchor",
            "reason_code": "ordinary_dialogue",
        }
    return LABELS.seal_record(
        {
            "schema_version": 1,
            "record_type": "manga_font_label_final",
            "final_id": f"final-{sample_id}",
            "sample_id": sample_id,
            "work_id": work_id,
            "source_page_sha256": source_page_sha256,
            "role": {"primary": role, "confidence": 0.97},
            "source_style": {
                field: 0.5 for field in LABELS.STYLE_FIELDS
            }
            | {"unknown_fields": []},
            "treatment": {
                "orientation": "vertical",
                "outline": "none",
                "shadow": "none",
                "fill": "solid",
                "distortion": "none",
            },
            "font_judgment": judgment,
            "consistency": consistency,
            "resolution": {
                "kind": "primary",
                "resolver": "fixture-resolver",
                "resolved_at": "2026-08-01T00:00:00Z",
                "source_label_ids": [f"label-{sample_id}"],
                "catalog_version": "font-face-manifest-v1",
                "catalog_sha256": catalog_sha256,
                "renderer_hash": "d" * 64,
                "confidence": 0.96,
                "flags": flags,
                "notes": "",
                "adjudication_evidence": None,
            },
        }
    )


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.final_labels = root / "final-labels.jsonl"
        self.master_manifest = root / "master.jsonl"
        self.legacy_catalog = root / "legacy-catalog" / "manifest.json"
        self.expanded_catalog = root / "expanded-catalog" / "manifest.json"
        self.render_bank_root = root / "expanded-render-bank"
        self.render_bank_manifest = self.render_bank_root / "manifest.json"
        self.output = root / "rescue-output"
        self.display_ids = {
            font_id: f"{font_id}/face-regular/w400/normal"
            for font_id in ALL_FONT_IDS
        }
        self.aliases = {
            font_id: f"ko-candidate-{index:02d}"
            for index, font_id in enumerate(ALL_FONT_IDS)
        }
        self._write_catalogs()
        self.legacy_sha256 = RESCUE.sha256_file(self.legacy_catalog)
        self._write_labels_and_master()
        self._build_render_bank()

    def _write_catalogs(self) -> None:
        write_json(
            self.legacy_catalog,
            {
                "schema_version": "font-face-manifest-v1",
                "family_count": len(LEGACY_FONT_IDS),
                "families": [{"font_id": value} for value in LEGACY_FONT_IDS],
            },
        )
        write_json(
            self.expanded_catalog,
            {
                "schema_version": "font-face-manifest-v1",
                "family_count": len(ALL_FONT_IDS),
                "families": [{"font_id": value} for value in ALL_FONT_IDS],
            },
        )

    def _write_labels_and_master(self) -> None:
        accepted_page_sha = "a" * 64
        none_page_sha = "b" * 64
        self.final_rows = [
            final_row(
                "sample-accepted",
                work_id="work-accepted",
                source_page_sha256=accepted_page_sha,
                catalog_sha256=self.legacy_sha256,
                none_acceptable=False,
            ),
            final_row(
                "sample-none",
                work_id="work-none",
                source_page_sha256=none_page_sha,
                catalog_sha256=self.legacy_sha256,
                none_acceptable=True,
            ),
        ]
        write_jsonl(self.final_labels, self.final_rows)
        self.master_rows = [
            {
                "id": "sample-accepted",
                "work": {"id": "work-accepted"},
                "page": {"source_page_sha256": accepted_page_sha},
                "provenance": {"qa_overlay": False, "synthetic": False},
            },
            {
                "id": "sample-none",
                "work": {"id": "work-none"},
                "page": {"source_page_sha256": none_page_sha},
                "metadata": {"orientation": "horizontal"},
                "provenance": {"qa_overlay": False, "synthetic": False},
            },
        ]
        write_jsonl(self.master_manifest, self.master_rows)

    def _candidate(self, font_id: str) -> dict[str, Any]:
        return {
            "font_id": font_id,
            "face_id": f"face-{font_id}",
            "display_id": self.display_ids[font_id],
            "blind_alias": self.aliases[font_id],
            "production_400_normal_canonical": True,
            "production_asset_status": {"chromium_ots_compatible": True},
            "allowed_writing_modes": ["horizontal", "vertical"],
            "render_weight": 400,
            "render_style": "normal",
        }

    def _build_render_bank(self) -> None:
        self.candidates = [self._candidate(font_id) for font_id in ALL_FONT_IDS]
        self.candidates.append(
            {
                **self._candidate(NEW_FONT_IDS[0]),
                "face_id": "face-font-new-a-bold",
                "display_id": "font-new-a/face-bold/w700/normal",
                "production_400_normal_canonical": False,
                "render_weight": 700,
            }
        )
        self.renders: list[dict[str, Any]] = []
        for font_id in ALL_FONT_IDS:
            for mode in ("horizontal", "vertical"):
                relative = (
                    f"images/{self.aliases[font_id]}/probe-main-{mode}.bin"
                )
                payload = f"{font_id}:probe-main:{mode}".encode("utf-8")
                artifact = self.render_bank_root.joinpath(*Path(relative).parts)
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(payload)
                self.renders.append(
                    {
                        "render_id": f"render-{font_id}-{mode}",
                        "candidate_display_id": self.display_ids[font_id],
                        "probe_id": "probe-main",
                        "writing_mode": mode,
                        "font_weight": 400,
                        "font_style": "normal",
                        "readiness": {
                            "document_fonts_ready": True,
                            "font_check_passed": True,
                            "production_font_check_passed": True,
                            "content_fits": True,
                        },
                        "fallback_detection": {"status": "passed"},
                        "artifact": {
                            "file": relative,
                            "sha256": sha256_bytes(payload),
                            "qa_overlay": False,
                        },
                    }
                )
        self.bank_document = {
            "schema_version": "font-render-bank-v1",
            "source_contract": {
                "schema_version": "font-face-manifest-v1",
                "manifest_sha256": RESCUE.sha256_file(self.expanded_catalog),
            },
            "renderer": {"engine": "fixture-chromium"},
            "candidate_identity_contract": {"blind": True},
            "render_spec": {"qa_overlay": False},
            "probe_bank": [{"id": "probe-main", "text": "쾅!!"}],
            "candidates": self.candidates,
            "renders": self.renders,
        }
        self.rewrite_bank()

    def rewrite_bank(self) -> None:
        write_json(self.render_bank_manifest, self.bank_document)

    def rewrite_labels(self) -> None:
        write_jsonl(self.final_labels, self.final_rows)

    def rewrite_master(self) -> None:
        write_jsonl(self.master_manifest, self.master_rows)

    def build_kwargs(self) -> dict[str, Any]:
        return {
            "final_labels": self.final_labels,
            "master_manifest": self.master_manifest,
            "legacy_catalog": self.legacy_catalog,
            "expanded_catalog": self.expanded_catalog,
            "expanded_render_bank": self.render_bank_manifest,
            "expected_samples": 1,
            "expected_new_candidates": len(NEW_FONT_IDS),
        }

    def build_files(self) -> dict[str, bytes]:
        return RESCUE.build_files(**self.build_kwargs())

    def cli_args(self, command: str) -> list[str]:
        return [
            command,
            "--final-labels",
            str(self.final_labels),
            "--master-manifest",
            str(self.master_manifest),
            "--legacy-catalog",
            str(self.legacy_catalog),
            "--expanded-catalog",
            str(self.expanded_catalog),
            "--expanded-render-bank",
            str(self.render_bank_manifest),
            "--output-dir",
            str(self.output),
            "--expected-samples",
            "1",
            "--expected-new-candidates",
            str(len(NEW_FONT_IDS)),
        ]

    def candidate(self, font_id: str) -> dict[str, Any]:
        return next(
            candidate
            for candidate in self.candidates
            if candidate["font_id"] == font_id
            and candidate["production_400_normal_canonical"] is True
        )

    def new_renders(self) -> list[dict[str, Any]]:
        displays = {self.display_ids[value] for value in NEW_FONT_IDS}
        return [
            render
            for render in self.renders
            if render["candidate_display_id"] in displays
        ]


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


class CatalogRescueInputTests(unittest.TestCase):
    def test_selects_only_prior_none_and_new_canonical_families(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))

            files = fixture.build_files()
            masters = decode_jsonl(files[RESCUE.MASTER_FILE])
            selections = decode_jsonl(files[RESCUE.SELECTION_FILE])
            bank = json.loads(files[RESCUE.RENDER_BANK_MANIFEST])
            report = json.loads(files[RESCUE.REPORT_FILE])

            self.assertEqual(["sample-none"], [row["id"] for row in masters])
            self.assertEqual(["sample-none"], [row["sample_id"] for row in selections])
            self.assertEqual("prior_none_acceptable", selections[0]["selection_reason"])
            self.assertEqual("vertical", masters[0]["metadata"]["orientation"])
            self.assertEqual(
                "prior_final_human_orientation",
                masters[0]["metadata"]["catalog_rescue_orientation"]["source"],
            )
            self.assertTrue(selections[0]["orientation_changed"])
            self.assertEqual(
                "horizontal", selections[0]["previous_master_orientation"]
            )
            self.assertEqual(
                list(NEW_FONT_IDS),
                [candidate["font_id"] for candidate in bank["candidates"]],
            )
            self.assertTrue(
                all(
                    candidate["production_400_normal_canonical"] is True
                    for candidate in bank["candidates"]
                )
            )
            new_displays = {fixture.display_ids[value] for value in NEW_FONT_IDS}
            self.assertEqual(
                new_displays,
                {render["candidate_display_id"] for render in bank["renders"]},
            )
            self.assertEqual(4, len(bank["renders"]))
            self.assertEqual(2, report["summary"]["new_candidate_count"])
            self.assertEqual(1, report["summary"]["selected_sample_count"])
            self.assertEqual(1, report["summary"]["hard_sfx_count"])

    def test_rejects_catalog_or_master_provenance_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.final_rows[1])
            changed["resolution"]["catalog_sha256"] = "e" * 64
            fixture.final_rows[1] = LABELS.seal_record(changed)
            fixture.rewrite_labels()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "legacy catalog"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.master_rows[1]["page"]["source_page_sha256"] = "f" * 64
            fixture.rewrite_master()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "source-page"):
                fixture.build_files()

    def test_requires_a_reviewed_single_writing_orientation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            changed = copy.deepcopy(fixture.final_rows[1])
            changed["treatment"]["orientation"] = "mixed"
            fixture.final_rows[1] = LABELS.seal_record(changed)
            fixture.rewrite_labels()

            with self.assertRaisesRegex(
                RESCUE.RescueInputError, "unsupported reviewed orientation 'mixed'"
            ):
                fixture.build_files()

    def test_rejects_expanded_catalog_that_drops_a_legacy_family(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            incomplete = (*LEGACY_FONT_IDS[:-1], *NEW_FONT_IDS)
            write_json(
                fixture.expanded_catalog,
                {
                    "schema_version": "font-face-manifest-v1",
                    "family_count": len(incomplete),
                    "families": [{"font_id": value} for value in incomplete],
                },
            )

            with self.assertRaisesRegex(
                RESCUE.RescueInputError, "strict legacy superset"
            ):
                fixture.build_files()

    def test_requires_unique_production_400_normal_canonical_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.candidate(NEW_FONT_IDS[0])["render_weight"] = 700
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "400 normal"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.candidate(NEW_FONT_IDS[1])["display_id"] = fixture.display_ids[
                NEW_FONT_IDS[0]
            ]
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "unique display IDs"):
                fixture.build_files()

    def test_rejects_incomplete_or_duplicated_render_matrix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.renders.remove(fixture.new_renders()[-1])
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "render matrix"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            first, second = fixture.new_renders()[:2]
            second["render_id"] = first["render_id"]
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "render IDs"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            first, second = fixture.new_renders()[:2]
            second["artifact"] = copy.deepcopy(first["artifact"])
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "artifact paths"):
                fixture.build_files()

    def test_rejects_hash_readiness_fallback_overlay_and_wrong_face(self) -> None:
        scenarios = (
            (
                "artifact hash",
                lambda render: render["artifact"].__setitem__("sha256", "0" * 64),
                "missing or stale",
            ),
            (
                "fonts ready",
                lambda render: render["readiness"].__setitem__(
                    "document_fonts_ready", False
                ),
                "readiness/fallback",
            ),
            (
                "font check",
                lambda render: render["readiness"].__setitem__(
                    "font_check_passed", False
                ),
                "readiness/fallback",
            ),
            (
                "production font check",
                lambda render: render["readiness"].__setitem__(
                    "production_font_check_passed", False
                ),
                "readiness/fallback",
            ),
            (
                "content fit",
                lambda render: render["readiness"].__setitem__(
                    "content_fits", False
                ),
                "readiness/fallback",
            ),
            (
                "fallback",
                lambda render: render["fallback_detection"].__setitem__(
                    "status", "failed"
                ),
                "readiness/fallback",
            ),
            (
                "overlay",
                lambda render: render["artifact"].__setitem__("qa_overlay", True),
                "QA overlay",
            ),
            (
                "wrong face",
                lambda render: render.__setitem__("font_weight", 700),
                "400 normal",
            ),
        )
        for name, mutate, message in scenarios:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                fixture = Fixture(Path(directory))
                mutate(fixture.new_renders()[0])
                fixture.rewrite_bank()

                with self.assertRaisesRegex(RESCUE.RescueInputError, message):
                    fixture.build_files()

    def test_rejects_windows_style_artifact_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.new_renders()[0]["artifact"]["file"] = "..\\escaped.bin"
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "unsafe"):
                fixture.build_files()

    def test_build_then_validate_is_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))

            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, RESCUE.main(fixture.cli_args("build")))
            first = snapshot(fixture.output)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, RESCUE.main(fixture.cli_args("validate")))
                self.assertEqual(0, RESCUE.main(fixture.cli_args("build")))
            second = snapshot(fixture.output)

            self.assertEqual(first, second)

    def test_detects_tamper_and_refuses_unowned_or_unmanaged_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            files = fixture.build_files()
            fixture.output.mkdir()
            foreign = fixture.output / "keep-me.txt"
            foreign.write_text("user data", encoding="utf-8")

            with self.assertRaisesRegex(RESCUE.RescueInputError, "unowned"):
                RESCUE.write_output(fixture.output, files)
            self.assertEqual("user data", foreign.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            files = fixture.build_files()
            RESCUE.write_output(fixture.output, files)
            master = fixture.output / RESCUE.MASTER_FILE
            master.write_bytes(master.read_bytes() + b"tampered\n")

            with self.assertRaisesRegex(RESCUE.RescueInputError, "tampered"):
                RESCUE.validate_files(fixture.output, files)
            with self.assertRaisesRegex(RESCUE.RescueInputError, "tampered"):
                RESCUE.write_output(fixture.output, files)

        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            files = fixture.build_files()
            RESCUE.write_output(fixture.output, files)
            extra = fixture.output / "foreign-notes.txt"
            extra.write_text("do not delete", encoding="utf-8")

            with self.assertRaisesRegex(RESCUE.RescueInputError, "unmanaged"):
                RESCUE.write_output(fixture.output, files)
            self.assertTrue(extra.is_file())


if __name__ == "__main__":
    unittest.main()
