#!/usr/bin/env python3
"""Summarize matched full-pipeline Gemma chapter benchmark reports."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-report", required=True, type=Path)
    parser.add_argument("--qat-report", required=True, type=Path)
    parser.add_argument("--output-json", required=True, type=Path)
    parser.add_argument("--output-markdown", required=True, type=Path)
    parser.add_argument("--baseline-label", default="B 기존 12B")
    parser.add_argument("--qat-label", default="C QAT 12B + MTP")
    parser.add_argument("--title", default="Gemma 4 12B vs QAT 12B + MTP · 14화 실측")
    parser.add_argument("--baseline-vram", type=Path)
    parser.add_argument("--qat-vram", type=Path)
    return parser.parse_args()


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def sum_numeric(rows: list[dict[str, Any]], field: str) -> float:
    return sum(float(row.get(field) or 0) for row in rows)


def summarize_report(report: dict[str, Any]) -> dict[str, Any]:
    measurements = report.get("runtimeMeasurements") or {}
    completed_calls = [
        row for row in measurements.get("translationCalls") or [] if row.get("status") == "completed"
    ]
    wall_times = [float(row.get("elapsedMs") or 0) for row in completed_calls]
    main_timings: list[dict[str, Any]] = []
    all_timings: list[dict[str, Any]] = []
    for call in completed_calls:
        timings = call.get("timings") or []
        all_timings.extend(timings)
        main_timings.extend(row for row in timings if row.get("location") == "rawResponse.translation")
    main_predicted_n = sum_numeric(main_timings, "predicted_n")
    main_predicted_ms = sum_numeric(main_timings, "predicted_ms")
    all_predicted_n = sum_numeric(all_timings, "predicted_n")
    all_predicted_ms = sum_numeric(all_timings, "predicted_ms")
    main_draft_n = sum_numeric(main_timings, "draft_n")
    main_draft_accepted = sum_numeric(main_timings, "draft_n_accepted")
    all_draft_n = sum_numeric(all_timings, "draft_n")
    all_draft_accepted = sum_numeric(all_timings, "draft_n_accepted")
    pages = report.get("pages") or []
    completed_pages = [row for row in pages if row.get("status") == "completed"]
    endpoint_starts = measurements.get("endpointStarts") or []
    stage = report.get("stageTimings") or {}
    ocr_reuse = report.get("ocrCacheReuse") or {}
    ocr_reuse_pages = ocr_reuse.get("pages") or []
    return {
        "status": report.get("status"),
        "candidateId": report.get("candidateId"),
        "runId": report.get("runId"),
        "pageCount": int(report.get("pageCount") or len(pages)),
        "completedPages": len(completed_pages),
        "translatedBlocks": sum(int(row.get("blockCount") or 0) for row in completed_pages),
        "translationRequests": {
            "completed": len(completed_calls),
            "wallMsTotal": sum(wall_times),
            "wallMsMean": statistics.fmean(wall_times) if wall_times else 0,
            "wallMsMedian": statistics.median(wall_times) if wall_times else 0,
            "wallMsP95": percentile(wall_times, 0.95),
        },
        "mainDecode": {
            "samples": len(main_timings),
            "promptTokens": sum_numeric(main_timings, "prompt_n"),
            "promptMs": sum_numeric(main_timings, "prompt_ms"),
            "predictedTokens": main_predicted_n,
            "predictedMs": main_predicted_ms,
            "weightedTokensPerSecond": main_predicted_n / (main_predicted_ms / 1000)
            if main_predicted_ms
            else 0,
            "draftTokens": main_draft_n,
            "draftAccepted": main_draft_accepted,
            "draftAcceptanceRate": main_draft_accepted / main_draft_n if main_draft_n else None,
        },
        "allDecode": {
            "samples": len(all_timings),
            "predictedTokens": all_predicted_n,
            "predictedMs": all_predicted_ms,
            "weightedTokensPerSecond": all_predicted_n / (all_predicted_ms / 1000)
            if all_predicted_ms
            else 0,
            "draftTokens": all_draft_n,
            "draftAccepted": all_draft_accepted,
            "draftAcceptanceRate": all_draft_accepted / all_draft_n if all_draft_n else None,
        },
        "stageTimings": {
            "translationElapsedMs": float(stage.get("translationElapsedMs") or 0),
            "finishingElapsedMs": float(stage.get("finishingElapsedMs") or 0),
            "fullPipelineElapsedMs": float(stage.get("fullPipelineElapsedMs") or 0),
            "endpointStartMs": sum(float(row.get("elapsedMs") or 0) for row in endpoint_starts),
        },
        "ocr": {
            "runtimeCalls": len(measurements.get("ocrCalls") or []),
            "reusedPages": len(ocr_reuse_pages),
            "reusePayloadSha256": [row.get("payloadSha256") for row in ocr_reuse_pages],
        },
    }


def safe_ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def seconds(value: float) -> str:
    return f"{value / 1000:.2f}s"


def summarize_vram(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise RuntimeError(f"Empty VRAM sample file: {path}")
    samples = [
        {
            "memoryUsedMiB": int(float(row["memory_used_mib"])),
            "memoryTotalMiB": int(float(row["memory_total_mib"])),
            "phase": row["phase"],
        }
        for row in rows
    ]
    leading_idle: list[int] = []
    for sample in samples:
        if sample["phase"] != "idle":
            break
        leading_idle.append(sample["memoryUsedMiB"])
    if not leading_idle:
        leading_idle = [sample["memoryUsedMiB"] for sample in samples[: min(10, len(samples))]]
    baseline = statistics.median(leading_idle)

    def phase_peak(phase: str) -> int | None:
        values = [sample["memoryUsedMiB"] for sample in samples if sample["phase"] == phase]
        return max(values) if values else None

    peak = max(sample["memoryUsedMiB"] for sample in samples)
    return {
        "path": str(path.resolve()),
        "sampleCount": len(samples),
        "memoryTotalMiB": samples[0]["memoryTotalMiB"],
        "baselineMiB": baseline,
        "peakMiB": peak,
        "peakDeltaMiB": peak - baseline,
        "phasePeaksMiB": {
            phase: phase_peak(phase) for phase in ("idle", "llama", "flux", "llama+flux")
        },
        "measurementNote": "nvidia-smi board-wide memory.used; peak delta is relative to leading idle median",
    }


def write_markdown(summary: dict[str, Any], path: Path) -> None:
    baseline = summary["baseline"]
    qat = summary["qatMtp"]
    comparison = summary["comparison"]
    baseline_main = baseline["mainDecode"]
    qat_main = qat["mainDecode"]
    baseline_requests = baseline["translationRequests"]
    qat_requests = qat["translationRequests"]
    baseline_stage = baseline["stageTimings"]
    qat_stage = qat["stageTimings"]
    lines = [
        f"# {summary['title']}",
        "",
        "동일한 선택 페이지 집합과 동일 OCR payload로 번역·인페인팅·자동 레이아웃까지 완료한 결과다.",
        "모델 속도 비교의 주 지표는 OCR/인페인팅 시간을 제외한 번역 요청 wall time과 llama.cpp main decode timing이다.",
        "",
        f"| 지표 | {summary['baselineLabel']} | {summary['qatLabel']} | 변화 |",
        "|---|---:|---:|---:|",
        f"| 완료 페이지 | {baseline['completedPages']} | {qat['completedPages']} | — |",
        f"| 번역 요청 총 wall time | {seconds(baseline_requests['wallMsTotal'])} | {seconds(qat_requests['wallMsTotal'])} | {pct(comparison['translationWallReduction'])} 단축 |",
        f"| 페이지당 번역 요청 평균 | {seconds(baseline_requests['wallMsMean'])} | {seconds(qat_requests['wallMsMean'])} | {comparison['translationWallSpeedup']:.2f}× |",
        f"| main decode 가중 속도 | {baseline_main['weightedTokensPerSecond']:.1f} tok/s | {qat_main['weightedTokensPerSecond']:.1f} tok/s | {comparison['mainDecodeSpeedup']:.2f}× |",
        f"| main decode 출력 토큰 | {baseline_main['predictedTokens']:.0f} | {qat_main['predictedTokens']:.0f} | 모델 출력량 차이 포함 |",
        f"| MTP draft 제안/수락 | — | {qat_main['draftTokens']:.0f} / {qat_main['draftAccepted']:.0f} | 수락률 {pct(qat_main['draftAcceptanceRate'])} |",
        f"| 번역 단계 경과 | {seconds(baseline_stage['translationElapsedMs'])} | {seconds(qat_stage['translationElapsedMs'])} | OCR 캐시 포함 조건은 아래 참조 |",
        f"| 인페인팅·렌더 마감 | {seconds(baseline_stage['finishingElapsedMs'])} | {seconds(qat_stage['finishingElapsedMs'])} | 모델 외 구간 |",
        f"| 전체 QA 파이프라인 | {seconds(baseline_stage['fullPipelineElapsedMs'])} | {seconds(qat_stage['fullPipelineElapsedMs'])} | OCR 조건 차이 포함 |",
        "",
        "## OCR 동일성",
        "",
        f"- {summary['baselineLabel']} 실제 OCR 호출/재사용: {baseline['ocr']['runtimeCalls']}회 / {baseline['ocr']['reusedPages']}페이지",
        f"- {summary['qatLabel']} 실제 OCR 호출/재사용: {qat['ocr']['runtimeCalls']}회 / {qat['ocr']['reusedPages']}페이지",
        f"- C가 B 결과에서 재사용한 OCR payload: {qat['ocr']['reusedPages']} / {qat['pageCount']}페이지",
        f"- payload SHA-256 모두 존재·고유 페이지 수: {summary['ocrEquality']['payloadDigestCount']} / {qat['pageCount']}",
        "",
    ]
    if summary.get("vram"):
        baseline_vram = summary["vram"]["baseline"]
        qat_vram = summary["vram"]["qatMtp"]
        lines.extend(
            [
                "## VRAM 실측",
                "",
                "`nvidia-smi memory.used`의 GPU 전체 사용량이다. WDDM 환경이라 프로세스별 수치가 아닌, 실행 직전 idle 중앙값 대비 증가량을 함께 적었다.",
                "",
                f"| 지표 | {summary['baselineLabel']} | {summary['qatLabel']} |",
                "|---|---:|---:|",
                f"| 실행 전 idle 중앙값 | {baseline_vram['baselineMiB']:.0f} MiB | {qat_vram['baselineMiB']:.0f} MiB |",
                f"| 전체 최고 사용량 | {baseline_vram['peakMiB']:.0f} MiB | {qat_vram['peakMiB']:.0f} MiB |",
                f"| idle 대비 최고 증가량 | {baseline_vram['peakDeltaMiB']:.0f} MiB | {qat_vram['peakDeltaMiB']:.0f} MiB |",
                f"| llama 구간 최고 | {baseline_vram['phasePeaksMiB']['llama'] or 0:.0f} MiB | {qat_vram['phasePeaksMiB']['llama'] or 0:.0f} MiB |",
                f"| llama+인페인팅 중첩 최고 | {baseline_vram['phasePeaksMiB']['llama+flux'] or 0:.0f} MiB | {qat_vram['phasePeaksMiB']['llama+flux'] or 0:.0f} MiB |",
                "",
            ]
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    baseline = summarize_report(load_report(args.baseline_report.resolve()))
    qat = summarize_report(load_report(args.qat_report.resolve()))
    baseline_wall = baseline["translationRequests"]["wallMsTotal"]
    qat_wall = qat["translationRequests"]["wallMsTotal"]
    baseline_decode = baseline["mainDecode"]["weightedTokensPerSecond"]
    qat_decode = qat["mainDecode"]["weightedTokensPerSecond"]
    qat_digests = [value for value in qat["ocr"]["reusePayloadSha256"] if value]
    summary = {
        "schemaVersion": 1,
        "title": args.title,
        "baselineLabel": args.baseline_label,
        "qatLabel": args.qat_label,
        "baselineReport": str(args.baseline_report.resolve()),
        "qatReport": str(args.qat_report.resolve()),
        "baseline": baseline,
        "qatMtp": qat,
        "comparison": {
            "translationWallReduction": 1 - safe_ratio(qat_wall, baseline_wall)
            if baseline_wall
            else None,
            "translationWallSpeedup": safe_ratio(baseline_wall, qat_wall),
            "mainDecodeSpeedup": safe_ratio(qat_decode, baseline_decode),
        },
        "ocrEquality": {
            "qatRuntimeOcrCallsZero": qat["ocr"]["runtimeCalls"] == 0,
            "allPagesReused": qat["ocr"]["reusedPages"] == qat["pageCount"],
            "payloadDigestCount": len(qat_digests),
            "allPayloadDigestsPresent": len(qat_digests) == qat["pageCount"],
        },
    }
    if bool(args.baseline_vram) != bool(args.qat_vram):
        raise RuntimeError("Provide both --baseline-vram and --qat-vram, or neither")
    if args.baseline_vram and args.qat_vram:
        summary["vram"] = {
            "baseline": summarize_vram(args.baseline_vram.resolve()),
            "qatMtp": summarize_vram(args.qat_vram.resolve()),
        }
    if baseline["status"] != "completed" or qat["status"] != "completed":
        raise RuntimeError("Both benchmark reports must be completed")
    if not all(summary["ocrEquality"].values()):
        raise RuntimeError(f"OCR reuse equality contract failed: {summary['ocrEquality']}")
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(summary, args.output_markdown)
    print(json.dumps(summary["comparison"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
