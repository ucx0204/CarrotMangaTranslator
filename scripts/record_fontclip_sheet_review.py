#!/usr/bin/env python3
"""Record and finalize exhaustive FontCLIP contact-sheet reviews.

The exhaustive QA command emits one PNG plus one JSON inventory per sheet.
This helper turns a deliberate invocation into an auditable assertion that
every cell on that sheet was inspected:

* cells named by ``--reject`` or ``--recrop`` receive that decision;
* every other inventory cell is recorded as ``pass``;
* the record is bound to the exact PNG bytes, JSON bytes, and ordered ID list.

Records are kept one-per-sheet in an atomically rewritten JSONL shard journal.
Finalization verifies the current QA audit state and every expected sheet,
then emits a complete CSV accepted by ``adjudicate_fontclip_audit.py``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
RECORD_TYPE = "fontclip_sheet_review"
LEDGER_MARKER_TYPE = "fontclip_completed_review_ledger"
AUDIT_SHEET_RE = re.compile(
    r"^fontclip_audit_(?P<shard>.+)_audit_(?P<index>\d{5})\.json$"
)
SHARD_TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
NUMBERED_SHARD_RE = re.compile(r"^shard-(?P<index>\d+)-of-(?P<count>\d+)$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
LEDGER_FIELDS = (
    "id",
    "decision",
    "reject_reason",
    "recrop_bbox_px",
    "padding_px",
    "reviewer",
    "reviewed_at",
    "notes",
    "sheet",
    "cell_index",
)


@dataclass(frozen=True)
class InventoryItem:
    cell_index: int
    item_id: str


@dataclass(frozen=True)
class SheetInventory:
    json_path: Path
    png_path: Path
    json_sha256: str
    png_sha256: str
    shard_tag: str
    sheet_index: int
    items: tuple[InventoryItem, ...]

    @property
    def ordered_ids(self) -> tuple[str, ...]:
        return tuple(item.item_id for item in self.items)

    @property
    def ordered_ids_sha256(self) -> str:
        return hash_id_list(self.ordered_ids, sort_items=False)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Record one exhaustive FontCLIP audit sheet, or finalize a "
            "complete shard journal into an adjudicator-compatible CSV."
        )
    )
    parser.add_argument(
        "--journal",
        type=Path,
        required=True,
        help="Shard review journal JSONL (must be under the dataset qa directory).",
    )
    parser.add_argument(
        "--finalize",
        action="store_true",
        help="Validate complete shard coverage and write the final decision CSV.",
    )

    record = parser.add_argument_group("record one sheet")
    record.add_argument("--sheet-json", type=Path)
    record.add_argument("--reviewer")
    record.add_argument(
        "--reject",
        action="append",
        default=[],
        metavar="CELL:REASON",
        help="Reject a 1-based sheet cell. May be repeated.",
    )
    record.add_argument(
        "--recrop",
        action="append",
        default=[],
        metavar="CELL:NOTE",
        help=(
            "Mark a 1-based cell for recropping. May be repeated; a bbox may "
            "be supplied now or added by replacing the sheet record later."
        ),
    )
    record.add_argument(
        "--recrop-bbox",
        "--bbox",
        dest="recrop_bbox",
        action="append",
        default=[],
        metavar="CELL:X1,Y1,X2,Y2",
        help="Source-page bbox for a declared recrop cell. May be repeated.",
    )
    record.add_argument(
        "--recrop-padding",
        "--padding",
        dest="recrop_padding",
        action="append",
        default=[],
        metavar="CELL:PX",
        help="Non-negative padding for a declared recrop cell. May be repeated.",
    )
    record.add_argument(
        "--replace-sheet",
        action="store_true",
        help="Explicitly replace a prior non-idempotent record for this sheet.",
    )

    finalize = parser.add_argument_group("finalize a shard")
    finalize.add_argument("--qa-dir", type=Path)
    finalize.add_argument("--shard-tag")
    finalize.add_argument("--output-ledger", type=Path)
    finalize.add_argument(
        "--replace-ledger",
        action="store_true",
        help=(
            "Replace a nonidentical completed ledger only when its valid "
            "completion marker proves this tool created the existing file."
        ),
    )
    return parser.parse_args(argv)


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def utc_now() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def hash_id_list(ids: Iterable[str], *, sort_items: bool) -> str:
    values = list(ids)
    if sort_items:
        values.sort()
    return sha256_bytes("\n".join(values).encode("utf-8"))


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def require_under(root: Path, candidate: Path, label: str) -> None:
    if not is_within(root, candidate):
        raise ValueError(f"{label} must resolve under {root}: {candidate}")


def read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def parse_sheet_inventory(path_value: Path) -> SheetInventory:
    path = path_value.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    match = AUDIT_SHEET_RE.fullmatch(path.name)
    if match is None:
        raise ValueError(
            f"{path}: expected an exhaustive audit inventory named "
            "fontclip_audit_<shard>_audit_<NNNNN>.json"
        )
    payload = read_json_object(path)
    if payload.get("schema_version") != 1:
        raise ValueError(f"{path}: unsupported inventory schema_version")
    if string_value(payload.get("stratified_by")) != "audit":
        raise ValueError(f"{path}: only exhaustive 'audit' sheets may be recorded")
    if string_value(payload.get("merge_key")) != "id":
        raise ValueError(f"{path}: inventory merge_key must be 'id'")

    png_path = path.with_suffix(".png")
    declared_sheet = string_value(payload.get("sheet"))
    if declared_sheet != png_path.name:
        raise ValueError(
            f"{path}: inventory sheet {declared_sheet!r} does not match "
            f"{png_path.name!r}"
        )
    if not png_path.is_file():
        raise FileNotFoundError(png_path)

    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ValueError(f"{path}: inventory items must be a non-empty array")
    items: list[InventoryItem] = []
    seen_ids: set[str] = set()
    for position, raw in enumerate(raw_items, 1):
        if not isinstance(raw, Mapping):
            raise ValueError(f"{path}: item {position} must be an object")
        cell_value = raw.get("cell_index")
        if isinstance(cell_value, bool):
            raise ValueError(f"{path}: item {position} has invalid cell_index")
        try:
            cell_index = int(cell_value)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"{path}: item {position} has invalid cell_index"
            ) from error
        if cell_index != position:
            raise ValueError(
                f"{path}: cell_index must be contiguous and 1-based; "
                f"item {position} declares {cell_index}"
            )
        item_id = string_value(raw.get("id"))
        if not item_id:
            raise ValueError(f"{path}: cell {cell_index} has no id")
        if item_id in seen_ids:
            raise ValueError(f"{path}: duplicate item id {item_id!r}")
        seen_ids.add(item_id)
        items.append(InventoryItem(cell_index, item_id))

    return SheetInventory(
        json_path=path,
        png_path=png_path,
        json_sha256=sha256_file(path),
        png_sha256=sha256_file(png_path),
        shard_tag=match.group("shard"),
        sheet_index=int(match.group("index")),
        items=tuple(items),
    )


def split_cell_spec(value: str, *, option: str) -> tuple[int, str]:
    cell_text, separator, detail = value.partition(":")
    if not separator:
        raise ValueError(f"{option} expects CELL:VALUE, got {value!r}")
    try:
        cell = int(cell_text.strip())
    except ValueError as error:
        raise ValueError(f"{option} cell must be an integer: {value!r}") from error
    if cell < 1:
        raise ValueError(f"{option} cell must be at least 1: {value!r}")
    return cell, detail.strip()


def parse_text_overrides(values: Sequence[str], *, option: str) -> dict[int, str]:
    result: dict[int, str] = {}
    for value in values:
        cell, detail = split_cell_spec(value, option=option)
        if not detail:
            raise ValueError(
                f"{option} requires a non-empty reason/note for cell {cell}"
            )
        if cell in result:
            raise ValueError(f"{option} repeats cell {cell}")
        result[cell] = detail
    return result


def parse_bbox_overrides(values: Sequence[str]) -> dict[int, list[int]]:
    result: dict[int, list[int]] = {}
    for value in values:
        cell, detail = split_cell_spec(value, option="--recrop-bbox")
        pieces = [piece.strip() for piece in detail.split(",")]
        if len(pieces) != 4:
            raise ValueError(f"--recrop-bbox cell {cell} requires X1,Y1,X2,Y2")
        try:
            bbox = [int(piece) for piece in pieces]
        except ValueError as error:
            raise ValueError(
                f"--recrop-bbox cell {cell} coordinates must be integers"
            ) from error
        x1, y1, x2, y2 = bbox
        if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
            raise ValueError(f"--recrop-bbox cell {cell} is invalid: {bbox}")
        if cell in result:
            raise ValueError(f"--recrop-bbox repeats cell {cell}")
        result[cell] = bbox
    return result


def parse_padding_overrides(values: Sequence[str]) -> dict[int, int]:
    result: dict[int, int] = {}
    for value in values:
        cell, detail = split_cell_spec(value, option="--recrop-padding")
        try:
            padding = int(detail)
        except ValueError as error:
            raise ValueError(
                f"--recrop-padding cell {cell} must be an integer"
            ) from error
        if padding < 0:
            raise ValueError(f"--recrop-padding cell {cell} cannot be negative")
        if cell in result:
            raise ValueError(f"--recrop-padding repeats cell {cell}")
        result[cell] = padding
    return result


def record_without_hash(record: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "record_sha256"}


def calculate_record_hash(record: Mapping[str, Any]) -> str:
    return sha256_bytes(canonical_json_bytes(record_without_hash(record)))


def validate_journal_record(
    record: Mapping[str, Any], *, path: Path, line_number: int
) -> dict[str, Any]:
    location = f"{path}:{line_number}"
    if record.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"{location}: unsupported schema_version")
    if record.get("record_type") != RECORD_TYPE:
        raise ValueError(f"{location}: unexpected record_type")
    recorded_hash = string_value(record.get("record_sha256"))
    if not SHA256_RE.fullmatch(recorded_hash):
        raise ValueError(f"{location}: missing or invalid record_sha256")
    expected_hash = calculate_record_hash(record)
    if recorded_hash != expected_hash:
        raise ValueError(f"{location}: record_sha256 does not match record contents")
    sheet_json = string_value(record.get("sheet_json"))
    if not sheet_json or Path(sheet_json).name != sheet_json:
        raise ValueError(f"{location}: sheet_json must be a basename")
    if not SHARD_TAG_RE.fullmatch(string_value(record.get("shard_tag"))):
        raise ValueError(f"{location}: invalid shard_tag")
    decisions = record.get("decisions")
    item_ids = record.get("item_ids")
    if not isinstance(decisions, list) or not isinstance(item_ids, list):
        raise ValueError(f"{location}: decisions and item_ids must be arrays")
    if len(decisions) != len(item_ids) or len(item_ids) != record.get("item_count"):
        raise ValueError(f"{location}: decision/item counts disagree")
    return dict(record)


def load_journal(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    if not path.is_file():
        raise ValueError(f"journal is not a file: {path}")
    records: list[dict[str, Any]] = []
    names: set[str] = set()
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(raw, Mapping):
                raise ValueError(f"{path}:{line_number}: expected an object")
            record = validate_journal_record(raw, path=path, line_number=line_number)
            name = string_value(record.get("sheet_json"))
            if name in names:
                raise ValueError(f"{path}: sheet {name!r} appears more than once")
            names.add(name)
            records.append(record)
    return records


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def serialize_journal(records: Sequence[Mapping[str, Any]]) -> bytes:
    lines = [
        canonical_json_bytes(record).decode("utf-8")
        for record in sorted(
            records,
            key=lambda value: (
                int(value.get("sheet_index", 0)),
                string_value(value.get("sheet_json")),
            ),
        )
    ]
    return (("\n".join(lines) + "\n") if lines else "").encode("utf-8")


def stable_review_fingerprint(
    inventory: SheetInventory,
    reviewer: str,
    decisions: Sequence[Mapping[str, Any]],
) -> str:
    stable_decisions = []
    for decision in decisions:
        stable_decisions.append(
            {
                key: value
                for key, value in decision.items()
                if key not in {"reviewed_at"}
            }
        )
    payload = {
        "sheet_json": inventory.json_path.name,
        "sheet_json_sha256": inventory.json_sha256,
        "sheet_png_sha256": inventory.png_sha256,
        "ordered_ids_sha256": inventory.ordered_ids_sha256,
        "item_ids": list(inventory.ordered_ids),
        "reviewer": reviewer,
        "decisions": stable_decisions,
    }
    return sha256_bytes(canonical_json_bytes(payload))


def build_sheet_record(
    inventory: SheetInventory,
    *,
    reviewer: str,
    rejects: Mapping[int, str],
    recrops: Mapping[int, str],
    bboxes: Mapping[int, list[int]],
    paddings: Mapping[int, int],
    previous: Mapping[str, Any] | None,
) -> dict[str, Any]:
    maximum_cell = len(inventory.items)
    specified = set(rejects) | set(recrops) | set(bboxes) | set(paddings)
    outside = sorted(cell for cell in specified if cell > maximum_cell)
    if outside:
        raise ValueError(f"cell indices exceed sheet size {maximum_cell}: {outside}")
    overlap = sorted(set(rejects) & set(recrops))
    if overlap:
        raise ValueError(f"cells cannot be both reject and recrop: {overlap}")
    undeclared_bbox = sorted(set(bboxes) - set(recrops))
    if undeclared_bbox:
        raise ValueError(
            "--recrop-bbox refers to cells not declared with --recrop: "
            f"{undeclared_bbox}"
        )
    undeclared_padding = sorted(set(paddings) - set(recrops))
    if undeclared_padding:
        raise ValueError(
            "--recrop-padding refers to cells not declared with --recrop: "
            f"{undeclared_padding}"
        )

    reviewed_at = utc_now()
    decisions: list[dict[str, Any]] = []
    for item in inventory.items:
        decision = "pass"
        reject_reason = ""
        notes = ""
        bbox: list[int] | None = None
        padding = 0
        if item.cell_index in rejects:
            decision = "reject"
            reject_reason = rejects[item.cell_index]
        elif item.cell_index in recrops:
            decision = "recrop"
            notes = recrops[item.cell_index]
            bbox = bboxes.get(item.cell_index)
            padding = paddings.get(item.cell_index, 0)
        decisions.append(
            {
                "cell_index": item.cell_index,
                "id": item.item_id,
                "decision": decision,
                "reject_reason": reject_reason,
                "recrop_bbox_px": bbox,
                "padding_px": padding,
                "reviewer": reviewer,
                "reviewed_at": reviewed_at,
                "notes": notes,
            }
        )

    fingerprint = stable_review_fingerprint(inventory, reviewer, decisions)
    replacement_count = (
        int(previous.get("replacement_count", 0)) + 1 if previous is not None else 0
    )
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "record_type": RECORD_TYPE,
        "sheet_json": inventory.json_path.name,
        "sheet_png": inventory.png_path.name,
        "shard_tag": inventory.shard_tag,
        "sheet_index": inventory.sheet_index,
        "sheet_json_sha256": inventory.json_sha256,
        "sheet_png_sha256": inventory.png_sha256,
        "ordered_ids_sha256": inventory.ordered_ids_sha256,
        "item_count": len(inventory.items),
        "item_ids": list(inventory.ordered_ids),
        "reviewer": reviewer,
        "reviewed_at": reviewed_at,
        "decisions": decisions,
        "review_fingerprint_sha256": fingerprint,
        "replacement_count": replacement_count,
    }
    if previous is not None:
        record["replaces_record_sha256"] = previous["record_sha256"]
    record["record_sha256"] = calculate_record_hash(record)
    return record


def record_sheet(args: argparse.Namespace) -> int:
    if args.sheet_json is None:
        raise ValueError("--sheet-json is required unless --finalize is used")
    reviewer = string_value(args.reviewer)
    if not reviewer:
        raise ValueError("--reviewer is required when recording a sheet")
    if any((args.qa_dir, args.shard_tag, args.output_ledger, args.replace_ledger)):
        raise ValueError("finalize-only options cannot be used while recording a sheet")

    inventory = parse_sheet_inventory(args.sheet_json)
    qa_dir = inventory.json_path.parent
    journal = args.journal.expanduser().resolve()
    if journal.suffix.lower() not in {".jsonl", ".ndjson"}:
        raise ValueError("--journal must use a .jsonl or .ndjson extension")
    require_under(qa_dir, journal, "--journal")

    rejects = parse_text_overrides(args.reject, option="--reject")
    recrops = parse_text_overrides(args.recrop, option="--recrop")
    bboxes = parse_bbox_overrides(args.recrop_bbox)
    paddings = parse_padding_overrides(args.recrop_padding)

    records = load_journal(journal)
    foreign_tags = sorted(
        {
            string_value(record.get("shard_tag"))
            for record in records
            if string_value(record.get("shard_tag")) != inventory.shard_tag
        }
    )
    if foreign_tags:
        raise ValueError(
            f"{journal}: shard journal contains other shard tags: {foreign_tags}"
        )
    prior = next(
        (
            record
            for record in records
            if record.get("sheet_json") == inventory.json_path.name
        ),
        None,
    )
    candidate = build_sheet_record(
        inventory,
        reviewer=reviewer,
        rejects=rejects,
        recrops=recrops,
        bboxes=bboxes,
        paddings=paddings,
        previous=prior,
    )
    if prior is not None:
        same_review = (
            prior.get("review_fingerprint_sha256")
            == candidate.get("review_fingerprint_sha256")
            and prior.get("sheet_json_sha256") == inventory.json_sha256
            and prior.get("sheet_png_sha256") == inventory.png_sha256
            and prior.get("item_ids") == list(inventory.ordered_ids)
        )
        if same_review:
            print(f"Sheet already recorded (idempotent): {inventory.json_path.name}")
            return 0
        if not args.replace_sheet:
            raise ValueError(
                f"{inventory.json_path.name} already has a different review "
                "or its bound artifacts changed; use --replace-sheet after "
                "re-reviewing the whole sheet"
            )
        records = [
            candidate
            if record.get("sheet_json") == inventory.json_path.name
            else record
            for record in records
        ]
    else:
        if args.replace_sheet:
            raise ValueError(
                "--replace-sheet was supplied, but this sheet has no prior record"
            )
        records.append(candidate)

    atomic_write_bytes(journal, serialize_journal(records))
    counts: dict[str, int] = {"pass": 0, "reject": 0, "recrop": 0}
    for decision in candidate["decisions"]:
        counts[decision["decision"]] += 1
    print(
        f"Recorded {inventory.json_path.name}: "
        f"{counts['pass']} pass, {counts['reject']} reject, "
        f"{counts['recrop']} recrop -> {journal}"
    )
    return 0


def expected_state_path(qa_dir: Path, shard_tag: str) -> Path:
    return (
        qa_dir / "audit_state.json"
        if shard_tag == "all"
        else qa_dir / f"audit_state_{shard_tag}.json"
    )


def validate_shard_state(
    qa_dir: Path, shard_tag: str
) -> tuple[dict[str, Any], list[Path]]:
    if not SHARD_TAG_RE.fullmatch(shard_tag):
        raise ValueError(f"invalid --shard-tag: {shard_tag!r}")
    state_path = expected_state_path(qa_dir, shard_tag)
    if not state_path.is_file():
        raise FileNotFoundError(state_path)
    state = read_json_object(state_path)
    if state.get("schema_version") != 1 or not state.get("audit_all"):
        raise ValueError(
            f"{state_path}: finalization requires an exhaustive audit state"
        )

    try:
        shard_index = int(state.get("shard_index"))
        shard_count = int(state.get("shard_count"))
        item_count = int(state.get("item_count"))
        maximum_items = int(state["contact_sheet"]["max_items"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            f"{state_path}: malformed shard/contact-sheet state"
        ) from error
    if shard_count < 1 or shard_index < 0 or shard_index >= shard_count:
        raise ValueError(f"{state_path}: invalid shard coordinates")
    if item_count < 0 or maximum_items < 1:
        raise ValueError(f"{state_path}: invalid item_count/contact-sheet size")

    if shard_tag == "all":
        if shard_index != 0 or shard_count != 1:
            raise ValueError(
                f"{state_path}: shard tag 'all' requires shard_index=0, shard_count=1"
            )
    else:
        match = NUMBERED_SHARD_RE.fullmatch(shard_tag)
        if match is None:
            raise ValueError("--shard-tag must be 'all' or shard-<index>-of-<count>")
        if (
            int(match.group("index")) != shard_index
            or int(match.group("count")) != shard_count
        ):
            raise ValueError(
                f"{state_path}: shard tag does not match audit state coordinates"
            )

    prefix = f"fontclip_audit_{shard_tag}_audit_"
    inventories = sorted(qa_dir.glob(f"{prefix}[0-9][0-9][0-9][0-9][0-9].json"))
    expected_count = math.ceil(item_count / maximum_items) if item_count else 0
    if len(inventories) != expected_count:
        raise ValueError(
            f"{qa_dir}: expected {expected_count} audit sheet inventories "
            f"from audit state, found {len(inventories)}"
        )
    expected_names = [
        f"{prefix}{index:05d}.json" for index in range(1, expected_count + 1)
    ]
    if [path.name for path in inventories] != expected_names:
        raise ValueError(f"{qa_dir}: audit sheet inventory sequence is not contiguous")
    return state, inventories


def verify_record_against_inventory(
    record: Mapping[str, Any], inventory: SheetInventory
) -> None:
    checks = {
        "sheet_png": inventory.png_path.name,
        "shard_tag": inventory.shard_tag,
        "sheet_index": inventory.sheet_index,
        "sheet_json_sha256": inventory.json_sha256,
        "sheet_png_sha256": inventory.png_sha256,
        "ordered_ids_sha256": inventory.ordered_ids_sha256,
        "item_count": len(inventory.items),
        "item_ids": list(inventory.ordered_ids),
    }
    mismatches = [
        key for key, expected in checks.items() if record.get(key) != expected
    ]
    if mismatches:
        raise ValueError(
            f"{inventory.json_path.name}: recorded review no longer matches "
            f"current sheet artifacts ({', '.join(mismatches)}); re-review "
            "and record with --replace-sheet"
        )
    decisions = record.get("decisions")
    if not isinstance(decisions, list) or len(decisions) != len(inventory.items):
        raise ValueError(
            f"{inventory.json_path.name}: recorded decisions are incomplete"
        )
    for item, decision in zip(inventory.items, decisions):
        if not isinstance(decision, Mapping):
            raise ValueError(
                f"{inventory.json_path.name}: invalid decision for cell "
                f"{item.cell_index}"
            )
        if (
            decision.get("cell_index") != item.cell_index
            or decision.get("id") != item.item_id
        ):
            raise ValueError(
                f"{inventory.json_path.name}: decision does not match cell "
                f"{item.cell_index}"
            )
        if decision.get("decision") not in {"pass", "reject", "recrop"}:
            raise ValueError(
                f"{inventory.json_path.name}: invalid decision for cell "
                f"{item.cell_index}"
            )


def ledger_csv_bytes(rows: Sequence[Mapping[str, Any]]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=list(LEDGER_FIELDS),
        lineterminator="\n",
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in rows:
        output = dict(row)
        bbox = output.get("recrop_bbox_px")
        output["recrop_bbox_px"] = (
            json.dumps(bbox, separators=(",", ":")) if bbox is not None else ""
        )
        if output.get("decision") != "recrop":
            output["padding_px"] = ""
        writer.writerow(output)
    return stream.getvalue().encode("utf-8")


def completion_marker_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".complete.json")


def validate_existing_completion_marker(
    marker_path: Path, output: Path, current_sha256: str
) -> dict[str, Any]:
    if not marker_path.is_file():
        raise ValueError(
            f"refusing to replace unmarked ledger {output}; expected "
            f"completion marker {marker_path}"
        )
    marker = read_json_object(marker_path)
    if (
        marker.get("schema_version") != SCHEMA_VERSION
        or marker.get("marker_type") != LEDGER_MARKER_TYPE
        or marker.get("completed") is not True
        or marker.get("ledger") != output.name
        or marker.get("ledger_sha256") != current_sha256
    ):
        raise ValueError(
            f"{marker_path}: completion marker does not authenticate the "
            "existing ledger"
        )
    return marker


def finalize_shard(args: argparse.Namespace) -> int:
    if args.qa_dir is None or not string_value(args.shard_tag):
        raise ValueError("--qa-dir and --shard-tag are required with --finalize")
    if args.output_ledger is None:
        raise ValueError("--output-ledger is required with --finalize")
    if any(
        (
            args.sheet_json,
            args.reviewer,
            args.reject,
            args.recrop,
            args.recrop_bbox,
            args.recrop_padding,
            args.replace_sheet,
        )
    ):
        raise ValueError("sheet-recording options cannot be used with --finalize")

    qa_dir = args.qa_dir.expanduser().resolve()
    if not qa_dir.is_dir():
        raise FileNotFoundError(qa_dir)
    shard_tag = string_value(args.shard_tag)
    journal = args.journal.expanduser().resolve()
    output = args.output_ledger.expanduser().resolve()
    require_under(qa_dir, journal, "--journal")
    require_under(qa_dir, output, "--output-ledger")
    if output.suffix.lower() != ".csv":
        raise ValueError("--output-ledger must be a CSV file")
    if output == journal:
        raise ValueError("--output-ledger and --journal must differ")

    state, inventory_paths = validate_shard_state(qa_dir, shard_tag)
    inventories = [parse_sheet_inventory(path) for path in inventory_paths]
    records = load_journal(journal)
    by_sheet = {string_value(record.get("sheet_json")): record for record in records}
    expected_names = {inventory.json_path.name for inventory in inventories}
    recorded_names = set(by_sheet)
    missing = sorted(expected_names - recorded_names)
    extra = sorted(recorded_names - expected_names)
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing={missing[:8]}")
        if extra:
            details.append(f"unexpected={extra[:8]}")
        raise ValueError(
            "journal must contain every expected shard sheet exactly once: "
            + ", ".join(details)
        )

    ledger_rows: list[dict[str, Any]] = []
    ordered_ids: list[str] = []
    missing_bboxes: list[str] = []
    for inventory in inventories:
        record = by_sheet[inventory.json_path.name]
        verify_record_against_inventory(record, inventory)
        for decision in record["decisions"]:
            item_id = string_value(decision.get("id"))
            ordered_ids.append(item_id)
            if (
                decision.get("decision") == "recrop"
                and decision.get("recrop_bbox_px") is None
            ):
                missing_bboxes.append(
                    f"{inventory.json_path.name}:cell "
                    f"{decision.get('cell_index')}:{item_id}"
                )
            ledger_rows.append(
                {
                    "id": item_id,
                    "decision": decision.get("decision"),
                    "reject_reason": string_value(decision.get("reject_reason")),
                    "recrop_bbox_px": decision.get("recrop_bbox_px"),
                    "padding_px": decision.get("padding_px", 0),
                    "reviewer": string_value(decision.get("reviewer")),
                    "reviewed_at": string_value(decision.get("reviewed_at")),
                    "notes": string_value(decision.get("notes")),
                    "sheet": inventory.png_path.name,
                    "cell_index": decision.get("cell_index"),
                }
            )
    if missing_bboxes:
        preview = ", ".join(missing_bboxes[:10])
        suffix = (
            f" (+{len(missing_bboxes) - 10} more)" if len(missing_bboxes) > 10 else ""
        )
        raise ValueError(
            "cannot finalize: recrop candidates still lack source-page "
            f"bboxes: {preview}{suffix}"
        )

    if len(ordered_ids) != len(set(ordered_ids)):
        raise ValueError("audit sheets contain duplicate item IDs")
    state_ids = state.get("ids")
    if not isinstance(state_ids, list) or not all(
        isinstance(item_id, str) and item_id for item_id in state_ids
    ):
        raise ValueError("audit state has an invalid ids list")
    if (
        len(ordered_ids) != state.get("item_count")
        or sorted(ordered_ids) != state_ids
        or hash_id_list(ordered_ids, sort_items=True) != state.get("id_set_sha256")
        or hash_id_list(ordered_ids, sort_items=False)
        != state.get("ordered_ids_sha256")
    ):
        raise ValueError(
            "final sheet ID coverage/order does not match the bound audit state"
        )

    content = ledger_csv_bytes(ledger_rows)
    new_sha256 = sha256_bytes(content)
    marker_path = completion_marker_path(output)
    existing_identical = False
    if output.exists():
        if not output.is_file():
            raise ValueError(f"output ledger is not a file: {output}")
        current_sha256 = sha256_file(output)
        if current_sha256 == new_sha256:
            existing_identical = True
            if marker_path.exists():
                validate_existing_completion_marker(marker_path, output, current_sha256)
        else:
            if not args.replace_ledger:
                raise ValueError(
                    f"refusing to overwrite nonidentical completed ledger "
                    f"{output}; use --replace-ledger"
                )
            validate_existing_completion_marker(marker_path, output, current_sha256)
    elif marker_path.exists():
        raise ValueError(
            f"stale completion marker exists without ledger: {marker_path}"
        )
    elif args.replace_ledger:
        raise ValueError(
            "--replace-ledger was supplied, but no existing ledger is present"
        )

    if not existing_identical:
        atomic_write_bytes(output, content)
    marker: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "marker_type": LEDGER_MARKER_TYPE,
        "completed": True,
        "ledger": output.name,
        "ledger_sha256": new_sha256,
        "journal": journal.name,
        "journal_sha256": sha256_file(journal),
        "shard_tag": shard_tag,
        "sheet_count": len(inventories),
        "item_count": len(ledger_rows),
        "ordered_ids_sha256": hash_id_list(ordered_ids, sort_items=False),
        "completed_at": utc_now(),
    }
    atomic_write_bytes(
        marker_path,
        json.dumps(marker, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        + b"\n",
    )
    counts = {
        decision: sum(row["decision"] == decision for row in ledger_rows)
        for decision in ("pass", "reject", "recrop")
    }
    action = "Verified" if existing_identical else "Finalized"
    print(
        f"{action} shard {shard_tag}: {len(inventories)} sheets, "
        f"{counts['pass']} pass, {counts['reject']} reject, "
        f"{counts['recrop']} recrop -> {output}"
    )
    return 0


def run(args: argparse.Namespace) -> int:
    return finalize_shard(args) if args.finalize else record_sheet(args)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except (OSError, ValueError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
