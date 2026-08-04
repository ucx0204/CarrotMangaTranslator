from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "run_manga_font_hidden_cache_resilient.py"
BUILDER = ROOT / "scripts" / "build_manga_font_master_v3_siglip2_hidden_cache.py"
EXPECTED_BUILDER_SHA256 = (
    "d4c3147c0cb33d9cded2d77af78dcc5305df5a2c7ad5928698891b16c0e9d17f"
)
SPEC = importlib.util.spec_from_file_location(
    "run_manga_font_hidden_cache_resilient_tested", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNNER
SPEC.loader.exec_module(RUNNER)


def winerror(code: int) -> PermissionError:
    error = PermissionError(13, "injected access error")
    error.winerror = code
    return error


class HiddenCacheResilientRunnerTest(unittest.TestCase):
    def test_retryable_winerror_5_then_success(self) -> None:
        calls: list[tuple[object, object, tuple[object, ...], dict[str, object]]] = []
        sleeps: list[float] = []

        def flaky_replace(
            source: object,
            destination: object,
            *args: object,
            **kwargs: object,
        ) -> str:
            calls.append((source, destination, args, kwargs))
            if len(calls) < 3:
                raise winerror(5)
            return "published"

        replace = RUNNER.make_retrying_replace(
            flaky_replace,
            max_attempts=4,
            initial_delay_seconds=0.1,
            max_delay_seconds=1.0,
            sleep=sleeps.append,
            report=lambda _message: None,
        )

        result = replace("staging", "final", "opaque", marker=True)

        self.assertEqual(result, "published")
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [0.1, 0.2])
        self.assertEqual(calls[-1], ("staging", "final", ("opaque",), {"marker": True}))

    def test_non_retryable_replace_error_fails_immediately(self) -> None:
        calls = 0
        sleeps: list[float] = []

        def failing_replace(_source: object, _destination: object) -> None:
            nonlocal calls
            calls += 1
            raise winerror(32)

        replace = RUNNER.make_retrying_replace(
            failing_replace,
            max_attempts=5,
            sleep=sleeps.append,
            report=lambda _message: None,
        )

        with self.assertRaises(PermissionError) as caught:
            replace("staging", "final")

        self.assertEqual(caught.exception.winerror, 32)
        self.assertEqual(calls, 1)
        self.assertEqual(sleeps, [])

    def test_builder_sha_file_identity_and_argv_are_preserved(self) -> None:
        before = hashlib.sha256(BUILDER.read_bytes()).hexdigest()
        self.assertEqual(before, EXPECTED_BUILDER_SHA256)
        self.assertEqual(RUNNER.BUILDER_PATH, BUILDER)

        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            fake_builder = temporary_root / "fake-builder.py"
            record = temporary_root / "record.json"
            fake_builder.write_text(
                "from pathlib import Path\n"
                "import json\n"
                "import sys\n"
                "Path(sys.argv[1]).write_text(json.dumps({\n"
                "    'argv': sys.argv,\n"
                "    'file': __file__,\n"
                "    'name': __name__,\n"
                "}), encoding='utf-8')\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            forwarded = (str(record), "build", "--resume", "value with spaces")
            original_argv = sys.argv
            original_replace = os.replace

            exit_code = RUNNER.run_builder(
                forwarded,
                builder_path=fake_builder,
                max_attempts=2,
            )

            observed = json.loads(record.read_text(encoding="utf-8"))
            self.assertEqual(exit_code, 0)
            self.assertEqual(
                observed["argv"],
                [str(fake_builder.resolve()), *forwarded],
            )
            self.assertEqual(observed["file"], str(fake_builder.resolve()))
            self.assertEqual(observed["name"], "__main__")
            self.assertIs(sys.argv, original_argv)
            self.assertIs(os.replace, original_replace)

        after = hashlib.sha256(BUILDER.read_bytes()).hexdigest()
        self.assertEqual(after, EXPECTED_BUILDER_SHA256)


if __name__ == "__main__":
    unittest.main()
