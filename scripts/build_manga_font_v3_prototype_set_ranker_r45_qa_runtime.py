"""Fuse the trained R45 prototype-aware chapter ranker into a QA runtime."""

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
    from scripts import screen_manga_font_v3_prototype_set_ranker_r45 as r45
    from scripts import train_manga_font_v3_prototype_set_ranker_r45 as r45_train
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import build_manga_font_v3_page_conditioned_r29_qa_runtime as r29_export
    import screen_manga_font_v3_prototype_set_ranker_r45 as r45
    import train_manga_font_v3_prototype_set_ranker_r45 as r45_train


BASE_RUNTIME = Path("artifacts/font-matching-runtime-r33-soft-page-common-qa-v1")
HEAD_DIR = Path("artifacts/manga-font-v3-prototype-set-ranker-r45-qa-v1")


def _layer_norm(
    nodes: list[Any], helper: Any, source: str, prefix: str, weight: str, bias: str
) -> str:
    mean = f"{prefix}_mean"
    centered = f"{prefix}_centered"
    square = f"{prefix}_square"
    variance = f"{prefix}_variance"
    adjusted = f"{prefix}_adjusted"
    denominator = f"{prefix}_denominator"
    normalized = f"{prefix}_normalized"
    scaled = f"{prefix}_scaled"
    output = f"{prefix}_output"
    nodes.extend(
        [
            helper.make_node("ReduceMean", [source], [mean], axes=[-1], keepdims=1),
            helper.make_node("Sub", [source, mean], [centered]),
            helper.make_node("Mul", [centered, centered], [square]),
            helper.make_node("ReduceMean", [square], [variance], axes=[-1], keepdims=1),
            helper.make_node("Add", [variance, "r45_ln_epsilon"], [adjusted]),
            helper.make_node("Sqrt", [adjusted], [denominator]),
            helper.make_node("Div", [centered, denominator], [normalized]),
            helper.make_node("Mul", [normalized, weight], [scaled]),
            helper.make_node("Add", [scaled, bias], [output]),
        ]
    )
    return output


def _linear(
    nodes: list[Any], helper: Any, source: str, prefix: str, weight: str, bias: str
) -> str:
    product = f"{prefix}_product"
    output = f"{prefix}_output"
    nodes.extend(
        [
            helper.make_node("MatMul", [source, weight], [product]),
            helper.make_node("Add", [product, bias], [output]),
        ]
    )
    return output


def _gelu(nodes: list[Any], helper: Any, source: str, prefix: str) -> str:
    scaled = f"{prefix}_scaled"
    erf = f"{prefix}_erf"
    plus_one = f"{prefix}_plus_one"
    product = f"{prefix}_product"
    output = f"{prefix}_output"
    nodes.extend(
        [
            helper.make_node("Div", [source, "r45_sqrt_two"], [scaled]),
            helper.make_node("Erf", [scaled], [erf]),
            helper.make_node("Add", [erf, "r45_one"], [plus_one]),
            helper.make_node("Mul", [source, plus_one], [product]),
            helper.make_node("Mul", [product, "r45_half"], [output]),
        ]
    )
    return output


