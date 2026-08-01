from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

from tests.python import test_promote_font_matching_font_signal_recrop_repair as base


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PROMOTION = load_script(
    "promote_font_matching_font_signal_recrop_repair",
    "promote_font_matching_font_signal_recrop_repair.py",
)
FINALIZER = load_script(
    "font_signal_terminal_finalizer",
    "finalize_font_matching_font_signal_terminal_exclusions_v1.py",
)


def bound(row: dict, line_number: int) -> object:
    payload = PROMOTION.json_bytes(row)
    return PROMOTION.BoundRow(
        row=row,
        line_number=line_number,
        line_bytes_sha256=PROMOTION.sha256_bytes(payload),
        record_sha256=PROMOTION.sha256_json(row),
    )


def pass_image() -> Image.Image:
    image = Image.new("RGB", (96, 72), (250, 250, 250))
    draw = ImageDraw.Draw(image)
    draw.line((24, 14, 24, 57), fill=(15, 15, 15), width=7)
    draw.line((24, 18, 65, 18), fill=(20, 20, 20), width=6)
    draw.line((24, 38, 60, 38), fill=(35, 35, 35), width=6)
    return image


def held_image(background: int) -> Image.Image:
    image = Image.new("RGB", (128, 96), (background,) * 3)
    draw = ImageDraw.Draw(image)
    for y in range(1, 95, 9):
        for x in range(1, 127, 9):
            draw.rectangle((x, y, x + 2, y + 2), fill="black")
    return image


def fake_final(*, extra_hold: bool = False) -> PROMOTION.FinalSnapshot:
    accepted = {}
    assets = {}
    ids = sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS) + [
        f"fm_pass_{index:02d}" for index in range(18)
    ]
    if extra_hold:
        ids.append("fm_unreviewed_hold")
    for index, sample_id in enumerate(ids, 1):
        if sample_id in PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS:
            image = held_image(255 if index % 2 else 254)
        elif sample_id == "fm_unreviewed_hold":
            image = held_image(253)
        else:
            image = pass_image()
        try:
            page_payload = PROMOTION._png_bytes(image)
            width, height = image.size
        finally:
            image.close()
        page_sha = PROMOTION.sha256_bytes(page_payload)
        descriptor = {
            "bbox_px": [0, 0, width, height],
            "decoded_mode": "RGB",
            "file_sha256": page_sha,
            "generated": False,
            "path": f"accepted-images/{sample_id}.png",
            "pixel_source": "direct_hash_verified_library_page_crop",
            "qa_overlay": False,
            "size_px": [width, height],
            "synthetic": False,
        }
        context = copy.deepcopy(descriptor)
        context["path"] = f"review-context/{sample_id}.png"
        row = PROMOTION.seal(
            {
                "accepted_bbox_px": [0, 0, width, height],
                "accepted_image": descriptor,
                "review_context": context,
                "sample_id": sample_id,
                "source_page": {
                    "decoded_mode": "RGB",
                    "file_sha256": page_sha,
                    "path": (f"works/work-a/chapters/chapter-a/pages/{sample_id}.png"),
                    "provenance": "real_preserved",
                    "size_bytes": len(page_payload),
                    "size_px": [width, height],
                    "storage_root": "library_root",
                },
            }
        )
        accepted[sample_id] = bound(row, index)
        assets[sample_id] = PROMOTION.FinalAssetSnapshot(
            accepted_payload=page_payload,
            context_payload=page_payload,
            source_page_payload=page_payload,
            accepted_file_sha256=page_sha,
            context_file_sha256=page_sha,
            source_page_file_sha256=page_sha,
        )
    fake_sha = PROMOTION.sha256_bytes(b"sealed-final-fixture")
    return PROMOTION.FinalSnapshot(
        root=Path("sealed-final-v3"),
        report={"record_sha256": fake_sha},
        marker={},
        accepted=accepted,
        terminal={},
        assets=assets,
        file_hashes={
            PROMOTION.FINAL_REPORT: fake_sha,
            PROMOTION.FINAL_ACCEPTED: PROMOTION.sha256_bytes(b"accepted"),
            PROMOTION.FINAL_TERMINAL: PROMOTION.sha256_bytes(b"terminal"),
        },
        marker_file_sha256=PROMOTION.sha256_bytes(b"marker"),
    )


