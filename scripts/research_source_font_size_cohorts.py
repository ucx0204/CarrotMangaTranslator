#!/usr/bin/env python3
"""Seal two work-disjoint body-page cohorts from an existing local library.

The script is intentionally read-only with respect to the library.  It selects
one already translated and inpainted body page per work, rejects cover/opening
pages, and writes only a manifest below the requested research output folder.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Iterable, Sequence


JAPANESE_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")


@dataclass(frozen=True)
class PageCandidate:
    work_id: str
    work_title: str
    chapter_id: str
    chapter_title: str
    chapter_path: str
    page_id: str
    page_name: str
    page_index: int
    image_path: str
    inpainted_image_path: str
    width: int
    height: int
    usable_blocks: int
    ordinary_blocks: int
    score: float
    chapter_sha256: str
    image_sha256: str
    inpainted_sha256: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def ordered_records(values: object, order: object) -> list[dict[str, object]]:
    records = [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []
    by_id = {str(record.get("id") or ""): record for record in records}
    ordered: list[dict[str, object]] = []
    seen: set[str] = set()
    if isinstance(order, list):
        for raw_id in order:
            record_id = str(raw_id or "")
            record = by_id.get(record_id)
            if record is not None:
                ordered.append(record)
                seen.add(record_id)
    ordered.extend(record for record in records if str(record.get("id") or "") not in seen)
    return ordered


def usable_block_count(page: dict[str, object]) -> tuple[int, int]:
    usable = 0
    ordinary = 0
    blocks = page.get("blocks")
    if not isinstance(blocks, list):
        return 0, 0
    for block in blocks:
        if not isinstance(block, dict):
            continue
        source = str(block.get("sourceText") or "").strip()
        translated = str(block.get("translatedText") or "").strip()
        bbox = block.get("bbox")
        direction = str(block.get("sourceDirection") or "")
        role = str(block.get("textRole") or "ordinary")
        if role == "ordinary":
            ordinary += 1
        if (
            role == "ordinary"
            and JAPANESE_RE.search(source)
            and HANGUL_RE.search(translated)
            and isinstance(bbox, dict)
            and direction in {"horizontal", "vertical"}
        ):
            try:
                width = float(bbox.get("w", 0))
                height = float(bbox.get("h", 0))
            except (TypeError, ValueError):
                continue
            if 8 <= width <= 420 and 8 <= height <= 520:
                usable += 1
    return usable, ordinary


def candidate_for_page(
    *,
    work_id: str,
    work_title: str,
    chapter_id: str,
    chapter_title: str,
    chapter_path: Path,
    chapter_hash: str,
    page: dict[str, object],
    page_index: int,
) -> PageCandidate | None:
    # Body-page only: page indexes 0 and 1 commonly contain a cover, title,
    # recap, or credits even when their filename looks like an ordinary page.
    if page_index < 2:
        return None
    image_path = Path(str(page.get("imagePath") or ""))
    inpainted_path = Path(str(page.get("inpaintedImagePath") or ""))
    if not image_path.is_file() or not inpainted_path.is_file():
        return None
    usable, ordinary = usable_block_count(page)
    if usable < 4:
        return None
    try:
        width = int(page.get("width") or 0)
        height = int(page.get("height") or 0)
    except (TypeError, ValueError):
        return None
    if width < 300 or height < 300:
        return None
    # Prefer dialogue-rich interior pages without selecting only the densest
    # possible pages.  A small mid-chapter bonus reduces opening/ending bias.
    density_score = min(usable, 14) * 10 + min(ordinary, 18)
    middle_bonus = 8 if 3 <= page_index <= 12 else 0
    score = float(density_score + middle_bonus - max(0, usable - 18) * 2)
    return PageCandidate(
        work_id=work_id,
        work_title=work_title,
        chapter_id=chapter_id,
        chapter_title=chapter_title,
        chapter_path=str(chapter_path.resolve()),
        page_id=str(page.get("id") or ""),
        page_name=str(page.get("name") or image_path.name),
        page_index=page_index,
        image_path=str(image_path.resolve()),
        inpainted_image_path=str(inpainted_path.resolve()),
        width=width,
        height=height,
        usable_blocks=usable,
        ordinary_blocks=ordinary,
        score=score,
        chapter_sha256=chapter_hash,
        image_sha256="",
        inpainted_sha256="",
    )


def best_candidates(library_root: Path) -> list[PageCandidate]:
    index = read_json(library_root / "index.json")
    works_root = library_root / "works"
    work_ids = index.get("workOrder")
    if not isinstance(work_ids, list):
        work_ids = [path.name for path in works_root.iterdir() if path.is_dir()]
    selected: list[PageCandidate] = []
    for raw_work_id in work_ids:
        work_id = str(raw_work_id or "")
        work_path = works_root / work_id / "work.json"
        if not work_path.is_file():
            continue
        work = read_json(work_path)
        work_title = str(work.get("title") or work_id)
        chapter_ids = work.get("chapterOrder")
        if not isinstance(chapter_ids, list):
            continue
        candidates: list[PageCandidate] = []
        for raw_chapter_id in chapter_ids:
            chapter_id = str(raw_chapter_id or "")
            chapter_path = works_root / work_id / "chapters" / chapter_id / "chapter.json"
            if not chapter_path.is_file():
                continue
            chapter = read_json(chapter_path)
            chapter_hash = sha256(chapter_path)
            pages = ordered_records(chapter.get("pages"), chapter.get("pageOrder"))
            for page_index, page in enumerate(pages):
                candidate = candidate_for_page(
                    work_id=work_id,
                    work_title=work_title,
                    chapter_id=chapter_id,
                    chapter_title=str(chapter.get("title") or chapter_id),
                    chapter_path=chapter_path,
                    chapter_hash=chapter_hash,
                    page=page,
                    page_index=page_index,
                )
                if candidate is not None:
                    candidates.append(candidate)
        if candidates:
            # Stable tie-breakers make the sealed cohorts reproducible.
            winner = max(
                candidates,
                key=lambda item: (item.score, -item.page_index, item.page_id),
            )
            selected.append(
                replace(
                    winner,
                    image_sha256=sha256(Path(winner.image_path)),
                    inpainted_sha256=sha256(Path(winner.inpainted_image_path)),
                )
            )
    return selected


def stable_partition(candidates: Iterable[PageCandidate], seed: str) -> list[PageCandidate]:
    def key(item: PageCandidate) -> tuple[str, str]:
        digest = hashlib.sha256(f"{seed}\0{item.work_id}".encode("utf-8")).hexdigest()
        return digest, item.work_id

    return sorted(candidates, key=key)


def normalize_title(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum() and not character.isdigit())


def remove_near_duplicate_series(candidates: Iterable[PageCandidate]) -> list[PageCandidate]:
    selected: list[PageCandidate] = []
    normalized: list[str] = []
    for candidate in candidates:
        title = normalize_title(candidate.work_title)
        if any(
            min(len(title), len(previous)) >= 8
            and (
                title in previous
                or previous in title
                or difflib.SequenceMatcher(a=title, b=previous).ratio() >= 0.82
            )
            for previous in normalized
        ):
            continue
        selected.append(candidate)
        normalized.append(title)
    return selected


def run(args: argparse.Namespace) -> int:
    library_root = Path(args.library_root).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    candidates = remove_near_duplicate_series(
        stable_partition(best_candidates(library_root), args.seed)
    )
    required = args.pages_per_cohort * 2
    if len(candidates) < required:
        raise RuntimeError(
            f"need {required} work-disjoint pages, found only {len(candidates)}"
        )
    cohorts = {
        "schemaVersion": 1,
        "selection": {
            "bodyPageMinimumIndex": 2,
            "alreadyTranslated": True,
            "alreadyInpainted": True,
            "onePagePerWork": True,
            "libraryReadOnly": True,
            "seed": args.seed,
        },
        "development": [asdict(item) for item in candidates[: args.pages_per_cohort]],
        "holdout": [
            asdict(item)
            for item in candidates[args.pages_per_cohort : required]
        ],
    }
    payload = json.dumps(cohorts, ensure_ascii=False, indent=2) + "\n"
    manifest_path = output / "cohorts.json"
    manifest_path.write_text(payload, encoding="utf-8")
    seal = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    (output / "cohorts.sha256").write_text(f"{seal}  cohorts.json\n", encoding="ascii")
    summary = {
        "eligibleWorks": len(candidates),
        "developmentWorks": len(cohorts["development"]),
        "holdoutWorks": len(cohorts["holdout"]),
        "manifest": str(manifest_path),
        "sha256": seal,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--pages-per-cohort", type=int, default=10)
    parser.add_argument("--seed", default="source-size-v1-body-pages")
    args = parser.parse_args(argv)
    if args.pages_per_cohort <= 0:
        parser.error("--pages-per-cohort must be positive")
    return args


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
