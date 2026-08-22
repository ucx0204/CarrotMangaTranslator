"""Fuse the trained R42 style metric into the QA-only R33 runtime.

The graph keeps every existing R33 output except the body candidate scores.
For a multi-row runtime batch it predicts source-style axes for each row,
compares them with fixed candidate-style vectors, and adds a learned local plus
batch-context residual.  A one-row batch is byte-identical to R33.
"""

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
    from scripts import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42
    from scripts import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export
    import screen_manga_font_v3_style_metric_chapter_ranker_r42 as r42
    import train_manga_font_v3_style_metric_chapter_ranker_r42 as r42_train


BASE_RUNTIME = Path("artifacts/font-matching-runtime-r33-soft-page-common-qa-v1")
HEAD_DIR = Path("artifacts/manga-font-v3-style-metric-chapter-ranker-r42-qa-v1")


def _layer_norm(
    nodes: list[Any],
    helper: Any,
    source: str,
    name: str,
    *,
    axis: int,
    weight: str,
    bias: str,
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
            helper.make_node("Add", [variance, "r42_layer_norm_epsilon"], [adjusted]),
            helper.make_node("Sqrt", [adjusted], [denominator]),
            helper.make_node("Div", [centered, denominator], [normalized]),
            helper.make_node("Mul", [normalized, weight], [scaled]),
            helper.make_node("Add", [scaled, bias], [output]),
        ]
    )
    return output


def _gelu(nodes: list[Any], helper: Any, source: str, name: str) -> str:
    scaled = f"{name}_scaled"
    erf = f"{name}_erf"
    plus_one = f"{name}_plus_one"
    product = f"{name}_product"
    output = f"{name}_output"
    nodes.extend(
        [
            helper.make_node("Div", [source, "r42_gelu_sqrt_two"], [scaled]),
            helper.make_node("Erf", [scaled], [erf]),
            helper.make_node("Add", [erf, "r42_one"], [plus_one]),
            helper.make_node("Mul", [source, plus_one], [product]),
            helper.make_node("Mul", [product, "r42_gelu_half"], [output]),
        ]
    )
    return output


def _metric_branch(
    nodes: list[Any],
    helper: Any,
    source: str,
    candidate: str,
    weight: str,
    prefix: str,
) -> str:
    difference = f"{prefix}_difference"
    square = f"{prefix}_square"
    weighted = f"{prefix}_weighted"
    mean = f"{prefix}_mean"
    negative = f"{prefix}_negative"
    centered_mean = f"{prefix}_centered_mean"
    centered = f"{prefix}_centered"
    nodes.extend(
        [
            helper.make_node("Sub", [source, candidate], [difference]),
            helper.make_node("Mul", [difference, difference], [square]),
            helper.make_node("Mul", [square, weight], [weighted]),
            helper.make_node("ReduceMean", [weighted], [mean], axes=[2], keepdims=0),
            helper.make_node("Neg", [mean], [negative]),
            helper.make_node(
                "ReduceMean", [negative], [centered_mean], axes=[1], keepdims=1
            ),
            helper.make_node("Sub", [negative, centered_mean], [centered]),
        ]
    )
    return centered


