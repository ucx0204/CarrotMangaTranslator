from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


PROMOTE = load_module(
    "promote_font_matching_qa_runtime_release_tested",
    ROOT / "scripts" / "promote_font_matching_qa_runtime_release.py",
)
ATTACH_TEST = load_module(
    "attach_font_matching_selection_calibration_fixture",
    ROOT / "tests" / "python" / "test_attach_font_matching_selection_calibration.py",
)


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PROMOTE.attach.json_bytes(value, pretty=True))


def write_jsonl(path: Path, rows: list[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(PROMOTE.attach.json_bytes(row) for row in rows))


def file_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): PROMOTE.attach.sha256_file(path)
        for path in root.rglob("*")
        if path.is_file()
    }


def embedded_descriptor_files(value: Any) -> list[str]:
    files: list[str] = []
    if isinstance(value, Mapping):
        if set(value) == {"byte_size", "file", "sha256"}:
            files.append(str(value["file"]))
        for child in value.values():
            files.extend(embedded_descriptor_files(child))
    elif isinstance(value, list):
        for child in value:
            files.extend(embedded_descriptor_files(child))
    return files


class QaRuntimeFixture:
    def __init__(self, root: Path) -> None:
        fixture = ATTACH_TEST.Fixture(root / "runtime-fixture")
        fixture.candidate_ids = PROMOTE.r5_eval._active_ids()  # noqa: SLF001
        fixture._write_runtime()  # noqa: SLF001
        contract_path = fixture.runtime / PROMOTE.attach.CONTRACT_FILE
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract.pop("record_sha256", None)
        contract["schema_version"] = PROMOTE.attach.RUNTIME_SCHEMA_VERSION_V2
        contract["hybrid_score_routing"] = ATTACH_TEST.hybrid_routing()
        contract["runtime_batching"] = {
            "encoder_batch_size": 2,
            "ranker_batch_size": 16,
            "parity_qualified": True,
        }
        contract["head"] = {
            **contract["head"],
            "body_checkpoint_sha256": "1" * 64,
            "variant_checkpoint_sha256": "1" * 64,
        }
        contract["calibration"] = {
            "calibration_split": "val",
            "none_threshold": 0.2,
            "none_threshold_selection_metric": "fixture",
            "temperature": 0.75,
            "temperature_selection_metric": "fixture",
        }
        contract["deployment"] = {
            "automatic_mutation_allowed": True,
            "fail_closed": True,
            "fallback_policy": {
                "automatic_profile_without_pixel_model": "forbidden",
                "invalid_artifact": "explicit_disabled",
                "manual_user_lock": "allowed",
                "missing_artifact": "explicit_disabled",
                "semantic_bootstrap": "forbidden",
            },
            "state": "ready",
        }
        write_json(contract_path, PROMOTE.attach.seal_record(contract))
        fixture._rewrite_marker()  # noqa: SLF001
        marker_path = fixture.runtime / PROMOTE.attach.MARKER_FILE
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["owner"] = PROMOTE.attach.RUNTIME_OWNER_V2
        marker["schema_version"] = PROMOTE.attach.RUNTIME_SCHEMA_VERSION_V2
        write_json(marker_path, marker)

        v1 = fixture.calibration_record()
        points = copy.deepcopy(v1["operating_points"])
        for point in points.values():
            point["precision_target"] = 0.99
            point["precision_target_passed"] = False
            point["risk_lcb"] = 0.1
        points["global"]["preferred_at1"] = 0.44
        points["variant"]["preferred_at1"] = 0.49
        raw_top1_sha = PROMOTE.attach.sha256_bytes(b"fixture-raw-top1")
        rank_preserving = PROMOTE.attach._load_rank_preserving_calibration_validator()  # noqa: SLF001
        v2 = PROMOTE.attach.seal_record(
            {
                "bindings": v1["bindings"],
                "candidate_ids": list(fixture.candidate_ids),
                "confidence_calibration": {
                    "c": 0.1,
                    "coef": [0.2, -0.3],
                    "feature_names": list(rank_preserving.FEATURE_NAMES),
                    "intercept": 0.4,
                    "schema_version": rank_preserving.CONFIDENCE_SCHEMA,
                    "sigmoid": rank_preserving.SIGMOID,
                },
                "leakage_audit": {
                    "allowed_split": "val",
                    "candidate_reranking": False,
                    "hybrid_score_route_source": (
                        "pixel_shared_scores_role_downstream_only"
                    ),
                    "non_val_label_rows_parsed": 0,
                    "pixel_only_confidence_features": True,
                    "pseudo_label_rows_used_for_fit": 0,
                    "semantic_feature_count": 0,
                    "test_rows_used_for_fit": 0,
                    "train_rows_used_for_fit": 0,
                },
                "oof_report": {
                    "confidence_log_loss": 0.4,
                    "confidence_roc_auc": 0.7,
                    "final_C": 0.1,
                    "fit_implementation": {},
                    "folds": [],
                    "full_oof": copy.deepcopy(points),
                    "nested_operating_evaluation": copy.deepcopy(points),
                    "rank_preservation": {
                        "calibrated_top1_sha256": raw_top1_sha,
                        "changed_top1_count": 0,
                        "evaluated_sample_count": 70,
                        "exact_top1_agreement": 1.0,
                        "raw_top1_sha256": raw_top1_sha,
                    },
                    "selected_C_values": [0.1],
                },
                "operating_points": copy.deepcopy(points),
                "ranking_policy": copy.deepcopy(rank_preserving.RANKING_POLICY),
                "record_type": rank_preserving.RECORD_TYPE,
                "schema_version": rank_preserving.SCHEMA_VERSION,
                "training_boundary": {
                    "raw_top1_sha256": raw_top1_sha,
                    "split": "val",
                    "supervision": {"pseudo_labels_forbidden": True},
                },
            }
        )
        write_json(fixture.calibration, v2)
        fixture.attach(qa_only=True)
        self.root = fixture.output


