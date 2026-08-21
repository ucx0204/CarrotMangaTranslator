from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]


def load_script():
    path = ROOT / "scripts" / "build_bubble_fit_gate_dataset.py"
    spec = importlib.util.spec_from_file_location(
        "build_bubble_fit_gate_dataset_test_target", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DATASET = load_script()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


class FakeDetector:
    def __init__(self, outputs: Sequence[Sequence[Any]]) -> None:
        self.outputs = outputs
        self.inference_count = 0

    def detect(self, _image: Image.Image) -> list[Any]:
        output = list(self.outputs[self.inference_count % len(self.outputs)])
        self.inference_count += 1
        return output


class DetectorFactory:
    def __init__(self, outputs: Sequence[Sequence[Any]]) -> None:
        self.outputs = outputs
        self.instances: list[FakeDetector] = []

    def __call__(self, _model_path: Path, _score_threshold: float) -> FakeDetector:
        detector = FakeDetector(self.outputs)
        self.instances.append(detector)
        return detector


class CompletedRunFixture:
    def __init__(self, root: Path, page_count: int = 2) -> None:
        self.root = root
        self.run_dir = root / "완료 런"
        self.report_path = self.run_dir / "run-report.json"
        self.model_path = root / "모델" / "detector-v4-s_int8.onnx"
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        self.model_path.write_bytes(b"fixture-int8-rtdetr-model")
        self.model_sha256 = sha256_file(self.model_path)
        self.pages = [self._page(index) for index in range(page_count)]
        self.report = {
            "schemaVersion": 1,
            "status": "completed",
            "startedAt": "2026-08-18T00:00:00.000Z",
            "finishedAt": "2026-08-18T00:05:00.000Z",
            "runId": "bubble-fit-fixture-한글",
            "cohort": "diverse-pages",
            "cohortDigest": "c" * 64,
            "candidateId": "baseline",
            "pageCount": page_count,
            "pages": self.pages,
        }
        write_json(self.report_path, self.report)

    def _image(self, path: Path, index: int, cleaned: bool) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (120, 160), (225, 222, 214))
        draw = ImageDraw.Draw(image)
        draw.ellipse(
            (8, 12, 71, 61), fill=(252, 252, 250), outline=(35, 35, 35), width=2
        )
        draw.polygon([(60, 55), (78, 73), (55, 59)], fill=(252, 252, 250))
        draw.ellipse(
            (88, 105, 128, 174), fill=(245, 245, 242), outline=(45, 45, 45), width=2
        )
        if cleaned:
            draw.rectangle((20, 25, 54, 44), fill=(252, 252, 250))
            draw.rectangle((99, 123, 117, 148), fill=(245, 245, 242))
        else:
            draw.line((20, 31, 54, 31), fill=(20 + index, 20, 20), width=4)
            draw.line((22, 39, 50, 39), fill=(20, 20, 20), width=4)
            draw.line((100, 128, 116, 145), fill=(25, 25, 25), width=4)
        image.save(path, format="PNG")
        image.close()

    def _page(self, index: int) -> dict[str, Any]:
        page_dir = self.run_dir / "pages" / f"{index + 1:02d}" / "한글 경로"
        original = page_dir / "원본.png"
        cleaned = page_dir / "인페인트.png"
        self._image(original, index, cleaned=False)
        self._image(cleaned, index, cleaned=True)
        return {
            "selectionIndex": index,
            "sourcePageId": f"page-{index + 1}",
            "sourcePageName": f"페이지-{index + 1}.png",
            "sourcePageSha256": sha256_file(original),
            "workId": f"work-{index + 1}",
            "workTitle": f"서로 다른 작품 {index + 1}",
            "chapterId": f"chapter-{index + 1}",
            "chapterTitle": f"제{index + 1}화",
            "status": "completed",
            "stage": "done",
            "mode": "full",
            "blockCount": 2,
            "stagedOriginalImagePath": (
                str(original.resolve())
                if index == 0
                else original.relative_to(self.run_dir).as_posix()
            ),
            "cleanedImagePath": cleaned.relative_to(self.run_dir).as_posix(),
        }

    def snapshot(self) -> dict[str, str]:
        return {
            path.relative_to(self.run_dir).as_posix(): sha256_file(path)
            for path in self.run_dir.rglob("*")
            if path.is_file()
        }


class BubbleFitGateDatasetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "유니코드 데이터셋 테스트"
        self.fixture = CompletedRunFixture(self.root)
        self.output = self.root / "bubble gate evidence"
        self.outputs = [self._detections(), self._detections()]

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _detections(self) -> list[Any]:
        return [
            DATASET.Detection("text_bubble", 0.92, (20, 25, 55, 45)),
            DATASET.Detection("bubble", 0.96, (8, 12, 72, 62)),
            DATASET.Detection("text_bubble", 0.90, (99, 123, 118, 149)),
            DATASET.Detection("bubble", 0.80, (88, 105, 130, 175)),
            DATASET.Detection("text_bubble", 0.88, (72, 4, 96, 28)),
            DATASET.Detection("text_free", 0.99, (4, 80, 40, 100)),
        ]

    def _options(
        self,
        output: Path | None = None,
        *,
        fixture: CompletedRunFixture | None = None,
        selection_start: int | None = None,
        selection_count: int | None = None,
    ) -> Any:
        selected_fixture = fixture or self.fixture
        return DATASET.BuildOptions(
            report_path=selected_fixture.report_path,
            output_dir=output or self.output,
            model_path=selected_fixture.model_path,
            expected_model_sha256=selected_fixture.model_sha256,
            score_threshold=0.35,
            context_ratio=0.20,
            selection_start=selection_start,
            selection_count=selection_count,
            quiet=True,
        )

    def _build(
        self,
        output: Path | None = None,
        *,
        fixture: CompletedRunFixture | None = None,
        selection_start: int | None = None,
        selection_count: int | None = None,
        outputs: Sequence[Sequence[Any]] | None = None,
    ) -> tuple[dict[str, Any], DetectorFactory]:
        factory = DetectorFactory(outputs or self.outputs)
        result = DATASET.build_dataset(
            self._options(
                output,
                fixture=fixture,
                selection_start=selection_start,
                selection_count=selection_count,
            ),
            detector_factory=factory,
        )
        return result, factory

    def _rebind_manifest_and_seal(self, output: Path) -> None:
        manifest_path = output / DATASET.MANIFEST_NAME
        seal_path = output / DATASET.SEAL_NAME
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["manifestBindingSha256"] = DATASET._sha256_json(
            DATASET._manifest_without_binding(manifest)
        )
        write_json(manifest_path, manifest)
        seal = json.loads(seal_path.read_text(encoding="utf-8"))
        seal["manifestSha256"] = sha256_file(manifest_path)
        seal["manifestBindingSha256"] = manifest["manifestBindingSha256"]
        write_json(seal_path, seal)

    def test_builds_bound_native_training_overlay_prompt_and_core_mask_assets(
        self,
    ) -> None:
        before = self.fixture.snapshot()
        result, factory = self._build()
        after = self.fixture.snapshot()

        self.assertEqual(before, after)
        self.assertEqual(result["pages"], 2)
        self.assertEqual(result["candidates"], 4)
        self.assertEqual(result["artifacts"], 28)
        self.assertEqual(result["inferences"], 2)
        self.assertEqual(factory.instances[0].inference_count, 2)

        manifest = json.loads(
            (self.output / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("sourceSelection", manifest)
        self.assertFalse(manifest["labels"]["present"])
        self.assertFalse(manifest["maskSpec"]["exactProductionFloodParity"])
        self.assertEqual(manifest["counts"]["associatedTextPrompts"], 4)
        self.assertEqual(manifest["pages"][0]["textBubbleDetectionCount"], 3)
        self.assertEqual(manifest["pages"][0]["associatedTextBubbleCount"], 2)
        self.assertEqual(manifest["pages"][0]["unassociatedTextBubbleCount"], 1)

        first = manifest["candidates"][0]
        self.assertEqual(first["workId"], "work-1")
        self.assertEqual(first["detectionBboxPx"], [8, 12, 72, 62])
        self.assertEqual(first["requestedCropBboxPx"], [-5, -1, 85, 75])
        self.assertEqual(first["cropBboxPx"], [0, 0, 85, 75])
        self.assertEqual(first["contextClampedSides"], ["left", "top"])
        self.assertEqual(first["promptBoxesPx"], [[20, 25, 55, 45]])
        self.assertEqual(first["candidateCoreMask"]["pageBboxPx"], [12, 16, 68, 58])

        artifacts = first["artifacts"]
        native_path = self.output / artifacts["originalNative"]["path"]
        training_path = self.output / artifacts["originalTraining224"]["path"]
        overlay_path = self.output / artifacts["qaSingleCandidateOverlay"]["path"]
        mask_path = self.output / artifacts["candidateCoreMask"]["path"]
        with Image.open(native_path) as image:
            self.assertEqual(image.size, (85, 75))
        with Image.open(training_path) as image:
            self.assertEqual(image.size, (224, 224))
            self.assertEqual(image.mode, "RGB")
        with Image.open(overlay_path) as image:
            self.assertEqual(image.size, (85, 75))
        with Image.open(mask_path) as image:
            self.assertEqual(image.size, (85, 75))
            self.assertEqual(image.mode, "L")
            self.assertEqual(set(image.getdata()), {0, 255})
            self.assertEqual(sum(value == 255 for value in image.getdata()), 56 * 42)

        validation_factory = DetectorFactory(self.outputs)
        validated = DATASET.validate_dataset(
            self.output,
            detector_factory=validation_factory,
            quiet=True,
        )
        self.assertTrue(validated["ok"])
        self.assertEqual(validated["candidates"], 4)
        self.assertEqual(validated["inferences"], 2)

    def test_build_is_deterministic_for_the_same_bound_inputs(self) -> None:
        first_output = self.output
        second_output = self.root / "second evidence"
        self._build(first_output)
        self._build(second_output)
        first_files = {
            path.relative_to(first_output).as_posix(): sha256_file(path)
            for path in first_output.rglob("*")
            if path.is_file()
        }
        second_files = {
            path.relative_to(second_output).as_posix(): sha256_file(path)
            for path in second_output.rglob("*")
            if path.is_file()
        }
        self.assertEqual(first_files, second_files)

    def test_refuses_nonempty_output_without_touching_it(self) -> None:
        self.output.mkdir(parents=True)
        sentinel = self.output / "사용자 파일.txt"
        sentinel.write_text("keep", encoding="utf-8")
        factory = DetectorFactory(self.outputs)
        with self.assertRaisesRegex(DATASET.BubbleFitDatasetError, "new or empty"):
            DATASET.build_dataset(self._options(), detector_factory=factory)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
        self.assertEqual(factory.instances, [])

    def test_builds_and_validates_official_20_to_39_source_slice(self) -> None:
        fixture = CompletedRunFixture(self.root / "slice-40", page_count=40)
        output = self.root / "slice-20-to-39"
        outputs = [self._detections()]
        result, factory = self._build(
            output,
            fixture=fixture,
            selection_start=20,
            selection_count=20,
            outputs=outputs,
        )

        self.assertEqual(result["pages"], 20)
        self.assertEqual(result["inferences"], 20)
        self.assertEqual(factory.instances[0].inference_count, 20)
        manifest = json.loads(
            (output / DATASET.MANIFEST_NAME).read_text(encoding="utf-8")
        )
        expected_indices = list(range(20, 40))
        self.assertEqual(
            manifest["sourceSelection"],
            {
                "start": 20,
                "count": 20,
                "endExclusive": 40,
                "indicesSha256": DATASET._sha256_json(expected_indices),
            },
        )
        self.assertEqual(
            [page["selectionIndex"] for page in manifest["pages"]],
            expected_indices,
        )
        self.assertEqual(
            sorted({item["selectionIndex"] for item in manifest["candidates"]}),
            expected_indices,
        )
        self.assertEqual(
            manifest["sourceRun"]["sha256"], sha256_file(fixture.report_path)
        )

        validation_factory = DetectorFactory(outputs)
        validated = DATASET.validate_dataset(
            output,
            detector_factory=validation_factory,
            quiet=True,
        )
        self.assertEqual(validated["pages"], 20)
        self.assertEqual(validated["inferences"], 20)

        args = DATASET.build_argument_parser().parse_args(
            [
                "build",
                "--run-report",
                str(fixture.report_path),
                "--output",
                str(self.root / "cli-output"),
                "--selection-start",
                "20",
                "--selection-count",
                "20",
            ]
        )
        self.assertEqual((args.selection_start, args.selection_count), (20, 20))

    def test_slice_options_reject_partial_and_out_of_range_before_inference(
        self,
    ) -> None:
        fixture = CompletedRunFixture(self.root / "slice-options", page_count=4)
        cases = [
            (1, None, "provided together"),
            (None, 2, "provided together"),
            (0, 0, "selection-count"),
            (3, 2, "out of range"),
        ]
        for ordinal, (start, count, message) in enumerate(cases):
            with self.subTest(start=start, count=count):
                factory = DetectorFactory([self._detections()])
                with self.assertRaisesRegex(DATASET.BubbleFitDatasetError, message):
                    DATASET.build_dataset(
                        self._options(
                            self.root / f"invalid-slice-{ordinal}",
                            fixture=fixture,
                            selection_start=start,
                            selection_count=count,
                        ),
                        detector_factory=factory,
                    )
                self.assertEqual(factory.instances, [])

    def test_validation_rejects_rebound_source_selection_contract_tampering(
        self,
    ) -> None:
        fixture = CompletedRunFixture(self.root / "slice-tamper", page_count=6)
        mutations = {
            "tampered end": lambda selection: selection.update({"endExclusive": 5}),
            "out of range": lambda selection: selection.update(
                {
                    "start": 5,
                    "count": 2,
                    "endExclusive": 7,
                    "indicesSha256": DATASET._sha256_json([5, 6]),
                }
            ),
            "noncontiguous indices": lambda selection: selection.update(
                {"indicesSha256": DATASET._sha256_json([2, 4])}
            ),
        }
        for ordinal, (case, mutate) in enumerate(mutations.items()):
            with self.subTest(case=case):
                output = self.root / f"rebound-source-selection-{ordinal}"
                self._build(
                    output,
                    fixture=fixture,
                    selection_start=2,
                    selection_count=2,
                    outputs=[self._detections()],
                )
                manifest_path = output / DATASET.MANIFEST_NAME
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                mutate(manifest["sourceSelection"])
                write_json(manifest_path, manifest)
                self._rebind_manifest_and_seal(output)
                factory = DetectorFactory([self._detections()])
                with self.assertRaises(DATASET.BubbleFitDatasetError):
                    DATASET.validate_dataset(
                        output,
                        detector_factory=factory,
                        quiet=True,
                    )
                self.assertEqual(factory.instances, [])

    def test_slice_build_rejects_noncontiguous_full_report_before_inference(
        self,
    ) -> None:
        fixture = CompletedRunFixture(self.root / "noncontiguous", page_count=4)
        fixture.report["pages"][1]["selectionIndex"] = 4
        write_json(fixture.report_path, fixture.report)
        factory = DetectorFactory([self._detections()])
        with self.assertRaisesRegex(
            DATASET.BubbleFitDatasetError, "contiguous from zero"
        ):
            DATASET.build_dataset(
                self._options(
                    self.root / "noncontiguous-output",
                    fixture=fixture,
                    selection_start=1,
                    selection_count=2,
                ),
                detector_factory=factory,
            )
        self.assertEqual(factory.instances, [])

    def test_validation_rejects_artifact_tampering_and_detector_drift(self) -> None:
        self._build()
        manifest = json.loads(
            (self.output / "manifest.json").read_text(encoding="utf-8")
        )
        training = (
            self.output
            / manifest["candidates"][0]["artifacts"]["originalTraining224"]["path"]
        )
        Image.new("RGB", (224, 224), (255, 0, 0)).save(training, format="PNG")
        with self.assertRaisesRegex(
            DATASET.BubbleFitDatasetError, "artifact SHA-256 mismatch"
        ):
            DATASET.validate_dataset(
                self.output,
                detector_factory=DetectorFactory(self.outputs),
                quiet=True,
            )

        clean_output = self.root / "drift evidence"
        self._build(clean_output)
        drifted = [
            [
                DATASET.Detection(
                    item.label,
                    item.score,
                    (item.bbox[0] + 1, item.bbox[1], item.bbox[2], item.bbox[3]),
                )
                if item.label == "bubble"
                else item
                for item in self._detections()
            ]
        ] * 2
        with self.assertRaisesRegex(
            DATASET.BubbleFitDatasetError, "recomputed candidate"
        ):
            DATASET.validate_dataset(
                clean_output,
                detector_factory=DetectorFactory(drifted),
                quiet=True,
            )

    def test_validation_rejects_manifest_binding_tampering_before_inference(
        self,
    ) -> None:
        self._build()
        manifest_path = self.output / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["cropSpec"]["contextRatio"] = 0.25
        write_json(manifest_path, manifest)
        factory = DetectorFactory(self.outputs)
        with self.assertRaisesRegex(DATASET.BubbleFitDatasetError, "manifest binding"):
            DATASET.validate_dataset(
                self.output,
                detector_factory=factory,
                quiet=True,
            )
        self.assertEqual(factory.instances, [])


if __name__ == "__main__":
    unittest.main()
