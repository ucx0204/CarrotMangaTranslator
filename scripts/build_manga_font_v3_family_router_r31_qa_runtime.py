"""Fuse the R31 replacement family router into a QA-only font runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import (
        build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export,
    )
    from scripts import screen_manga_font_v3_page_family_router_r31 as r31
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export
    import screen_manga_font_v3_page_family_router_r31 as r31


HEAD_DIR = Path("artifacts/manga-font-v3-page-family-router-r31-local-mlp32-qa-v1")
CHECKPOINT_FILE = "family-router.safetensors"


def _learned_layer_norm(nodes: list[Any], helper: Any, source: str, name: str) -> str:
    normalized = r29_export._layer_norm(nodes, helper, source, name, 32)
    scaled = f"{name}_scaled"
    output = f"{name}_learned"
    nodes.extend(
        [
            helper.make_node("Mul", [normalized, "r31_hidden_norm_weight"], [scaled]),
            helper.make_node("Add", [scaled, "r31_hidden_norm_bias"], [output]),
        ]
    )
    return output


def fuse_ranker(base_ranker: Path, checkpoint: Path, output: Path) -> Mapping[str, Any]:
    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper
    from safetensors.torch import load_file

    model = onnx.load(str(base_ranker))
    graph = model.graph
    r29_export._rename_tensor(graph, "role_logits", "r31_anchor_role_logits")

    state = dict(load_file(str(checkpoint), device="cpu"))
    expected = {
        "anchor.weight",
        "hidden_norm.bias",
        "hidden_norm.weight",
        "local.weight",
        "output.bias",
        "output.weight",
    }
    if set(state) != expected:
        raise RuntimeError("R31 checkpoint inventory drifted")
    expected_shapes = {
        "anchor.weight": (32, 2),
        "hidden_norm.bias": (32,),
        "hidden_norm.weight": (32,),
        "local.weight": (32, 1024),
        "output.bias": (2,),
        "output.weight": (2, 32),
    }
    if any(
        tuple(state[name].shape) != shape for name, shape in expected_shapes.items()
    ):
        raise RuntimeError("R31 checkpoint shape drifted")

    initializers = [
        r29_export._initializer(
            helper, "r31_query_starts", np.asarray([256], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_query_ends", np.asarray([1280], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_query_axes", np.asarray([2], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_query_steps", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_family_indices", np.asarray([0, 5], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_body_starts", np.asarray([0], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_body_ends", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_body_axes", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_body_steps", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_variant_starts", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_variant_ends", np.asarray([2], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_variant_axes", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r31_variant_steps", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r29_norm_epsilon", np.asarray([1e-6], dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r29_layer_norm_epsilon", np.asarray([1e-5], dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r31_gelu_half", np.asarray([0.5], dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r31_gelu_one", np.asarray([1.0], dtype=np.float32)
        ),
        r29_export._initializer(
            helper,
            "r31_gelu_sqrt_two",
            np.asarray([np.sqrt(2.0)], dtype=np.float32),
        ),
        r29_export._initializer(
            helper, "r31_zero", np.asarray([0.0], dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r31_negative_twenty", np.asarray([-20.0], dtype=np.float32)
        ),
        r29_export._initializer(
            helper,
            "r31_local_weight",
            state["local.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r31_anchor_weight",
            state["anchor.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r31_hidden_norm_weight",
            state["hidden_norm.weight"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r31_hidden_norm_bias",
            state["hidden_norm.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r31_output_weight",
            state["output.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r31_output_bias",
            state["output.bias"].numpy().astype(np.float32),
        ),
    ]
    existing_initializers = {value.name for value in graph.initializer}
    graph.initializer.extend(
        [value for value in initializers if value.name not in existing_initializers]
    )

    nodes: list[Any] = []
    r29_export._slice(nodes, helper, "views", "r31_query_views", "r31_query")
    nodes.append(
        helper.make_node(
            "ReduceMean", ["r31_query_views"], ["r31_local_mean"], axes=[1], keepdims=0
        )
    )
    local = r29_export._l2_normalize(
        nodes, helper, "r31_local_mean", "r31_local", axis=1
    )
    nodes.append(
        helper.make_node(
            "Gather",
            ["r31_anchor_role_logits", "r31_family_indices"],
            ["r31_anchor_family_logits"],
            axis=1,
        )
    )
    local_norm = r29_export._layer_norm(nodes, helper, local, "r31_local_ln", 1024)
    anchor_norm = r29_export._layer_norm(
        nodes, helper, "r31_anchor_family_logits", "r31_anchor_ln", 2
    )
    nodes.extend(
        [
            helper.make_node(
                "MatMul", [local_norm, "r31_local_weight"], ["r31_local_hidden"]
            ),
            helper.make_node(
                "MatMul",
                [anchor_norm, "r31_anchor_weight"],
                ["r31_anchor_hidden"],
            ),
            helper.make_node(
                "Add", ["r31_local_hidden", "r31_anchor_hidden"], ["r31_hidden_sum"]
            ),
        ]
    )
    hidden_norm = _learned_layer_norm(nodes, helper, "r31_hidden_sum", "r31_hidden_ln")
    nodes.extend(
        [
            helper.make_node(
                "Div", [hidden_norm, "r31_gelu_sqrt_two"], ["r31_gelu_scaled"]
            ),
            helper.make_node("Erf", ["r31_gelu_scaled"], ["r31_gelu_erf"]),
            helper.make_node(
                "Add", ["r31_gelu_erf", "r31_gelu_one"], ["r31_gelu_plus_one"]
            ),
            helper.make_node(
                "Mul", [hidden_norm, "r31_gelu_plus_one"], ["r31_gelu_product"]
            ),
            helper.make_node(
                "Mul", ["r31_gelu_product", "r31_gelu_half"], ["r31_hidden"]
            ),
            helper.make_node(
                "MatMul", ["r31_hidden", "r31_output_weight"], ["r31_output_linear"]
            ),
            helper.make_node(
                "Add", ["r31_output_linear", "r31_output_bias"], ["r31_family_logits"]
            ),
        ]
    )
    r29_export._slice(nodes, helper, "r31_family_logits", "r31_body", "r31_body")
    r29_export._slice(nodes, helper, "r31_family_logits", "r31_variant", "r31_variant")
    nodes.extend(
        [
            helper.make_node("Mul", ["r31_body", "r31_zero"], ["r31_neutral_zero"]),
            helper.make_node(
                "Add",
                ["r31_neutral_zero", "r31_negative_twenty"],
                ["r31_neutral_role"],
            ),
            helper.make_node(
                "Concat",
                [
                    "r31_body",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_variant",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                    "r31_neutral_role",
                ],
                ["role_logits"],
                axis=1,
            ),
        ]
    )
    for index, node in enumerate(nodes):
        node.name = f"r31_{index:03d}_{node.op_type}"
    graph.node.extend(nodes)
    graph.output.extend(
        [helper.make_tensor_value_info("role_logits", TensorProto.FLOAT, ["batch", 14])]
    )
    for index in reversed(range(len(graph.output))):
        if graph.output[index].name == "r31_anchor_role_logits":
            del graph.output[index]
    output_order = (
        "candidate_scores",
        "body_candidate_scores",
        "variant_candidate_scores",
        "none_logits",
        "role_logits",
        "style_logits",
        "treatment_distortion_logits",
        "treatment_fill_logits",
        "treatment_orientation_logits",
        "treatment_outline_logits",
        "treatment_shadow_logits",
        "view_gate_weights",
    )
    outputs = {value.name: value for value in graph.output}
    if set(outputs) != set(output_order):
        raise RuntimeError("R31 fused ONNX output inventory drifted")
    del graph.output[:]
    graph.output.extend([outputs[name] for name in output_order])
    onnx.checker.check_model(model)
    onnx.save(model, str(output))

    batch = 12
    rng = np.random.default_rng(20260831)
    views = rng.standard_normal((batch, 3, 1280), dtype=np.float32)
    prototypes = np.fromfile(
        r29_export.BASE_RUNTIME / "prototype-features.f32", dtype="<f4"
    ).reshape(336, 1280)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    base_session = ort.InferenceSession(
        str(base_ranker), sess_options=options, providers=["CPUExecutionProvider"]
    )
    actual_session = ort.InferenceSession(
        str(output), sess_options=options, providers=["CPUExecutionProvider"]
    )
    feed = {"views": views, "prototype_features": prototypes}
    base_names = [item.name for item in base_session.get_outputs()]
    base_values = dict(zip(base_names, base_session.run(None, feed), strict=True))
    actual_names = [item.name for item in actual_session.get_outputs()]
    actual_values = dict(zip(actual_names, actual_session.run(None, feed), strict=True))
    local = views[:, :, 256:].mean(axis=1)
    local /= np.maximum(np.linalg.norm(local, axis=1, keepdims=True), 1e-6)
    anchor_family = base_values["role_logits"][:, [0, 5]]
    head = r31._build_model(torch, r31.CELLS[0], seed=0)
    head.load_state_dict(state, strict=True)
    head.eval()
    with torch.no_grad():
        family = head(
            torch.from_numpy(local),
            torch.from_numpy(local),
            torch.from_numpy(anchor_family),
        )
        role = r31.r29.r23.v8.expand_family_logits_to_role_logits(torch, family)
    error = float(np.max(np.abs(actual_values["role_logits"] - role.numpy())))
    frozen = {
        name: bool(np.array_equal(actual_values[name], base_values[name]))
        for name in (
            "candidate_scores",
            "body_candidate_scores",
            "variant_candidate_scores",
        )
    }
    if error > 2e-4 or not all(frozen.values()):
        raise RuntimeError(f"R31 fused ONNX parity failed: {error}, {frozen}")
    return {"candidate_outputs_byte_exact": frozen, "role_logits_max_abs_error": error}


def build(
    output_dir: Path,
    *,
    head_dir: Path = HEAD_DIR,
    base_runtime: Path = r29_export.BASE_RUNTIME,
) -> Mapping[str, Any]:
    target = output_dir.resolve()
    if target.exists():
        raise RuntimeError(f"output directory already exists: {target}")
    base = base_runtime.resolve()
    head = head_dir.resolve()
    checkpoint = head / CHECKPOINT_FILE
    report = r29_export._read_json(head / "report.json")
    if report.get("schema") != "manga-font-v3-page-family-router-r31-qa-v1":
        raise RuntimeError("R31 training report schema drifted")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        for name in r29_export.FILES:
            if name in {"ranker.onnx", "runtime-contract.json", r29_export.FILES[0]}:
                continue
            source = base / name
            destination = staging / name
            if name not in {"encoder.onnx", "prototype-features.f32"}:
                shutil.copy2(source, destination)
                continue
            try:
                os.link(source, destination)
            except OSError:
                shutil.copy2(source, destination)
        parity = fuse_ranker(base / "ranker.onnx", checkpoint, staging / "ranker.onnx")
        contract = r29_export._read_json(base / "runtime-contract.json")
        source_model_version = str(contract["model_version"])
        ranker = staging / "ranker.onnx"
        descriptor = {
            "byte_size": ranker.stat().st_size,
            "file": "ranker.onnx",
            "sha256": r29_export._sha256(ranker),
        }
        contract["artifacts"]["ranker.onnx"] = descriptor
        contract["model_version"] = f"manga-font-v9-r31-{descriptor['sha256'][:12]}"
        contract["r31_family_router_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "candidate_score_outputs_frozen": True,
            "candidate_score_source_model_version": source_model_version,
            "checkpoint_sha256": r29_export._sha256(checkpoint),
            "cpu_budget": report["architecture"],
            "parity": parity,
            "production_eligible": False,
            "router": "local-query-anchor-family-mlp32-v1",
            "training_report_sha256": r29_export._sha256(head / "report.json"),
        }
        contract["v8_font_family_evidence"]["role_logits"] = (
            "r31_local_query_replacement_family_router_qa"
        )
        calibration = r29_export._read_json(base / "selection-calibration.json")
        bindings = dict(calibration["bindings"])
        bindings["model_version"] = contract["model_version"]
        bindings["ranker_sha256"] = descriptor["sha256"]
        bindings["runtime_contract_sha256"] = (
            r29_export._source_runtime_contract_sha256(contract)
        )
        calibration["bindings"] = bindings
        calibration = runtime.seal_record(
            {key: value for key, value in calibration.items() if key != "record_sha256"}
        )
        calibration_path = staging / "selection-calibration.json"
        calibration_path.write_bytes(runtime.json_bytes(calibration, pretty=True))
        contract["artifacts"]["selection-calibration.json"] = {
            "byte_size": calibration_path.stat().st_size,
            "file": "selection-calibration.json",
            "sha256": r29_export._sha256(calibration_path),
        }
        contract = runtime.seal_record(
            {key: value for key, value in contract.items() if key != "record_sha256"}
        )
        (staging / "runtime-contract.json").write_bytes(
            runtime.json_bytes(contract, pretty=True)
        )
        marker = {
            "artifacts": {
                name: r29_export._sha256(staging / name)
                for name in r29_export.FILES
                if name != r29_export.FILES[0]
            },
            "owner": "carrot-manga-translator/font-matching-runtime-artifact-v2",
            "qa_only": True,
            "release_approved": False,
            "safe_replace": True,
            "schema_version": "font-matching-runtime-artifact-v2",
        }
        (staging / r29_export.FILES[0]).write_bytes(
            runtime.json_bytes(marker, pretty=True)
        )
        if {path.name for path in staging.iterdir()} != set(r29_export.FILES):
            raise RuntimeError("R31 QA runtime inventory drifted")
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {
        "model_version": contract["model_version"],
        "output_dir": str(target),
        "parity": parity,
        "qa_only": True,
        "ranker": descriptor,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--head-dir", type=Path, default=HEAD_DIR)
    parser.add_argument("--base-runtime", type=Path, default=r29_export.BASE_RUNTIME)
    args = parser.parse_args()
    print(
        json.dumps(
            build(
                args.output_dir,
                head_dir=args.head_dir,
                base_runtime=args.base_runtime,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
