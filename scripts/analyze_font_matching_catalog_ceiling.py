#!/usr/bin/env python3
"""Measure whether the reviewed Korean font catalog contains acceptable matches.

The report is intentionally computed only from sealed final human labels.  It
is a P1 go/no-go gate: if ordinary dialogue or SFX exceeds the frozen
``none_acceptable`` ceilings, the catalog/treatment palette must be expanded
before training a model that would merely learn to choose a bad candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

try:
    import font_matching_labels as labels
except ImportError:  # pragma: no cover - module import from repository root
    from scripts import font_matching_labels as labels  # type: ignore[no-redef]


SCHEMA_VERSION = "font-matching-catalog-ceiling-v1"
RECORD_TYPE = "font_matching_catalog_ceiling_report"
SFX_ROLES = frozenset(
    {
        "sfx_impact",
        "sfx_motion",
        "sfx_ambient",
        "sfx_emotion",
        "sfx_comic",
    }
)
ROLE_VALUES = tuple(labels.ROLE_VALUES)


class CatalogCeilingError(ValueError):
    """Raised when catalog-ceiling evidence is incomplete or inconsistent."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(value: Mapping[str, Any]) -> dict[str, Any]:
    output = dict(value)
    output["record_sha256"] = hashlib.sha256(canonical_json(output)).hexdigest()
    return output


def atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def require_probability(value: Any, *, location: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or not 0 <= float(value) <= 1
    ):
        raise CatalogCeilingError(f"{location}: expected a probability")
    return float(value)


def candidate_universe(row: Mapping[str, Any]) -> tuple[str, ...]:
    judgment = row.get("font_judgment")
    if not isinstance(judgment, Mapping):
        raise CatalogCeilingError("font_judgment must be an object")
    values: list[str] = []
    for tier in labels.FONT_TIERS:
        candidates = judgment.get(tier)
        if not isinstance(candidates, list):
            raise CatalogCeilingError(f"font_judgment.{tier} must be an array")
        values.extend(str(candidate) for candidate in candidates)
    return tuple(sorted(values))


def validate_finals(
    rows: Sequence[Mapping[str, Any]], *, expected_finals: int | None
) -> tuple[tuple[str, ...], dict[str, str]]:
    if not rows:
        raise CatalogCeilingError("final label ledger is empty")
    if expected_finals is not None and len(rows) != expected_finals:
        raise CatalogCeilingError(
            f"expected {expected_finals} final labels, got {len(rows)}"
        )
    universe = candidate_universe(rows[0])
    if not universe:
        raise CatalogCeilingError("candidate universe is empty")
    if len(universe) != len(set(universe)):
        raise CatalogCeilingError("candidate universe contains duplicates")
    sample_ids: set[str] = set()
    contracts: set[tuple[str, str, str]] = set()
    for index, row in enumerate(rows, 1):
        try:
            labels.validate_final_record(row, candidate_ids=universe)
        except labels.LabelValidationError as error:
            raise CatalogCeilingError(f"final[{index}]: {error}") from error
        sample_id = str(row["sample_id"])
        if sample_id in sample_ids:
            raise CatalogCeilingError(f"duplicate final sample: {sample_id}")
        sample_ids.add(sample_id)
        if candidate_universe(row) != universe:
            raise CatalogCeilingError(
                "final labels do not share one candidate universe"
            )
        resolution = row["resolution"]
        contracts.add(
            (
                str(resolution["catalog_version"]),
                str(resolution["catalog_sha256"]),
                str(resolution["renderer_hash"]),
            )
        )
    if len(contracts) != 1:
        raise CatalogCeilingError(
            "final labels do not share one catalog and renderer contract"
        )
    version, catalog_sha, renderer_hash = next(iter(contracts))
    return universe, {
        "catalog_version": version,
        "catalog_sha256": catalog_sha,
        "renderer_hash": renderer_hash,
    }


def wilson_interval(successes: int, total: int) -> tuple[float, float]:
    if total == 0:
        return 0.0, 1.0
    z = 1.959963984540054
    rate = successes / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    spread = (
        z
        * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))
        / denominator
    )
    return max(0.0, center - spread), min(1.0, center + spread)


def rounded(value: float) -> float:
    return round(value, 6)


