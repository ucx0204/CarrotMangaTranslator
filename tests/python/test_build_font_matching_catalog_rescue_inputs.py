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
V3_LEGACY_FONT_IDS = tuple(f"legacy-font-{index:02d}" for index in range(15))
V3_NEW_FONT_IDS = tuple(f"new-font-{index:02d}" for index in range(7))
V3_ALL_FONT_IDS = (*V3_LEGACY_FONT_IDS, *V3_NEW_FONT_IDS)


def delta_priority_sample(
    sample_id: str,
    *,
    role: str = "dialogue",
    none_acceptable: bool = False,
    handwritten: float = 0.0,
    irregularity: float = 0.0,
    unknown_count: int = 0,
    manual_recrop: bool = False,
    source_family_override: bool = False,
) -> dict[str, Any]:
    unknown_fields = list(LABELS.STYLE_FIELDS[:unknown_count])
    style = {
        field: (None if field in unknown_fields else 0.0)
        for field in LABELS.STYLE_FIELDS
    }
    style["handwritten"] = None if "handwritten" in unknown_fields else handwritten
    style["irregularity"] = None if "irregularity" in unknown_fields else irregularity
    style["unknown_fields"] = unknown_fields
    return {
        "sample_id": sample_id,
        "work_id": "work-priority-contract",
        "role": {"primary": role, "confidence": 0.95},
        "source_style": style,
        "font_judgment": {"none_acceptable": none_acceptable},
        "consistency": {
            "policy": (
                "intentional_override"
                if source_family_override
                else "inherit_work_anchor"
            ),
            "reason_code": (
                "emphasis" if source_family_override else "ordinary_dialogue"
            ),
        },
        "provenance": {
            "master": {
                "source_catalog_id": "fixture-base",
                "source_lineage": [],
            }
        },
        "review_provenance": {
            "resolution": {
                "flags": ["manual_recrop_resolved"] if manual_recrop else []
            },
            "source_reviews": [],
        },
    }


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


