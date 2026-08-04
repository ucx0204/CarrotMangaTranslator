#!/usr/bin/env python3
"""Run the sealed hidden-cache builder with narrow Windows rename retries.

The builder source is deliberately executed as-is so its ``__file__`` and
source hash remain bound to the original builder.  This wrapper changes only
``os.replace`` for the duration of that execution, and retries only Windows
``ERROR_ACCESS_DENIED`` (WinError 5).  Every other failure is raised
immediately.
"""

from __future__ import annotations

import functools
import os
import runpy
import sys
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any


BUILDER_PATH = (
    Path(__file__).resolve().parent
    / "build_manga_font_master_v3_siglip2_hidden_cache.py"
)
MAX_ATTEMPTS_ENV = "MANGA_FONT_HIDDEN_CACHE_REPLACE_MAX_ATTEMPTS"
DEFAULT_MAX_ATTEMPTS = 12
DEFAULT_INITIAL_DELAY_SECONDS = 0.10
DEFAULT_MAX_DELAY_SECONDS = 1.00
WINDOWS_ERROR_ACCESS_DENIED = 5

ReplaceFunction = Callable[..., Any]
SleepFunction = Callable[[float], None]
ReportFunction = Callable[[str], None]


def _stderr_report(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def is_retryable_replace_error(error: OSError) -> bool:
    """Return true only for Windows ERROR_ACCESS_DENIED from ``os.replace``."""

    return getattr(error, "winerror", None) == WINDOWS_ERROR_ACCESS_DENIED


def make_retrying_replace(
    original_replace: ReplaceFunction,
    *,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    initial_delay_seconds: float = DEFAULT_INITIAL_DELAY_SECONDS,
    max_delay_seconds: float = DEFAULT_MAX_DELAY_SECONDS,
    sleep: SleepFunction = time.sleep,
    report: ReportFunction = _stderr_report,
) -> ReplaceFunction:
    """Wrap ``os.replace`` with bounded exponential retries for WinError 5."""

    if isinstance(max_attempts, bool) or max_attempts < 1:
        raise ValueError("max_attempts must be a positive integer")
    if initial_delay_seconds < 0 or max_delay_seconds < 0:
        raise ValueError("retry delays must be non-negative")

    @functools.wraps(original_replace)
    def replace_with_retry(
        source: os.PathLike[str] | str | bytes,
        destination: os.PathLike[str] | str | bytes,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        for attempt in range(1, max_attempts + 1):
            try:
                return original_replace(source, destination, *args, **kwargs)
            except OSError as error:
                if not is_retryable_replace_error(error) or attempt >= max_attempts:
                    raise
                delay = min(
                    initial_delay_seconds * (2 ** (attempt - 1)),
                    max_delay_seconds,
                )
                report(
                    "hidden-cache os.replace hit transient WinError 5; "
                    f"retry {attempt + 1}/{max_attempts} in {delay:.2f}s: "
                    f"{source!s} -> {destination!s}"
                )
                sleep(delay)
        raise AssertionError("unreachable os.replace retry state")

    return replace_with_retry


def run_builder(
    builder_argv: Sequence[str],
    *,
    builder_path: Path = BUILDER_PATH,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    initial_delay_seconds: float = DEFAULT_INITIAL_DELAY_SECONDS,
    max_delay_seconds: float = DEFAULT_MAX_DELAY_SECONDS,
) -> int:
    """Execute the original builder as ``__main__`` with unchanged arguments."""

    resolved_builder = builder_path.resolve(strict=True)
    original_argv = sys.argv
    original_replace = os.replace
    sys.argv = [os.fspath(resolved_builder), *builder_argv]
    os.replace = make_retrying_replace(
        original_replace,
        max_attempts=max_attempts,
        initial_delay_seconds=initial_delay_seconds,
        max_delay_seconds=max_delay_seconds,
    )
    try:
        try:
            runpy.run_path(os.fspath(resolved_builder), run_name="__main__")
        except SystemExit as error:
            if error.code is None:
                return 0
            if isinstance(error.code, int):
                return error.code
            raise
        return 0
    finally:
        os.replace = original_replace
        sys.argv = original_argv


def _max_attempts_from_environment() -> int:
    raw = os.environ.get(MAX_ATTEMPTS_ENV)
    if raw is None:
        return DEFAULT_MAX_ATTEMPTS
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{MAX_ATTEMPTS_ENV} must be an integer") from error
    if not 1 <= value <= 50:
        raise ValueError(f"{MAX_ATTEMPTS_ENV} must be between 1 and 50")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    forwarded = tuple(sys.argv[1:] if argv is None else argv)
    return run_builder(
        forwarded,
        max_attempts=_max_attempts_from_environment(),
    )


if __name__ == "__main__":
    raise SystemExit(main())