class CompletedQaRun:
    def __init__(
        self,
        root: Path,
        *,
        cohort: str,
        runtime: Path,
        start_hour: int,
    ) -> None:
        self.cohort = cohort
        self.run_dir = root / f"{cohort}-run"
        self.report_path = self.run_dir / "run-report.json"
        self.pack_dir = root / f"{cohort}-visual-pack"
        contract = json.loads(
            (runtime / PROMOTE.attach.CONTRACT_FILE).read_text(encoding="utf-8")
        )
        catalog = contract["catalog"]
        pages: list[dict[str, Any]] = []
        manifest_rows: list[dict[str, Any]] = []
        cohort_color_offset = 0 if cohort == "baseline40" else 97
        for index in range(PROMOTE.EXPECTED_PAGES):
            prefix = "base" if cohort == "baseline40" else "hold"
            page_id = f"{prefix}-page-{index:02d}"
            work_id = f"work-{index % 5:02d}"
            chapter_id = f"{prefix}-chapter-{index:02d}"
            page_dir = self.run_dir / "pages" / f"{index + 1:02d}"
            original = page_dir / "original.png"
            rendered = page_dir / "rendered.png"
            original.parent.mkdir(parents=True, exist_ok=True)
            Image.new(
                "RGB",
                (64, 96),
                ((index * 3 + cohort_color_offset) % 255, 240, 230),
            ).save(original)
            Image.new(
                "RGB",
                (64, 96),
                (230, (index * 5 + cohort_color_offset) % 255, 240),
            ).save(rendered)
            source_sha = PROMOTE.attach.sha256_file(original)
            rendered_sha = PROMOTE.attach.sha256_file(rendered)
            font_input = page_dir / "font-input.json"
            font_inference = page_dir / "font-inference.json"
            block_id = f"{page_id}-block-0"
            write_json(
                font_input,
                {
                    "schemaVersion": 1,
                    "sourcePageId": page_id,
                    "sourcePageSha256": source_sha,
                    "page": {"blocks": [{"id": block_id}]},
                    "requestBlocks": [{"blockId": block_id, "item": {}}],
                },
            )
            write_json(
                font_inference,
                {
                    "elapsedMs": 1,
                    "requestBlocks": [],
                    "runtimeArtifactStatus": {
                        "state": "ready",
                        "automaticMutationAllowed": True,
                        "semanticBootstrapAllowed": False,
                        "modelVersion": contract["model_version"],
                        "catalogVersion": catalog["catalog_version"],
                        "candidateIds": catalog["candidate_ids"],
                        "candidateOrderSha256": catalog["candidate_order_sha256"],
                        "calibration": {
                            "temperature": contract["calibration"]["temperature"],
                            "noneThreshold": contract["calibration"]["none_threshold"],
                        },
                    },
                    "pixelInference": [
                        {
                            "blockId": block_id,
                            "candidateOrderSha256": catalog["candidate_order_sha256"],
                            "kind": "verified_pixel_inference",
                            "modelVersion": contract["model_version"],
                            "pageId": page_id,
                        }
                    ],
                },
            )
            decision = {
                "applied": True,
                "bbox": {"h": 200, "w": 300, "x": 100, "y": 100},
                "blockId": block_id,
                "blockIndex": 0,
                "confidence": 0.9,
                "effectiveFontFamily": catalog["candidate_ids"][0],
                "effectiveOutlineColor": "#ffffff",
                "effectiveOutlineContrastRatio": 18.883060964595,
                "effectiveOutlineWidthScale": 0.5,
                "effectiveTextColor": "#111111",
                "localConfidence": 0.9,
                "noneAcceptable": False,
                "role": "dialogue",
                "selectedFontId": catalog["candidate_ids"][0],
                "selectionCalibration": {"applied": True},
                "source": "local_visual",
                "sourceText": "テスト",
                "top5": [],
                "translatedText": "테스트",
            }
            pages.append(
                {
                    "blockCount": 1,
                    "chapterId": chapter_id,
                    "chapterTitle": f"{index + 1}화",
                    "cleanedImagePath": str(original),
                    "fontDecisions": [decision],
                    "fontInferencePath": str(font_inference),
                    "fontInputPath": str(font_input),
                    "mode": "font-replay-cache",
                    "renderedImagePath": str(rendered),
                    "renderedImageSha256": rendered_sha,
                    "selectionIndex": index,
                    "sourcePageId": page_id,
                    "sourcePageName": f"{index + 1:03d}.png",
                    "sourcePageSha256": source_sha,
                    "stage": "done",
                    "stagedOriginalImagePath": str(original),
                    "status": "completed",
                    "workId": work_id,
                    "workTitle": f"작품 {index % 5}",
                }
            )
            manifest_rows.append(
                {
                    "chapter": {"id": chapter_id, "title": f"{index + 1}화"},
                    "cohort": cohort,
                    "inferenceBoundary": {
                        "datasetSplit": None,
                        "qaOverlay": False,
                        "source": "user_page",
                    },
                    "page": {
                        "id": page_id,
                        "imageSha256": source_sha,
                        "name": f"{index + 1:03d}.png",
                    },
                    "schemaVersion": 1,
                    "selectionIndex": index,
                    "work": {"id": work_id, "title": f"작품 {index % 5}"},
                }
            )
        manifest = root / "cohorts" / f"{cohort}.jsonl"
        write_jsonl(manifest, manifest_rows)
        digest = PROMOTE.attach.sha256_file(manifest)
        started = f"2026-08-03T{start_hour:02d}:00:00+00:00"
        finished = f"2026-08-03T{start_hour:02d}:10:00+00:00"
        self.report = {
            "candidateId": "fixture-active21",
            "candidateRuntimeDir": str(runtime),
            "cohort": cohort,
            "cohortDigest": digest,
            "finishedAt": finished,
            "pageCount": PROMOTE.EXPECTED_PAGES,
            "pages": pages,
            "runId": f"{cohort}-fixture-run",
            "schemaVersion": 1,
            "startedAt": started,
            "status": "completed",
        }
        write_json(self.report_path, self.report)
        write_json(
            self.run_dir / "run-config.json",
            {
                "allowHoldout": cohort == "holdout40",
                "allowQaOnlyRuntime": True,
                "candidateId": self.report["candidateId"],
                "cohort": cohort,
                "cohortDigest": digest,
                "execute": True,
                "manifestPath": str(manifest),
                "pageLimit": None,
                "preflightOnly": False,
                "qaOnlyRuntime": True,
                "runtimeDir": str(runtime),
            },
        )
        PROMOTE.visual_pack.build_review(
            PROMOTE.visual_pack.BuildOptions(
                report_path=self.report_path,
                output_dir=self.pack_dir,
                expected_pages=PROMOTE.EXPECTED_PAGES,
                pair_page_max_width=256,
                pair_page_max_height=256,
                blocks_per_sheet=20,
                crop_padding_ratio=0.1,
            )
        )

    def write_accepts(self, path: Path, *, reviewed_at: str) -> None:
        validation = PROMOTE.visual_pack.validate_review(self.pack_dir)
        rows = []
        for index, page in enumerate(self.report["pages"]):
            rows.append(
                PROMOTE.attach.seal_record(
                    {
                        "chapter_id": page["chapterId"],
                        "notes": "직접 좌우 비교 확인",
                        "record_type": PROMOTE.PAGE_VERDICT_ROW_RECORD,
                        "schema_version": PROMOTE.PAGE_VERDICT_ROW_SCHEMA,
                        "selection_index": index,
                        "source_page_id": page["sourcePageId"],
                        "source_page_sha256": page["sourcePageSha256"],
                        "verdict": "accept",
                        "work_id": page["workId"],
                    }
                )
            )
        record = PROMOTE.attach.seal_record(
            {
                "automatic_visual_judgment": False,
                "cohort": self.cohort,
                "cohort_sha256": self.report["cohortDigest"],
                "page_count": PROMOTE.EXPECTED_PAGES,
                "pages": rows,
                "record_type": PROMOTE.PAGE_VERDICTS_RECORD,
                "review_method": "manual_visual_inspection",
                "reviewed_at": reviewed_at,
                "reviewer": "fixture-human-reviewer",
                "run_report_sha256": PROMOTE.attach.sha256_file(self.report_path),
                "schema_version": PROMOTE.PAGE_VERDICTS_SCHEMA,
                "visual_review_binding_sha256": validation["bindingSha256"],
                "visual_review_index_sha256": validation["indexSha256"],
            }
        )
        write_json(path, record)


