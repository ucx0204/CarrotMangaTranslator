"""Keep native print-repair libraries warm for one erasure lease."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys

SCRIPTS = {
    "qwen_layered_ink.py", "qwen_jacket_plane.py", "qwen_cover_residual.py",
    "qwen-screen-detail.py", "qwen-reconnect-balloon.py", "qwen_screen_transfer.py",
    "qwen-motion-lines.py", "qwen-register-contours.py", "qwen-register-substrate.py",
    "qwen-title-stock.py", "qwen-restore-illustration.py",
}


def execute(script, arguments):
    if script not in SCRIPTS:
        raise ValueError("Unknown native print operation")
    path = str(Path(__file__).with_name(script))
    argv, paths = sys.argv, list(sys.path)
    output = io.StringIO()
    try:
        sys.argv = [path, *arguments]
        sys.path.insert(0, str(Path(path).parent))
        with contextlib.redirect_stdout(output):
            try:
                runpy.run_path(path, run_name="__main__")
            except SystemExit as exit_status:
                if exit_status.code not in (0, None):
                    raise RuntimeError(str(exit_status)) from exit_status
    finally:
        sys.argv = argv
        sys.path[:] = paths
    return output.getvalue()


if __name__ == "__main__":
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("type") == "shutdown":
            break
        response = {"id": request["id"], "ok": False}
        try:
            response["stdout"] = execute(request["script"], request["args"])
            response["ok"] = True
        except Exception as error:
            response["error"] = str(error)
        print(json.dumps(response), flush=True)