def fuse_ranker(base_ranker: Path, checkpoint: Path, output: Path) -> Mapping[str, Any]:
    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper
    from safetensors.torch import load_file

    model = onnx.load(str(base_ranker))
    graph = model.graph
    r29_export._rename_tensor(
        graph, "body_candidate_scores", "r42_anchor_body_candidate_scores"
    )
    r29_export._rename_tensor(graph, "candidate_scores", "r42_anchor_candidate_scores")
    state = dict(load_file(str(checkpoint), device="cpu"))
    expected_shapes = {
        "style.network.0.weight": (1024,),
        "style.network.0.bias": (1024,),
        "style.network.1.weight": (32, 1024),
        "style.network.1.bias": (32,),
        "style.network.3.weight": (10, 32),
        "style.network.3.bias": (10,),
        "metric.candidate_style": (21, 10),
        "metric.local_axis_logits": (10,),
        "metric.chapter_axis_logits": (10,),
        "metric.candidate_bias": (21,),
        "metric.local_strength": (),
        "metric.chapter_strength": (),
    }
    if set(state) != set(expected_shapes) or any(
        tuple(state[name].shape) != shape for name, shape in expected_shapes.items()
    ):
        raise RuntimeError("R42 checkpoint inventory or shape drifted")

    local_logits = state["metric.local_axis_logits"].numpy().astype(np.float32)
    chapter_logits = state["metric.chapter_axis_logits"].numpy().astype(np.float32)
    local_weight = np.exp(local_logits - np.max(local_logits))
    local_weight = (10.0 * local_weight / local_weight.sum()).astype(np.float32)
    chapter_weight = np.exp(chapter_logits - np.max(chapter_logits))
    chapter_weight = (10.0 * chapter_weight / chapter_weight.sum()).astype(np.float32)
    local_strength = np.logaddexp(
        0.0, float(state["metric.local_strength"].item())
    ).astype(np.float32)
    chapter_strength = np.logaddexp(
        0.0, float(state["metric.chapter_strength"].item())
    ).astype(np.float32)

    initializers = [
        r29_export._initializer(
            helper, "r42_layer_norm_epsilon", np.asarray(1e-5, dtype=np.float32)
        ),
        r29_export._initializer(helper, "r42_one", np.asarray(1.0, dtype=np.float32)),
        r29_export._initializer(
            helper, "r42_gelu_half", np.asarray(0.5, dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r42_gelu_sqrt_two", np.asarray(np.sqrt(2.0), dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r42_delta_scale", np.asarray(4.0, dtype=np.float32)
        ),
        r29_export._initializer(
            helper, "r42_axis_one", np.asarray([1], dtype=np.int64)
        ),
        r29_export._initializer(
            helper,
            "r42_style_norm_weight",
            state["style.network.0.weight"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r42_style_norm_bias",
            state["style.network.0.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r42_style_hidden_weight",
            state["style.network.1.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r42_style_hidden_bias",
            state["style.network.1.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r42_style_output_weight",
            state["style.network.3.weight"].numpy().astype(np.float32).T,
        ),
        r29_export._initializer(
            helper,
            "r42_style_output_bias",
            state["style.network.3.bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper,
            "r42_candidate_style",
            state["metric.candidate_style"].numpy().astype(np.float32)[None, :, :],
        ),
        r29_export._initializer(
            helper, "r42_local_axis_weight", local_weight[None, None, :]
        ),
        r29_export._initializer(
            helper, "r42_chapter_axis_weight", chapter_weight[None, None, :]
        ),
        r29_export._initializer(
            helper,
            "r42_candidate_bias",
            state["metric.candidate_bias"].numpy().astype(np.float32),
        ),
        r29_export._initializer(
            helper, "r42_local_strength", np.asarray(local_strength, dtype=np.float32)
        ),
        r29_export._initializer(
            helper,
            "r42_chapter_strength",
            np.asarray(chapter_strength, dtype=np.float32),
        ),
    ]
    graph.initializer.extend(initializers)

    nodes: list[Any] = []
    normalized = _layer_norm(
        nodes,
        helper,
        "r33_local_output",
        "r42_style_norm",
        axis=1,
        weight="r42_style_norm_weight",
        bias="r42_style_norm_bias",
    )
    nodes.extend(
        [
            helper.make_node(
                "MatMul",
                [normalized, "r42_style_hidden_weight"],
                ["r42_style_hidden_linear"],
            ),
            helper.make_node(
                "Add",
                ["r42_style_hidden_linear", "r42_style_hidden_bias"],
                ["r42_style_hidden_bias_added"],
            ),
        ]
    )
    hidden = _gelu(nodes, helper, "r42_style_hidden_bias_added", "r42_style_gelu")
    nodes.extend(
        [
            helper.make_node(
                "MatMul",
                [hidden, "r42_style_output_weight"],
                ["r42_style_output_linear"],
            ),
            helper.make_node(
                "Add",
                ["r42_style_output_linear", "r42_style_output_bias"],
                ["r42_style_output_bias_added"],
            ),
            helper.make_node(
                "Sigmoid", ["r42_style_output_bias_added"], ["r42_source_style"]
            ),
            helper.make_node(
                "Unsqueeze",
                ["r42_source_style", "r42_axis_one"],
                ["r42_local_style_3d"],
            ),
            helper.make_node(
                "ReduceMean",
                ["r42_source_style"],
                ["r42_chapter_style"],
                axes=[0],
                keepdims=1,
            ),
            helper.make_node(
                "Unsqueeze",
                ["r42_chapter_style", "r42_axis_one"],
                ["r42_chapter_style_3d"],
            ),
        ]
    )
    local_metric = _metric_branch(
        nodes,
        helper,
        "r42_local_style_3d",
        "r42_candidate_style",
        "r42_local_axis_weight",
        "r42_local_metric",
    )
    chapter_metric = _metric_branch(
        nodes,
        helper,
        "r42_chapter_style_3d",
        "r42_candidate_style",
        "r42_chapter_axis_weight",
        "r42_chapter_metric",
    )
    nodes.extend(
        [
            helper.make_node(
                "Mul", [local_metric, "r42_local_strength"], ["r42_local_scaled"]
            ),
            helper.make_node(
                "Mul", [chapter_metric, "r42_chapter_strength"], ["r42_chapter_scaled"]
            ),
            helper.make_node(
                "Add", ["r42_local_scaled", "r42_chapter_scaled"], ["r42_metric_base"]
            ),
            helper.make_node(
                "Add", ["r42_metric_base", "r42_candidate_bias"], ["r42_metric"]
            ),
            helper.make_node("Tanh", ["r42_metric"], ["r42_metric_tanh"]),
            helper.make_node(
                "Mul", ["r42_metric_tanh", "r42_delta_scale"], ["r42_raw_delta"]
            ),
            helper.make_node("Mul", ["r42_raw_delta", "r33_page_gate"], ["r42_delta"]),
            helper.make_node(
                "Add",
                ["r42_anchor_body_candidate_scores", "r42_delta"],
                ["body_candidate_scores"],
            ),
            helper.make_node(
                "Identity", ["body_candidate_scores"], ["candidate_scores"]
            ),
        ]
    )
    for index, node in enumerate(nodes):
        node.name = f"r42_{index:03d}_{node.op_type}"
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
    anchors = {"r42_anchor_candidate_scores", "r42_anchor_body_candidate_scores"}
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
        raise RuntimeError("R42 fused ONNX output inventory drifted")
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
    style_model = r42.r40.r39._build_model(torch, seed=0)
    style_state = {
        name.removeprefix("style."): value
        for name, value in state.items()
        if name.startswith("style.")
    }
    style_model.load_state_dict(style_state, strict=True)
    candidates = state["metric.candidate_style"]
    metric_model = r42._build_model(torch, candidates, seed=0)
    metric_state = {
        name.removeprefix("metric."): value
        for name, value in state.items()
        if name.startswith("metric.")
    }
    metric_model.load_state_dict(metric_state, strict=True)
    style_model.eval()
    metric_model.eval()
    prototypes = np.fromfile(
        BASE_RUNTIME / "prototype-features.f32", dtype="<f4"
    ).reshape(336, 1280)
    errors = []
    single_exact = False
    for batch in (1, 7):
        rng = np.random.default_rng(20260842 + batch)
        views = rng.standard_normal((batch, 3, 1280), dtype=np.float32)
        feed = {"views": views, "prototype_features": prototypes}
        base_values = dict(
            zip(
                [item.name for item in base_session.get_outputs()],
                base_session.run(None, feed),
                strict=True,
            )
        )
        actual_values = dict(
            zip(
                [item.name for item in actual_session.get_outputs()],
                actual_session.run(None, feed),
                strict=True,
            )
        )
        query = views[:, :, 256:].mean(axis=1)
        query /= np.maximum(np.linalg.norm(query, axis=1, keepdims=True), 1e-6)
        with torch.no_grad():
            source_style = style_model(torch.from_numpy(query))
            reference = metric_model(
                source_style, torch.from_numpy(base_values["body_candidate_scores"])
            )["body_candidate_scores"].numpy()
        errors.append(
            float(np.max(np.abs(actual_values["body_candidate_scores"] - reference)))
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
            raise RuntimeError("R42 frozen output parity failed")
    if max(errors) > 3e-4 or not single_exact:
        raise RuntimeError(f"R42 parity failed: {errors}, {single_exact}")
    return {
        "body_scores_max_abs_error": max(errors),
        "single_row_body_scores_byte_exact": single_exact,
        "variant_and_role_outputs_byte_exact": True,
    }


def build(output_dir: Path, *, head_dir: Path = HEAD_DIR) -> Mapping[str, Any]:
    target = output_dir.resolve()
    if target.exists():
        raise RuntimeError(f"output directory already exists: {target}")
    head = head_dir.resolve()
    report = r29_export._read_json(head / r42_train.REPORT_FILE)
    if report.get("schema") != r42_train.SCHEMA:
        raise RuntimeError("R42 report schema drifted")
    checkpoint = head / r42_train.CHECKPOINT_FILE
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        for name in r29_export.FILES:
            if name in {"ranker.onnx", "runtime-contract.json", r29_export.FILES[0]}:
                continue
            source = BASE_RUNTIME / name
            destination = staging / name
            if name not in {"encoder.onnx", "prototype-features.f32"}:
                shutil.copy2(source, destination)
                continue
            try:
                os.link(source, destination)
            except OSError:
                shutil.copy2(source, destination)
        parity = fuse_ranker(
            BASE_RUNTIME / "ranker.onnx", checkpoint, staging / "ranker.onnx"
        )
        contract = r29_export._read_json(BASE_RUNTIME / "runtime-contract.json")
        source_model_version = str(contract["model_version"])
        ranker = staging / "ranker.onnx"
        descriptor = {
            "byte_size": ranker.stat().st_size,
            "file": "ranker.onnx",
            "sha256": r29_export._sha256(ranker),
        }
        contract["artifacts"]["ranker.onnx"] = descriptor
        contract["head"] = dict(contract["head"])
        contract["head"]["onnx_sha256"] = descriptor["sha256"]
        contract["head"]["version"] = "manga-font-v10-r42-style-metric-chapter-onnx-v1"
        contract["model_version"] = f"manga-font-v10-r42-{descriptor['sha256'][:12]}"
        contract["r42_style_metric_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "checkpoint_sha256": r29_export._sha256(checkpoint),
            "context_boundary": "runtime_batch_mean_currently_page_scoped",
            "parity": parity,
            "production_eligible": False,
            "source_model_version": source_model_version,
            "training_report_sha256": r29_export._sha256(head / r42_train.REPORT_FILE),
        }
        calibration = r29_export._read_json(BASE_RUNTIME / "selection-calibration.json")
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
            raise RuntimeError("R42 runtime inventory drifted")
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
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.output_dir, head_dir=args.head_dir),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