def evaluation_row(
    *, epoch: int, sample: str, cohort: str, kind: str
) -> dict[str, Any]:
    improved = epoch == 1 and kind == "correction"
    baseline = {
        "acceptable_at1": False,
        "acceptable_at3": True,
        "selected_at1": False,
        "selected_at3": True,
        "top1_font_id": "font-before",
    }
    candidate = {
        "acceptable_at1": improved,
        "acceptable_at3": True,
        "selected_at1": improved,
        "selected_at3": True,
        "top1_font_id": "font-after" if improved else "font-before",
    }
    return PROMOTE.r5_eval.seal_record(
        {
            "baseline": baseline,
            "candidate": candidate,
            "cohort": cohort,
            "comparison_outcome": ("improved" if improved else "same"),
            "confirmed_baseline_top1_retained": (True if kind == "confirmed" else None),
            "decision_kind": kind,
            "evaluation_authority": PROMOTE.r5_eval.QA_AUTHORITY,
            "record_type": "manga_font_r5_qa_snapshot_comparison_row",
            "role": "dialogue",
            "sample_id": f"{sample}-epoch-{epoch}",
            "schema_version": PROMOTE.r5_eval.ROW_SCHEMA,
            "snapshot_epoch": epoch,
            "snapshot_sha256": ("0" if epoch == 0 else "1") * 64,
            "source_category": "bubble_edge",
            "split": "val",
            "training_eligible": False,
        }
    )


