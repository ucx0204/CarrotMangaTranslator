from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from scripts import build_manga_font_v3_page_consistency_overlay as builder


class MangaFontV3PageConsistencyOverlayTests(unittest.TestCase):
    candidate_ids = ("font-a", "font-b", "single-day")

    def source_row(
        self,
        *,
        sample_id: str,
        work_id: str,
        page_id: str,
        positive: tuple[str, ...],
        eligible: tuple[str, ...] = ("font-a", "font-b", "single-day"),
    ) -> dict[str, object]:
        return builder.seal_record(
            {
                "authority": dict(builder.EXPECTED_SOURCE_ROW_AUTHORITY),
                "candidate_labels": {
                    "eligible_candidate_ids": list(eligible),
                    "positive_candidate_ids": list(positive),
                    "preferred_candidate_ids": [positive[0]],
                },
                "family": "body",
                "identity": {
                    "chapter_id": f"chapter-{work_id}",
                    "master_row_sha256": "1" * 64,
                    "page_id": page_id,
                    "source_page_sha256": "2" * 64,
                    "work_id": work_id,
                },
                "record_type": "manga_font_v2_high_value_training_label",
                "role": "dialogue",
                "sample_id": sample_id,
                "schema_version": builder.SOURCE_SCHEMA_VERSION,
                "supervision_weight": 0.9,
            }
        )

    def write_source(self, root: Path, rows: list[dict[str, object]]) -> None:
        root.mkdir()
        labels_path = root / builder.SOURCE_LABEL_FILE
        labels_path.write_bytes(b"".join(builder.json_bytes(row) for row in rows))
        manifest = builder.seal_record(
            {
                "authority": dict(builder.EXPECTED_SOURCE_MANIFEST_AUTHORITY),
                "candidate_ids": list(self.candidate_ids),
                "labels": builder._artifact_descriptor(
                    labels_path, row_count=len(rows)
                ),
                "record_type": "manga_font_v2_high_value_supervised_labels_manifest",
                "schema_version": builder.SOURCE_SCHEMA_VERSION,
            }
        )
        manifest_path = root / builder.SOURCE_MANIFEST_FILE
        manifest_path.write_bytes(builder.json_bytes(manifest, pretty=True))
        report = builder.seal_record(
            {
                "artifacts": {
                    builder.SOURCE_LABEL_FILE: builder._artifact_descriptor(
                        labels_path, row_count=len(rows)
                    ),
                    builder.SOURCE_MANIFEST_FILE: builder._artifact_descriptor(
                        manifest_path
                    ),
                },
                "manifest_record_sha256": manifest["record_sha256"],
                "record_type": "manga_font_v2_high_value_supervised_labels_report",
                "schema_version": builder.SOURCE_SCHEMA_VERSION,
            }
        )
        report_path = root / builder.SOURCE_REPORT_FILE
        report_path.write_bytes(builder.json_bytes(report, pretty=True))
        marker = builder.seal_record(
            {
                "artifacts": {
                    builder.SOURCE_LABEL_FILE: builder.sha256_file(labels_path),
                    builder.SOURCE_MANIFEST_FILE: builder.sha256_file(manifest_path),
                    builder.SOURCE_REPORT_FILE: builder.sha256_file(report_path),
                },
                "owner": (
                    "carrot-manga-translator/"
                    "manga-font-v2-high-value-supervised-labels-v1"
                ),
                "safe_replace": True,
                "schema_version": builder.SOURCE_SCHEMA_VERSION,
            }
        )
        (root / builder.SOURCE_MARKER_FILE).write_bytes(
            builder.json_bytes(marker, pretty=True)
        )

    def write_base_npz(self, path: Path, source_rows: int) -> None:
        count = source_rows + 2
        candidates = len(self.candidate_ids)
        positive = np.zeros((count, candidates), dtype=bool)
        preferred = np.zeros_like(positive)
        eligible = np.zeros_like(positive)
        for index in (source_rows, source_rows + 1):
            positive[index, 0] = True
            preferred[index, 0] = True
            eligible[index, :2] = True
        weights = np.zeros(count, dtype=np.float32)
        weights[-2:] = 1.0
        authority = np.asarray(["none"] * source_rows + ["visual", "visual"])
        split = np.asarray([0] * (source_rows + 1) + [1], dtype=np.int8)
        sample_ids = np.asarray(
            [f"sample-{index}" for index in range(source_rows)]
            + ["train-supervised", "val-supervised"]
        )
        work_ids = np.asarray(
            [f"work-{index // 2}" for index in range(source_rows)]
            + ["train-extra", "val-extra"]
        )
        np.savez_compressed(
            path,
            candidate_ids=np.asarray(self.candidate_ids),
            query_views=np.zeros((count, 3, 4, 256), dtype=np.float16),
            prototype_queries=np.zeros((candidates, 4, 256), dtype=np.float32),
            family_labels=np.zeros(count, dtype=np.int8),
            family_label_weights=np.ones(count, dtype=np.float32),
            positive_mask=positive,
            preferred_mask=preferred,
            candidate_eligible_mask=eligible,
            font_supervision_weights=weights,
            single_day_body_negative=np.ones(count, dtype=bool),
            font_authority=authority,
            sample_ids=sample_ids,
            work_ids=work_ids,
            split=split,
        )

    def test_selection_uses_only_shared_reviewed_support(self) -> None:
        rows = [
            self.source_row(
                sample_id="sample-0",
                work_id="work-a",
                page_id="page-a",
                positive=("font-a", "single-day"),
            ),
            self.source_row(
                sample_id="sample-1",
                work_id="work-a",
                page_id="page-a",
                positive=("font-a",),
                eligible=("font-a", "single-day"),
            ),
            self.source_row(
                sample_id="sample-2",
                work_id="work-b",
                page_id="page-b",
                positive=("font-a",),
            ),
            self.source_row(
                sample_id="sample-3",
                work_id="work-b",
                page_id="page-b",
                positive=("font-a",),
            ),
        ]
        groups, split = builder.select_page_groups(
            rows,
            candidate_ids=self.candidate_ids,
            seed="synthetic",
            eval_work_count=1,
        )
        self.assertEqual(2, len(groups))
        group = next(group for group in groups if group["work_id"] == "work-a")
        self.assertEqual(["font-a"], group["common_positive_candidate_ids"])
        self.assertEqual(["font-a"], group["shared_reviewed_eligible_candidate_ids"])
        self.assertNotIn("single-day", group["common_positive_candidate_ids"])
        self.assertFalse(
            set(split["train_work_ids"]) & set(split["development_eval_work_ids"])
        )

    def test_build_validate_and_tamper_detection(self) -> None:
        rows: list[dict[str, object]] = []
        for index in range(8):
            rows.append(
                self.source_row(
                    sample_id=f"sample-{index}",
                    work_id=f"work-{index // 2}",
                    page_id=f"page-{index // 2}",
                    positive=(("font-a",) if index < 4 else ("font-b",)),
                )
            )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            base = root / "base.npz"
            output = root / "overlay"
            self.write_source(source, rows)
            self.write_base_npz(base, len(rows))
            result = builder.build_overlay(
                source_label_dir=source,
                base_npz=base,
                output_dir=output,
                seed="synthetic",
                eval_work_count=1,
                expected_source_rows=len(rows),
                expected_counts=None,
                expected_base_npz_sha256=None,
            )
            self.assertEqual(4, result["counts"]["group_count"])
            self.assertEqual(8, result["counts"]["row_count"])
            self.assertEqual(
                "valid_training_only_page_consistency_overlay", result["status"]
            )
            payload = (output / builder.OVERLAY_FILE).read_text(encoding="utf-8")
            first, *rest = payload.splitlines()
            row = json.loads(first)
            row["supervision_weight"] = 0.1
            (output / builder.OVERLAY_FILE).write_text(
                "\n".join([builder.canonical_json(row), *rest]) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(builder.PageConsistencyOverlayError, "drifted"):
                builder.validate_output(
                    output,
                    require_sources=False,
                    expected_counts=None,
                    expected_base_npz_sha256=None,
                )

    def test_production_mode_rejects_non_r3_base_npz(self) -> None:
        rows = [
            self.source_row(
                sample_id=f"sample-{index}",
                work_id=f"work-{index // 2}",
                page_id=f"page-{index // 2}",
                positive=("font-a",),
            )
            for index in range(8)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            base = root / "base.npz"
            self.write_source(source, rows)
            self.write_base_npz(base, len(rows))
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError,
                "exact production r3 dataset",
            ):
                builder.build_overlay(
                    source_label_dir=source,
                    base_npz=base,
                    output_dir=root / "overlay",
                    seed="synthetic",
                    eval_work_count=1,
                    expected_source_rows=len(rows),
                    expected_counts=None,
                )

    def test_linked_root_and_child_are_rejected_before_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real_source = root / "real-source"
            real_source.mkdir()
            linked_source = root / "linked-source"
            try:
                linked_source.symlink_to(real_source, target_is_directory=True)
            except OSError:
                with mock.patch.object(
                    builder, "_is_link_or_reparse", return_value=True
                ):
                    with self.assertRaisesRegex(
                        builder.PageConsistencyOverlayError, "directory is linked"
                    ):
                        builder.validate_source_labels(
                            linked_source, expected_row_count=None
                        )
            else:
                with self.assertRaisesRegex(
                    builder.PageConsistencyOverlayError, "directory is linked"
                ):
                    builder.validate_source_labels(
                        linked_source, expected_row_count=None
                    )

            output = root / "output"
            output.mkdir()
            target = root / "target.txt"
            target.write_text("sealed elsewhere", encoding="utf-8")
            try:
                (output / "linked-child").symlink_to(target)
            except OSError:
                child_context = mock.patch.object(
                    builder, "_contains_link_or_reparse", return_value=True
                )
            else:
                child_context = mock.patch.object(
                    builder,
                    "_contains_link_or_reparse",
                    wraps=builder._contains_link_or_reparse,
                )
            with child_context:
                with self.assertRaisesRegex(
                    builder.PageConsistencyOverlayError, "missing or linked"
                ):
                    builder.validate_output(
                        output,
                        require_sources=False,
                        expected_counts=None,
                        expected_base_npz_sha256=None,
                    )

    def test_linked_base_npz_is_rejected_before_loader_resolution(self) -> None:
        rows = [
            self.source_row(
                sample_id=f"sample-{index}",
                work_id=f"work-{index // 2}",
                page_id=f"page-{index // 2}",
                positive=("font-a",),
            )
            for index in range(8)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            real_base = root / "real-base.npz"
            linked_base = root / "linked-base.npz"
            self.write_source(source, rows)
            self.write_base_npz(real_base, len(rows))
            try:
                linked_base.symlink_to(real_base)
            except OSError:
                original = builder._path_or_ancestor_is_link_or_reparse

                def linked_base_only(path: Path) -> bool:
                    if Path(path).absolute() == linked_base.absolute():
                        return True
                    return original(path)

                link_context = mock.patch.object(
                    builder,
                    "_path_or_ancestor_is_link_or_reparse",
                    side_effect=linked_base_only,
                )
            else:
                link_context = mock.patch.object(
                    builder,
                    "_path_or_ancestor_is_link_or_reparse",
                    wraps=builder._path_or_ancestor_is_link_or_reparse,
                )
            with link_context:
                with self.assertRaisesRegex(
                    builder.PageConsistencyOverlayError, "base NPZ cannot be linked"
                ):
                    builder.build_overlay(
                        source_label_dir=source,
                        base_npz=linked_base,
                        output_dir=root / "overlay",
                        seed="synthetic",
                        eval_work_count=1,
                        expected_source_rows=len(rows),
                        expected_counts=None,
                        expected_base_npz_sha256=None,
                    )

    def test_resealed_overlay_authority_elevation_is_rejected_exactly(self) -> None:
        rows = [
            self.source_row(
                sample_id=f"sample-{index}",
                work_id=f"work-{index // 2}",
                page_id=f"page-{index // 2}",
                positive=("font-a",),
            )
            for index in range(8)
        ]

        def build_at(root: Path) -> Path:
            source = root / "source"
            base = root / "base.npz"
            output = root / "overlay"
            self.write_source(source, rows)
            self.write_base_npz(base, len(rows))
            builder.build_overlay(
                source_label_dir=source,
                base_npz=base,
                output_dir=output,
                seed="synthetic",
                eval_work_count=1,
                expected_source_rows=len(rows),
                expected_counts=None,
                expected_base_npz_sha256=None,
            )
            return output

        def reseal_marker(output: Path) -> None:
            marker_path = output / builder.MARKER_FILE
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            for name in (
                builder.DIRECT_FAMILY_FILE,
                builder.OVERLAY_FILE,
                builder.MANIFEST_FILE,
            ):
                marker["artifacts"][name] = builder.sha256_file(output / name)
            marker_path.write_bytes(
                builder.json_bytes(builder.seal_record(marker), pretty=True)
            )

        with tempfile.TemporaryDirectory() as temporary:
            output = build_at(Path(temporary))
            manifest_path = output / builder.MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["authority"]["evaluation_authority"] = True
            manifest_path.write_bytes(
                builder.json_bytes(builder.seal_record(manifest), pretty=True)
            )
            reseal_marker(output)
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError, "authority was elevated"
            ):
                builder.validate_output(
                    output,
                    require_sources=False,
                    expected_counts=None,
                    expected_base_npz_sha256=None,
                )

        with tempfile.TemporaryDirectory() as temporary:
            output = build_at(Path(temporary))
            direct_path = output / builder.DIRECT_FAMILY_FILE
            direct_rows = [
                json.loads(line)
                for line in direct_path.read_text(encoding="utf-8").splitlines()
            ]
            direct_rows[0]["authority"]["human_gold"] = True
            direct_rows[0] = builder.seal_record(direct_rows[0])
            direct_path.write_bytes(
                b"".join(builder.json_bytes(row) for row in direct_rows)
            )
            manifest_path = output / builder.MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["artifacts"][builder.DIRECT_FAMILY_FILE] = (
                builder._artifact_descriptor(direct_path, row_count=len(direct_rows))
            )
            manifest["direct_family_record_inventory_sha256"] = builder.sha256_bytes(
                builder.canonical_json(
                    [row["record_sha256"] for row in direct_rows]
                ).encode("utf-8")
            )
            manifest_path.write_bytes(
                builder.json_bytes(builder.seal_record(manifest), pretty=True)
            )
            reseal_marker(output)
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError, "row contract drifted"
            ):
                builder.validate_output(
                    output,
                    require_sources=False,
                    expected_counts=None,
                    expected_base_npz_sha256=None,
                )

    def test_resealed_source_authority_elevation_is_rejected_exactly(self) -> None:
        rows = [
            self.source_row(
                sample_id=f"sample-{index}",
                work_id=f"work-{index // 2}",
                page_id=f"page-{index // 2}",
                positive=("font-a",),
            )
            for index in range(2)
        ]

        def reseal_source(source: Path) -> None:
            labels_path = source / builder.SOURCE_LABEL_FILE
            manifest_path = source / builder.SOURCE_MANIFEST_FILE
            report_path = source / builder.SOURCE_REPORT_FILE
            marker_path = source / builder.SOURCE_MARKER_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["labels"] = builder._artifact_descriptor(
                labels_path, row_count=len(rows)
            )
            manifest = builder.seal_record(manifest)
            manifest_path.write_bytes(builder.json_bytes(manifest, pretty=True))
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["artifacts"][builder.SOURCE_LABEL_FILE] = (
                builder._artifact_descriptor(labels_path, row_count=len(rows))
            )
            report["artifacts"][builder.SOURCE_MANIFEST_FILE] = (
                builder._artifact_descriptor(manifest_path)
            )
            report["manifest_record_sha256"] = manifest["record_sha256"]
            report = builder.seal_record(report)
            report_path.write_bytes(builder.json_bytes(report, pretty=True))
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            for name in (
                builder.SOURCE_LABEL_FILE,
                builder.SOURCE_MANIFEST_FILE,
                builder.SOURCE_REPORT_FILE,
            ):
                marker["artifacts"][name] = builder.sha256_file(source / name)
            marker_path.write_bytes(
                builder.json_bytes(builder.seal_record(marker), pretty=True)
            )

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            self.write_source(source, rows)
            manifest_path = source / builder.SOURCE_MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["authority"]["evaluation_authority"] = True
            manifest_path.write_bytes(
                builder.json_bytes(builder.seal_record(manifest), pretty=True)
            )
            reseal_source(source)
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError, "authority was elevated"
            ):
                builder.validate_source_labels(source, expected_row_count=len(rows))

        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            self.write_source(source, rows)
            labels_path = source / builder.SOURCE_LABEL_FILE
            source_rows = [
                json.loads(line)
                for line in labels_path.read_text(encoding="utf-8").splitlines()
            ]
            source_rows[0]["authority"]["human_gold"] = True
            source_rows[0] = builder.seal_record(source_rows[0])
            labels_path.write_bytes(
                b"".join(builder.json_bytes(row) for row in source_rows)
            )
            reseal_source(source)
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError, "authority drifted"
            ):
                builder.validate_source_labels(source, expected_row_count=len(rows))

    def test_resealed_direct_family_target_cannot_escape_exact_source(self) -> None:
        rows = [
            self.source_row(
                sample_id=f"sample-{index}",
                work_id=f"work-{index // 2}",
                page_id=f"page-{index // 2}",
                positive=("font-a",),
            )
            for index in range(8)
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            base = root / "base.npz"
            output = root / "overlay"
            self.write_source(source, rows)
            self.write_base_npz(base, len(rows))
            builder.build_overlay(
                source_label_dir=source,
                base_npz=base,
                output_dir=output,
                seed="synthetic",
                eval_work_count=1,
                expected_source_rows=len(rows),
                expected_counts=None,
                expected_base_npz_sha256=None,
            )
            direct_path = output / builder.DIRECT_FAMILY_FILE
            direct_rows = [
                json.loads(line)
                for line in direct_path.read_text(encoding="utf-8").splitlines()
            ]
            direct_rows[0]["family"] = "variant"
            direct_rows[0] = builder.seal_record(direct_rows[0])
            direct_path.write_bytes(
                b"".join(builder.json_bytes(row) for row in direct_rows)
            )
            manifest_path = output / builder.MANIFEST_FILE
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["artifacts"][builder.DIRECT_FAMILY_FILE] = (
                builder._artifact_descriptor(direct_path, row_count=len(direct_rows))
            )
            manifest["direct_family_record_inventory_sha256"] = builder.sha256_bytes(
                builder.canonical_json(
                    [row["record_sha256"] for row in direct_rows]
                ).encode("utf-8")
            )
            manifest["counts"].update(builder._direct_family_counts(direct_rows))
            manifest = builder.seal_record(manifest)
            manifest_path.write_bytes(builder.json_bytes(manifest, pretty=True))
            marker_path = output / builder.MARKER_FILE
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            marker["artifacts"][builder.DIRECT_FAMILY_FILE] = builder.sha256_file(
                direct_path
            )
            marker["artifacts"][builder.MANIFEST_FILE] = builder.sha256_file(
                manifest_path
            )
            marker = builder.seal_record(marker)
            marker_path.write_bytes(builder.json_bytes(marker, pretty=True))
            with self.assertRaisesRegex(
                builder.PageConsistencyOverlayError,
                "direct-family row/source binding drifted",
            ):
                builder.validate_output(
                    output,
                    require_sources=True,
                    expected_counts=None,
                    expected_base_npz_sha256=None,
                )


if __name__ == "__main__":
    unittest.main()
