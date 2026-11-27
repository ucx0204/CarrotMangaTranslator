"""Run the pinned 1920px detector. Transfer FP32 only for qualifying queries."""
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import zipfile

SOURCE_SHA = "b2f8807dfd00adc82233f4456e79a32fdc32d658ddb2a7a0182c523c638e52ea"
SPARSE_SHA = "649ee56450d34f009b0912b335a0e16b60ea9d03ae2be14a6f1468e1662b302a"
WHEEL_SHA = "cf494da233f3fc02bbeb2a3178e3ace7361b6b4fef7031b19c1e5aed5e9328ce"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def sparse_model(source, cache):
    # The short protobuf splices replace the final dense Einsum by
    # Gather(queries with max logit > -1.13) -> MatMul -> original bias.
    # All trained weights, boxes and logits are copied verbatim.
    target = cache / "model-sparse-fp32-v1.onnx"
    if target.is_file() and digest(target) == SPARSE_SHA:
        return target
    original = source.read_bytes()
    if hashlib.sha256(original).hexdigest() != SOURCE_SHA:
        raise ValueError("Unrecognized KoharuLayout model revision")
    parts = json.loads(Path(__file__).with_name("koharu-sparse-model.json").read_text("utf-8"))
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as stage:
        name = Path(stage.name)
        for part in parts:
            stage.write(memoryview(original)[slice(*part)] if isinstance(part, list) else base64.b64decode(part))
    try:
        if digest(name) != SPARSE_SHA:
            raise ValueError("Sparse KoharuLayout graph verification failed")
        os.replace(name, target)
    finally:
        name.unlink(missing_ok=True)
    return target


def runtime(wheel):
    if digest(wheel) != WHEEL_SHA:
        raise ValueError("ONNX Runtime CUDA wheel verification failed")
    package = wheel.parent / ("ort-" + WHEEL_SHA[:16])
    with zipfile.ZipFile(wheel) as archive:
        record = next(n for n in archive.namelist() if n.endswith(".dist-info/RECORD"))
        with archive.open(record) as manifest:
            rows = list(csv.reader(io.TextIOWrapper(manifest, encoding="utf-8")))
        for name, checksum, size in rows:
            entry = Path(name)
            if entry.parts[:1] != ("onnxruntime",) or ".." in entry.parts or entry.is_absolute():
                continue
            if entry.suffix not in (".dll", ".pyd", ".py") or "tensorrt" in entry.name:
                continue
            if not checksum.startswith("sha256="):
                raise ValueError("Missing CUDA runtime file hash")
            expected = base64.urlsafe_b64decode(checksum[7:] + "==").hex()
            target = package / entry
            if target.is_file() and target.stat().st_size == int(size) and digest(target) == expected:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as staged:
                path = Path(staged.name)
                with archive.open(name) as src:
                    shutil.copyfileobj(src, staged)
            try:
                if digest(path) != expected:
                    raise ValueError("CUDA runtime file verification failed")
                os.replace(path, target)
            finally:
                path.unlink(missing_ok=True)
    return package


def start(config):
    wheel = Path(config["wheel"])
    model = sparse_model(Path(config["model"]), wheel.parent)
    package = runtime(wheel)
    sys.path.insert(0, str(package))
    torchlib = Path(sys.executable).parent / "Lib/site-packages/torch/lib"
    dll = os.add_dll_directory(str(torchlib))
    import onnxruntime as ort
    ort.preload_dlls(directory=str(torchlib))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    providers = [("CUDAExecutionProvider", {
        "device_id": "0", "gpu_mem_limit": str(int(5.1 * 1024**3)),
        "arena_extend_strategy": "kSameAsRequested", "use_tf32": "0",
        "cudnn_conv_algo_search": "HEURISTIC", "cudnn_conv_use_max_workspace": "0",
    })]
    session = ort.InferenceSession(str(model), options, providers=providers)
    if session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDA execution provider is unavailable")
    return session, dll


def run():
    session = None
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("type") == "shutdown":
            break
        reply = {"id": request["id"], "ok": False}
        try:
            config = json.loads(Path(request["config"]).read_text("utf-8"))
            if session is None:
                session, dll = start(config)
            import numpy as np
            chw = np.fromfile(config["input"], dtype="<f4").reshape(1, 3, 1920, 1920)
            boxes, labels, masks, ids = session.run(["dets", "labels", "masks", "queries"], {"input": chw})
            with open(config["output"], "wb") as output:
                output.write(struct.pack("<I", ids.size))
                ids.astype("<u4").tofile(output)
                for data in (boxes, labels, masks):
                    data.astype("<f4", copy=False).tofile(output)
            reply["ok"] = True
        except Exception as error:
            reply["error"] = str(error)
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    run()