def _add_parameter_initializers(
    helper: Any, state: Mapping[str, Any], candidate_tokens: np.ndarray
) -> list[Any]:
    values: dict[str, np.ndarray] = {
        "r45_ln_epsilon": np.asarray(1e-5, dtype=np.float32),
        "r45_one": np.asarray(1.0, dtype=np.float32),
        "r45_half": np.asarray(0.5, dtype=np.float32),
        "r45_sqrt_two": np.asarray(np.sqrt(2.0), dtype=np.float32),
        "r45_delta_scale": np.asarray(r45.MAXIMUM_DELTA, dtype=np.float32),
        "r45_unsqueeze_axis": np.asarray([1], dtype=np.int64),
        "r45_column_axis": np.asarray([2], dtype=np.int64),
        "r45_assignment_reduce_axis": np.asarray([1], dtype=np.int64),
        "r45_candidate_tokens": candidate_tokens[None, :, :].astype(np.float32),
    }
    mapping = {
        "source_encoder.0.weight": "r45_source_ln1_weight",
        "source_encoder.0.bias": "r45_source_ln1_bias",
        "source_encoder.1.weight": "r45_source_fc1_weight",
        "source_encoder.1.bias": "r45_source_fc1_bias",
        "source_encoder.3.weight": "r45_source_fc2_weight",
        "source_encoder.3.bias": "r45_source_fc2_bias",
        "source_encoder.4.weight": "r45_source_ln2_weight",
        "source_encoder.4.bias": "r45_source_ln2_bias",
        "assignment.weight": "r45_assignment_weight",
        "assignment.bias": "r45_assignment_bias",
        "route.weight": "r45_route_weight",
        "route.bias": "r45_route_bias",
        "scorer.0.weight": "r45_scorer_ln_weight",
        "scorer.0.bias": "r45_scorer_ln_bias",
        "scorer.1.weight": "r45_scorer_fc1_weight",
        "scorer.1.bias": "r45_scorer_fc1_bias",
        "scorer.3.weight": "r45_scorer_fc2_weight",
        "scorer.3.bias": "r45_scorer_fc2_bias",
    }
    transposed = {
        "source_encoder.1.weight",
        "source_encoder.3.weight",
        "assignment.weight",
        "route.weight",
        "scorer.1.weight",
        "scorer.3.weight",
    }
    for source, target in mapping.items():
        array = state[source].numpy().astype(np.float32)
        values[target] = array.T if source in transposed else array
    return [
        r29_export._initializer(helper, name, value) for name, value in values.items()
    ]


