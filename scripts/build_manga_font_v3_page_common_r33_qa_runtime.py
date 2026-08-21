"""Fuse the R33 soft page-common prior into the QA-only R31 runtime."""

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
    from scripts import screen_manga_font_v3_page_common_ranker_r33 as r33
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export
    import screen_manga_font_v3_page_common_ranker_r33 as r33


BASE_RUNTIME = Path("artifacts/font-matching-runtime-r31-local-family-router-qa-v1")
HEAD_DIR = Path("artifacts/manga-font-v3-page-common-ranker-r33-qa-v1")
CHECKPOINT_FILE = "page-common-ranker.safetensors"


def _layer_norm_last(
    nodes: list[Any], helper: Any, source: str, name: str, *, axis: int
) -> str:
    mean = f"{name}_mean"
    centered = f"{name}_centered"
    square = f"{name}_square"
    variance = f"{name}_variance"
    adjusted = f"{name}_adjusted"
    denominator = f"{name}_denominator"
    normalized = f"{name}_normalized"
    scaled = f"{name}_scaled"
    output = f"{name}_output"
    nodes.extend(
        [
            helper.make_node("ReduceMean", [source], [mean], axes=[axis], keepdims=1),
            helper.make_node("Sub", [source, mean], [centered]),
            helper.make_node("Mul", [centered, centered], [square]),
            helper.make_node(
                "ReduceMean", [square], [variance], axes=[axis], keepdims=1
            ),
            helper.make_node("Add", [variance, "r29_layer_norm_epsilon"], [adjusted]),
            helper.make_node("Sqrt", [adjusted], [denominator]),
            helper.make_node("Div", [centered, denominator], [normalized]),
            helper.make_node("Mul", [normalized, "r33_input_norm_weight"], [scaled]),
            helper.make_node("Add", [scaled, "r33_input_norm_bias"], [output]),
        ]
    )
    return output