def summarize(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    none_count = sum(bool(row["font_judgment"]["none_acceptable"]) for row in rows)
    catalog_gap_count = sum(
        "catalog_gap_confirmed" in row["resolution"]["flags"] for row in rows
    )
    work_values: defaultdict[str, list[bool]] = defaultdict(list)
    for row in rows:
        work_values[str(row["work_id"])].append(
            bool(row["font_judgment"]["none_acceptable"])
        )
    work_rates = [sum(values) / len(values) for values in work_values.values()]
    lower, upper = wilson_interval(none_count, len(rows))
    return {
        "sample_count": len(rows),
        "work_count": len(work_values),
        "none_acceptable_count": none_count,
        "none_acceptable_rate": rounded(none_count / len(rows)) if rows else None,
        "none_acceptable_wilson_95": {
            "lower": rounded(lower),
            "upper": rounded(upper),
        },
        "catalog_gap_confirmed_count": catalog_gap_count,
        "catalog_gap_confirmed_rate": (
            rounded(catalog_gap_count / len(rows)) if rows else None
        ),
        "work_macro_none_acceptable_rate": (
            rounded(sum(work_rates) / len(work_rates)) if work_rates else None
        ),
    }


def cohort_predicates() -> dict[str, Callable[[Mapping[str, Any]], bool]]:
    predicates: dict[str, Callable[[Mapping[str, Any]], bool]] = {
        "all": lambda row: True,
        "ordinary_dialogue": lambda row: (
            row["role"]["primary"] == "dialogue"
            and row["consistency"]["policy"] == "inherit_work_anchor"
            and row["consistency"]["reason_code"] == "ordinary_dialogue"
        ),
        "hard_sfx": lambda row: row["role"]["primary"] in SFX_ROLES,
        "aside_or_handwritten": lambda row: (
            row["role"]["primary"] in {"aside_balloon_edge", "whisper"}
            or float(row["source_style"]["handwritten"] or 0) >= 0.5
        ),
        "emphasis_or_shout": lambda row: (
            row["role"]["primary"] in {"emphasis_dialogue", "shout"}
        ),
        "treatment_heavy": lambda row: (
            row["treatment"]["outline"] not in {"none", "unknown"}
            or row["treatment"]["shadow"] not in {"none", "unknown"}
            or row["treatment"]["fill"] not in {"solid", "unknown"}
            or row["treatment"]["distortion"] not in {"none", "unknown"}
        ),
        "horizontal": lambda row: row["treatment"]["orientation"] == "horizontal",
        "vertical": lambda row: row["treatment"]["orientation"] == "vertical",
    }
    predicates.update(
        {
            f"role:{role}": lambda row, expected=role: (
                row["role"]["primary"] == expected
            )
            for role in ROLE_VALUES
            if role != "unknown_needs_review"
        }
    )
    return predicates


def analyze(
    *,
    final_labels: Path,
    output: Path,
    expected_finals: int | None = None,
    ordinary_dialogue_ceiling: float = 0.1,
    hard_sfx_ceiling: float = 0.25,
) -> dict[str, Any]:
    ordinary_dialogue_ceiling = require_probability(
        ordinary_dialogue_ceiling, location="ordinary_dialogue_ceiling"
    )
    hard_sfx_ceiling = require_probability(
        hard_sfx_ceiling, location="hard_sfx_ceiling"
    )
    try:
        rows = labels.read_jsonl(final_labels)
    except (OSError, labels.LabelValidationError) as error:
        raise CatalogCeilingError(f"could not read final labels: {error}") from error
    universe, contract = validate_finals(rows, expected_finals=expected_finals)
    cohorts = {
        name: summarize([row for row in rows if predicate(row)])
        for name, predicate in cohort_predicates().items()
    }
    gate_specs = {
        "ordinary_dialogue": ordinary_dialogue_ceiling,
        "hard_sfx": hard_sfx_ceiling,
    }
    gates: dict[str, Any] = {}
    for name, threshold in gate_specs.items():
        cohort = cohorts[name]
        rate = cohort["none_acceptable_rate"]
        gates[name] = {
            "sample_count": cohort["sample_count"],
            "threshold": threshold,
            "observed_rate": rate,
            "pass": rate is not None and rate <= threshold,
        }
    all_gates_pass = all(gate["pass"] for gate in gates.values())
    report = seal(
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": RECORD_TYPE,
            "source": {
                "final_labels_sha256": sha256_file(final_labels),
                "final_count": len(rows),
                **contract,
            },
            "candidate_ids": list(universe),
            "cohorts": cohorts,
            "gates": {**gates, "all_pass": all_gates_pass},
            "decision": (
                "proceed_to_v2_calibration"
                if all_gates_pass
                else "expand_catalog_before_training"
            ),
            "safety": {
                "sealed_finals_only": True,
                "work_titles_used": False,
                "model_predictions_used": False,
                "unreviewed_candidates": 0,
            },
        }
    )
    atomic_write_json(output, report)
    return report


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-labels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-finals", type=int)
    parser.add_argument("--ordinary-dialogue-ceiling", type=float, default=0.1)
    parser.add_argument("--hard-sfx-ceiling", type=float, default=0.25)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = analyze(
            final_labels=args.final_labels.resolve(),
            output=args.output.resolve(),
            expected_finals=args.expected_finals,
            ordinary_dialogue_ceiling=args.ordinary_dialogue_ceiling,
            hard_sfx_ceiling=args.hard_sfx_ceiling,
        )
    except CatalogCeilingError as error:
        print(f"error: {error}")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["gates"]["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
