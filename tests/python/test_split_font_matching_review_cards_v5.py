from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "split_font_matching_review_cards_v5.py"
SPEC = importlib.util.spec_from_file_location(
    "split_font_matching_review_cards_v5", SCRIPT
)
assert SPEC and SPEC.loader
SPLIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SPLIT)


class SplitCardsFixture:
    def __init__(self, root: Path, *, separated: bool = True) -> None:
        self.root = root
        self.source = root / "source"
        self.source.mkdir(parents=True)
        cards = self.source / "cards"
        cards.mkdir()
        image = Image.new("RGB", (SPLIT.FULL_WIDTH, SPLIT.FULL_HEIGHT), (220, 30, 30))
        for y in range(SPLIT.SOURCE_BOTTOM, SPLIT.FULL_HEIGHT):
            for x in range(SPLIT.FULL_WIDTH):
                image.putpixel((x, y), (20, 40, 220))
        self.card = cards / "assignment-1.png"
        image.save(self.card, format="PNG", compress_level=9)
        self.manifest = self.source / "manifest.json"
        document = {
            "renderer_hash": "a" * 64,
            "qa_overlay": True,
            "training_asset": False,
            "card_count": 1,
            "card_render_contract": {
                "probe_profile": "v4",
                "canvas_px": [SPLIT.FULL_WIDTH, SPLIT.FULL_HEIGHT],
                "source_stage_visually_separated": separated,
            },
            "cards": [
                {
                    "assignment": {
                        "assignment_id": "assignment-1",
                        "sample_id": "sample-1",
                        "stage": "primary",
                    },
                    "artifact": {
                        "file": "cards/assignment-1.png",
                        "sha256": SPLIT.sha256_file(self.card),
                        "width": SPLIT.FULL_WIDTH,
                        "height": SPLIT.FULL_HEIGHT,
                    },
                }
            ],
        }
        self.manifest.write_text(json.dumps(document), encoding="utf-8")


class ReviewCardSplitV5Tests(unittest.TestCase):
    def setUp(self) -> None:
        self._constants = (
            SPLIT.FULL_WIDTH,
            SPLIT.FULL_HEIGHT,
            SPLIT.SOURCE_BOTTOM,
            SPLIT.SOURCE_SIZE,
            SPLIT.CANDIDATE_SIZE,
        )
        SPLIT.FULL_WIDTH = 24
        SPLIT.FULL_HEIGHT = 58
        SPLIT.SOURCE_BOTTOM = 14
        SPLIT.SOURCE_SIZE = (24, 14)
        SPLIT.CANDIDATE_SIZE = (24, 44)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        (
            SPLIT.FULL_WIDTH,
            SPLIT.FULL_HEIGHT,
            SPLIT.SOURCE_BOTTOM,
            SPLIT.SOURCE_SIZE,
            SPLIT.CANDIDATE_SIZE,
        ) = self._constants
        self.temporary.cleanup()

    def test_production_boundary_is_frozen(self) -> None:
        width, height, bottom, source_size, candidate_size = self._constants
        self.assertEqual((2400, 5840, 1412), (width, height, bottom))
        self.assertEqual((2400, 1412), source_size)
        self.assertEqual((2400, 4428), candidate_size)

    def test_build_is_lossless_sealed_and_deterministic(self) -> None:
        fixture = SplitCardsFixture(self.root)
        first = self.root / "split-a"
        second = self.root / "split-b"
        nested = self.root / "new-parent" / "split-c"
        report_a = SPLIT.build(fixture.manifest, first)
        report_b = SPLIT.build(fixture.manifest, second)
        report_c = SPLIT.build(fixture.manifest, nested)
        self.assertEqual(report_a["record_sha256"], report_b["record_sha256"])
        self.assertEqual(report_a["record_sha256"], report_c["record_sha256"])
        self.assertEqual(1, report_a["card_count"])
        SPLIT.validate_tree(first)
        row = report_a["cards"][0]
        with Image.open(first / row["source_only"]["file"]) as source:
            self.assertEqual((24, 14), source.size)
            self.assertEqual({(220, 30, 30)}, set(source.getdata()))
        with Image.open(first / row["candidate_only"]["file"]) as candidate:
            self.assertEqual((24, 44), candidate.size)
            self.assertEqual({(20, 40, 220)}, set(candidate.getdata()))
        self.assertEqual(
            (first / SPLIT.MARKER_FILE).read_bytes(),
            (second / SPLIT.MARKER_FILE).read_bytes(),
        )

    def test_tampered_split_or_source_fails_closed(self) -> None:
        fixture = SplitCardsFixture(self.root)
        output = self.root / "split"
        report = SPLIT.build(fixture.manifest, output)
        candidate = output / report["cards"][0]["candidate_only"]["file"]
        candidate.write_bytes(candidate.read_bytes() + b"tamper")
        with self.assertRaisesRegex(SPLIT.SplitCardError, "inventory drifted"):
            SPLIT.validate_tree(output)

        output_two = self.root / "split-two"
        SPLIT.build(fixture.manifest, output_two)
        fixture.card.write_bytes(fixture.card.read_bytes() + b"tamper")
        with self.assertRaisesRegex(SPLIT.SplitCardError, "file SHA drifted"):
            SPLIT.validate_tree(output_two)

    def test_contract_and_path_overlap_are_rejected(self) -> None:
        fixture = SplitCardsFixture(self.root, separated=False)
        with self.assertRaisesRegex(SPLIT.SplitCardError, "visual separation"):
            SPLIT.build(fixture.manifest, self.root / "split")

        valid_root = self.root / "valid"
        valid = SplitCardsFixture(valid_root)
        with self.assertRaisesRegex(SPLIT.SplitCardError, "inside source"):
            SPLIT.build(valid.manifest, valid.source / "nested-output")


if __name__ == "__main__":
    unittest.main()