def fuse_ranker(
    base_ranker: Path,
    checkpoint: Path,
    output: Path,
    *,
    prototype_queries: np.ndarray,
    strength: float,
) -> Mapping[str, Any]:
    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper
    from safetensors.torch import load_file

    model = onnx.load(str(base_ranker))
    graph = model.graph
    r29_export._rename_tensor(graph, "candidate_scores", "r33_anchor_candidate_scores")
    r29_export._rename_tensor(
        graph, "body_candidate_scores", "r33_anchor_body_candidate_scores"
    )
    state = dict(load_file(str(checkpoint), device="cpu"))
    expected_shapes = {
        "candidate_embedding.weight": (21, 4),
        "page.weight": (16, 1024),
        "scorer.0.bias": (25,),
        "scorer.0.weight": (25,),
        "scorer.1.bias": (16,),
        "scorer.1.weight": (16, 25),
        "scorer.3.bias": (1,),
        "scorer.3.weight": (1, 16),
    }
    if set(state) != set(expected_shapes) or any(
        tuple(state[name].shape) != shape for name, shape in expected_shapes.items()
    ):
        raise RuntimeError("R33 checkpoint inventory or shape drifted")
    prototypes = np.asarray(prototype_queries, dtype=np.float32)
    if prototypes.shape != (21, 4, 256):
        raise RuntimeError("R33 candidate prototype shape drifted")
    prototypes /= np.maximum(np.linalg.norm(prototypes, axis=-1, keepdims=True), 1e-6)

    initializers = [
        r29_export._initializer(
            helper, "r33_query_starts", np.asarray([256], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_query_ends", np.asarray([1280], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_query_axes", np.asarray([2], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_query_steps", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_query_shape", np.asarray([-1, 4, 256], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_page_expand_shape", np.asarray([1, 21, 16], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_candidate_axes", np.asarray([0], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_anchor_axes", np.asarray([2], dtype=np.int64)
        ),
        r29_export._initializer(
            helper, "r33_batch_index", np.asarray(0, dtype=np.int64)
        ),
        r29_export._initializer(helper, "r33_zero", np.asarray(0.0, dtype=np.float32)),
        r29_export._initializer(helper, "r33_one", np.asarray(1.0, dtype=np.float32)),
        r29_export._initializer(
            helper, "r33_gelu_half", np.asarray([0.5], dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r33_gelu_one", np.asarray([1.0], dtype=np.float32)
        ),
        r29_export._initializer(
            helper,
            "r33_gelu_sqrt_two",
            np.asarray([np.sqrt(2.0)], dtype=np.float32),
        ),
        r29_export._initializer(
            helper, "r33_delta_scale", np.asarray([4.0 * strength], dtype=np.float32)
        ),
        r29_export._initializer(helper, "r33_prototypes", prototypes),
        r29_export._initializer(
            helper,
            "r33_page_weight",
            state["page.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r33_candidate_embedding",
            state["candidate_embedding.weight"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r33_input_norm_weight",
            state["scorer.0.weight"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r33_input_norm_bias",
            state["scorer.0.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r33_hidden_weight",
            state["scorer.1.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r33_hidden_bias",
            state["scorer.1.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r33_output_weight",
            state["scorer.3.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r33_output_bias",
            state["scorer.3.bias"].numpy().astype(np.float32),
        ),
    ]
    graph.initializer.extend(initializers)

    nodes: list[Any] = []
    r29_export._slice(nodes, helper, "views", "r33_query_views", "r33_query")
    nodes.extend(
        [
            helper.make_node(
                "ReduceMean",
                ["r33_query_views"],
                ["r33_query_flat"],
                axes=[1],
                keepdims=0,
            ),
            helper.make_node(
                "Reshape", ["r33_query_flat", "r33_query_shape"], ["r33_query_4d"]
            ),
        ]
    )
    local = r29_export._l2_normalize(
        nodes, helper, "r33_query_flat", "r33_local", axis=1
    )
    query = r29_export._l2_normalize(
        nodes, helper, "r33_query_4d", "r33_per_query", axis=2
    )
    nodes.extend(
        [
            helper.make_node(
                "Einsum",
                [query, "r33_prototypes"],
                ["r33_candidate_per_query"],
                equation="bqd,cqd->bcq",
            ),
            helper.make_node(
                "ReduceMean",
                [local],
                ["r33_page_query_raw"],
                axes=[0],
                keepdims=1,
            ),
            helper.make_node(
                "ReduceMean",
                ["r33_candidate_per_query"],
                ["r33_page_per_query"],
                axes=[0],
                keepdims=1,
            ),
            helper.make_node(
                "ReduceMean",
                ["r33_anchor_body_candidate_scores"],
                ["r33_page_anchor_body"],
                axes=[0],
                keepdims=1,
            ),
        ]
    )
    page = r29_export._l2_normalize(
        nodes, helper, "r33_page_query_raw", "r33_page", axis=1
    )
    page_norm = r29_export._layer_norm(nodes, helper, page, "r33_page_ln", 1024)
    nodes.extend(
        [
            helper.make_node(
                "MatMul", [page_norm, "r33_page_weight"], ["r33_page_hidden"]
            ),
            helper.make_node(
                "Unsqueeze",
                ["r33_page_hidden", "r33_candidate_axes"],
                ["r33_page_hidden_unsqueezed"],
            ),
            helper.make_node(
                "Expand",
                ["r33_page_hidden_unsqueezed", "r33_page_expand_shape"],
                ["r33_page_hidden_expanded"],
            ),
            helper.make_node(
                "Unsqueeze",
                ["r33_page_anchor_body", "r33_anchor_axes"],
                ["r33_page_anchor_column"],
            ),
            helper.make_node(
                "Unsqueeze",
                ["r33_candidate_embedding", "r33_candidate_axes"],
                ["r33_candidate_embedding_batch"],
            ),
            helper.make_node(
                "Concat",
                [
                    "r33_page_hidden_expanded",
                    "r33_page_per_query",
                    "r33_page_anchor_column",
                    "r33_candidate_embedding_batch",
                ],
                ["r33_features"],
                axis=2,
            ),
        ]
    )
    normalized = _layer_norm_last(nodes, helper, "r33_features", "r33_input_ln", axis=2)
    nodes.extend(
        [
            helper.make_node(
                "MatMul", [normalized, "r33_hidden_weight"], ["r33_hidden_linear"]
            ),
            helper.make_node(
                "Add",
                ["r33_hidden_linear", "r33_hidden_bias"],
                ["r33_hidden_bias_added"],
            ),
            helper.make_node(
                "Div",
                ["r33_hidden_bias_added", "r33_gelu_sqrt_two"],
                ["r33_gelu_scaled"],
            ),
            helper.make_node("Erf", ["r33_gelu_scaled"], ["r33_gelu_erf"]),
            helper.make_node(
                "Add", ["r33_gelu_erf", "r33_gelu_one"], ["r33_gelu_plus_one"]
            ),
            helper.make_node(
                "Mul",
                ["r33_hidden_bias_added", "r33_gelu_plus_one"],
                ["r33_gelu_product"],
            ),
            helper.make_node(
                "Mul", ["r33_gelu_product", "r33_gelu_half"], ["r33_hidden"]
            ),
            helper.make_node(
                "MatMul", ["r33_hidden", "r33_output_weight"], ["r33_output_linear"]
            ),
            helper.make_node(
                "Add",
                ["r33_output_linear", "r33_output_bias"],
                ["r33_output_bias_added"],
            ),
            helper.make_node("Tanh", ["r33_output_bias_added"], ["r33_output_tanh"]),
            helper.make_node(
                "Mul", ["r33_output_tanh", "r33_delta_scale"], ["r33_page_delta_3d"]
            ),
            helper.make_node(
                "Squeeze",
                ["r33_page_delta_3d", "r33_anchor_axes"],
                ["r33_page_delta"],
            ),
            helper.make_node("Shape", ["views"], ["r33_views_shape"]),
            helper.make_node(
                "Gather",
                ["r33_views_shape", "r33_batch_index"],
                ["r33_batch_size"],
                axis=0,
            ),
            helper.make_node(
                "Cast", ["r33_batch_size"], ["r33_batch_float"], to=TensorProto.FLOAT
            ),
            helper.make_node(
                "Sub", ["r33_batch_float", "r33_one"], ["r33_batch_minus_one"]
            ),
            helper.make_node(
                "Clip",
                ["r33_batch_minus_one", "r33_zero", "r33_one"],
                ["r33_page_gate"],
            ),
            helper.make_node(
                "Mul", ["r33_page_delta", "r33_page_gate"], ["r33_gated_delta"]
            ),
            helper.make_node(
                "Add",
                ["r33_anchor_body_candidate_scores", "r33_gated_delta"],
                ["body_candidate_scores"],
            ),
            helper.make_node(
                "Identity", ["body_candidate_scores"], ["candidate_scores"]
            ),
        ]
    )
    for index, node in enumerate(nodes):
        node.name = f"r33_{index:03d}_{node.op_type}"
    graph.node.extend(nodes)
    graph.output.extend(
        [
            helper.make_tensor_value_info(
                "candidate_scores", TensorProto.FLOAT, ["batch", 21]
            ),
            helper.make_tensor_value_info(
                "body_candidate_scores", TensorProto.FLOAT, ["batch", 21]
            ),
        ]
    )
    anchors = {"r33_anchor_candidate_scores", "r33_anchor_body_candidate_scores"}
    for index in reversed(range(len(graph.output))):
        if graph.output[index].name in anchors:
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
        raise RuntimeError("R33 fused ONNX output inventory drifted")
    del graph.output[:]
    graph.output.extend([outputs[name] for name in output_order])
    onnx.checker.check_model(model)
    onnx.save(model, str(output))

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    base_session = ort.InferenceSession(
        str(base_ranker), sess_options=options, providers=["CPUExecutionProvider"]
    )
    actual_session = ort.InferenceSession(
        str(output), sess_options=options, providers=["CPUExecutionProvider"]
    )
    head = r33._build_page_model(torch, seed=0)
    head.load_state_dict(state, strict=True)
    head.eval()
    runtime_prototypes = np.fromfile(
        BASE_RUNTIME / "prototype-features.f32", dtype="<f4"
    ).reshape(336, 1280)
    errors = []
    single_exact = False
    for batch in (1, 12):
        rng = np.random.default_rng(20260833 + batch)
        views = rng.standard_normal((batch, 3, 1280), dtype=np.float32)
        feed = {"views": views, "prototype_features": runtime_prototypes}
        base_names = [item.name for item in base_session.get_outputs()]
        base_values = dict(zip(base_names, base_session.run(None, feed), strict=True))
        actual_names = [item.name for item in actual_session.get_outputs()]
        actual_values = dict(
            zip(actual_names, actual_session.run(None, feed), strict=True)
        )
        query_flat = views[:, :, 256:].mean(axis=1)
        local = query_flat / np.maximum(
            np.linalg.norm(query_flat, axis=1, keepdims=True), 1e-6
        )
        query = query_flat.reshape(batch, 4, 256)
        query /= np.maximum(np.linalg.norm(query, axis=2, keepdims=True), 1e-6)
        per_query = np.einsum("bqd,cqd->bcq", query, prototypes, optimize=True)
        page = local.mean(axis=0, keepdims=True)
        page /= np.maximum(np.linalg.norm(page, axis=1, keepdims=True), 1e-6)
        with torch.no_grad():
            reference = head(
                torch.from_numpy(page),
                torch.from_numpy(per_query.mean(axis=0, keepdims=True)),
                torch.from_numpy(
                    base_values["body_candidate_scores"].mean(axis=0, keepdims=True)
                ),
            )
        expected_body = base_values["body_candidate_scores"].copy()
        if batch > 1:
            expected_body += strength * reference["delta"].numpy()
        errors.append(
            float(
                np.max(np.abs(actual_values["body_candidate_scores"] - expected_body))
            )
        )
        if batch == 1:
            single_exact = bool(
                np.array_equal(
                    actual_values["body_candidate_scores"],
                    base_values["body_candidate_scores"],
                )
            )
        if (
            not np.array_equal(
                actual_values["candidate_scores"],
                actual_values["body_candidate_scores"],
            )
            or not np.array_equal(
                actual_values["variant_candidate_scores"],
                base_values["variant_candidate_scores"],
            )
            or not np.array_equal(
                actual_values["role_logits"], base_values["role_logits"]
            )
        ):
            raise RuntimeError("R33 frozen output parity failed")
    if max(errors) > 2e-4 or not single_exact:
        raise RuntimeError(f"R33 page head parity failed: {errors}, {single_exact}")
    return {
        "body_scores_max_abs_error": max(errors),
        "single_row_body_scores_byte_exact": single_exact,
        "variant_and_role_outputs_byte_exact": True,
    }


def build(
    output_dir: Path, *, head_dir: Path = HEAD_DIR, strength: float = 1.0
) -> Mapping[str, Any]:
    import torch

    target = output_dir.resolve()
    if target.exists():
        raise RuntimeError(f"output directory already exists: {target}")
    if strength not in {1.0, 2.0}:
        raise RuntimeError("R33 QA strength must be 1 or 2")
    base = BASE_RUNTIME.resolve()
    head = head_dir.resolve()
    checkpoint = head / CHECKPOINT_FILE
    report = r29_export._read_json(head / "report.json")
    if report.get("schema") != "manga-font-v3-page-common-ranker-r33-qa-v1":
        raise RuntimeError("R33 training report schema drifted")
    prepared = r33.r32.r31.r29._prepare(torch)
    prototypes = prepared["context"]["arrays"]["prototype_queries"].astype(
        np.float32, copy=True
    )
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
        parity = fuse_ranker(
            base / "ranker.onnx",
            checkpoint,
            staging / "ranker.onnx",
            prototype_queries=prototypes,
            strength=strength,
        )
        contract = r29_export._read_json(base / "runtime-contract.json")
        source_model_version = str(contract["model_version"])
        ranker = staging / "ranker.onnx"
        descriptor = {
            "byte_size": ranker.stat().st_size,
            "file": "ranker.onnx",
            "sha256": r29_export._sha256(ranker),
        }
        contract["artifacts"]["ranker.onnx"] = descriptor
        # The fused R33 graph is the runtime ranker.  Keep the semantic head
        # descriptor aligned with the artifact descriptor so the ordinary
        # bundle validator can verify the QA bundle without a model-specific
        # exception.
        contract["head"] = dict(contract["head"])
        contract["head"]["onnx_sha256"] = descriptor["sha256"]
        contract["head"]["version"] = "manga-font-v9-r33-page-common-ranker-onnx-v1"
        contract["model_version"] = f"manga-font-v9-r33-{descriptor['sha256'][:12]}"
        contract["r33_page_common_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "checkpoint_sha256": r29_export._sha256(checkpoint),
            "cpu_budget": report["architecture"],
            "page_common_mode": f"soft-learned-candidate-prior-strength-{strength:g}",
            "parity": parity,
            "production_eligible": False,
            "source_model_version": source_model_version,
            "training_report_sha256": r29_export._sha256(head / "report.json"),
        }
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
            raise RuntimeError("R33 QA runtime inventory drifted")
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
    parser.add_argument("--strength", type=float, choices=(1.0, 2.0), default=1.0)
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.output_dir, head_dir=args.head_dir, strength=args.strength),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
