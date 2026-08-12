from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "seal_library_full_pipeline_font_qa_run.py"
SPEC = importlib.util.spec_from_file_location(
    "seal_library_full_pipeline_font_qa_run", SCRIPT
)
assert SPEC and SPEC.loader
SEAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SEAL
SPEC.loader.exec_module(SEAL)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def write_jsonl(path: Path, values: list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = "".join(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
        for value in values
    )
    path.write_text(encoded, encoding="utf-8")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def boundary_binding(path: Path) -> str:
    value = f"{path.resolve()}:{sha256_file(path)}".encode()
    return hashlib.sha256(value).hexdigest()


class RunFixture:
    def __init__(
        self,
        root: Path,
        *,
        replay: bool = False,
        page_count: int = SEAL.EXPECTED_PAGES,
        source_overlap: bool = False,
        work_overlap: bool = False,
    ) -> None:
        self.root = root
        self.baseline_fixture: RunFixture | None = None
        self.cache_seal_path: Path | None = None
        self.cache_seal_identity: dict[str, Any] | None = None
        if replay:
            self.baseline_fixture = RunFixture(
                root, replay=False, page_count=page_count
            )
            self.output_root = self.baseline_fixture.output_root
            self.cache_dir = self.baseline_fixture.run_dir
            self.cache_seal_path = root / "seals" / "fresh-baseline-audit.json"
            SEAL.seal_audit(
                SEAL.SealOptions(
                    report_path=self.baseline_fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                ),
                self.cache_seal_path,
            )
            self.cache_seal_identity = {
                "path": str(self.cache_seal_path.resolve()),
                "sha256": sha256_file(self.cache_seal_path),
                "pageCount": SEAL.EXPECTED_PAGES,
                "profile": SEAL.PROFILE_FRESH_GEMMA_FULL,
            }
        else:
            self.output_root = root / "qa-output"
            self.cache_dir = root / "precommitted-fresh-gemma-baseline"
            self.cache_dir.mkdir(parents=True)
        self.run_dir = (
            self.output_root
            / "runs"
            / "baseline40"
            / ("v2c-replay" if replay else "fresh-gemma")
            / "run-1"
        )
        self.report_path = self.run_dir / "run-report.json"
        self.config_path = self.run_dir / "run-config.json"
        self.replay = replay
        self.pages = [self._page(index, replay=replay) for index in range(page_count)]
        self.cohort_records = [
            self._cohort_record(index, page) for index, page in enumerate(self.pages)
        ]
        self.manifest_path = self.output_root / "cohorts" / "baseline40.jsonl"
        write_jsonl(self.manifest_path, self.cohort_records)

        first_record = self.cohort_records[0] if self.cohort_records else None
        first_page = first_record["page"] if first_record else {}
        self.source_boundary_path = (
            root
            / "sealed-boundaries"
            / "training-calibration-pseudo-and-prior-qa.jsonl"
        )
        self.source_boundary_records = [
            {
                "split": "train",
                "page": {
                    "id": (
                        first_page.get("id") if source_overlap else "old-training-page"
                    ),
                    "imageRelativePath": (
                        first_page.get("imageRelativePath")
                        if source_overlap
                        else "works/old-training/page.png"
                    ),
                },
                "source_page_sha256": (
                    first_page.get("imageSha256") if source_overlap else "a" * 64
                ),
            },
            {
                "cohort": "baseline40",
                "page": {
                    "id": "old-qa-page",
                    "imageRelativePath": "works/old-qa/page.png",
                },
                "source_page_sha256": "b" * 64,
            },
        ]
        write_jsonl(self.source_boundary_path, self.source_boundary_records)
        self.work_boundary_path = root / "sealed-boundaries" / "work-boundary.jsonl"
        self.work_boundary_records = [
            {
                "work_id": (
                    self.cohort_records[0]["work"]["id"]
                    if work_overlap and self.cohort_records
                    else "old-training-work"
                )
            }
        ]
        write_jsonl(self.work_boundary_path, self.work_boundary_records)
        self.selection_path = self.output_root / "selection.json"
        self.write_selection()

        page_ids = [page["sourcePageId"] for page in self.pages]
        cache_from = str(self.cache_dir.resolve()) if replay else None
        self.report: dict[str, Any] = {
            "schemaVersion": 1,
            "status": "completed",
            "startedAt": "2026-08-11T00:00:00.000Z",
            "finishedAt": "2026-08-11T00:10:00.000Z",
            "runId": "replay-run" if replay else "fresh-run",
            "cohort": "baseline40",
            "cohortDigest": sha256_file(self.manifest_path),
            "candidateId": "v2c" if replay else "r3h-fresh-gemma-v1",
            "qaPageRelativeRoleReroute": replay,
            "cacheFrom": cache_from,
            "provider": "gemma",
            "targetLanguage": "ko",
            "pageCount": page_count,
            "pages": self.pages,
        }
        if replay:
            self.report["cache"] = {
                "sourceRun": cache_from,
                "replayedPageIds": page_ids,
                "sourceGeometryDirectionReplay": {
                    "contractVersion": "font-matching-ocr-geometry-replay-summary-v1",
                    "pageCount": page_count,
                    "auditedPageCount": page_count,
                    "rawReadyPageCount": page_count,
                    "rawMissingPageCount": 0,
                    "rawConflictPageCount": 0,
                    "rawInvalidPageCount": 0,
                    "blockCount": page_count,
                    "resolvedBlockCount": page_count,
                    "rawResolvedBlockCount": page_count,
                    "existingEvidenceResolvedBlockCount": 0,
                    "missingBlockCount": 0,
                },
                "fontInference": {
                    "mode": "off",
                    "validationVersion": 1,
                    "reusedPageIds": [],
                    "livePageIds": page_ids,
                },
            }
        self.config: dict[str, Any] = {
            "root": str(root.resolve()),
            "outputRoot": str(self.output_root.resolve()),
            "manifestPath": str(self.manifest_path.resolve()),
            "runId": self.report["runId"],
            "cohort": "baseline40",
            "cohortDigest": self.report["cohortDigest"],
            "candidateId": self.report["candidateId"],
            "runDir": str(self.run_dir.resolve()),
            "cacheFrom": cache_from,
            "cacheFromSeal": (
                str(self.cache_seal_path.resolve())
                if self.cache_seal_path is not None
                else None
            ),
            "fontInferenceCacheMode": "off",
            "qaPageRelativeRoleReroute": replay,
            "execute": True,
            "preflightOnly": False,
            "pageLimit": None,
            "provider": "gemma",
            "targetLanguage": "ko",
            "model": {"source": "huggingface", "repo": "gemma", "file": "model.gguf"},
        }
        self.write()

    def _page(self, index: int, *, replay: bool) -> dict[str, Any]:
        library_dir = self.root / "library" / f"work-{index + 1}"
        page_dir = self.run_dir / "pages" / f"{index + 1:02d}"
        original = library_dir / f"source-{index + 1}.png"
        cleaned = page_dir / "cleaned.png"
        rendered = page_dir / "rendered.png"
        for path, color in (
            (original, ((index * 3) % 255, 250, 250)),
            (cleaned, ((index * 3) % 255, 245, 245)),
            (rendered, ((index * 3) % 255, 240, 240)),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            image = Image.new("RGB", (16, 24), color)
            image.save(path)
            image.close()
        page_id = f"page-{index + 1}"
        block_id = f"block-{index + 1}"
        font_id = "single-day" if index == 0 else "nanum-gothic"
        role = "dialogue" if index == 0 else "sfx_impact"
        decision = {
            "blockIndex": 0,
            "blockId": block_id,
            "bbox": {"x": 100, "y": 100, "w": 300, "h": 200},
            "sourceText": "ドン",
            "translatedText": "쾅",
            "applied": True,
            "selectedFontId": font_id,
            "effectiveFontFamily": font_id,
            "role": role,
            "confidence": 0.8,
            "effectiveOutlineWidthScale": 1.25,
            "effectiveTextColor": "#111111",
            "effectiveOutlineColor": "#ffffff",
            "effectiveOutlineContrastRatio": 18.883060964594996,
            "source": "pixel_runtime",
            "selectionCalibration": None,
            "noneAcceptable": False,
            "localConfidence": 0.8,
            "top5": [],
        }
        source_sha = sha256_file(original)
        request_blocks = [{"blockId": block_id, "item": {"id": 1, "candidateIds": [1]}}]
        font_input_run_root = self.cache_dir if replay else self.run_dir
        font_input = (
            font_input_run_root / "pages" / f"{index + 1:02d}" / "font-input.json"
        )
        font_inference = page_dir / "font-inference.json"
        write_json(
            font_input,
            {
                "schemaVersion": 1,
                "sourcePageId": page_id,
                "sourcePageSha256": source_sha,
                "page": {
                    "id": page_id,
                    "imagePath": str(original.resolve()),
                    "width": 16,
                    "height": 24,
                    "blocks": [{"id": block_id}],
                },
                "requestBlocks": request_blocks,
            },
        )
        raw_result_path = (
            font_input_run_root
            / "analysis"
            / "job-a"
            / "ocr-hints"
            / page_id
            / "result.json"
        )
        raw_result = {
            "schemaVersion": 10,
            "imagePath": str(original.resolve()),
            "width": 16,
            "height": 24,
            "sourceLanguage": "ja",
            "configuration": {"ocrBboxMode": "ocr", "ocrMergeMode": "semantic"},
            "hints": [
                {
                    "id": 1,
                    "x1": 1,
                    "y1": 1,
                    "x2": 5,
                    "y2": 14,
                    "reviewRole": "body",
                }
            ],
            "diagnostics": [{"provider": "paddleocr-vl"}],
            "noTextDetected": False,
        }
        write_json(raw_result_path, raw_result)
        if not replay:
            translation_result_path = (
                self.run_dir
                / "analysis"
                / "job-a"
                / "run"
                / "pages"
                / page_id
                / "attempt-1"
                / "result.json"
            )
            write_json(
                translation_result_path,
                {
                    "createdAt": "2026-08-11T00:00:01.000Z",
                    "imagePath": str(original.resolve()),
                    "label": f"page-{index + 1}-attempt-1",
                    "outputText": '{"blocks":[]}',
                    "prompt": "Translate the supplied Japanese blocks into Korean.",
                    "systemPrompt": "Return Korean fixed-block translations.",
                    "settings": {
                        "modelProvider": "gemma",
                        "modelSource": "huggingface",
                        "modelRepo": "gemma",
                        "modelFile": "model.gguf",
                    },
                    "requestSummary": {
                        "fixedBlockCount": 1,
                        "fixedBlockIds": [block_id],
                        "noTextDetected": False,
                        "options": {
                            "sourceLanguage": "ja",
                            "targetLanguage": "ko",
                            "modelProvider": "gemma",
                            "modelSource": "huggingface",
                            "modelRepo": "gemma",
                            "modelFile": "model.gguf",
                        },
                    },
                    "rawResponse": {"translation": {}},
                },
            )
        raw_artifact = {
            "path": str(raw_result_path.resolve()),
            "sha256": sha256_file(raw_result_path),
            "artifactSource": "analysis_ocr_hints_result",
            "schemaVersion": 10,
            "sourceLanguage": "ja",
            "providers": ["paddleocr-vl"],
            "configurationSha256": hashlib.sha256(
                json.dumps(
                    raw_result["configuration"],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
            "geometrySha256": SEAL._canonical_geometry_sha256(raw_result["hints"]),
            "sourceBinding": {
                "status": "ready",
                "expected": {
                    "pageId": page_id,
                    "sourcePageId": page_id,
                    "sourcePageSha256": source_sha,
                    "imagePath": str(original.resolve()),
                    "width": 16,
                    "height": 24,
                },
                "actual": {
                    "requestedPageId": page_id,
                    "imagePath": str(original.resolve()),
                    "imageSha256": source_sha,
                    "width": 16,
                    "height": 24,
                    "resultPath": str(raw_result_path.resolve()),
                },
                "pageIdMatches": True,
                "imagePathMatches": True,
                "sha256Matches": True,
                "dimensionsMatch": True,
            },
        }
        geometry_audit = {
            "contractVersion": "font-matching-ocr-geometry-replay-v1",
            **(
                {"freshBaselineSeal": dict(self.cache_seal_identity)}
                if replay and self.cache_seal_identity is not None
                else {}
            ),
            "rawArtifactStatus": "ready",
            "rawArtifacts": [raw_artifact],
            "fontInputBinding": {
                "status": "ready",
                "path": str(font_input.resolve()),
                "sha256": sha256_file(font_input),
                "providedBlockInventoryMatches": True,
                "expected": {
                    "requestedPageId": page_id,
                    "sourcePageId": page_id,
                    "pageId": page_id,
                    "sourcePageSha256": source_sha,
                    "imagePath": str(original.resolve()),
                    "width": 16,
                    "height": 24,
                },
            },
            "rawHintCount": 1,
            "blockCount": 1,
            "resolvedBlockCount": 1,
            "rawResolvedBlockCount": 1,
            "existingEvidenceResolvedBlockCount": 0,
            "missingBlockCount": 0,
        }
        write_json(
            font_inference,
            {
                "elapsedMs": 3,
                "qaPageRelativeRoleReroute": replay,
                "requestBlocks": request_blocks,
                "runtimeArtifactStatus": {
                    "state": "ready",
                    "automaticMutationAllowed": True,
                },
                "pixelInference": [
                    {
                        "blockId": block_id,
                        "kind": "verified_pixel_inference",
                        "pageId": page_id,
                        "inputBoundary": dict(SEAL.EVALUATION_INFERENCE_BOUNDARY),
                    }
                ],
                **({"sourceGeometryDirectionReplay": geometry_audit} if replay else {}),
            },
        )
        return {
            "selectionIndex": index,
            "sourcePageId": page_id,
            "sourcePageName": original.name,
            "sourcePageSha256": source_sha,
            "workId": f"work-{index + 1}",
            "workTitle": f"작품 {index + 1}",
            "chapterId": f"chapter-{index + 1}",
            "chapterTitle": "1화",
            "status": "completed",
            "stage": "done",
            "mode": "font-replay-cache" if replay else "full",
            "fontInferenceSource": "live" if replay else None,
            "blockCount": 1,
            "blocksErased": 1,
            "blocksIncomplete": 0,
            "stagedOriginalImagePath": str(original.resolve()),
            "cleanedImagePath": str(cleaned.resolve()),
            "renderedImagePath": str(rendered.resolve()),
            "renderedImageSha256": sha256_file(rendered),
            "fontInputPath": str(font_input.resolve()),
            "fontInferencePath": str(font_inference.resolve()),
            "fontDecisions": [decision],
            **({"sourceGeometryDirectionReplay": geometry_audit} if replay else {}),
        }

    def _cohort_record(self, index: int, page: dict[str, Any]) -> dict[str, Any]:
        original = Path(page["stagedOriginalImagePath"])
        return {
            "schemaVersion": 1,
            "cohort": "baseline40",
            "selectionIndex": index,
            "work": {"id": page["workId"], "title": page["workTitle"], "index": index},
            "chapter": {
                "id": page["chapterId"],
                "title": page["chapterTitle"],
                "index": 0,
                "jsonPath": str((original.parent / "chapter.json").resolve()),
                "jsonSha256": "c" * 64,
            },
            "page": {
                "id": page["sourcePageId"],
                "name": page["sourcePageName"],
                "index": index,
                "imagePath": str(original.resolve()),
                "imageRelativePath": f"works/{page['workId']}/{original.name}",
                "imageSha256": page["sourcePageSha256"],
                "imageSizeBytes": original.stat().st_size,
                "width": 16,
                "height": 24,
                "existingBlockCount": 1,
                "variantSignalCount": 1,
                "variantSignals": {"strongTotal": 1, "total": 1},
            },
            "inferenceBoundary": dict(SEAL.EVALUATION_INFERENCE_BOUNDARY),
        }

    def write_selection(self) -> None:
        source_sha = sha256_file(self.source_boundary_path)
        work_sha = sha256_file(self.work_boundary_path)
        source_page_ids = {
            record.get("page", {}).get("id")
            for record in self.source_boundary_records
            if record.get("page", {}).get("id")
        }
        source_paths = {
            SEAL._normalize_relative_path(
                record.get("page", {}).get("imageRelativePath")
            )
            for record in self.source_boundary_records
            if record.get("page", {}).get("imageRelativePath")
        }
        source_hashes = {
            record["source_page_sha256"].lower()
            for record in self.source_boundary_records
            if isinstance(record.get("source_page_sha256"), str)
        }
        work_ids = {record["work_id"] for record in self.work_boundary_records}
        selection = {
            "schemaVersion": 1,
            "sourceBoundary": {
                "policy": SEAL.SOURCE_BOUNDARY_POLICY,
                "fileCount": 1,
                "recordsRead": len(self.source_boundary_records),
                "excludedPageIds": len(source_page_ids),
                "excludedRelativePaths": len(source_paths),
                "excludedSourcePageSha256s": len(source_hashes),
                "bindingSha256": boundary_binding(self.source_boundary_path),
                "files": [
                    {
                        "path": str(self.source_boundary_path.resolve()),
                        "sizeBytes": self.source_boundary_path.stat().st_size,
                        "sha256": source_sha,
                        "recordsRead": len(self.source_boundary_records),
                    }
                ],
            },
            "workBoundary": {
                "policy": SEAL.WORK_BOUNDARY_POLICY,
                "fileCount": 1,
                "recordsRead": len(self.work_boundary_records),
                "excludedWorkCount": len(work_ids),
                "bindingSha256": boundary_binding(self.work_boundary_path),
                "files": [
                    {
                        "path": str(self.work_boundary_path.resolve()),
                        "sizeBytes": self.work_boundary_path.stat().st_size,
                        "sha256": work_sha,
                        "recordsRead": len(self.work_boundary_records),
                    }
                ],
            },
            "cohorts": {
                "baseline40": {
                    "manifestPath": str(self.manifest_path.resolve()),
                    "manifestSha256": sha256_file(self.manifest_path),
                    "pages": len(self.cohort_records),
                }
            },
        }
        write_json(self.selection_path, selection)

    def write(self) -> None:
        write_json(self.report_path, self.report)
        write_json(self.config_path, self.config)


class SealLibraryFullPipelineFontQaRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_seals_and_revalidates_fresh_uncached_gemma_run(self) -> None:
        fixture = RunFixture(self.root)
        output = self.root / "seals" / "fresh-audit.json"
        result = SEAL.seal_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                expected_candidate_id="r3h-fresh-gemma-v1",
            ),
            output,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(1, result["singleDayApplied"])
        self.assertEqual(1, result["singleDayBodyRoleApplied"])
        validated = SEAL.validate_audit(output)
        self.assertEqual(result["auditSha256"], validated["auditSha256"])
        audit = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(SEAL.EXPECTED_PAGES, audit["runIdentity"]["pageCount"])
        self.assertEqual("live_full_pipeline", audit["execution"]["fontInferenceMode"])
        self.assertFalse(audit["dataUsePolicy"]["trainingLabelsAllowed"])
        self.assertEqual(
            SEAL.EXPECTED_PAGES, audit["outlineStats"]["appliedDecisionsValidated"]
        )
        self.assertEqual(
            SEAL.EXPECTED_PAGES, audit["artifactStats"]["font_inference_json"]["files"]
        )
        self.assertEqual(
            SEAL.EXPECTED_PAGES, audit["artifactStats"]["raw_ocr_result_json"]["files"]
        )
        self.assertEqual(
            SEAL.EXPECTED_PAGES,
            audit["artifactStats"]["translation_attempt_result_json"]["files"],
        )
        self.assertTrue(audit["targetLanguageEvidence"]["allPagesProven"])
        self.assertEqual(
            "explicit_ko",
            audit["targetLanguageEvidence"]["configTargetLanguageState"],
        )
        self.assertTrue(audit["rawOcrStats"]["allPagesReady"])
        for page in audit["pages"]:
            kinds = [artifact["kind"] for artifact in page["artifacts"]]
            self.assertEqual(1, kinds.count("font_input_json"))
            self.assertGreaterEqual(kinds.count("raw_ocr_result_json"), 1)
        self.assertEqual(
            {"pageId": 0, "relativePath": 0, "sourceSha256": 0, "workId": 0},
            audit["cohortIsolation"]["overlapCounts"],
        )

    def test_accepts_v11_boundary_policy_pair_and_rejects_mixed_pair(self) -> None:
        fixture = RunFixture(self.root)
        selection = json.loads(fixture.selection_path.read_text(encoding="utf-8"))
        selection["sourceBoundary"]["policy"] = SEAL.V11_SOURCE_BOUNDARY_POLICY
        selection["workBoundary"]["policy"] = SEAL.V11_WORK_BOUNDARY_POLICY
        write_json(fixture.selection_path, selection)
        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            )
        )
        self.assertEqual(
            {"pageId": 0, "relativePath": 0, "sourceSha256": 0, "workId": 0},
            audit["cohortIsolation"]["overlapCounts"],
        )

        selection["workBoundary"]["policy"] = SEAL.WORK_BOUNDARY_POLICY
        write_json(fixture.selection_path, selection)
        with self.assertRaisesRegex(SEAL.RunSealError, "policies are incompatible"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_historical_config_without_target_language_requires_bound_ko_results(
        self,
    ) -> None:
        fixture = RunFixture(self.root)
        fixture.config.pop("targetLanguage")
        fixture.write()
        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            )
        )
        self.assertEqual(
            "historical_absent_bound_by_attempt_results",
            audit["targetLanguageEvidence"]["configTargetLanguageState"],
        )
        self.assertEqual(
            SEAL.EXPECTED_PAGES,
            audit["targetLanguageEvidence"]["attemptArtifacts"],
        )

        first_page_id = fixture.pages[0]["sourcePageId"]
        result_path = (
            fixture.run_dir
            / "analysis"
            / "job-a"
            / "run"
            / "pages"
            / first_page_id
            / "attempt-1"
            / "result.json"
        )
        result = json.loads(result_path.read_text(encoding="utf-8"))
        result["requestSummary"]["options"]["targetLanguage"] = "en"
        write_json(result_path, result)
        with self.assertRaisesRegex(SEAL.RunSealError, "does not prove ja->ko"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_zero_block_page_requires_no_text_evidence_and_no_translation_attempt(
        self,
    ) -> None:
        fixture = RunFixture(self.root)
        page = fixture.pages[0]
        page["blockCount"] = 0
        page["blocksErased"] = 0
        page["fontDecisions"] = []
        inference_path = Path(page["fontInferencePath"])
        inference_path.unlink()
        page["fontInferencePath"] = None
        font_input_path = Path(page["fontInputPath"])
        font_input = json.loads(font_input_path.read_text(encoding="utf-8"))
        font_input["page"]["blocks"] = []
        font_input["requestBlocks"] = []
        write_json(font_input_path, font_input)
        raw_path = (
            fixture.run_dir
            / "analysis"
            / "job-a"
            / "ocr-hints"
            / page["sourcePageId"]
            / "result.json"
        )
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        raw["hints"] = []
        raw["noTextDetected"] = True
        write_json(raw_path, raw)
        translation_path = (
            fixture.run_dir
            / "analysis"
            / "job-a"
            / "run"
            / "pages"
            / page["sourcePageId"]
            / "attempt-1"
            / "result.json"
        )
        translation_path.unlink()
        fixture.cohort_records[0]["page"]["existingBlockCount"] = 0
        write_jsonl(fixture.manifest_path, fixture.cohort_records)
        fixture.report["cohortDigest"] = sha256_file(fixture.manifest_path)
        fixture.config["cohortDigest"] = fixture.report["cohortDigest"]
        fixture.write_selection()
        fixture.write()

        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            )
        )
        self.assertEqual(39, audit["targetLanguageEvidence"]["translatedPages"])
        self.assertEqual(1, audit["targetLanguageEvidence"]["zeroBlockPages"])
        self.assertEqual(39, audit["artifactStats"]["font_inference_json"]["files"])
        self.assertEqual(
            "not_applicable_zero_blocks", audit["pages"][0]["fontTrace"]["runtimeState"]
        )

        raw["noTextDetected"] = False
        write_json(raw_path, raw)
        with self.assertRaisesRegex(SEAL.RunSealError, "without raw no-text evidence"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_profiles_reject_any_non_40_page_override(self) -> None:
        fixture = RunFixture(self.root, page_count=2)
        with self.assertRaisesRegex(SEAL.RunSealError, "exactly 40"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                    expected_pages=2,
                )
            )

    def test_rejects_fresh_run_with_cache_or_non_gemma_provider(self) -> None:
        fixture = RunFixture(self.root)
        fixture.report["cacheFrom"] = str(fixture.cache_dir.resolve())
        fixture.config["cacheFrom"] = str(fixture.cache_dir.resolve())
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "cacheFrom=null"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )
        fixture.report["cacheFrom"] = None
        fixture.config["cacheFrom"] = None
        fixture.report["provider"] = "openai-api"
        fixture.config["provider"] = "openai-api"
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "provider=gemma"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_requires_live_font_inference_on_every_replay_page(self) -> None:
        fixture = RunFixture(self.root, replay=True)
        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                expected_candidate_id="v2c",
                expected_cache_from=fixture.cache_dir,
            )
        )
        self.assertEqual("live_all_pages", audit["execution"]["fontInferenceMode"])

        fixture.report["pages"][1]["fontInferenceSource"] = "cached"
        fixture.report["cache"]["fontInference"]["mode"] = "required"
        fixture.report["cache"]["fontInference"]["reusedPageIds"] = ["page-2"]
        fixture.config["fontInferenceCacheMode"] = "required"
        fixture.write()
        with self.assertRaisesRegex(
            SEAL.RunSealError, "forbids --reuse-cached-font-inference"
        ):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

    def test_rejects_cached_or_wrong_reroute_trace_and_wrong_file_type(self) -> None:
        fixture = RunFixture(self.root, replay=True)
        trace_path = Path(fixture.pages[0]["fontInferencePath"])
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        trace["cacheReuse"] = {"sourceTracePath": "cached.json"}
        write_json(trace_path, trace)
        with self.assertRaisesRegex(SEAL.RunSealError, "restored from cache"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

        trace.pop("cacheReuse")
        trace["qaPageRelativeRoleReroute"] = False
        write_json(trace_path, trace)
        with self.assertRaisesRegex(SEAL.RunSealError, "reroute flag"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

        fixture.pages[0]["fontInferencePath"] = fixture.pages[0]["fontInputPath"]
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "paths are identical"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

    def test_pixel_inference_may_only_omit_exact_fail_closed_abstentions(self) -> None:
        fixture = RunFixture(self.root)
        page = fixture.pages[0]
        trace_path = Path(page["fontInferencePath"])
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        trace["pixelInference"] = []
        write_json(trace_path, trace)
        decision = page["fontDecisions"][0]
        decision.update(
            {
                "applied": False,
                "selectedFontId": None,
                "source": None,
                "confidence": None,
                "selectionCalibration": None,
                "localConfidence": None,
                "noneAcceptable": None,
                "top5": [],
            }
        )
        fixture.write()
        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            )
        )
        self.assertEqual(1, audit["pages"][0]["fontTrace"]["pixelInferenceAbstentions"])

        decision["source"] = "unverified_default"
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "exact pixel-abstention"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_rejects_source_and_work_boundary_overlap(self) -> None:
        source_fixture = RunFixture(self.root / "source", source_overlap=True)
        with self.assertRaisesRegex(SEAL.RunSealError, "overlaps a sealed"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=source_fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )
        work_fixture = RunFixture(self.root / "work", work_overlap=True)
        with self.assertRaisesRegex(SEAL.RunSealError, "overlaps a sealed"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=work_fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_fresh_requires_raw_ocr_ready_and_replay_rejects_raw_tamper(self) -> None:
        fresh = RunFixture(self.root / "missing")
        raw_path = (
            fresh.run_dir
            / "analysis"
            / "job-a"
            / "ocr-hints"
            / fresh.pages[0]["sourcePageId"]
            / "result.json"
        )
        raw_path.unlink()
        with self.assertRaisesRegex(
            SEAL.RunSealError, "requires raw OCR provenance status=ready"
        ):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fresh.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

        replay = RunFixture(self.root / "tamper", replay=True)
        replay_raw_path = Path(
            replay.pages[0]["sourceGeometryDirectionReplay"]["rawArtifacts"][0]["path"]
        )
        raw = json.loads(replay_raw_path.read_text(encoding="utf-8"))
        raw["hints"][0]["x2"] = 9
        write_json(replay_raw_path, raw)
        with self.assertRaisesRegex(
            SEAL.RunSealError,
            "Fresh baseline seal is invalid|disagrees with source artifact",
        ):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=replay.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=replay.cache_dir,
                )
            )

    def test_replay_recomputes_geometry_summary_instead_of_trusting_report(
        self,
    ) -> None:
        fixture = RunFixture(self.root, replay=True)
        fixture.report["cache"]["sourceGeometryDirectionReplay"][
            "rawReadyPageCount"
        ] = 39
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "summary is stale"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

    def test_replay_trace_cannot_substitute_another_fresh_baseline_seal(
        self,
    ) -> None:
        fixture = RunFixture(self.root, replay=True)
        trace_path = Path(fixture.pages[0]["fontInferencePath"])
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        trace["sourceGeometryDirectionReplay"]["freshBaselineSeal"]["sha256"] = "f" * 64
        fixture.report["pages"][0]["sourceGeometryDirectionReplay"] = trace[
            "sourceGeometryDirectionReplay"
        ]
        write_json(trace_path, trace)
        fixture.write()
        with self.assertRaisesRegex(
            SEAL.RunSealError, "configured fresh baseline seal"
        ):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

    def test_rejects_manifest_or_boundary_drift(self) -> None:
        fixture = RunFixture(self.root / "manifest")
        fixture.manifest_path.write_text(
            fixture.manifest_path.read_text(encoding="utf-8") + "\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(SEAL.RunSealError, "manifest digest drifted"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )
        boundary_fixture = RunFixture(self.root / "boundary")
        boundary_fixture.source_boundary_path.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(SEAL.RunSealError, "SHA-256 mismatch"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=boundary_fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_rejects_unknown_single_day_role(self) -> None:
        fixture = RunFixture(self.root)
        fixture.report["pages"][0]["fontDecisions"][0]["role"] = None
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "unknown applied font role"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_rejects_replay_cache_source_run_mismatch(self) -> None:
        fixture = RunFixture(self.root, replay=True)
        fixture.report["cache"]["sourceRun"] = str(
            (self.root / "other-cache").resolve()
        )
        fixture.write()
        with self.assertRaisesRegex(SEAL.RunSealError, "cache.sourceRun"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=fixture.report_path,
                    profile=SEAL.PROFILE_LIVE_FONT_REPLAY,
                    expected_cache_from=fixture.cache_dir,
                )
            )

    def test_white_on_black_outline_passes_but_zero_width_fails(self) -> None:
        fixture = RunFixture(self.root / "white")
        decision = fixture.report["pages"][0]["fontDecisions"][0]
        decision["effectiveTextColor"] = "#ffffff"
        decision["effectiveOutlineColor"] = "#000000"
        decision["effectiveOutlineContrastRatio"] = 21.0
        fixture.write()
        audit = SEAL.build_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            )
        )
        self.assertEqual(21.0, audit["outlineStats"]["contrastRatio"]["maximum"])

        zero_fixture = RunFixture(self.root / "zero")
        zero_fixture.report["pages"][0]["fontDecisions"][0][
            "effectiveOutlineWidthScale"
        ] = 0
        zero_fixture.write()
        with self.assertRaisesRegex(Exception, "finite number > 0"):
            SEAL.build_audit(
                SEAL.SealOptions(
                    report_path=zero_fixture.report_path,
                    profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
                )
            )

    def test_validation_detects_bound_artifact_drift(self) -> None:
        fixture = RunFixture(self.root)
        output = self.root / "fresh-audit.json"
        SEAL.seal_audit(
            SEAL.SealOptions(
                report_path=fixture.report_path,
                profile=SEAL.PROFILE_FRESH_GEMMA_FULL,
            ),
            output,
        )
        Path(fixture.pages[0]["renderedImagePath"]).write_bytes(b"drift")
        with self.assertRaisesRegex(SEAL.RunSealError, "drifted"):
            SEAL.validate_audit(output)


if __name__ == "__main__":
    unittest.main()
