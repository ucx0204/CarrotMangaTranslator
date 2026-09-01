#!/usr/bin/env python3
"""Collect a reproducible primary-literature inventory for region splitting.

Crossref is used only as a bibliographic index.  Every inventory row points to
the paper DOI/publisher URL, and conclusions are drawn separately from the
shortlisted primary papers rather than from search snippets.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any


QUERIES = (
    ("comic-balloon", "comic speech balloon detection segmentation"),
    ("comic-balloon", "manga speech balloon extraction"),
    ("comic-layout", "comic book layout analysis"),
    ("comic-text", "comic text detection segmentation"),
    ("watershed", "touching object separation watershed"),
    ("watershed", "marker controlled watershed touching objects"),
    ("watershed", "distance transform watershed instance segmentation"),
    ("watershed", "deep watershed instance segmentation"),
    ("clump-splitting", "touching cells splitting segmentation"),
    ("clump-splitting", "overlapping object separation concavity"),
    ("clump-splitting", "clump splitting concavity analysis"),
    ("shape", "shape decomposition concavity skeleton"),
    ("boundary-instance", "boundary aware instance segmentation"),
    ("boundary-instance", "semantic to instance segmentation boundaries"),
    ("boundary-instance", "center distance map instance segmentation"),
    ("cell-instance", "cell instance segmentation touching nuclei"),
    ("cell-instance", "flow field instance segmentation Cellpose"),
    ("cell-instance", "star convex instance segmentation StarDist"),
    ("seeded-segmentation", "random walker image segmentation markers"),
    ("seeded-segmentation", "graph cut touching object segmentation"),
    ("graph-partition", "multicut instance segmentation boundary"),
    ("graph-partition", "mutex watershed instance segmentation"),
    ("text-grouping", "scene text component grouping"),
    ("text-grouping", "text line grouping graph detection"),
    ("text-grouping", "pixel linking scene text detection"),
    ("text-grouping", "hierarchical text detection layout analysis"),
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def fetch(query: str, rows: int) -> list[dict[str, Any]]:
    parameters = urllib.parse.urlencode(
        {
            "query.title": query,
            "rows": rows,
            "select": "DOI,title,published,URL,type,publisher,author,container-title",
        }
    )
    request = urllib.request.Request(
        f"https://api.crossref.org/works?{parameters}",
        headers={
            "User-Agent": "manga-region-research/1.0 (bibliographic survey; contact: local-research@example.invalid)",
            "Accept": "application/json",
        },
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            return list(payload["message"]["items"])
        except (OSError, KeyError, ValueError) as error:
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Crossref query failed for {query!r}: {last_error}")


def title_of(item: dict[str, Any]) -> str:
    titles = item.get("title") or []
    return " ".join(str(value).strip() for value in titles if str(value).strip())


def year_of(item: dict[str, Any]) -> int | None:
    parts = ((item.get("published") or {}).get("date-parts") or [[]])[0]
    try:
        return int(parts[0])
    except (IndexError, TypeError, ValueError):
        return None


def authors_of(item: dict[str, Any]) -> list[str]:
    authors: list[str] = []
    for author in item.get("author") or []:
        name = " ".join(
            value
            for value in (str(author.get("given") or "").strip(), str(author.get("family") or "").strip())
            if value
        )
        if name:
            authors.append(name)
    return authors


def normalized_key(item: dict[str, Any]) -> str:
    doi = str(item.get("DOI") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    return "title:" + " ".join(title_of(item).casefold().split())


def collect(rows: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    query_counts: dict[str, int] = {}
    for index, (category, query) in enumerate(QUERIES, 1):
        items = fetch(query, rows)
        query_counts[query] = len(items)
        print(f"[crossref] {index}/{len(QUERIES)} {category}: {len(items)}", flush=True)
        for rank, item in enumerate(items, 1):
            title = title_of(item)
            if not title:
                continue
            key = normalized_key(item)
            current = merged.setdefault(
                key,
                {
                    "title": title,
                    "doi": str(item.get("DOI") or "").strip() or None,
                    "url": str(item.get("URL") or "").strip() or None,
                    "year": year_of(item),
                    "type": str(item.get("type") or ""),
                    "publisher": str(item.get("publisher") or ""),
                    "venue": " | ".join(str(value) for value in item.get("container-title") or []),
                    "authors": authors_of(item),
                    "categories": [],
                    "matchedQueries": [],
                    "bestRank": rank,
                },
            )
            if category not in current["categories"]:
                current["categories"].append(category)
            current["matchedQueries"].append(query)
            current["bestRank"] = min(int(current["bestRank"]), rank)
        time.sleep(0.12)
    records = sorted(
        merged.values(),
        key=lambda value: (
            -len(value["categories"]),
            int(value["bestRank"]),
            -(int(value["year"]) if value["year"] else 0),
            str(value["title"]).casefold(),
        ),
    )
    category_counts: dict[str, int] = defaultdict(int)
    for record in records:
        for category in record["categories"]:
            category_counts[category] += 1
    summary = {
        "queryCount": len(QUERIES),
        "rowsPerQuery": rows,
        "rawResultCount": sum(query_counts.values()),
        "uniqueSourceCount": len(records),
        "categoryUniqueCounts": dict(sorted(category_counts.items())),
        "queryResultCounts": query_counts,
    }
    return records, summary


def write_markdown(path: Path, records: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    lines = [
        "# OCR region / over-merged instance literature inventory",
        "",
        f"- Queries: {summary['queryCount']}",
        f"- Raw Crossref results reviewed: {summary['rawResultCount']}",
        f"- Unique primary-source records: {summary['uniqueSourceCount']}",
        "- Crossref is the bibliographic index; DOI/publisher pages below are the sources.",
        "",
        "## Inventory",
        "",
    ]
    for index, record in enumerate(records, 1):
        target = record["url"] or (f"https://doi.org/{record['doi']}" if record["doi"] else "")
        title = str(record["title"]).replace("[", "\\[").replace("]", "\\]")
        link = f"[{title}]({target})" if target else title
        categories = ", ".join(record["categories"])
        lines.append(f"{index}. {link} ({record['year'] or 'n.d.'}) — {categories}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--rows", type=int, default=12)
    args = parser.parse_args()
    if args.rows < 5 or args.rows > 50:
        parser.error("--rows must be between 5 and 50")
    output_dir = Path(args.output_dir).resolve()
    records, summary = collect(args.rows)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "inventory.json").write_text(
        canonical_json({"summary": summary, "sources": records}), encoding="utf-8"
    )
    write_markdown(output_dir / "inventory.md", records, summary)
    print(canonical_json(summary), end="")
    if int(summary["uniqueSourceCount"]) < 100:
        raise RuntimeError("research inventory contains fewer than 100 unique sources")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
