#!/usr/bin/env python3
"""Build and validate the fail-closed Font Matching v2 runtime policy."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "font-matching-runtime-policy-v1"
RECORD_TYPE = "font_matching_runtime_policy"


class RuntimePolicyError(ValueError):
    """Raised when a policy cannot be proven to match the runtime contract."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_bytes(value: Any, *, pretty: bool = True) -> bytes:
    if pretty:
        rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        rendered = canonical_json(value)
    return (rendered + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def seal_record(core: Mapping[str, Any]) -> dict[str, Any]:
    output = copy.deepcopy(dict(core))
    output.pop("record_sha256", None)
    output["record_sha256"] = sha256_bytes(canonical_json(output).encode("utf-8"))
    return output


def require_mapping(value: Any, *, location: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RuntimePolicyError(f"{location}: expected an object")
    return value


def require_probability(value: Any, *, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimePolicyError(f"{location}: expected a probability")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise RuntimePolicyError(f"{location}: probability must be in [0, 1]")
    return result


def validate_record_seal(record: Mapping[str, Any], *, location: str) -> str:
    value = record.get("record_sha256")
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise RuntimePolicyError(f"{location}.record_sha256: invalid SHA-256")
    core = {key: item for key, item in record.items() if key != "record_sha256"}
    actual = sha256_bytes(canonical_json(core).encode("utf-8"))
    if actual != value:
        raise RuntimePolicyError(f"{location}: record seal mismatch")
    return actual


def build_policy(
    *,
    minimum_calibrated_confidence: float,
    minimum_role_confidence: float,
    minimum_intentional_override_confidence: float,
    intentional_override_minimum_score_margin: float,
    chapter_prior_maximum_score_contribution: float,
    chapter_prior_minimum_anchor_evidence_count: int,
    chapter_prior_local_override_minimum_score_margin: float,
) -> dict[str, Any]:
    automatic_values = {
        "intentional_override_minimum_score_margin": require_probability(
            intentional_override_minimum_score_margin,
            location="intentional_override_minimum_score_margin",
        ),
        "minimum_calibrated_confidence": require_probability(
            minimum_calibrated_confidence,
            location="minimum_calibrated_confidence",
        ),
        "minimum_intentional_override_confidence": require_probability(
            minimum_intentional_override_confidence,
            location="minimum_intentional_override_confidence",
        ),
        "minimum_role_confidence": require_probability(
            minimum_role_confidence,
            location="minimum_role_confidence",
        ),
        "require_none_acceptable_false": True,
        "require_runtime_artifact_ready": True,
        "require_translation_glyph_coverage": True,
    }
    maximum_contribution = require_probability(
        chapter_prior_maximum_score_contribution,
        location="chapter_prior_maximum_score_contribution",
    )
    if maximum_contribution > 0.1:
        raise RuntimePolicyError(
            "chapter prior maximum score contribution must not exceed 0.1"
        )
    anchor_count = chapter_prior_minimum_anchor_evidence_count
    if isinstance(anchor_count, bool) or not isinstance(anchor_count, int) or anchor_count < 2:
        raise RuntimePolicyError(
            "chapter prior minimum anchor evidence count must be an integer >= 2"
        )
    return seal_record(
        {
            "automatic_mutation": automatic_values,
            "chapter_prior": {
                "local_override_minimum_score_margin": require_probability(
                    chapter_prior_local_override_minimum_score_margin,
                    location="chapter_prior_local_override_minimum_score_margin",
                ),
                "maximum_score_contribution": maximum_contribution,
                "minimum_anchor_evidence_count": anchor_count,
                "mode": "weak_prior_never_hard_constraint",
                "real_local_change_overrides_prior": True,
                "scope": "chapter",
            },
            "fallback": {
                "automatic_profile_without_pixel_model": "forbidden",
                "invalid_artifact": "explicit_disabled",
                "manual_user_lock": "allowed",
                "missing_artifact": "explicit_disabled",
                "semantic_bootstrap": "forbidden",
            },
            "record_type": RECORD_TYPE,
            "schema_version": SCHEMA_VERSION,
        }
    )


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], *, location: str
) -> None:
    if set(value) != expected:
        raise RuntimePolicyError(
            f"{location}: invalid keys; missing={sorted(expected - set(value))}, "
            f"unexpected={sorted(set(value) - expected)}"
        )


def validate_policy_record(
    record: Mapping[str, Any], *, expected: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    validate_record_seal(record, location="runtime policy")
    _require_exact_keys(
        record,
        {
            "automatic_mutation",
            "chapter_prior",
            "fallback",
            "record_sha256",
            "record_type",
            "schema_version",
        },
        location="runtime policy",
    )
    if (
        record.get("schema_version") != SCHEMA_VERSION
        or record.get("record_type") != RECORD_TYPE
    ):
        raise RuntimePolicyError("runtime policy schema/type is unsupported")
    automatic = require_mapping(
        record.get("automatic_mutation"), location="runtime policy.automatic_mutation"
    )
    _require_exact_keys(
        automatic,
        {
            "intentional_override_minimum_score_margin",
            "minimum_calibrated_confidence",
            "minimum_intentional_override_confidence",
            "minimum_role_confidence",
            "require_none_acceptable_false",
            "require_runtime_artifact_ready",
            "require_translation_glyph_coverage",
        },
        location="runtime policy.automatic_mutation",
    )
    chapter = require_mapping(
        record.get("chapter_prior"), location="runtime policy.chapter_prior"
    )
    _require_exact_keys(
        chapter,
        {
            "local_override_minimum_score_margin",
            "maximum_score_contribution",
            "minimum_anchor_evidence_count",
            "mode",
            "real_local_change_overrides_prior",
            "scope",
        },
        location="runtime policy.chapter_prior",
    )
    fallback = require_mapping(record.get("fallback"), location="runtime policy.fallback")
    _require_exact_keys(
        fallback,
        {
            "automatic_profile_without_pixel_model",
            "invalid_artifact",
            "manual_user_lock",
            "missing_artifact",
            "semantic_bootstrap",
        },
        location="runtime policy.fallback",
    )
    rebuilt = build_policy(
        minimum_calibrated_confidence=automatic.get("minimum_calibrated_confidence"),
        minimum_role_confidence=automatic.get("minimum_role_confidence"),
        minimum_intentional_override_confidence=automatic.get(
            "minimum_intentional_override_confidence"
        ),
        intentional_override_minimum_score_margin=automatic.get(
            "intentional_override_minimum_score_margin"
        ),
        chapter_prior_maximum_score_contribution=chapter.get(
            "maximum_score_contribution"
        ),
        chapter_prior_minimum_anchor_evidence_count=chapter.get(
            "minimum_anchor_evidence_count"
        ),
        chapter_prior_local_override_minimum_score_margin=chapter.get(
            "local_override_minimum_score_margin"
        ),
    )
    if dict(record) != rebuilt:
        raise RuntimePolicyError("runtime policy fixed safety behavior drifted")
    if expected is not None and dict(record) != dict(expected):
        raise RuntimePolicyError("runtime policy does not match requested thresholds")
    return rebuilt


def read_policy(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise RuntimePolicyError("runtime policy file is missing or linked")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimePolicyError(f"runtime policy is invalid JSON: {error}") from error
    return dict(require_mapping(value, location="runtime policy"))


def write_policy(path: Path, record: Mapping[str, Any], *, replace_existing: bool) -> None:
    target = path.expanduser().resolve()
    if target == Path(target.anchor) or target.name in {"", ".", ".."}:
        raise RuntimePolicyError(f"unsafe runtime policy path: {target}")
    if path.exists() and path.is_symlink():
        raise RuntimePolicyError("refusing a symlink runtime policy target")
    if target.exists():
        if not replace_existing:
            raise RuntimePolicyError("runtime policy exists; pass --replace-existing")
        validate_policy_record(read_policy(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(json_bytes(record))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _add_threshold_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--minimum-calibrated-confidence", type=float, required=True)
    parser.add_argument("--minimum-role-confidence", type=float, required=True)
    parser.add_argument(
        "--minimum-intentional-override-confidence", type=float, required=True
    )
    parser.add_argument(
        "--intentional-override-minimum-score-margin", type=float, required=True
    )
    parser.add_argument(
        "--chapter-prior-maximum-score-contribution", type=float, required=True
    )
    parser.add_argument(
        "--chapter-prior-minimum-anchor-evidence-count", type=int, required=True
    )
    parser.add_argument(
        "--chapter-prior-local-override-minimum-score-margin",
        type=float,
        required=True,
    )


def _from_args(args: argparse.Namespace) -> dict[str, Any]:
    return build_policy(
        minimum_calibrated_confidence=args.minimum_calibrated_confidence,
        minimum_role_confidence=args.minimum_role_confidence,
        minimum_intentional_override_confidence=(
            args.minimum_intentional_override_confidence
        ),
        intentional_override_minimum_score_margin=(
            args.intentional_override_minimum_score_margin
        ),
        chapter_prior_maximum_score_contribution=(
            args.chapter_prior_maximum_score_contribution
        ),
        chapter_prior_minimum_anchor_evidence_count=(
            args.chapter_prior_minimum_anchor_evidence_count
        ),
        chapter_prior_local_override_minimum_score_margin=(
            args.chapter_prior_local_override_minimum_score_margin
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build = subparsers.add_parser("build", help="write a sealed runtime policy")
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--replace-existing", action="store_true")
    _add_threshold_arguments(build)
    validate = subparsers.add_parser("validate", help="validate exact policy values")
    validate.add_argument("--policy", type=Path, required=True)
    _add_threshold_arguments(validate)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    expected = _from_args(args)
    if args.command == "build":
        write_policy(args.output, expected, replace_existing=args.replace_existing)
        record = validate_policy_record(read_policy(args.output), expected=expected)
    else:
        record = validate_policy_record(read_policy(args.policy), expected=expected)
    print(json.dumps({"record_sha256": record["record_sha256"], "status": "valid"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimePolicyError as error:
        raise SystemExit(f"runtime-policy error: {error}") from error