def fake_promotion_snapshot(
    final: PROMOTION.FinalSnapshot,
    glyph_report: dict,
    review: PROMOTION.TerminalReviewSnapshot,
) -> PROMOTION.PromotionSnapshot:
    placeholder = mock.Mock()
    return PROMOTION.PromotionSnapshot(
        final=final,
        source_master=placeholder,
        registry=placeholder,
        registry_parent=placeholder,
        library_root=Path("library"),
        glyph_report=glyph_report,
        terminal_review=review,
    )


def augment_fixture_with_two_terminal_holds(
    base_fixture: base.PromotionFixture,
) -> None:
    held_catalog_id = "fontclip-hard-accepted-v2"
    held_catalog = base_fixture.root / "source-hard-held"
    held_specs = [
        (
            "fm_511d6cd195edb424c3f3efe7",
            "fhp_b1d571952f1bd221c0e181d0",
            254,
        ),
        (
            "fm_ef3d9054b5f850ddc134087e",
            "fhp_36acd28f1a33efde312e5dd5",
            253,
        ),
    ]
    base.write_jsonl(
        held_catalog / "manifest.jsonl",
        [
            {"id": source_id, "provenance": "real_processed"}
            for _sample_id, source_id, _background in held_specs
        ],
    )
    source_lines = (held_catalog / "manifest.jsonl").read_bytes().splitlines()

    master_rows = [
        json.loads(line)
        for line in (base_fixture.master / "manifest.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    accepted_rows = [
        json.loads(line)
        for line in (base_fixture.final / PROMOTION.FINAL_ACCEPTED)
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    parent_template = master_rows[0]
    accepted_template = accepted_rows[0]
    for index, (sample_id, source_id, background) in enumerate(held_specs, 1):
        page = held_image(background)
        try:
            page_payload = PROMOTION._png_bytes(page)
            page_size = [page.width, page.height]
        finally:
            page.close()
        page_sha = PROMOTION.sha256_bytes(page_payload)
        page_relative = (
            f"works/{base_fixture.work_id}/chapters/{base_fixture.chapter_id}/"
            f"pages/held-{index}.png"
        )
        page_path = base_fixture.library / Path(*Path(page_relative).parts)
        page_path.write_bytes(page_payload)
        source_line_number = index
        source_line_sha = PROMOTION.sha256_bytes(source_lines[source_line_number - 1])

        parent = copy.deepcopy(parent_template)
        parent["id"] = sample_id
        parent["sample_crop_sha256"] = PROMOTION.sha256_bytes(
            f"held-crop-{index}".encode()
        )
        parent["groups"] = {
            "normalized_glyph": "glyph-white-sha256:" + str(index) * 64,
            "root": f"{base_fixture.catalog_id}:held-{index}",
            "split_component": f"held-component-{index}",
            "variant": f"{base_fixture.catalog_id}:held-{index}",
        }
        parent["geometry"] = {
            "bbox_px": [0, 0, *page_size],
            "crop_bbox_px": [0, 0, *page_size],
            "final_bbox_px": [0, 0, *page_size],
            "mask_tight_bbox_px": [0, 0, *page_size],
            "page_size_px": page_size,
        }
        parent["page"] = {
            "id": f"held-page-{index}",
            "name": f"held-{index}.png",
            "source_locator": {
                "file_sha256": page_sha,
                "path": page_relative,
                "provenance": "real_preserved",
                "resolution_contract": ("resolve against caller-supplied library_root"),
                "size_bytes": len(page_payload),
                "size_px": page_size,
                "storage_root": "library_root",
            },
            "source_page_sha256": page_sha,
        }
        parent["provenance"]["source_id"] = source_id
        parent["provenance"]["source_catalog_id"] = held_catalog_id
        parent["provenance"]["source_line_number"] = source_line_number
        parent["provenance"]["source_line_sha256"] = source_line_sha
        master_rows.append(parent)

        accepted = copy.deepcopy(accepted_template)
        accepted.pop("record_sha256", None)
        accepted["sample_id"] = sample_id
        accepted["accepted_bbox_px"] = [0, 0, *page_size]
        accepted["orientation"] = "horizontal"
        accepted["accepted_image"] = {
            "bbox_px": [0, 0, *page_size],
            "decoded_mode": "RGB",
            "file_sha256": page_sha,
            "generated": False,
            "path": f"accepted-images/{sample_id}.png",
            "pixel_source": "direct_hash_verified_library_page_crop",
            "qa_overlay": False,
            "size_px": page_size,
            "synthetic": False,
        }
        accepted["review_context"] = {
            **copy.deepcopy(accepted["accepted_image"]),
            "path": f"review-context/{sample_id}.png",
        }
        accepted["source_page"] = {
            "decoded_mode": "RGB",
            "file_sha256": page_sha,
            "path": page_relative,
            "provenance": "real_preserved",
            "size_bytes": len(page_payload),
            "size_px": page_size,
            "storage_root": "library_root",
        }
        (base_fixture.final / accepted["accepted_image"]["path"]).write_bytes(
            page_payload
        )
        (base_fixture.final / accepted["review_context"]["path"]).write_bytes(
            page_payload
        )
        accepted_rows.append(PROMOTION.seal(accepted))

    base.write_jsonl(base_fixture.master / "manifest.jsonl", master_rows)
    base_fixture._refresh_master_report()
    base.write_jsonl(base_fixture.final / PROMOTION.FINAL_ACCEPTED, accepted_rows)
    base_fixture._refresh_final_metadata()
    registry_snapshot = base.REGISTRY.build_registry_snapshot(
        catalog_specs=[
            (base_fixture.catalog_id, "hard", str(base_fixture.catalog)),
            (held_catalog_id, "hard", str(held_catalog)),
        ],
        exclusion_ledgers=[],
        parent_master_manifest=None,
        frozen_split_map=base_fixture.registry_dir / "split-map.json",
    )
    base_fixture.registry.write_bytes(registry_snapshot.payload)


class FontSignalTerminalFinalizerTests(unittest.TestCase):
    def test_production_allowlist_is_exact_and_cli_requires_both_ids(self) -> None:
        self.assertEqual(
            PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS,
            {
                "fm_511d6cd195edb424c3f3efe7",
                "fm_ef3d9054b5f850ddc134087e",
            },
        )
        self.assertEqual(
            FINALIZER._normalized_ids(sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)),
            set(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS),
        )
        for invalid in (
            [next(iter(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS))],
            [*sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS), "fm_other"],
            [
                sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)[0],
                sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)[0],
            ],
        ):
            with self.subTest(invalid=invalid), self.assertRaises(
                FINALIZER.TerminalFinalizationError
            ):
                FINALIZER._normalized_ids(invalid)

    def test_sealed_review_binds_crop_context_page_and_promotes_only_18(self) -> None:
        final = fake_final()
        glyph_report = PROMOTION._glyph_preflight_report(final)
        FINALIZER._require_exact_hold_population(final, glyph_report)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "terminal-review"
            report = FINALIZER._write_tree(
                physical_root=output,
                declared_root=output,
                final=final,
                glyph_report=glyph_report,
                reviewer="codex-root-direct-review-v4",
                library_root=Path("library"),
            )
            review = PROMOTION.load_terminal_review_snapshot(
                output,
                final=final,
                glyph_report=glyph_report,
            )
            eligible, terminal = PROMOTION._resolved_promotion_ids(
                fake_promotion_snapshot(final, glyph_report, review)
            )
            self.assertEqual(len(eligible), 18)
            self.assertEqual(terminal, set(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS))
            self.assertEqual(report["counts"]["replacement_pixels_created"], 0)
            for terminal_id, terminal_row in review.records.items():
                bindings = terminal_row.row["bindings"]
                self.assertEqual(
                    bindings["accepted_image_file_sha256"],
                    final.assets[terminal_id].accepted_file_sha256,
                )
                self.assertEqual(
                    bindings["review_context_file_sha256"],
                    final.assets[terminal_id].context_file_sha256,
                )
                self.assertEqual(
                    bindings["source_page_file_sha256"],
                    final.assets[terminal_id].source_page_file_sha256,
                )
                self.assertFalse(
                    terminal_row.row["generated_or_synthetic_repair_authorized"]
                )

    def test_unreviewed_or_different_hold_fails_closed(self) -> None:
        final = fake_final(extra_hold=True)
        glyph_report = PROMOTION._glyph_preflight_report(final)
        with self.assertRaisesRegex(
            FINALIZER.TerminalFinalizationError,
            "exactly the two approved contaminated samples",
        ):
            FINALIZER._require_exact_hold_population(final, glyph_report)

        clean_final = fake_final()
        clean_report = PROMOTION._glyph_preflight_report(clean_final)
        records = PROMOTION._glyph_records_by_id(clean_report)
        sample_id = sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)[0]
        records[sample_id]["review_hold_reasons"] = ["some_other_hold"]
        with self.assertRaisesRegex(
            PROMOTION.FontSignalPromotionError, "exact irreducible art hold"
        ):
            PROMOTION.terminal_review_record_core(
                clean_final,
                sample_id=sample_id,
                glyph_record=records[sample_id],
                reviewer="reviewer-v1",
            )

    def test_tamper_source_mutation_overlap_and_existing_output_fail_closed(
        self,
    ) -> None:
        final = fake_final()
        glyph_report = PROMOTION._glyph_preflight_report(final)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "terminal-review"
            FINALIZER._write_tree(
                physical_root=output,
                declared_root=output,
                final=final,
                glyph_report=glyph_report,
                reviewer="reviewer-v1",
                library_root=Path("library"),
            )
            ledger = output / PROMOTION.TERMINAL_REVIEW_LEDGER
            ledger.write_bytes(ledger.read_bytes() + b"tamper")
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "managed artifact drifted"
            ):
                PROMOTION.load_terminal_review_snapshot(
                    output,
                    final=final,
                    glyph_report=glyph_report,
                )

            final_root = root / "final"
            library_root = root / "library"
            final_root.mkdir()
            library_root.mkdir()
            existing = root / "existing"
            existing.mkdir()
            with self.assertRaisesRegex(
                FINALIZER.TerminalFinalizationError, "already exists"
            ):
                FINALIZER._validate_paths(
                    final_root=final_root,
                    library_root=library_root,
                    output_root=existing,
                    require_output_absent=True,
                )
            with self.assertRaisesRegex(
                PROMOTION.FontSignalPromotionError, "separate, non-nested roots"
            ):
                FINALIZER._validate_paths(
                    final_root=final_root,
                    library_root=library_root,
                    output_root=final_root / "nested",
                    require_output_absent=True,
                )

        mutated = fake_final()
        mutated_report = PROMOTION._glyph_preflight_report(mutated)
        sample_id = sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)[0]
        original = mutated.assets[sample_id]
        mutated.assets[sample_id] = PROMOTION.FinalAssetSnapshot(
            accepted_payload=original.accepted_payload + b"mutation",
            context_payload=original.context_payload,
            source_page_payload=original.source_page_payload,
            accepted_file_sha256=original.accepted_file_sha256,
            context_file_sha256=original.context_file_sha256,
            source_page_file_sha256=original.source_page_file_sha256,
        )
        with self.assertRaisesRegex(
            PROMOTION.FontSignalPromotionError, "snapshot hash drifted"
        ):
            PROMOTION.terminal_review_record_core(
                mutated,
                sample_id=sample_id,
                glyph_record=PROMOTION._glyph_records_by_id(mutated_report)[sample_id],
                reviewer="reviewer-v1",
            )

    def test_terminal_parent_exclusion_has_no_successor_or_replacement(self) -> None:
        final = fake_final()
        glyph_report = PROMOTION._glyph_preflight_report(final)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "terminal-review"
            FINALIZER._write_tree(
                physical_root=output,
                declared_root=output,
                final=final,
                glyph_report=glyph_report,
                reviewer="reviewer-v1",
                library_root=Path("library"),
            )
            review = PROMOTION.load_terminal_review_snapshot(
                output, final=final, glyph_report=glyph_report
            )
            sample_id = sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)[0]
            source_parent = bound(
                {"id": sample_id, "provenance": {"source_id": "source-a"}}, 1
            )
            registry_parent = bound(
                {
                    "id": sample_id,
                    "provenance": {
                        "source_catalog_id": "catalog-a",
                        "source_id": "source-a",
                        "source_line_number": 1,
                        "source_line_sha256": "a" * 64,
                    },
                },
                1,
            )
            exclusion = PROMOTION._build_terminal_parent_exclusion(
                catalog_id="replacement-catalog",
                sample_id=sample_id,
                accepted=final.accepted[sample_id],
                source_parent=source_parent,
                registry_parent=registry_parent,
                terminal_review=review.records[sample_id],
            )
            PROMOTION.validate_seal(exclusion, "terminal exclusion")
            self.assertTrue(exclusion["excluded_from_training"])
            self.assertTrue(exclusion["excluded_from_font_review"])
            self.assertIsNone(exclusion["successor_catalog_id"])
            self.assertIsNone(exclusion["successor_source_id"])
            self.assertFalse(exclusion["replacement_pixels_created"])
            self.assertFalse(exclusion["synthetic"])

    def test_end_to_end_promoter_materializes_passes_and_excludes_all_parents(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = base.PromotionFixture(Path(temporary))
            augment_fixture_with_two_terminal_holds(fixture)
            terminal_root = fixture.root / "terminal-resolution"
            explicit_ids = [
                value
                for sample_id in sorted(PROMOTION.TERMINAL_REVIEW_ALLOWED_IDS)
                for value in ("--exclude-id", sample_id)
            ]
            terminal_args = [
                "build",
                "--final-root",
                str(fixture.final),
                "--library-root",
                str(fixture.library),
                "--output-root",
                str(terminal_root),
                "--reviewer",
                "reviewer-v1",
                *explicit_ids,
                "--expected-accepted",
                "3",
                "--expected-terminal",
                "0",
            ]
            self.assertEqual(FINALIZER.main(terminal_args), 0)

            promotion_args = fixture.args(
                "build", expected_accepted=3, expected_terminal=0
            )
            promotion_args.extend(
                ["--terminal-exclusion-review-root", str(terminal_root)]
            )
            self.assertEqual(PROMOTION.main(promotion_args), 0)
            manifest = PROMOTION._read_bound_jsonl(
                fixture.output / PROMOTION.MANIFEST_FILE, "manifest"
            )
            exclusions = PROMOTION._read_bound_jsonl(
                fixture.output / PROMOTION.EXCLUSIONS_FILE, "exclusions"
            )
            reviewed = PROMOTION._read_bound_jsonl(
                fixture.output / PROMOTION.REVIEWED_TERMINAL_FILE,
                "reviewed terminal",
            )
            report = PROMOTION.validate_tree(fixture.output)
            self.assertEqual(len(manifest), 1)
            self.assertEqual(len(exclusions), 3)
            self.assertEqual(len(reviewed), 2)
            self.assertEqual(report["counts"]["promoted_successors"], 1)
            self.assertEqual(report["counts"]["human_reviewed_terminal_exclusions"], 2)
            self.assertEqual(report["counts"]["parents_excluded"], 3)
            terminal_exclusions = [
                row.row for row in exclusions if row.row.get("terminal_exclusion")
            ]
            self.assertEqual(len(terminal_exclusions), 2)
            self.assertTrue(
                all(row["successor_source_id"] is None for row in terminal_exclusions)
            )

            registry_input = PROMOTION._read_json(
                fixture.output / PROMOTION.REGISTRY_INPUT_FILE,
                "registry input",
            )
            new_ledger = next(
                ledger
                for ledger in registry_input["exclusion_ledgers"]
                if Path(ledger["path"]) == fixture.output / PROMOTION.EXCLUSIONS_FILE
            )
            self.assertEqual(new_ledger["expected_rows"], 3)
            registry_argv = registry_input["build_registry_command_argv"][2:]
            self.assertEqual(base.REGISTRY.main(registry_argv), 0)


if __name__ == "__main__":
    unittest.main()