def build_r5_evaluation(root: Path) -> None:
    root.mkdir(parents=True)
    all_rows: list[dict[str, Any]] = []
    metric_rows: list[dict[str, Any]] = []
    candidate_ids = list(PROMOTE.r5_eval._active_ids())  # noqa: SLF001
    for epoch in (0, 1):
        rows = [
            evaluation_row(
                epoch=epoch,
                sample="abcd-confirmed",
                cohort="abcd_heldout",
                kind="confirmed",
            ),
            evaluation_row(
                epoch=epoch,
                sample="abcd-correction",
                cohort="abcd_heldout",
                kind="correction",
            ),
            evaluation_row(
                epoch=epoch,
                sample="post-confirmed",
                cohort=PROMOTE.r5_eval.POST_CUTOFF_COHORT,
                kind="confirmed",
            ),
            evaluation_row(
                epoch=epoch,
                sample="post-correction",
                cohort=PROMOTE.r5_eval.POST_CUTOFF_COHORT,
                kind="correction",
            ),
        ]
        all_rows.extend(rows)
        snapshot = {
            "candidate_ids": candidate_ids,
            "epoch": epoch,
            "file": f"epoch-{epoch:03d}-head.safetensors",
            "purpose": PROMOTE.r5_eval.SNAPSHOT_PURPOSE,
            "schema_version": "manga-font-v7-mass21-r5-qa-head-snapshot-v1",
            "sha256": ("0" if epoch == 0 else "1") * 64,
        }
        metric_rows.append(
            PROMOTE.r5_eval.seal_record(
                {
                    "authority": PROMOTE.r5_eval.QA_AUTHORITY,
                    "candidate_ids": candidate_ids,
                    "metrics": PROMOTE.r5_eval.compute_metrics(rows),
                    "record_type": "manga_font_r5_qa_snapshot_metric",
                    "row_count": len(rows),
                    "schema_version": PROMOTE.r5_eval.METRIC_SCHEMA,
                    "snapshot": snapshot,
                    "training_eligible": False,
                }
            )
        )
    metrics_path = root / PROMOTE.r5_eval.METRICS_FILE
    rows_path = root / PROMOTE.r5_eval.ROWS_FILE
    write_jsonl(metrics_path, metric_rows)
    write_jsonl(rows_path, all_rows)
    authority = {
        "human_gold": False,
        "independent_gold": False,
        "quality_gate_authority": False,
        "training_eligible": False,
        "visual_review_authority": PROMOTE.r5_eval.QA_AUTHORITY,
    }
    manifest = PROMOTE.r5_eval.seal_record(
        {
            "authority": authority,
            "candidate_ids": candidate_ids,
            "hidden_cache": {"actual_selected_rows_read": 4},
            "record_type": "manga_font_r5_qa_snapshot_evaluation_manifest",
            "row_count_per_snapshot": 4,
            "schema_version": PROMOTE.r5_eval.MANIFEST_SCHEMA,
            "source_code_sha256": PROMOTE.r5_eval.sha256_file(
                Path(PROMOTE.r5_eval.__file__).resolve()
            ),
        }
    )
    manifest_path = root / PROMOTE.r5_eval.MANIFEST_FILE
    write_json(manifest_path, manifest)
    report = PROMOTE.r5_eval.seal_record(
        {
            "artifacts": {
                PROMOTE.r5_eval.MANIFEST_FILE: PROMOTE.r5_eval._descriptor(  # noqa: SLF001
                    manifest_path
                ),
                PROMOTE.r5_eval.METRICS_FILE: PROMOTE.r5_eval._descriptor(  # noqa: SLF001
                    metrics_path, row_count=2
                ),
                PROMOTE.r5_eval.ROWS_FILE: PROMOTE.r5_eval._descriptor(  # noqa: SLF001
                    rows_path, row_count=8
                ),
            },
            "authority": authority,
            "manifest_record_sha256": manifest["record_sha256"],
            "record_type": "manga_font_r5_qa_snapshot_evaluation_report",
            "schema_version": PROMOTE.r5_eval.REPORT_SCHEMA,
        }
    )
    report_path = root / PROMOTE.r5_eval.REPORT_FILE
    write_json(report_path, report)
    marker = PROMOTE.r5_eval.seal_record(
        {
            "manifest_sha256": PROMOTE.r5_eval.sha256_file(manifest_path),
            "owner": PROMOTE.r5_eval.OWNER,
            "report_sha256": PROMOTE.r5_eval.sha256_file(report_path),
            "safe_replace": True,
            "schema_version": PROMOTE.r5_eval.SCHEMA,
        }
    )
    write_json(root / PROMOTE.r5_eval.MARKER_FILE, marker)
    PROMOTE.r5_eval.validate_output(root)


class PromotionFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.runtime = QaRuntimeFixture(root).root
        self.baseline = CompletedQaRun(
            root, cohort="baseline40", runtime=self.runtime, start_hour=0
        )
        self.holdout = CompletedQaRun(
            root, cohort="holdout40", runtime=self.runtime, start_hour=3
        )
        self.baseline_verdicts = root / "baseline-verdicts.json"
        self.holdout_verdicts = root / "holdout-verdicts.json"
        self.baseline.write_accepts(
            self.baseline_verdicts, reviewed_at="2026-08-03T02:00:00+00:00"
        )
        self.holdout.write_accepts(
            self.holdout_verdicts, reviewed_at="2026-08-03T05:00:00+00:00"
        )
        self.eval_e = root / "r5-e"
        self.eval_f = root / "r5-f"
        build_r5_evaluation(self.eval_e)
        build_r5_evaluation(self.eval_f)
        self.provenance = root / "selected-model-provenance.json"
        self.output = root / "release-runtime"
        self.write_provenance()

    def write_provenance(self) -> None:
        runtime = PROMOTE._runtime_identity(self.runtime)  # noqa: SLF001
        baseline_pack = PROMOTE.visual_pack.validate_review(self.baseline.pack_dir)
        holdout_pack = PROMOTE.visual_pack.validate_review(self.holdout.pack_dir)
        baseline_verdict = json.loads(
            self.baseline_verdicts.read_text(encoding="utf-8")
        )
        holdout_verdict = json.loads(self.holdout_verdicts.read_text(encoding="utf-8"))
        e_report = json.loads(
            (self.eval_e / PROMOTE.r5_eval.REPORT_FILE).read_text(encoding="utf-8")
        )
        f_report = json.loads(
            (self.eval_f / PROMOTE.r5_eval.REPORT_FILE).read_text(encoding="utf-8")
        )
        record = PROMOTE.attach.seal_record(
            {
                "automatic_model_selection": False,
                "evidence": {
                    "baseline": {
                        "page_verdicts_record_sha256": baseline_verdict[
                            "record_sha256"
                        ],
                        "run_report_sha256": PROMOTE.attach.sha256_file(
                            self.baseline.report_path
                        ),
                        "visual_review_index_sha256": baseline_pack["indexSha256"],
                    },
                    "holdout": {
                        "page_verdicts_record_sha256": holdout_verdict["record_sha256"],
                        "run_report_sha256": PROMOTE.attach.sha256_file(
                            self.holdout.report_path
                        ),
                        "visual_review_index_sha256": holdout_pack["indexSha256"],
                    },
                    "r5_e": {
                        "report_record_sha256": e_report["record_sha256"],
                        "report_sha256": PROMOTE.attach.sha256_file(
                            self.eval_e / PROMOTE.r5_eval.REPORT_FILE
                        ),
                    },
                    "r5_f": {
                        "report_record_sha256": f_report["record_sha256"],
                        "report_sha256": PROMOTE.attach.sha256_file(
                            self.eval_f / PROMOTE.r5_eval.REPORT_FILE
                        ),
                    },
                },
                "holdout_policy": {
                    "baseline_acceptance_preceded_holdout": True,
                    "explicit_allow_holdout": True,
                },
                "record_type": PROMOTE.SELECTED_MODEL_RECORD,
                "runtime": runtime,
                "schema_version": PROMOTE.SELECTED_MODEL_SCHEMA,
                "selected_at": "2026-08-03T06:00:00+00:00",
                "selected_by": "fixture-release-owner",
                "selected_snapshot": {"epoch": 1, "sha256": "1" * 64},
                "selection_authority": "explicit_manual_selection",
            }
        )
        write_json(self.provenance, record)

    def promote(self) -> Mapping[str, Any]:
        return PROMOTE.promote_runtime(
            qa_runtime=self.runtime,
            baseline_run_report=self.baseline.report_path,
            baseline_visual_pack=self.baseline.pack_dir,
            baseline_page_verdicts=self.baseline_verdicts,
            holdout_run_report=self.holdout.report_path,
            holdout_visual_pack=self.holdout.pack_dir,
            holdout_page_verdicts=self.holdout_verdicts,
            r5_evaluation_e=self.eval_e,
            r5_evaluation_f=self.eval_f,
            selected_model_provenance=self.provenance,
            output_dir=self.output,
        )

    def seal_selection(
        self,
        *,
        output: Path | None = None,
        selected_by: str = "fixture-release-owner",
        minimum_epoch1_retention: float = PROMOTE.DEFAULT_RETENTION_FLOOR,
    ) -> Mapping[str, Any]:
        return PROMOTE.seal_selected_model_provenance(
            qa_runtime=self.runtime,
            baseline_run_report=self.baseline.report_path,
            baseline_visual_pack=self.baseline.pack_dir,
            baseline_page_verdicts=self.baseline_verdicts,
            holdout_run_report=self.holdout.report_path,
            holdout_visual_pack=self.holdout.pack_dir,
            holdout_page_verdicts=self.holdout_verdicts,
            r5_evaluation_e=self.eval_e,
            r5_evaluation_f=self.eval_f,
            selected_by=selected_by,
            output=output or self.provenance,
            minimum_epoch1_retention=minimum_epoch1_retention,
        )


class PromoteFontMatchingQaRuntimeReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = PromotionFixture(Path(self.temp.name) / "release-fixture")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_fixture_smoke_promotes_and_keeps_source_immutable(self) -> None:
        source_before = file_snapshot(self.fixture.runtime)
        source_calibration = json.loads(
            (
                self.fixture.runtime / PROMOTE.attach.SELECTION_CALIBRATION_FILE
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            source_calibration["schema_version"],
            PROMOTE.attach.SELECTION_CALIBRATION_SCHEMA_VERSION_V2,
        )

        result = self.fixture.promote()

        self.assertEqual(source_before, file_snapshot(self.fixture.runtime))
        self.assertTrue(result["release_approved"])
        self.assertFalse(result["qa_only"])
        self.assertTrue(result["external_release_acceptance"])
        self.assertEqual(
            source_before[PROMOTE.attach.SELECTION_CALIBRATION_FILE],
            PROMOTE.attach.sha256_file(
                self.fixture.output / PROMOTE.attach.SELECTION_CALIBRATION_FILE
            ),
        )
        marker = json.loads(
            (self.fixture.output / PROMOTE.attach.MARKER_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(set(marker), set(PROMOTE.attach.MARKER_KEYS))
        contract = json.loads(
            (self.fixture.output / PROMOTE.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            contract["release_acceptance"]["quality_gate"]["manual_page_verdicts"],
            {"accepted": 80, "total": 80},
        )
        self.assertEqual(
            PROMOTE.validate_release_bundle(self.fixture.output)["status"],
            "ready",
        )

    def test_promotion_rejects_missing_zero_and_low_contrast_outlines(self) -> None:
        cases = (
            (
                "missing",
                lambda decision: decision.pop("effectiveOutlineWidthScale"),
                "effectiveOutlineWidthScale must be a finite number > 0",
            ),
            (
                "zero",
                lambda decision: decision.__setitem__(
                    "effectiveOutlineWidthScale", 0
                ),
                "effectiveOutlineWidthScale must be a finite number > 0",
            ),
            (
                "low contrast",
                lambda decision: decision.update(
                    {
                        "effectiveTextColor": "#777777",
                        "effectiveOutlineColor": "#888888",
                    }
                ),
                "effective text/outline contrast .* is below the required 3",
            ),
        )
        for label, mutate, message in cases:
            with self.subTest(case=label):
                report = copy.deepcopy(self.fixture.baseline.report)
                mutate(report["pages"][0]["fontDecisions"][0])
                with self.assertRaisesRegex(
                    PROMOTE.QaRuntimePromotionError, message
                ):
                    PROMOTE._validate_applied_font_decision_outlines(  # noqa: SLF001
                        report, "baseline40"
                    )

    def test_seal_selection_validates_roundtrips_and_redacts_evidence_paths(
        self,
    ) -> None:
        self.fixture.provenance.unlink()

        result = self.fixture.seal_selection(selected_by="fixture-human-selector")

        self.assertEqual(result["status"], "sealed_selected_model_provenance")
        self.assertFalse(result["automatic_model_selection"])
        record = json.loads(self.fixture.provenance.read_text(encoding="utf-8"))
        self.assertEqual(record["selected_by"], "fixture-human-selector")
        self.assertEqual(record["selected_snapshot"], {"epoch": 1, "sha256": "1" * 64})
        PROMOTE.attach.validate_record_seal(record, location="sealed selection")

        before = self.fixture.provenance.read_bytes()
        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "output already exists"
        ):
            self.fixture.seal_selection(selected_by="second-selector")
        self.assertEqual(self.fixture.provenance.read_bytes(), before)

        parsed = PROMOTE._parser().parse_args(  # noqa: SLF001
            [
                "seal-selection",
                "--qa-runtime",
                str(self.fixture.runtime),
                "--baseline-run-report",
                str(self.fixture.baseline.report_path),
                "--baseline-visual-pack",
                str(self.fixture.baseline.pack_dir),
                "--baseline-page-verdicts",
                str(self.fixture.baseline_verdicts),
                "--holdout-run-report",
                str(self.fixture.holdout.report_path),
                "--holdout-visual-pack",
                str(self.fixture.holdout.pack_dir),
                "--holdout-page-verdicts",
                str(self.fixture.holdout_verdicts),
                "--r5-evaluation-e",
                str(self.fixture.eval_e),
                "--r5-evaluation-f",
                str(self.fixture.eval_f),
                "--selected-by",
                "fixture-human-selector",
                "--output",
                str(self.fixture.provenance),
                "--minimum-epoch1-retention",
                "0.96",
            ]
        )
        self.assertEqual(parsed.command, "seal-selection")
        self.assertEqual(parsed.minimum_epoch1_retention, 0.96)

        self.fixture.promote()
        contract = json.loads(
            (self.fixture.output / PROMOTE.attach.CONTRACT_FILE).read_text(
                encoding="utf-8"
            )
        )
        descriptor_files = embedded_descriptor_files(contract["release_acceptance"])
        self.assertGreater(len(descriptor_files), 10)
        private_fragments = {
            str(self.fixture.root).lower(),
            str(Path.home()).lower(),
            str(Path(tempfile.gettempdir())).lower(),
        }
        for logical_file in descriptor_files:
            self.assertFalse(PROMOTE.PureWindowsPath(logical_file).is_absolute())
            self.assertFalse(
                PROMOTE.PurePosixPath(logical_file.replace("\\", "/")).is_absolute()
            )
            for fragment in private_fragments:
                self.assertNotIn(fragment, logical_file.lower())

        repository_descriptor = PROMOTE._descriptor(  # noqa: SLF001
            ROOT / "scripts" / "promote_font_matching_qa_runtime_release.py",
            location="promotion tool",
        )
        self.assertEqual(
            repository_descriptor["file"],
            "scripts/promote_font_matching_qa_runtime_release.py",
        )
        external_descriptor = PROMOTE._descriptor(  # noqa: SLF001
            self.fixture.provenance, location="selected model provenance"
        )
        self.assertRegex(
            external_descriptor["file"],
            r"^external-evidence/selected-model-provenance-[0-9a-f]{12}\.json$",
        )
        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "non-sensitive logical path"
        ):
            PROMOTE._validate_embedded_descriptor(  # noqa: SLF001
                {
                    "byte_size": 1,
                    "file": str(self.fixture.provenance),
                    "sha256": "a" * 64,
                },
                "tampered descriptor",
            )

        baseline_verdicts = json.loads(
            self.fixture.baseline_verdicts.read_text(encoding="utf-8")
        )
        baseline_verdicts.pop("record_sha256")
        baseline_verdicts["reviewed_at"] = "2026-08-03T04:00:00+00:00"
        write_json(
            self.fixture.baseline_verdicts,
            PROMOTE.attach.seal_record(baseline_verdicts),
        )
        chronology_output = self.fixture.root / "invalid-chronology-selection.json"
        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError,
            "holdout began before the baseline manual acceptance",
        ):
            self.fixture.seal_selection(
                output=chronology_output,
                selected_by="fixture-human-selector",
            )
        self.assertFalse(chronology_output.exists())

    def test_rejects_non_accept_page_without_publishing(self) -> None:
        value = json.loads(self.fixture.holdout_verdicts.read_text(encoding="utf-8"))
        row = dict(value["pages"][0])
        row.pop("record_sha256")
        row["verdict"] = "reject"
        value["pages"][0] = PROMOTE.attach.seal_record(row)
        value.pop("record_sha256")
        write_json(
            self.fixture.holdout_verdicts,
            PROMOTE.attach.seal_record(value),
        )
        self.fixture.write_provenance()

        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "not an exact manual accept"
        ):
            self.fixture.promote()
        self.assertFalse(self.fixture.output.exists())

    def test_rejects_holdout_without_explicit_runner_allow_policy(self) -> None:
        config_path = self.fixture.holdout.run_dir / "run-config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["allowHoldout"] = False
        write_json(config_path, config)

        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "execution/holdout policy drifted"
        ):
            self.fixture.promote()
        self.assertFalse(self.fixture.output.exists())

    def test_release_validation_rejects_resealed_acceptance_gate_drift(self) -> None:
        self.fixture.promote()
        contract_path = self.fixture.output / PROMOTE.attach.CONTRACT_FILE
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract.pop("record_sha256")
        acceptance = dict(contract["release_acceptance"])
        acceptance.pop("record_sha256")
        quality_gate = dict(acceptance["quality_gate"])
        quality_gate["baseline_pages"] = 39
        acceptance["quality_gate"] = quality_gate
        contract["release_acceptance"] = PROMOTE.attach.seal_record(acceptance)
        write_json(contract_path, PROMOTE.attach.seal_record(contract))
        marker_path = self.fixture.output / PROMOTE.attach.MARKER_FILE
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["artifacts"][PROMOTE.attach.CONTRACT_FILE] = PROMOTE.attach.sha256_file(
            contract_path
        )
        write_json(marker_path, marker)

        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError,
            "release_acceptance envelope drifted",
        ):
            PROMOTE.validate_release_bundle(self.fixture.output)


class SealManualPageVerdictsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = PromotionFixture(Path(cls.temp.name) / "verdict-fixture")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def manual_rows(self) -> list[dict[str, Any]]:
        return [
            {
                "chapter_id": page["chapterId"],
                "notes": f"좌우 비교 수동 확인 {index + 1}",
                "selection_index": index,
                "source_page_id": page["sourcePageId"],
                "source_page_sha256": page["sourcePageSha256"],
                "verdict": "accept",
                "work_id": page["workId"],
            }
            for index, page in enumerate(self.fixture.baseline.report["pages"])
        ]

    def seal(
        self,
        name: str,
        rows: list[Mapping[str, Any]],
        *,
        visual_pack_dir: Path | None = None,
    ) -> tuple[Path, Path, Mapping[str, Any]]:
        manual = self.fixture.root / f"{name}-manual.jsonl"
        output = self.fixture.root / f"{name}-verdicts.json"
        write_jsonl(manual, list(rows))
        result = PROMOTE.seal_manual_page_verdicts(
            run_report=self.fixture.baseline.report_path,
            visual_pack_dir=(visual_pack_dir or self.fixture.baseline.pack_dir),
            manual_review_jsonl=manual,
            reviewer="fixture-human-reviewer",
            output=output,
        )
        return manual, output, result

    def test_seals_explicit_40_row_manual_review_roundtrip(self) -> None:
        _manual, output, result = self.seal("valid", self.manual_rows())

        self.assertEqual(result["status"], "sealed_manual_page_verdicts")
        self.assertEqual(result["page_count"], PROMOTE.EXPECTED_PAGES)
        record = json.loads(output.read_text(encoding="utf-8"))
        PROMOTE.attach.validate_record_seal(record, location="sealed verdicts")
        self.assertFalse(record["automatic_visual_judgment"])
        self.assertEqual(len(record["pages"]), PROMOTE.EXPECTED_PAGES)
        for index, row in enumerate(record["pages"]):
            PROMOTE.attach.validate_record_seal(
                row, location=f"sealed verdict row {index + 1}"
            )
        run = PROMOTE._manual_verdict_run_binding(  # noqa: SLF001
            report_path=self.fixture.baseline.report_path,
            review_dir=self.fixture.baseline.pack_dir,
        )
        validated = PROMOTE._validate_page_verdicts(  # noqa: SLF001
            path=output, run=run, cohort="baseline40"
        )
        self.assertEqual(validated["record_sha256"], record["record_sha256"])

    def test_rejects_39_rows_without_creating_output(self) -> None:
        manual = self.fixture.root / "short-manual.jsonl"
        output = self.fixture.root / "short-verdicts.json"
        write_jsonl(manual, self.manual_rows()[:-1])

        with self.assertRaisesRegex(PROMOTE.QaRuntimePromotionError, "exactly 40 rows"):
            PROMOTE.seal_manual_page_verdicts(
                run_report=self.fixture.baseline.report_path,
                visual_pack_dir=self.fixture.baseline.pack_dir,
                manual_review_jsonl=manual,
                reviewer="fixture-human-reviewer",
                output=output,
            )
        self.assertFalse(output.exists())

    def test_rejects_duplicate_selection_index_without_creating_output(self) -> None:
        rows = self.manual_rows()
        rows[1]["selection_index"] = 0
        manual = self.fixture.root / "duplicate-manual.jsonl"
        output = self.fixture.root / "duplicate-verdicts.json"
        write_jsonl(manual, rows)

        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "duplicate selection_index"
        ):
            PROMOTE.seal_manual_page_verdicts(
                run_report=self.fixture.baseline.report_path,
                visual_pack_dir=self.fixture.baseline.pack_dir,
                manual_review_jsonl=manual,
                reviewer="fixture-human-reviewer",
                output=output,
            )
        self.assertFalse(output.exists())

    def test_rejects_non_accept_without_creating_output(self) -> None:
        rows = self.manual_rows()
        rows[7]["verdict"] = "reject"
        manual = self.fixture.root / "reject-manual.jsonl"
        output = self.fixture.root / "reject-verdicts.json"
        write_jsonl(manual, rows)

        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "explicitly be accept"
        ):
            PROMOTE.seal_manual_page_verdicts(
                run_report=self.fixture.baseline.report_path,
                visual_pack_dir=self.fixture.baseline.pack_dir,
                manual_review_jsonl=manual,
                reviewer="fixture-human-reviewer",
                output=output,
            )
        self.assertFalse(output.exists())

    def test_rejects_page_identity_and_visual_pack_mismatch(self) -> None:
        rows = self.manual_rows()
        rows[3]["source_page_id"] = "different-page"
        manual = self.fixture.root / "identity-manual.jsonl"
        identity_output = self.fixture.root / "identity-verdicts.json"
        write_jsonl(manual, rows)
        with self.assertRaisesRegex(PROMOTE.QaRuntimePromotionError, "page identity"):
            PROMOTE.seal_manual_page_verdicts(
                run_report=self.fixture.baseline.report_path,
                visual_pack_dir=self.fixture.baseline.pack_dir,
                manual_review_jsonl=manual,
                reviewer="fixture-human-reviewer",
                output=identity_output,
            )
        self.assertFalse(identity_output.exists())

        pack_output = self.fixture.root / "pack-mismatch-verdicts.json"
        with self.assertRaisesRegex(
            PROMOTE.QaRuntimePromotionError, "visual pack coverage drifted"
        ):
            PROMOTE.seal_manual_page_verdicts(
                run_report=self.fixture.baseline.report_path,
                visual_pack_dir=self.fixture.holdout.pack_dir,
                manual_review_jsonl=manual,
                reviewer="fixture-human-reviewer",
                output=pack_output,
            )
        self.assertFalse(pack_output.exists())


if __name__ == "__main__":
    unittest.main()
