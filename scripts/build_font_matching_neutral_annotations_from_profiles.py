#!/usr/bin/env python3
"""Build strict candidate-free v5 neutral annotations from visual profiles."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


AXES = ("weight", "width", "roundness", "handwritten", "angularity", "energy")
TREATMENTS = ("outline", "shadow", "inverse_fill", "texture", "distortion", "rotation")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if raw.strip():
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} must be an object")
            rows.append(value)
    return rows


def _role_evidence(role: str) -> dict[str, Any]:
    value: dict[str, Any] = {
        "label": False,
        "sfx_event": "none",
        "comic_timing": False,
        "external_utterance": False,
        "independent_aside": False,
        "same_utterance_contrast": False,
        "shout_cues": [],
        "whisper": False,
        "inner_thought": False,
        "narrator": False,
        "other": False,
    }
    if role == "sign_ui_title":
        value["label"] = True
    elif role in {"sfx_impact", "sfx_motion", "sfx_ambient", "sfx_emotion"}:
        value["sfx_event"] = role.removeprefix("sfx_")
    elif role == "sfx_comic":
        value["comic_timing"] = True
    elif role == "aside_balloon_edge":
        value["external_utterance"] = True
        value["independent_aside"] = True
    elif role == "emphasis_dialogue":
        value["external_utterance"] = True
        value["same_utterance_contrast"] = True
    elif role == "shout":
        value["external_utterance"] = True
        value["shout_cues"] = [
            "semantic_high_volume",
            "size_or_weight",
            "balloon_or_background",
        ]
    elif role == "whisper":
        value["external_utterance"] = True
        value["whisper"] = True
    elif role == "dialogue":
        value["external_utterance"] = True
    elif role == "thought":
        value["inner_thought"] = True
    elif role == "narration":
        value["narrator"] = True
    elif role == "other":
        value["other"] = True
    else:
        raise ValueError(f"unsupported role: {role}")
    return value


def _serif_evidence(profile: dict[str, Any]) -> dict[str, Any]:
    glyph_ids = [f"glyph-{index}" for index in range(1, int(profile.get("serif", 0)) + 1)]
    return {
        "raw": {
            "thick_thin_glyph_ids": glyph_ids,
            "terminal_serif_glyph_ids": glyph_ids,
        },
        "glyph_view": {
            "thick_thin_glyph_ids": glyph_ids,
            "terminal_serif_glyph_ids": glyph_ids,
        },
        "cross_view_glyph_ids": glyph_ids,
    }


def _eligibility(profile: dict[str, Any]) -> dict[str, Any]:
    default = {
        "complete_text_object": True,
        "single_source_skeleton": True,
        "clean_glyph_isolation": True,
        "role_context_sufficient": True,
        "font_signal_skeleton_present": True,
        "crop_issue": "none",
    }
    default.update(profile.get("elig", {}))
    return default


def build(*, profiles_path: Path, bindings_path: Path, stage: str) -> list[dict[str, Any]]:
    profiles = json.loads(profiles_path.read_text(encoding="utf-8"))
    if not isinstance(profiles, list):
        raise ValueError("profiles must be an array")
    by_filename: dict[str, dict[str, Any]] = {}
    for binding in _read_jsonl(bindings_path):
        assignment = binding["assignment"]
        if assignment["stage"] != stage:
            continue
        filename = Path(binding["card"]["v5_source_card"]["file"]).name
        if filename in by_filename:
            raise ValueError(f"duplicate binding filename: {filename}")
        by_filename[filename] = binding

    rows: list[dict[str, Any]] = []
    seen_files: set[str] = set()
    for profile in profiles:
        filename = str(profile["file"])
        if filename in seen_files:
            raise ValueError(f"duplicate profile filename: {filename}")
        seen_files.add(filename)
        binding = by_filename.get(filename)
        if binding is None:
            raise ValueError(f"profile has no {stage} binding: {filename}")
        assignment = binding["assignment"]
        card = binding["card"]["v5_source_card"]
        axis_values = profile["axes"]
        if len(axis_values) != len(AXES):
            raise ValueError(f"{filename}: expected {len(AXES)} axes")
        treated = set(profile.get("treat", []))
        unknown_treatments = treated.difference(TREATMENTS)
        if unknown_treatments:
            raise ValueError(f"{filename}: unsupported treatments {sorted(unknown_treatments)}")
        rows.append(
            {
                "schema_version": "font-matching-delta-source-annotation-neutral-v5",
                "record_type": "font_matching_delta_source_annotation_neutral",
                "assignment_id": assignment["assignment_id"],
                "sample_id": assignment["sample_id"],
                "stage": stage,
                "source_only_card_sha256": card["sha256"],
                "eligibility_evidence": _eligibility(profile),
                "role_evidence": _role_evidence(str(profile["role"])),
                "source_family": profile["family"],
                "source_family_confidence": profile["fc"],
                "serif_evidence": _serif_evidence(profile),
                "axes": dict(zip(AXES, axis_values, strict=True)),
                "hard_axes": profile["hard"],
                "treatment": {key: key in treated for key in TREATMENTS},
                "rationale": profile["why"],
                "review_confidence": profile["conf"],
                "visual_review_index": profile["i"],
            }
        )
    missing = set(by_filename).difference(seen_files)
    if missing:
        raise ValueError(f"missing {len(missing)} bound profiles")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", type=Path, required=True)
    parser.add_argument("--private-bindings", type=Path, required=True)
    parser.add_argument("--stage", choices=("primary", "secondary"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = build(
        profiles_path=args.profiles,
        bindings_path=args.private_bindings,
        stage=args.stage,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(json.dumps({"stage": args.stage, "rows": len(rows), "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