def fuse_ranker(base_ranker: Path, checkpoint: Path, output: Path) -> Mapping[str, Any]:
    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper
    from safetensors.torch import load_file

    model = onnx.load(str(base_ranker))
    graph = model.graph
    r29_export._rename_tensor(
        graph, "body_candidate_scores", "r45_anchor_body_candidate_scores"
    )
    r29_export._rename_tensor(graph, "candidate_scores", "r45_anchor_candidate_scores")
    state = dict(load_file(str(checkpoint), device="cpu"))
    reference = r45._build_model(torch, seed=0)
    expected = {
        name: tuple(value.shape) for name, value in reference.state_dict().items()
    }
    if set(state) != set(expected) or any(
        tuple(state[name].shape) != shape for name, shape in expected.items()
    ):
        raise RuntimeError("R45 checkpoint inventory or shape drifted")
    reference.load_state_dict(state, strict=True)
    reference.eval()
    prepared = r45.r41.r36.r35.r34.r33.r32.r31.r29._prepare(torch)
    candidate_query = r45._candidate_query(torch, prepared, device=torch.device("cpu"))
    with torch.no_grad():
        candidate_tokens = reference.candidate_encoder(candidate_query).numpy()
    graph.initializer.extend(
        _add_parameter_initializers(helper, state, candidate_tokens)
    )

    nodes: list[Any] = []
    source = _layer_norm(
        nodes,
        helper,
        "r33_local_output",
        "r45_source_ln1",
        "r45_source_ln1_weight",
        "r45_source_ln1_bias",
    )
    source = _linear(
        nodes,
        helper,
        source,
        "r45_source_fc1",
        "r45_source_fc1_weight",
        "r45_source_fc1_bias",
    )
    source = _gelu(nodes, helper, source, "r45_source_gelu")
    source = _linear(
        nodes,
        helper,
        source,
        "r45_source_fc2",
        "r45_source_fc2_weight",
        "r45_source_fc2_bias",
    )
    source = _layer_norm(
        nodes,
        helper,
        source,
        "r45_source_ln2",
        "r45_source_ln2_weight",
        "r45_source_ln2_bias",
    )
    assignment_logits = _linear(
        nodes,
        helper,
        source,
        "r45_assignment",
        "r45_assignment_weight",
        "r45_assignment_bias",
    )
    route_logits = _linear(
        nodes,
        helper,
        source,
        "r45_route",
        "r45_route_weight",
        "r45_route_bias",
    )
    nodes.extend(
        [
            helper.make_node(
                "Softmax", [assignment_logits], ["r45_assignment_softmax"], axis=1
            ),
            helper.make_node(
                "Transpose",
                ["r45_assignment_softmax"],
                ["r45_assignment_transposed"],
                perm=[1, 0],
            ),
            helper.make_node(
                "ReduceSum",
                ["r45_assignment_transposed", "r45_assignment_reduce_axis"],
                ["r45_assignment_sum"],
                keepdims=1,
            ),
            helper.make_node(
                "Div",
                ["r45_assignment_transposed", "r45_assignment_sum"],
                ["r45_assignment_weights"],
            ),
            helper.make_node(
                "MatMul", ["r45_assignment_weights", source], ["r45_experts"]
            ),
            helper.make_node("Softmax", [route_logits], ["r45_route_softmax"], axis=1),
            helper.make_node(
                "MatMul", ["r45_route_softmax", "r45_experts"], ["r45_context"]
            ),
            helper.make_node(
                "Unsqueeze", [source, "r45_unsqueeze_axis"], ["r45_source_3d"]
            ),
            helper.make_node(
                "Unsqueeze",
                ["r45_context", "r45_unsqueeze_axis"],
                ["r45_context_3d"],
            ),
            helper.make_node(
                "Mul",
                ["r45_source_3d", "r45_candidate_tokens"],
                ["r45_local_product"],
            ),
            helper.make_node(
                "Mul",
                ["r45_context_3d", "r45_candidate_tokens"],
                ["r45_context_product"],
            ),
            helper.make_node(
                "Sub",
                ["r45_source_3d", "r45_candidate_tokens"],
                ["r45_local_difference"],
            ),
            helper.make_node("Abs", ["r45_local_difference"], ["r45_local_abs"]),
            helper.make_node(
                "Sub",
                ["r45_context_3d", "r45_candidate_tokens"],
                ["r45_context_difference"],
            ),
            helper.make_node("Abs", ["r45_context_difference"], ["r45_context_abs"]),
            helper.make_node(
                "Unsqueeze",
                ["r45_anchor_body_candidate_scores", "r45_column_axis"],
                ["r45_anchor_column"],
            ),
            helper.make_node(
                "ReduceMean",
                ["r45_anchor_body_candidate_scores"],
                ["r45_chapter_anchor"],
                axes=[0],
                keepdims=1,
            ),
            helper.make_node(
                "Unsqueeze",
                ["r45_chapter_anchor", "r45_column_axis"],
                ["r45_chapter_anchor_column"],
            ),
            helper.make_node(
                "Shape", ["r45_anchor_column"], ["r45_anchor_column_shape"]
            ),
            helper.make_node(
                "Expand",
                ["r45_chapter_anchor_column", "r45_anchor_column_shape"],
                ["r45_chapter_anchor_expanded"],
            ),
            helper.make_node(
                "Concat",
                [
                    "r45_local_product",
                    "r45_context_product",
                    "r45_local_abs",
                    "r45_context_abs",
                    "r33_candidate_per_query",
                    "r45_anchor_column",
                    "r45_chapter_anchor_expanded",
                ],
                ["r45_features"],
                axis=2,
            ),
        ]
    )
    scored = _layer_norm(
        nodes,
        helper,
        "r45_features",
        "r45_scorer_ln",
        "r45_scorer_ln_weight",
        "r45_scorer_ln_bias",
    )
    scored = _linear(
        nodes,
        helper,
        scored,
        "r45_scorer_fc1",
        "r45_scorer_fc1_weight",
        "r45_scorer_fc1_bias",
    )
    scored = _gelu(nodes, helper, scored, "r45_scorer_gelu")
    scored = _linear(
        nodes,
        helper,
        scored,
        "r45_scorer_fc2",
        "r45_scorer_fc2_weight",
        "r45_scorer_fc2_bias",
    )
    nodes.extend(
        [
            helper.make_node("Squeeze", [scored, "r45_column_axis"], ["r45_raw"]),
            helper.make_node("Tanh", ["r45_raw"], ["r45_tanh"]),
            helper.make_node(
                "Mul", ["r45_tanh", "r45_delta_scale"], ["r45_scaled_delta"]
            ),
            helper.make_node(
                "Mul", ["r45_scaled_delta", "r33_page_gate"], ["r45_delta"]
            ),
            helper.make_node(
                "Add",
                ["r45_anchor_body_candidate_scores", "r45_delta"],
                ["body_candidate_scores"],
            ),
            helper.make_node(
                "Identity", ["body_candidate_scores"], ["candidate_scores"]
            ),
        ]
    )
    for index, node in enumerate(nodes):
        node.name = f"r45_{index:03d}_{node.op_type}"
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
    anchors = {"r45_anchor_candidate_scores", "r45_anchor_body_candidate_scores"}
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
        raise RuntimeError("R45 fused ONNX output inventory drifted")
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
    prototypes = np.fromfile(
        BASE_RUNTIME / "prototype-features.f32", dtype="<f4"
    ).reshape(336, 1280)
    candidate_tensor = candidate_query
    errors: list[float] = []
    single_exact = False
    for batch in (1, 7):
        rng = np.random.default_rng(20260845 + batch)
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
        query_views = views[:, :, 256:].reshape(batch, 3, 4, 256)
        query_views = query_views.mean(axis=1)
        query_views /= np.maximum(
            np.linalg.norm(query_views, axis=2, keepdims=True), 1e-6
        )
        prototype_query = prepared["context"]["arrays"]["prototype_queries"].astype(
            np.float32, copy=True
        )
        prototype_query /= np.maximum(
            np.linalg.norm(prototype_query, axis=2, keepdims=True), 1e-6
        )
        per_query = np.einsum(
            "bqd,cqd->bcq", query_views, prototype_query, optimize=True
        ).astype(np.float32)
        local = views[:, :, 256:].mean(axis=1)
        local /= np.maximum(np.linalg.norm(local, axis=1, keepdims=True), 1e-6)
        with torch.no_grad():
            reference_values = reference(
                torch.from_numpy(local),
                candidate_tensor,
                torch.from_numpy(per_query),
                torch.from_numpy(base_values["body_candidate_scores"]),
            )["body_candidate_scores"].numpy()
        errors.append(
            float(
                np.max(
                    np.abs(actual_values["body_candidate_scores"] - reference_values)
                )
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
            raise RuntimeError("R45 frozen output parity failed")
    if max(errors) > 5e-4 or not single_exact:
        raise RuntimeError(f"R45 parity failed: {errors}, {single_exact}")
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
    report = r29_export._read_json(head / r45_train.REPORT_FILE)
    if report.get("schema") != r45_train.SCHEMA:
        raise RuntimeError("R45 report schema drifted")
    checkpoint = head / r45_train.CHECKPOINT_FILE
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
        contract["head"]["version"] = "manga-font-v10-r45-prototype-set-onnx-v1"
        contract["model_version"] = f"manga-font-v10-r45-{descriptor['sha256'][:12]}"
        contract["r45_prototype_set_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "checkpoint_sha256": r29_export._sha256(checkpoint),
            "context_boundary": "runtime_batch_currently_page_scoped",
            "parity": parity,
            "production_eligible": False,
            "source_model_version": source_model_version,
            "training_report_sha256": r29_export._sha256(head / r45_train.REPORT_FILE),
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
            raise RuntimeError("R45 runtime inventory drifted")
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
