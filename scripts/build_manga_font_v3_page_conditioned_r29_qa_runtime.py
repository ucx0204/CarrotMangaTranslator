"""Fuse the R29 page-context head into the current QA font ranker ONNX.

The encoder, prototypes, catalog, and calibration remain byte-identical to the
frozen r3h evaluation runtime.  Only ranker.onnx is extended.  The result is a
QA-only runtime and cannot be mistaken for a release-approved production asset.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Mapping

import numpy as np

try:
    from scripts import build_font_matching_runtime_artifact as runtime
    from scripts import screen_manga_font_v3_page_conditioned_direct_r29 as r29
except ImportError:  # pragma: no cover
    import build_font_matching_runtime_artifact as runtime
    import screen_manga_font_v3_page_conditioned_direct_r29 as r29


BASE_RUNTIME = Path(
    "artifacts/manga-font-student-v81-role-family-runtime-"
    "evaluation-only-production-r3h-v1"
)
HEAD_DIR = Path("artifacts/manga-font-v3-page-conditioned-direct-r29-qa-v1")
FILES = (
    ".font-matching-runtime-artifact-owned.json",
    "auto-match-active-catalog.json",
    "encoder.onnx",
    "prototype-features.f32",
    "ranker.onnx",
    "runtime-contract.json",
    "selection-calibration.json",
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"expected JSON object: {path}")
    return value


def _source_runtime_contract_sha256(contract: Mapping[str, Any]) -> str:
    source = copy.deepcopy(dict(contract))
    source.pop("record_sha256", None)
    source.pop("release_acceptance", None)
    source.pop("evaluation_only_runtime", None)
    artifacts = dict(source["artifacts"])
    artifacts.pop("selection-calibration.json", None)
    source["artifacts"] = artifacts
    packaging = dict(source["v8_runtime_packaging"])
    for key in (
        "evaluation_only",
        "loader_opt_in_required",
        "non_promotable",
        "qa_only",
        "release_approved",
    ):
        packaging.pop(key, None)
    packaging["quality_gate_bypassed"] = False
    source["v8_runtime_packaging"] = packaging
    record = runtime.seal_record(source)
    return hashlib.sha256(runtime.json_bytes(record, pretty=True)).hexdigest()


def _initializer(helper: Any, name: str, value: np.ndarray) -> Any:
    from onnx import numpy_helper

    return numpy_helper.from_array(np.ascontiguousarray(value), name=name)


def _rename_tensor(graph: Any, old: str, new: str) -> None:
    for node in graph.node:
        for index, value in enumerate(node.input):
            if value == old:
                node.input[index] = new
        for index, value in enumerate(node.output):
            if value == old:
                node.output[index] = new
    for collection in (graph.output, graph.value_info):
        for value in collection:
            if value.name == old:
                value.name = new


def _layer_norm(
    nodes: list[Any], helper: Any, source: str, name: str, width: int
) -> str:
    mean = f"{name}_mean"
    centered = f"{name}_centered"
    square = f"{name}_square"
    variance = f"{name}_variance"
    adjusted = f"{name}_adjusted_variance"
    denominator = f"{name}_denominator"
    output = f"{name}_output"
    nodes.extend(
        [
            helper.make_node("ReduceMean", [source], [mean], axes=[1], keepdims=1),
            helper.make_node("Sub", [source, mean], [centered]),
            helper.make_node("Mul", [centered, centered], [square]),
            helper.make_node("ReduceMean", [square], [variance], axes=[1], keepdims=1),
            helper.make_node("Add", [variance, "r29_layer_norm_epsilon"], [adjusted]),
            helper.make_node("Sqrt", [adjusted], [denominator]),
            helper.make_node("Div", [centered, denominator], [output]),
        ]
    )
    del width
    return output


def _l2_normalize(
    nodes: list[Any], helper: Any, source: str, name: str, *, axis: int
) -> str:
    norm = f"{name}_norm"
    safe_norm = f"{name}_safe_norm"
    output = f"{name}_output"
    nodes.extend(
        [
            helper.make_node("ReduceL2", [source], [norm], axes=[axis], keepdims=1),
            helper.make_node("Max", [norm, "r29_norm_epsilon"], [safe_norm]),
            helper.make_node("Div", [source, safe_norm], [output]),
        ]
    )
    return output


def _slice(
    nodes: list[Any], helper: Any, source: str, output: str, prefix: str
) -> None:
    nodes.append(
        helper.make_node(
            "Slice",
            [
                source,
                f"{prefix}_starts",
                f"{prefix}_ends",
                f"{prefix}_axes",
                f"{prefix}_steps",
            ],
            [output],
        )
    )


def fuse_ranker(base_ranker: Path, checkpoint: Path, output: Path) -> Mapping[str, Any]:
    import onnx
    import onnxruntime as ort
    import torch
    from onnx import TensorProto, helper
    from safetensors.torch import load_file

    model = onnx.load(str(base_ranker))
    graph = model.graph
    for old, new in (
        ("candidate_scores", "r29_anchor_candidate_scores"),
        ("body_candidate_scores", "r29_anchor_body_candidate_scores"),
        ("variant_candidate_scores", "r29_anchor_variant_candidate_scores"),
        ("role_logits", "r29_anchor_role_logits"),
    ):
        _rename_tensor(graph, old, new)

    state = dict(load_file(str(checkpoint), device="cpu"))
    expected = {"input.bias", "input.weight", "output.bias", "output.weight"}
    if set(state) != expected:
        raise RuntimeError("R29 checkpoint inventory drifted")
    if tuple(state["input.weight"].shape) != (32, 2092) or tuple(
        state["output.weight"].shape
    ) != (44, 32):
        raise RuntimeError("R29 checkpoint shape drifted")

    initializers = [
        _initializer(helper, "r29_query_starts", np.asarray([256], dtype=np.int64)),
        _initializer(helper, "r29_query_ends", np.asarray([1280], dtype=np.int64)),
        _initializer(helper, "r29_query_axes", np.asarray([2], dtype=np.int64)),
        _initializer(helper, "r29_query_steps", np.asarray([1], dtype=np.int64)),
        _initializer(helper, "r29_family_indices", np.asarray([0, 5], dtype=np.int64)),
        _initializer(helper, "r29_reduce_axis0", np.asarray([0], dtype=np.int64)),
        _initializer(helper, "r29_unsqueeze_axes", np.asarray([1], dtype=np.int64)),
        _initializer(helper, "r29_norm_epsilon", np.asarray([1e-6], dtype=np.float32)),
        _initializer(
            helper, "r29_layer_norm_epsilon", np.asarray([1e-5], dtype=np.float32)
        ),
        _initializer(helper, "r29_gelu_half", np.asarray([0.5], dtype=np.float32)),
        _initializer(helper, "r29_gelu_one", np.asarray([1.0], dtype=np.float32)),
        _initializer(
            helper,
            "r29_gelu_sqrt_two",
            np.asarray([np.sqrt(2.0)], dtype=np.float32),
        ),
        _initializer(helper, "r29_delta_scale", np.asarray([4.0], dtype=np.float32)),
        _initializer(helper, "r29_zero", np.asarray([0.0], dtype=np.float32)),
        _initializer(
            helper, "r29_negative_twenty", np.asarray([-20.0], dtype=np.float32)
        ),
        _initializer(
            helper,
            "r29_input_weight",
            state["input.weight"].numpy().astype(np.float32).T,
        ),
        _initializer(
            helper, "r29_input_bias", state["input.bias"].numpy().astype(np.float32)
        ),
        _initializer(
            helper,
            "r29_output_weight",
            state["output.weight"].numpy().astype(np.float32).T,
        ),
        _initializer(
            helper,
            "r29_output_bias",
            state["output.bias"].numpy().astype(np.float32),
        ),
    ]
    slices = {
        "r29_family_delta": (0, 2),
        "r29_body_delta": (2, 23),
        "r29_variant_delta": (23, 44),
        "r29_body_family": (0, 1),
        "r29_variant_family": (1, 2),
    }
    for prefix, (start, end) in slices.items():
        initializers.extend(
            [
                _initializer(
                    helper, f"{prefix}_starts", np.asarray([start], dtype=np.int64)
                ),
                _initializer(
                    helper, f"{prefix}_ends", np.asarray([end], dtype=np.int64)
                ),
                _initializer(helper, f"{prefix}_axes", np.asarray([1], dtype=np.int64)),
                _initializer(
                    helper, f"{prefix}_steps", np.asarray([1], dtype=np.int64)
                ),
            ]
        )
    graph.initializer.extend(initializers)

    nodes: list[Any] = []
    _slice(nodes, helper, "views", "r29_query_views", "r29_query")
    nodes.append(
        helper.make_node(
            "ReduceMean", ["r29_query_views"], ["r29_local_mean"], axes=[1], keepdims=0
        )
    )
    local = _l2_normalize(nodes, helper, "r29_local_mean", "r29_local", axis=1)
    nodes.extend(
        [
            helper.make_node(
                "Gather",
                ["r29_anchor_role_logits", "r29_family_indices"],
                ["r29_anchor_family_logits"],
                axis=1,
            ),
            helper.make_node(
                "Softmax",
                ["r29_anchor_family_logits"],
                ["r29_family_probabilities"],
                axis=1,
            ),
            helper.make_node(
                "Transpose",
                ["r29_family_probabilities"],
                ["r29_family_probabilities_t"],
                perm=[1, 0],
            ),
            helper.make_node(
                "MatMul",
                ["r29_family_probabilities_t", local],
                ["r29_page_weighted_sum"],
            ),
            helper.make_node(
                "ReduceSum",
                ["r29_family_probabilities", "r29_reduce_axis0"],
                ["r29_page_weight_sum"],
                keepdims=0,
            ),
            helper.make_node(
                "Unsqueeze",
                ["r29_page_weight_sum", "r29_unsqueeze_axes"],
                ["r29_page_weight_sum_column"],
            ),
            helper.make_node(
                "Max",
                ["r29_page_weight_sum_column", "r29_norm_epsilon"],
                ["r29_page_safe_weight_sum"],
            ),
            helper.make_node(
                "Div",
                ["r29_page_weighted_sum", "r29_page_safe_weight_sum"],
                ["r29_page_family_means_raw"],
            ),
        ]
    )
    family_means = _l2_normalize(
        nodes, helper, "r29_page_family_means_raw", "r29_page_family_means", axis=1
    )
    nodes.append(
        helper.make_node(
            "MatMul",
            ["r29_family_probabilities", family_means],
            ["r29_page_query_raw"],
        )
    )
    page = _l2_normalize(nodes, helper, "r29_page_query_raw", "r29_page", axis=1)
    nodes.append(
        helper.make_node(
            "Concat",
            [
                "r29_anchor_family_logits",
                "r29_anchor_body_candidate_scores",
                "r29_anchor_variant_candidate_scores",
            ],
            ["r29_anchor_outputs"],
            axis=1,
        )
    )
    local_norm = _layer_norm(nodes, helper, local, "r29_local_ln", 1024)
    page_norm = _layer_norm(nodes, helper, page, "r29_page_ln", 1024)
    anchor_norm = _layer_norm(nodes, helper, "r29_anchor_outputs", "r29_anchor_ln", 44)
    nodes.extend(
        [
            helper.make_node(
                "Concat",
                [local_norm, page_norm, anchor_norm],
                ["r29_features"],
                axis=1,
            ),
            helper.make_node(
                "MatMul", ["r29_features", "r29_input_weight"], ["r29_hidden_linear"]
            ),
            helper.make_node(
                "Add", ["r29_hidden_linear", "r29_input_bias"], ["r29_hidden_bias"]
            ),
            helper.make_node(
                "Div", ["r29_hidden_bias", "r29_gelu_sqrt_two"], ["r29_gelu_scaled"]
            ),
            helper.make_node("Erf", ["r29_gelu_scaled"], ["r29_gelu_erf"]),
            helper.make_node(
                "Add", ["r29_gelu_erf", "r29_gelu_one"], ["r29_gelu_plus_one"]
            ),
            helper.make_node(
                "Mul", ["r29_hidden_bias", "r29_gelu_plus_one"], ["r29_gelu_product"]
            ),
            helper.make_node(
                "Mul", ["r29_gelu_product", "r29_gelu_half"], ["r29_hidden"]
            ),
            helper.make_node(
                "MatMul", ["r29_hidden", "r29_output_weight"], ["r29_output_linear"]
            ),
            helper.make_node(
                "Add",
                ["r29_output_linear", "r29_output_bias"],
                ["r29_output_bias_added"],
            ),
            helper.make_node("Tanh", ["r29_output_bias_added"], ["r29_output_tanh"]),
            helper.make_node(
                "Mul", ["r29_output_tanh", "r29_delta_scale"], ["r29_delta"]
            ),
        ]
    )
    for output_name in (
        "r29_family_delta",
        "r29_body_delta",
        "r29_variant_delta",
    ):
        _slice(nodes, helper, "r29_delta", output_name, output_name)
    nodes.extend(
        [
            helper.make_node(
                "Add",
                ["r29_anchor_family_logits", "r29_family_delta"],
                ["r29_family_logits"],
            ),
            helper.make_node(
                "Add",
                ["r29_anchor_body_candidate_scores", "r29_body_delta"],
                ["body_candidate_scores"],
            ),
            helper.make_node(
                "Add",
                ["r29_anchor_variant_candidate_scores", "r29_variant_delta"],
                ["variant_candidate_scores"],
            ),
            helper.make_node(
                "Identity", ["body_candidate_scores"], ["candidate_scores"]
            ),
        ]
    )
    _slice(nodes, helper, "r29_family_logits", "r29_body_family", "r29_body_family")
    _slice(
        nodes,
        helper,
        "r29_family_logits",
        "r29_variant_family",
        "r29_variant_family",
    )
    nodes.extend(
        [
            helper.make_node(
                "Mul", ["r29_body_family", "r29_zero"], ["r29_neutral_zero"]
            ),
            helper.make_node(
                "Add",
                ["r29_neutral_zero", "r29_negative_twenty"],
                ["r29_neutral_role"],
            ),
            helper.make_node(
                "Concat",
                [
                    "r29_body_family",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_variant_family",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                    "r29_neutral_role",
                ],
                ["role_logits"],
                axis=1,
            ),
        ]
    )
    for index, node in enumerate(nodes):
        node.name = f"r29_{index:03d}_{node.op_type}"
    graph.node.extend(nodes)
    graph.output.extend(
        [
            helper.make_tensor_value_info(
                "candidate_scores", TensorProto.FLOAT, ["batch", 21]
            ),
            helper.make_tensor_value_info(
                "body_candidate_scores", TensorProto.FLOAT, ["batch", 21]
            ),
            helper.make_tensor_value_info(
                "variant_candidate_scores", TensorProto.FLOAT, ["batch", 21]
            ),
            helper.make_tensor_value_info(
                "role_logits", TensorProto.FLOAT, ["batch", 14]
            ),
        ]
    )
    anchor_outputs = {
        "r29_anchor_candidate_scores",
        "r29_anchor_body_candidate_scores",
        "r29_anchor_variant_candidate_scores",
        "r29_anchor_role_logits",
    }
    for index in reversed(range(len(graph.output))):
        if graph.output[index].name in anchor_outputs:
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
    outputs_by_name = {value.name: value for value in graph.output}
    if set(outputs_by_name) != set(output_order):
        raise RuntimeError("R29 fused ONNX output inventory drifted")
    ordered_outputs = [outputs_by_name[name] for name in output_order]
    del graph.output[:]
    graph.output.extend(ordered_outputs)
    onnx.checker.check_model(model)
    onnx.save(model, str(output))

    batch = 12
    rng = np.random.default_rng(20260829)
    views = rng.standard_normal((batch, 3, 1280), dtype=np.float32)
    prototypes = np.fromfile(
        BASE_RUNTIME / "prototype-features.f32", dtype="<f4"
    ).reshape(336, 1280)
    base_session = ort.InferenceSession(
        str(base_ranker), providers=["CPUExecutionProvider"]
    )
    actual_session = ort.InferenceSession(
        str(output), providers=["CPUExecutionProvider"]
    )
    feed = {"views": views, "prototype_features": prototypes}
    base_names = [item.name for item in base_session.get_outputs()]
    base_values = dict(zip(base_names, base_session.run(None, feed), strict=True))
    actual_names = [item.name for item in actual_session.get_outputs()]
    actual_values = dict(zip(actual_names, actual_session.run(None, feed), strict=True))

    local = views[:, :, 256:].mean(axis=1)
    local /= np.maximum(np.linalg.norm(local, axis=1, keepdims=True), 1e-6)
    anchor_family = base_values["role_logits"][:, [0, 5]]
    probabilities = torch.softmax(torch.from_numpy(anchor_family), dim=1).numpy()
    family_means = probabilities.T @ local
    family_means /= np.maximum(probabilities.sum(axis=0)[:, None], 1e-6)
    family_means /= np.maximum(
        np.linalg.norm(family_means, axis=1, keepdims=True), 1e-6
    )
    page = probabilities @ family_means
    page /= np.maximum(np.linalg.norm(page, axis=1, keepdims=True), 1e-6)
    head = r29._build_model(torch, seed=0)
    head.load_state_dict(state, strict=True)
    head.eval()
    with torch.no_grad():
        reference = head(
            torch.from_numpy(local),
            torch.from_numpy(page),
            torch.from_numpy(anchor_family),
            torch.from_numpy(base_values["body_candidate_scores"]),
            torch.from_numpy(base_values["variant_candidate_scores"]),
        )
    reference_values = {
        "body_candidate_scores": reference["body_candidate_scores"],
        "variant_candidate_scores": reference["variant_candidate_scores"],
        "role_logits": r29.r23.v8.expand_family_logits_to_role_logits(
            torch, reference["family_logits"]
        ),
    }
    errors = {
        name: float(
            np.max(
                np.abs(actual_values[name] - reference_values[name].detach().numpy())
            )
        )
        for name in reference_values
    }
    if max(errors.values()) > 2e-4 or not np.array_equal(
        actual_values["candidate_scores"], actual_values["body_candidate_scores"]
    ):
        raise RuntimeError(f"R29 fused ONNX parity failed: {errors}")
    return {"max_abs_errors": errors, "parity_batch": batch}


def build(output_dir: Path, *, head_dir: Path = HEAD_DIR) -> Mapping[str, Any]:
    target = output_dir.resolve()
    if target.exists():
        raise RuntimeError(f"output directory already exists: {target}")
    base = BASE_RUNTIME.resolve()
    head = head_dir.resolve()
    checkpoint = head / "page-context-head.safetensors"
    head_report = _read_json(head / "report.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent)
    )
    try:
        for name in FILES:
            if name in {"ranker.onnx", "runtime-contract.json", FILES[0]}:
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
        contract = _read_json(base / "runtime-contract.json")
        ranker_path = staging / "ranker.onnx"
        ranker_descriptor = {
            "byte_size": ranker_path.stat().st_size,
            "file": "ranker.onnx",
            "sha256": _sha256(ranker_path),
        }
        contract["artifacts"]["ranker.onnx"] = ranker_descriptor
        contract["model_version"] = (
            f"manga-font-v9-r29-{ranker_descriptor['sha256'][:12]}"
        )
        contract["r29_page_context_qa"] = {
            "automatic_mutation_release_approved": False,
            "calibration_reused_without_refit": True,
            "checkpoint_sha256": _sha256(checkpoint),
            "cpu_budget": head_report["architecture"],
            "page_context": "anchor-soft-family-weighted-page-mean-v1",
            "parity": parity,
            "production_eligible": False,
            "training_report_sha256": _sha256(head / "report.json"),
        }
        contract["v8_font_family_evidence"]["role_logits"] = (
            "pixel_query_plus_soft_page_context_qa"
        )
        calibration = _read_json(base / "selection-calibration.json")
        bindings = dict(calibration["bindings"])
        bindings["model_version"] = contract["model_version"]
        bindings["ranker_sha256"] = ranker_descriptor["sha256"]
        bindings["runtime_contract_sha256"] = _source_runtime_contract_sha256(contract)
        calibration["bindings"] = bindings
        calibration = runtime.seal_record(
            {key: value for key, value in calibration.items() if key != "record_sha256"}
        )
        calibration_path = staging / "selection-calibration.json"
        calibration_path.write_bytes(runtime.json_bytes(calibration, pretty=True))
        contract["artifacts"]["selection-calibration.json"] = {
            "byte_size": calibration_path.stat().st_size,
            "file": "selection-calibration.json",
            "sha256": _sha256(calibration_path),
        }
        contract = runtime.seal_record(
            {key: value for key, value in contract.items() if key != "record_sha256"}
        )
        contract_path = staging / "runtime-contract.json"
        contract_path.write_bytes(runtime.json_bytes(contract, pretty=True))
        marker_artifacts = {
            name: _sha256(staging / name)
            for name in FILES
            if name != ".font-matching-runtime-artifact-owned.json"
        }
        marker = {
            "artifacts": marker_artifacts,
            "owner": "carrot-manga-translator/font-matching-runtime-artifact-v2",
            "qa_only": True,
            "release_approved": False,
            "safe_replace": True,
            "schema_version": "font-matching-runtime-artifact-v2",
        }
        (staging / FILES[0]).write_bytes(runtime.json_bytes(marker, pretty=True))
        if {path.name for path in staging.iterdir()} != set(FILES):
            raise RuntimeError("R29 QA runtime inventory drifted")
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {
        "model_version": contract["model_version"],
        "output_dir": str(target),
        "parity": parity,
        "qa_only": True,
        "ranker": ranker_descriptor,
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