def seal_source_record(record: dict[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(record)
    output.pop("record_sha256", None)
    output["record_sha256"] = RESCUE.canonical_record_sha256(output)
    return output


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
            "source_style": {field: 0.5 for field in LABELS.STYLE_FIELDS}
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
            font_id: f"{font_id}/face-regular/w400/normal" for font_id in ALL_FONT_IDS
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
                relative = f"images/{self.aliases[font_id]}/probe-main-{mode}.bin"
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


class DeltaFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.training_export = root / "training-export"
        self.final_labels = root / "finals.jsonl"
        self.master_root = root / "master-v2"
        self.master_manifest = self.master_root / "manifest.jsonl"
        self.master_report = self.master_root / "report.json"
        self.master_split_map = self.master_root / "split_map.json"
        self.registry = root / "catalog-registry.json"
        self.legacy_catalog = root / "legacy-catalog" / "manifest.json"
        self.expanded_catalog = root / "expanded-catalog" / "manifest.json"
        self.render_bank_root = root / "expanded-render-bank"
        self.render_bank_manifest = self.render_bank_root / "manifest.json"
        self.output = root / "delta-output"
        self.aliases = {
            font_id: f"ko-candidate-{index:02d}"
            for index, font_id in enumerate(V3_ALL_FONT_IDS)
        }
        self.display_ids = {
            font_id: f"display-{index:02d}/face/w400/normal"
            for index, font_id in enumerate(V3_ALL_FONT_IDS)
        }
        self.specs = [
            {
                "sample_id": "fm_08980fe9ca80d39e6c18a32f",
                "work_id": "work-a",
                "split": "train",
                "role": "other",
                "none": True,
                "unknown_count": 8,
                "orientation": "mixed",
                "master_orientation": "horizontal",
                "handwritten": 0.0,
                "irregularity": 0.0,
                "source_catalog_id": "fixture-hard",
            },
            {
                "sample_id": "sample-none-sfx",
                "work_id": "work-b",
                "split": "val",
                "role": "sfx_impact",
                "none": True,
                "unknown_count": 0,
                "orientation": "vertical",
                "master_orientation": "vertical",
                "handwritten": 0.4,
                "irregularity": 0.4,
                "source_catalog_id": "fixture-hard",
            },
            {
                "sample_id": "sample-aside",
                "work_id": "work-c",
                "split": "test",
                "role": "aside_balloon_edge",
                "none": False,
                "unknown_count": 0,
                "orientation": "vertical",
                "master_orientation": "vertical",
                "handwritten": 0.0,
                "irregularity": 0.0,
                "source_catalog_id": "fixture-hard",
            },
            {
                "sample_id": "sample-handwritten",
                "work_id": "work-a",
                "split": "train",
                "role": "dialogue",
                "none": False,
                "unknown_count": 0,
                "orientation": "horizontal",
                "master_orientation": "horizontal",
                "handwritten": 0.8,
                "irregularity": 0.7,
                "source_catalog_id": "fixture-hard",
            },
            {
                "sample_id": "sample-dialogue-a",
                "work_id": "work-b",
                "split": "val",
                "role": "dialogue",
                "none": False,
                "unknown_count": 0,
                "orientation": "vertical",
                "master_orientation": "vertical",
                "handwritten": 0.0,
                "irregularity": 0.0,
                "source_catalog_id": "fixture-base",
            },
            {
                "sample_id": "sample-dialogue-b",
                "work_id": "work-c",
                "split": "test",
                "role": "dialogue",
                "none": False,
                "unknown_count": 0,
                "orientation": "vertical",
                "master_orientation": "vertical",
                "handwritten": 0.0,
                "irregularity": 0.0,
                "source_catalog_id": "fontclip-recrop-accepted-v1",
            },
        ]
        self._write_catalogs_and_render_bank()
        self._write_registry()
        self._write_finals_master_and_export()

    def _write_catalogs_and_render_bank(self) -> None:
        write_json(
            self.legacy_catalog,
            {
                "schema_version": "font-face-manifest-v1",
                "family_count": len(V3_LEGACY_FONT_IDS),
                "families": [{"font_id": value} for value in V3_LEGACY_FONT_IDS],
            },
        )
        write_json(
            self.expanded_catalog,
            {
                "schema_version": "font-face-manifest-v1",
                "family_count": len(V3_ALL_FONT_IDS),
                "families": [{"font_id": value} for value in V3_ALL_FONT_IDS],
            },
        )
        candidates = [
            {
                "font_id": font_id,
                "face_id": f"face-{index:02d}",
                "display_id": self.display_ids[font_id],
                "blind_alias": self.aliases[font_id],
                "production_400_normal_canonical": True,
                "production_asset_status": {"chromium_ots_compatible": True},
                "allowed_writing_modes": ["horizontal", "vertical"],
                "render_weight": 400,
                "render_style": "normal",
                "production_request_bindings": [
                    {
                        "requested_weight": 400,
                        "requested_style": "normal",
                        "synthetic_style": False,
                    }
                ],
            }
            for index, font_id in enumerate(V3_ALL_FONT_IDS)
        ]
        probes = [
            {"id": f"probe-{index:02d}", "text": f"검수{index}"} for index in range(10)
        ]
        renders: list[dict[str, Any]] = []
        for font_id in V3_NEW_FONT_IDS:
            alias = self.aliases[font_id]
            for probe in probes:
                for mode in ("horizontal", "vertical"):
                    relative = f"images/{alias}/{probe['id']}-{mode}.bin"
                    payload = f"{alias}:{probe['id']}:{mode}".encode("utf-8")
                    artifact_path = self.render_bank_root.joinpath(
                        *Path(relative).parts
                    )
                    artifact_path.parent.mkdir(parents=True, exist_ok=True)
                    artifact_path.write_bytes(payload)
                    renders.append(
                        {
                            "render_id": f"render-{alias}-{probe['id']}-{mode}",
                            "candidate_display_id": self.display_ids[font_id],
                            "probe_id": probe["id"],
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
            "candidate_identity_contract": {
                "display_id_field": "candidate_display_id",
                "blind_alias_field": "blind_alias",
                "image_paths_expose_font_identity": False,
            },
            "render_spec": {"qa_overlay": False},
            "probe_bank": probes,
            "candidates": candidates,
            "renders": renders,
        }
        self.rewrite_bank()

    def rewrite_bank(self) -> None:
        write_json(self.render_bank_manifest, self.bank_document)

    def _write_registry(self) -> None:
        self.registry_document = seal_source_record(
            {
                "schema_version": "font-matching-catalog-registry-v1",
                "record_type": "font_matching_catalog_registry",
                "catalogs": [],
                "exclusion_ledgers": [],
                "frozen_split_map": {"path": "fixture", "sha256": "1" * 64},
                "parent_master": {"manifest": "fixture", "manifest_sha256": "2" * 64},
            }
        )
        write_json(self.registry, self.registry_document)

    def _style(self, spec: dict[str, Any]) -> dict[str, Any]:
        unknown_fields = list(LABELS.STYLE_FIELDS[: spec["unknown_count"]])
        style: dict[str, Any] = {
            field: (None if field in unknown_fields else 0.25)
            for field in LABELS.STYLE_FIELDS
        }
        style["handwritten"] = (
            None if "handwritten" in unknown_fields else float(spec["handwritten"])
        )
        style["irregularity"] = (
            None if "irregularity" in unknown_fields else float(spec["irregularity"])
        )
        style["unknown_fields"] = unknown_fields
        return style

    def _final(self, spec: dict[str, Any], *, index: int) -> dict[str, Any]:
        if spec["none"]:
            judgment = {
                "preferred": [],
                "acceptable": [],
                "marginal": list(V3_LEGACY_FONT_IDS),
                "unacceptable": [],
                "unrenderable": [],
                "not_reviewed": [],
                "none_acceptable": True,
            }
            flags = ["none_acceptable_confirmed"]
        else:
            judgment = {
                "preferred": [V3_LEGACY_FONT_IDS[0]],
                "acceptable": [V3_LEGACY_FONT_IDS[1]],
                "marginal": list(V3_LEGACY_FONT_IDS[2:]),
                "unacceptable": [],
                "unrenderable": [],
                "not_reviewed": [],
                "none_acceptable": False,
            }
            flags = []
        known = spec["sample_id"] == "fm_08980fe9ca80d39e6c18a32f"
        consistency = (
            {"policy": "undetermined", "reason_code": "insufficient_evidence"}
            if known
            else {"policy": "inherit_work_anchor", "reason_code": "ordinary_dialogue"}
        )
        return LABELS.seal_record(
            {
                "schema_version": 1,
                "record_type": "manga_font_label_final",
                "final_id": f"final-{spec['sample_id']}",
                "sample_id": spec["sample_id"],
                "work_id": spec["work_id"],
                "source_page_sha256": f"{index + 1:064x}",
                "role": {"primary": spec["role"], "confidence": 0.95},
                "source_style": self._style(spec),
                "treatment": {
                    "orientation": spec["orientation"],
                    "outline": "none",
                    "shadow": "none",
                    "fill": "solid",
                    "distortion": "none",
                },
                "font_judgment": judgment,
                "consistency": consistency,
                "resolution": {
                    "kind": "primary",
                    "resolver": "fixture-human",
                    "resolved_at": "2026-08-01T00:00:00Z",
                    "source_label_ids": [f"label-{spec['sample_id']}"],
                    "catalog_version": "font-face-manifest-v1",
                    "catalog_sha256": RESCUE.sha256_file(self.legacy_catalog),
                    "renderer_hash": "d" * 64,
                    "confidence": 0.9,
                    "flags": flags,
                    "notes": (
                        "점만으로 family를 판별할 수 없어 학습용 family 대응에서는 제외가 필요하다."
                        if known
                        else ""
                    ),
                    "adjudication_evidence": None,
                },
            }
        )

    def _write_finals_master_and_export(self) -> None:
        finals = [
            self._final(spec, index=index) for index, spec in enumerate(self.specs)
        ]
        excluded_spec = {
            **self.specs[-1],
            "sample_id": "sample-invalidated",
            "work_id": "work-c",
            "none": True,
        }
        excluded_final = self._final(excluded_spec, index=len(self.specs))
        self.final_rows = [*finals, excluded_final]
        write_jsonl(self.final_labels, self.final_rows)

        master_rows: list[dict[str, Any]] = []
        samples: list[dict[str, Any]] = []
        for index, (spec, final) in enumerate(zip(self.specs, finals, strict=True)):
            provenance = {
                "approval": "exhaustive_manual_visual_review",
                "qa_overlay": False,
                "synthetic": False,
                "source_catalog_id": spec["source_catalog_id"],
                "source_id": f"source-{index}",
                "source_kind": (
                    "hard" if "base" not in spec["source_catalog_id"] else "base"
                ),
                "source_line_number": index + 1,
                "source_line_sha256": f"{index + 101:064x}",
                "source_lineage": [],
            }
            geometry = {
                "bbox_px": [10, 20, 60, 90],
                "crop_bbox_px": [8, 18, 62, 92],
                "final_bbox_px": [5, 15, 65, 95],
                "mask_tight_bbox_px": [12, 22, 58, 88],
                "page_size_px": [100, 120],
            }
            views = {
                name: {
                    "catalog_id": spec["source_catalog_id"],
                    "status": "available",
                    "path": f"images/{name}/{spec['sample_id']}.png",
                    "file_sha256": f"{index + offset:064x}",
                }
                for offset, name in enumerate(
                    ("raw_224", "context_224", "glyph_224"), start=201
                )
            }
            master_rows.append(
                {
                    "schema_version": 1,
                    "id": spec["sample_id"],
                    "catalog_version": 1,
                    "work": {"id": spec["work_id"], "title": spec["work_id"]},
                    "chapter": {"id": f"chapter-{index}", "title": "chapter"},
                    "page": {
                        "id": f"page-{index}",
                        "source_page_sha256": final["source_page_sha256"],
                        "source_locator": {
                            "path": f"works/{spec['work_id']}/page-{index}.png",
                            "file_sha256": final["source_page_sha256"],
                        },
                    },
                    "sample_crop_sha256": f"{index + 301:064x}",
                    "geometry": geometry,
                    "views": views,
                    "split": spec["split"],
                    "legacy_split": "train",
                    "metadata": {
                        "orientation": spec["master_orientation"],
                        "candidate_metadata": {
                            "model_font_suggestion": "must-disappear"
                        },
                    },
                    "font_label": None,
                    "label_status": "unlabeled",
                    "groups": {"split_component": f"component-{spec['work_id']}"},
                    "provenance": provenance,
                    "work_balance_weight": 0.5,
                }
            )
            samples.append(
                seal_source_record(
                    {
                        "schema_version": "font-matching-training-sample-v1",
                        "sample_id": spec["sample_id"],
                        "example_id": f"example-{index}",
                        "work_id": spec["work_id"],
                        "chapter_id": f"chapter-{index}",
                        "page_id": f"page-{index}",
                        "split": spec["split"],
                        "role": copy.deepcopy(final["role"]),
                        "source_style": copy.deepcopy(final["source_style"]),
                        "treatment": copy.deepcopy(final["treatment"]),
                        "font_judgment": copy.deepcopy(final["font_judgment"]),
                        "consistency": copy.deepcopy(final["consistency"]),
                        "source": {
                            "source_page_sha256": final["source_page_sha256"],
                            "sample_crop_sha256": f"{index + 301:064x}",
                            "geometry": geometry,
                            "views": views,
                        },
                        "provenance": {
                            "approval": "completed_human_final_label",
                            "qa_overlay": False,
                            "synthetic": False,
                            "master": provenance,
                        },
                        "review_provenance": {
                            "final_record_sha256": final["record_sha256"],
                            "resolution": copy.deepcopy(final["resolution"]),
                            "source_reviews": [],
                        },
                        "input_bindings": {},
                    }
                )
            )
        self.master_rows = master_rows
        write_jsonl(self.master_manifest, master_rows)
        work_split = {spec["work_id"]: spec["split"] for spec in self.specs}
        write_json(
            self.master_split_map,
            {
                "schema_version": 1,
                "work_assignments": work_split,
            },
        )
        registry_sha = RESCUE.sha256_file(self.registry)
        registry_record_sha = self.registry_document["record_sha256"]
        write_json(
            self.master_report,
            {
                "report_schema_version": 1,
                "inputs": {
                    "attestation": {
                        "catalog_registry": {
                            "sha256": registry_sha,
                            "record_sha256": registry_record_sha,
                        }
                    }
                },
                "outputs": {
                    "master_manifest_sha256": RESCUE.sha256_file(self.master_manifest),
                    "split_map_sha256": RESCUE.sha256_file(self.master_split_map),
                },
            },
        )
        input_bindings = {
            "catalog_registry_sha256": registry_sha,
            "font_catalog_sha256": RESCUE.sha256_file(self.legacy_catalog),
            "master_manifest_sha256": RESCUE.sha256_file(self.master_manifest),
        }
        for sample in samples:
            sample["input_bindings"] = copy.deepcopy(input_bindings)
            sample.update(seal_source_record(sample))
        self.sample_rows = samples
        write_jsonl(self.training_export / "samples.jsonl", samples)
        excluded_digest = RESCUE.sorted_ids_sha256({"sample-invalidated"})
        sample_descriptor = {
            "file": "samples.jsonl",
            "record_count": len(samples),
            "byte_size": (self.training_export / "samples.jsonl").stat().st_size,
            "sha256": RESCUE.sha256_file(self.training_export / "samples.jsonl"),
        }
        exclusions = {
            "catalog_registry_sha256": registry_sha,
            "excluded_final_count": 1,
            "excluded_final_ids_sha256": excluded_digest,
            "ids_digest_algorithm": "sha256-sorted-lf-utf8-v1",
        }
        manifest = {
            "schema_version": "font-matching-training-export-v1",
            "artifacts": {"samples.jsonl": sample_descriptor},
            "candidate_count": 15,
            "real_sample_count": len(samples),
            "input_hashes": {
                **input_bindings,
                "master_report_sha256": RESCUE.sha256_file(self.master_report),
                "master_split_map_sha256": RESCUE.sha256_file(self.master_split_map),
                "finals_sha256": RESCUE.sha256_file(self.final_labels),
            },
            "registry_exclusions": exclusions,
            "master_registry_binding": {
                "mode": "registry_parent_workspace_projection",
                "successor_label_inheritance_allowed": False,
                "master_report_sha256": RESCUE.sha256_file(self.master_report),
                "master_split_map_sha256": RESCUE.sha256_file(self.master_split_map),
                "attestation": {
                    "catalog_registry": {
                        "sha256": registry_sha,
                        "record_sha256": registry_record_sha,
                    }
                },
            },
            "work_split": work_split,
        }
        write_json(self.training_export / "manifest.json", manifest)
        manifest_sha = RESCUE.sha256_file(self.training_export / "manifest.json")
        split_counts: dict[str, int] = {}
        for spec in self.specs:
            split_counts[spec["split"]] = split_counts.get(spec["split"], 0) + 1
        report = {
            "schema_version": "font-matching-training-export-report-v1",
            "manifest_sha256": manifest_sha,
            "outputs": {"samples.jsonl": sample_descriptor},
            "registry_exclusions": exclusions | {"parent_workspace_projection": True},
            "summary": {
                "sample_count": len(samples),
                "candidate_count": 15,
                "completed_final_count": len(self.final_rows),
                "excluded_final_count": 1,
                "by_split": split_counts,
            },
            "checks": {
                "successor_label_inheritance_count": 0,
                "core_qa_overlay_count": 0,
                "core_synthetic_count": 0,
            },
        }
        write_json(self.training_export / "report.json", report)
        write_json(
            self.training_export / RESCUE.TRAINING_EXPORT_MARKER,
            {
                "owner": RESCUE.TRAINING_EXPORT_OWNER,
                "schema_version": RESCUE.TRAINING_EXPORT_SCHEMA,
                "safe_replace": True,
                "manifest_sha256": manifest_sha,
                "report_sha256": RESCUE.sha256_file(
                    self.training_export / "report.json"
                ),
            },
        )

    def rewrite_samples_and_seals(self) -> None:
        write_jsonl(self.training_export / "samples.jsonl", self.sample_rows)
        manifest = json.loads(
            (self.training_export / "manifest.json").read_text(encoding="utf-8")
        )
        descriptor = manifest["artifacts"]["samples.jsonl"]
        descriptor["byte_size"] = (
            (self.training_export / "samples.jsonl").stat().st_size
        )
        descriptor["sha256"] = RESCUE.sha256_file(
            self.training_export / "samples.jsonl"
        )
        write_json(self.training_export / "manifest.json", manifest)
        report = json.loads(
            (self.training_export / "report.json").read_text(encoding="utf-8")
        )
        report["manifest_sha256"] = RESCUE.sha256_file(
            self.training_export / "manifest.json"
        )
        report["outputs"]["samples.jsonl"] = copy.deepcopy(descriptor)
        write_json(self.training_export / "report.json", report)
        marker = json.loads(
            (self.training_export / RESCUE.TRAINING_EXPORT_MARKER).read_text(
                encoding="utf-8"
            )
        )
        marker["manifest_sha256"] = RESCUE.sha256_file(
            self.training_export / "manifest.json"
        )
        marker["report_sha256"] = RESCUE.sha256_file(
            self.training_export / "report.json"
        )
        write_json(self.training_export / RESCUE.TRAINING_EXPORT_MARKER, marker)

    def build_kwargs(self) -> dict[str, Any]:
        return {
            "training_export_dir": self.training_export,
            "prior_final_labels": self.final_labels,
            "master_manifest": self.master_manifest,
            "master_report": self.master_report,
            "master_split_map": self.master_split_map,
            "catalog_registry": self.registry,
            "legacy_catalog": self.legacy_catalog,
            "expanded_catalog": self.expanded_catalog,
            "expanded_render_bank": self.render_bank_manifest,
            "expected_samples": len(self.specs),
            "expected_invalidated": 1,
            "expected_new_candidates": 7,
        }

    def build_files(self) -> dict[str, bytes]:
        return RESCUE.build_delta_files(**self.build_kwargs())

    def cli_args(self, command: str) -> list[str]:
        return [
            command,
            "--training-export-dir",
            str(self.training_export),
            "--final-labels",
            str(self.final_labels),
            "--master-manifest",
            str(self.master_manifest),
            "--master-report",
            str(self.master_report),
            "--master-split-map",
            str(self.master_split_map),
            "--catalog-registry",
            str(self.registry),
            "--legacy-catalog",
            str(self.legacy_catalog),
            "--expanded-catalog",
            str(self.expanded_catalog),
            "--expanded-render-bank",
            str(self.render_bank_manifest),
            "--output-dir",
            str(self.output),
            "--expected-samples",
            str(len(self.specs)),
            "--expected-invalidated",
            "1",
            "--expected-new-candidates",
            "7",
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
            self.assertEqual("horizontal", selections[0]["previous_master_orientation"])
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
                lambda render: render["readiness"].__setitem__("content_fits", False),
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


class CatalogDeltaReviewInputTests(unittest.TestCase):
    def test_v3_variant_priority_is_the_single_mandatory_secondary_contract(
        self,
    ) -> None:
        rows: list[dict[str, Any]] = []
        expected_mandatory: set[str] = set()
        for role in sorted(RESCUE.VARIANT_SECONDARY_ROLES):
            sample_id = f"variant-{role}"
            sample = delta_priority_sample(sample_id, role=role)
            rank, code, reasons = RESCUE._priority_for_sample(sample)
            self.assertEqual((1, "priority_1"), (rank, code))
            self.assertIn(role, reasons)
            expected_mandatory.add(sample_id)
            rows.append(
                {
                    "sample_id": sample_id,
                    "work_id": sample["work_id"],
                    "sample": sample,
                    "priority_rank": rank,
                }
            )

        priority_cases = (
            ("high-handwritten", {"handwritten": 0.5}, 1, "handwritten"),
            ("high-irregular", {"irregularity": 0.5}, 1, "irregular"),
            ("manual-recrop", {"manual_recrop": True}, 1, "manual_recrop"),
            (
                "source-family-override",
                {"source_family_override": True},
                1,
                "source_family_override",
            ),
            ("prior-none", {"none_acceptable": True}, 0, "prior_none_acceptable"),
            (
                "eligibility-risk",
                {"unknown_count": 5},
                0,
                "font_signal_eligibility_risk",
            ),
        )
        for sample_id, kwargs, expected_rank, expected_reason in priority_cases:
            sample = delta_priority_sample(sample_id, **kwargs)
            audit_reasons = RESCUE._font_signal_audit_reasons(sample)
            rank, code, reasons = RESCUE._priority_for_sample(
                sample, eligibility_risk_reasons=audit_reasons
            )
            self.assertEqual(expected_rank, rank)
            self.assertEqual(f"priority_{expected_rank}", code)
            self.assertIn(expected_reason, reasons)
            expected_mandatory.add(sample_id)
            rows.append(
                {
                    "sample_id": sample_id,
                    "work_id": sample["work_id"],
                    "sample": sample,
                    "priority_rank": rank,
                }
            )

        ordinary_ids: set[str] = set()
        for index in range(10):
            sample_id = f"ordinary-dialogue-{index}"
            sample = delta_priority_sample(sample_id)
            rank, code, reasons = RESCUE._priority_for_sample(sample)
            self.assertEqual((2, "priority_2", ["ordinary"]), (rank, code, reasons))
            ordinary_ids.add(sample_id)
            rows.append(
                {
                    "sample_id": sample_id,
                    "work_id": sample["work_id"],
                    "sample": sample,
                    "priority_rank": rank,
                }
            )

        mandatory, sampled = RESCUE._secondary_sample_ids(rows)
        self.assertEqual(expected_mandatory, mandatory)
        self.assertEqual(2, len(sampled))
        self.assertTrue(sampled <= ordinary_ids)
        self.assertEqual((mandatory, sampled), RESCUE._secondary_sample_ids(rows))

    def test_v3_uses_all_active_samples_and_seals_prior_final_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))

            files = fixture.build_files()
            masters = decode_jsonl(files[RESCUE.MASTER_FILE])
            selections = decode_jsonl(files[RESCUE.SELECTION_FILE])
            assignments = decode_jsonl(files[RESCUE.ASSIGNMENTS_FILE])
            bank = json.loads(files[RESCUE.RENDER_BANK_MANIFEST])
            report = json.loads(files[RESCUE.REPORT_FILE])

            active_ids = {spec["sample_id"] for spec in fixture.specs}
            self.assertEqual(active_ids, {row["id"] for row in masters})
            self.assertEqual(active_ids, {row["sample_id"] for row in selections})
            self.assertNotIn("sample-invalidated", active_ids)
            self.assertEqual(
                active_ids,
                {row["sample_id"] for row in assignments if row["stage"] == "primary"},
            )
            self.assertTrue(all("split" not in row for row in masters))
            self.assertTrue(all("legacy_split" not in row for row in masters))
            self.assertTrue(all("font_label" not in row for row in masters))
            self.assertTrue(
                all("candidate_metadata" not in row["metadata"] for row in masters)
            )
            prior_by_sample = {row["sample_id"]: row for row in fixture.final_rows[:-1]}
            for selection in selections:
                sample_id = selection["sample_id"]
                provenance = selection["merge_provenance"]
                self.assertEqual(
                    prior_by_sample[sample_id], provenance["prior_final_record"]
                )
                self.assertEqual(
                    prior_by_sample[sample_id]["record_sha256"],
                    provenance["prior_final_record_sha256"],
                )
                judgment = selection["new_7_candidate_judgment"]
                self.assertEqual(list(V3_NEW_FONT_IDS), judgment["not_reviewed"])
                self.assertIsNone(judgment["none_acceptable"])
                self.assertFalse(judgment["automatic_tier_assignment_allowed"])
                for tier in (
                    "preferred",
                    "acceptable",
                    "marginal",
                    "unacceptable",
                    "unrenderable",
                ):
                    self.assertEqual([], judgment[tier])
                self.assertFalse(selection["review_surface"]["font_names_visible"])
                self.assertFalse(selection["review_surface"]["prior_tiers_visible"])
                self.assertFalse(selection["review_surface"]["split_visible"])
                self.assertFalse(
                    selection["review_surface"]["model_suggestions_visible"]
                )

            self.assertEqual(
                list(V3_NEW_FONT_IDS), report["summary"]["new_candidate_ids"]
            )
            self.assertEqual(6 * 7, report["summary"]["new_candidate_cells"])
            self.assertEqual(1, report["summary"]["invalidated_final_count"])
            self.assertEqual(
                0, report["summary"]["old_label_inheritance_to_successor_count"]
            )
            self.assertEqual(0, report["summary"]["qa_overlay_sample_count"])
            self.assertEqual(0, report["summary"]["synthetic_sample_count"])
            self.assertEqual(140, report["summary"]["copied_render_count"])
            self.assertEqual(7, len(bank["candidates"]))
            self.assertEqual(140, len(bank["renders"]))

    def test_v3_priority_assignments_and_font_signal_gate_are_blind(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))

            files = fixture.build_files()
            selections = decode_jsonl(files[RESCUE.SELECTION_FILE])
            assignments = decode_jsonl(files[RESCUE.ASSIGNMENTS_FILE])
            audits = decode_jsonl(files[RESCUE.FONT_SIGNAL_AUDIT_FILE])
            report = json.loads(files[RESCUE.REPORT_FILE])

            ranks = [row["priority"]["rank"] for row in selections]
            self.assertEqual(sorted(ranks), ranks)
            self.assertEqual([0, 0], ranks[:2])
            first_two_works = [row["work_id"] for row in selections[:2]]
            self.assertEqual(2, len(set(first_two_works)))
            self.assertTrue(
                all(
                    row["priority"]["split_used_for_ordering"] is False
                    for row in selections
                )
            )

            primary = [row for row in assignments if row["stage"] == "primary"]
            secondary = [row for row in assignments if row["stage"] == "secondary"]
            self.assertEqual(len(fixture.specs), len(primary))
            mandatory = {
                "fm_08980fe9ca80d39e6c18a32f",
                "sample-none-sfx",
                "sample-aside",
                "sample-handwritten",
                "sample-dialogue-b",
            }
            secondary_ids = {row["sample_id"] for row in secondary}
            selection_priority = {
                row["sample_id"]: row["priority"]["rank"] for row in selections
            }
            self.assertEqual(
                mandatory,
                {
                    sample_id
                    for sample_id, priority in selection_priority.items()
                    if priority <= 1
                },
            )
            self.assertTrue(mandatory <= secondary_ids)
            for assignment in assignments:
                self.assertEqual(7, assignment["candidate_count"])
                self.assertEqual("not_reviewed", assignment["candidate_initial_state"])
                self.assertFalse(assignment["font_names_visible"])
                self.assertFalse(assignment["model_suggestions_visible"])
                self.assertFalse(assignment["prior_tiers_visible"])
                self.assertFalse(assignment["split_visible"])
                self.assertEqual(
                    set(V3_NEW_FONT_IDS), set(assignment["candidate_order"])
                )
                self.assertTrue(
                    all(
                        alias.startswith("ko-candidate-")
                        for alias in assignment["blind_alias_order"]
                    )
                )
                if assignment["stage"] == "secondary":
                    self.assertTrue(
                        assignment["reviewer_independence"]["required_for_secondary"]
                    )
                    self.assertFalse(
                        assignment["reviewer_independence"][
                            "same_reviewer_as_primary_allowed"
                        ]
                    )
                self.assertEqual(
                    [
                        "primary_secondary_disagreement",
                        "none_acceptable",
                        "confidence_below_0.80",
                    ],
                    assignment["adjudication_if"],
                )

            self.assertEqual(1, len(audits))
            audit = audits[0]
            self.assertEqual("fm_08980fe9ca80d39e6c18a32f", audit["sample_id"])
            self.assertEqual("pending_human_audit", audit["status"])
            self.assertFalse(
                audit["decision_contract"]["automatic_absent_classification_allowed"]
            )
            self.assertEqual(
                {
                    "font_signal_present",
                    "font_signal_absent",
                    "needs_recrop",
                    "uncertain",
                },
                set(audit["decision_contract"]["allowed_human_outcomes"]),
            )
            known_selection = next(
                row for row in selections if row["sample_id"] == audit["sample_id"]
            )
            self.assertEqual({}, known_selection["batches"])
            self.assertEqual(
                "blocked_pending_font_signal_audit",
                next(row for row in primary if row["sample_id"] == audit["sample_id"])[
                    "release_state"
                ],
            )
            self.assertEqual(1, report["summary"]["font_signal_audit_count"])
            self.assertEqual(7, report["summary"]["font_signal_audit_blocked_cells"])
            self.assertEqual(35, report["summary"]["review_ready_new_candidate_cells"])
            self.assertEqual(
                RESCUE.sorted_ids_sha256({audit["sample_id"]}),
                report["summary"]["font_signal_audit_sample_ids_sha256"],
            )
            self.assertEqual(0, report["summary"]["priority_0_missing_secondary"])
            self.assertEqual(0, report["summary"]["priority_1_missing_secondary"])
            self.assertEqual(
                len([rank for rank in ranks if rank == 0]),
                report["summary"]["priority_0_secondary_count"],
            )
            self.assertEqual(
                len([rank for rank in ranks if rank == 1]),
                report["summary"]["priority_1_secondary_count"],
            )
            assignment_contract = report["contracts"]["assignments"]
            self.assertEqual(
                ["priority_0", "priority_1"],
                assignment_contract["mandatory_independent_secondary"],
            )
            self.assertEqual(
                "priority_rank_lte_1",
                assignment_contract["mandatory_secondary_rule"],
            )
            self.assertEqual(0, assignment_contract["priority_0_missing_secondary"])
            self.assertEqual(0, assignment_contract["priority_1_missing_secondary"])

    def test_v3_rejects_tampered_export_projection_and_blind_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))
            samples_path = fixture.training_export / "samples.jsonl"
            samples_path.write_bytes(samples_path.read_bytes() + b"\n")

            with self.assertRaisesRegex(RESCUE.RescueInputError, "missing or stale"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))
            changed = copy.deepcopy(fixture.sample_rows[0])
            changed["review_provenance"]["final_record_sha256"] = "e" * 64
            fixture.sample_rows[0] = seal_source_record(changed)
            fixture.rewrite_samples_and_seals()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "prior final hash"):
                fixture.build_files()

        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))
            fixture.bank_document["candidates"][-1]["blind_alias"] = fixture.aliases[
                V3_LEGACY_FONT_IDS[0]
            ]
            fixture.rewrite_bank()

            with self.assertRaisesRegex(RESCUE.RescueInputError, "blind aliases"):
                fixture.build_files()

    def test_v3_build_validate_and_rebuild_are_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = DeltaFixture(Path(directory))

            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, RESCUE.main(fixture.cli_args("build-v3")))
            first = snapshot(fixture.output)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(0, RESCUE.main(fixture.cli_args("validate-v3")))
                self.assertEqual(0, RESCUE.main(fixture.cli_args("build-v3")))
            second = snapshot(fixture.output)

            self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
