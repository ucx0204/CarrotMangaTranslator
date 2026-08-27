#!/usr/bin/env python3
"""Extract aligned source/B/C text from two completed Gemma chapter QA runs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-run", required=True, type=Path)
    parser.add_argument("--qat-run", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--output-markdown", required=True, type=Path)
    parser.add_argument("--baseline-label", default="B")
    parser.add_argument("--qat-label", default="C")
    return parser.parse_args()


def load_page(path: Path) -> dict[str, Any]:
    return json.loads((path / "font-input.json").read_text(encoding="utf-8"))


def page_dirs(run_dir: Path) -> list[Path]:
    return sorted(
        (path for path in (run_dir / "pages").iterdir() if path.is_dir()),
        key=lambda path: int(path.name),
    )


def markdown_cell(value: str | None) -> str:
    if value is None:
        return "—"
    return value.replace("|", "\\|").replace("\r", "").replace("\n", "<br>")


def keyed_blocks(
    blocks: list[dict[str, Any]],
) -> tuple[list[tuple[str, int]], dict[tuple[str, int], dict[str, Any]]]:
    counts: dict[str, int] = {}
    order: list[tuple[str, int]] = []
    keyed: dict[tuple[str, int], dict[str, Any]] = {}
    for block in blocks:
        source = block["sourceText"]
        occurrence = counts.get(source, 0) + 1
        counts[source] = occurrence
        key = (source, occurrence)
        order.append(key)
        keyed[key] = block
    return order, keyed


def main() -> int:
    args = parse_args()
    baseline_dirs = page_dirs(args.baseline_run.resolve())
    qat_dirs = page_dirs(args.qat_run.resolve())
    if [path.name for path in baseline_dirs] != [path.name for path in qat_dirs]:
        raise RuntimeError("B/C page inventories differ")

    pages: list[dict[str, Any]] = []
    for baseline_dir, qat_dir in zip(baseline_dirs, qat_dirs, strict=True):
        baseline = load_page(baseline_dir)
        qat = load_page(qat_dir)
        baseline_blocks = baseline["page"]["blocks"]
        qat_blocks = qat["page"]["blocks"]
        baseline_order, baseline_by_key = keyed_blocks(baseline_blocks)
        qat_order, qat_by_key = keyed_blocks(qat_blocks)
        block_order = baseline_order + [
            key for key in qat_order if key not in baseline_by_key
        ]
        blocks: list[dict[str, Any]] = []
        for index, key in enumerate(block_order, start=1):
            baseline_block = baseline_by_key.get(key)
            qat_block = qat_by_key.get(key)
            blocks.append(
                {
                    "block": index,
                    "source": key[0],
                    "baseline": baseline_block["translatedText"]
                    if baseline_block
                    else None,
                    "qat": qat_block["translatedText"] if qat_block else None,
                    "baselineFontFamily": baseline_block.get("fontFamily")
                    if baseline_block
                    else None,
                    "qatFontFamily": qat_block.get("fontFamily") if qat_block else None,
                    "baselineFontSizePx": baseline_block.get("fontSizePx")
                    if baseline_block
                    else None,
                    "qatFontSizePx": qat_block.get("fontSizePx") if qat_block else None,
                }
            )
        pages.append(
            {
                "page": int(baseline_dir.name),
                "sourceName": baseline["page"]["name"],
                "blocks": blocks,
            }
        )

    output = {
        "schemaVersion": 1,
        "baselineLabel": args.baseline_label,
        "qatLabel": args.qat_label,
        "pageCount": len(pages),
        "blockCount": sum(len(page["blocks"]) for page in pages),
        "pages": pages,
    }
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    lines = [
        "# Gemma chapter B/C aligned translation text",
        "",
        f"Pages: {output['pageCount']}; blocks: {output['blockCount']}",
        "",
    ]
    for page in pages:
        lines.extend(
            [
                f"## {page['page']:03d} · {page['sourceName']}",
                "",
                f"| # | 일본어 OCR | {args.baseline_label} | {args.qat_label} |",
                "|---:|---|---|---|",
            ]
        )
        for block in page["blocks"]:
            lines.append(
                "| {block} | {source} | {baseline} | {qat} |".format(
                    block=block["block"],
                    source=markdown_cell(block["source"]),
                    baseline=markdown_cell(block["baseline"]),
                    qat=markdown_cell(block["qat"]),
                )
            )
        lines.append("")
    args.output_markdown.parent.mkdir(parents=True, exist_ok=True)
    args.output_markdown.write_text("\n".join(lines), encoding="utf-8")
    print(
        json.dumps(
            {"pageCount": output["pageCount"], "blockCount": output["blockCount"]},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
