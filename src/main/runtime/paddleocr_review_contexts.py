"""Stable review-context projection for PaddleOCR textline partitions."""

from __future__ import annotations


def build_textline_review_context_ids(partition: dict) -> dict[int, str]:
    """Project review-edge connected components onto stable candidate ids."""

    edges = partition.get("reviewEdges", [])
    if not isinstance(edges, list):
        raise ValueError("axis-v4 reviewEdges must be a list")
    if not edges:
        return {}

    known_ids = _collect_partition_candidate_ids(partition)
    parent: dict[int, int] = {}
    for edge_index, edge in enumerate(edges, start=1):
        candidate_ids = _read_review_edge_candidate_ids(
            edge,
            edge_index,
            known_ids,
        )
        _union_component(parent, candidate_ids)
    return _serialize_review_contexts(parent)


def _collect_partition_candidate_ids(partition: dict) -> set[int]:
    known_ids: set[int] = set()
    for group in partition.get("groups", []):
        if not isinstance(group, list):
            raise ValueError("axis-v4 groups must be lists")
        for candidate in group:
            _register_candidate_id(candidate, known_ids)

    for entry in partition.get("deferred", []):
        deferred_items = entry.get("items") if isinstance(entry, dict) else None
        if not isinstance(deferred_items, list):
            raise ValueError("axis-v4 deferred entries need an items list")
        for candidate in deferred_items:
            _register_candidate_id(candidate, known_ids)
    return known_ids


def _register_candidate_id(candidate: object, known_ids: set[int]) -> None:
    candidate_id = candidate.get("id") if isinstance(candidate, dict) else None
    if (
        not isinstance(candidate_id, int)
        or isinstance(candidate_id, bool)
        or candidate_id <= 0
        or candidate_id in known_ids
    ):
        raise ValueError("axis-v4 candidates need unique positive ids")
    known_ids.add(candidate_id)


def _read_review_edge_candidate_ids(
    edge: object,
    edge_index: int,
    known_ids: set[int],
) -> list[int]:
    component_ids = (
        edge.get("componentCandidateIds")
        if isinstance(edge, dict)
        else None
    )
    if (
        not isinstance(component_ids, list)
        or len(component_ids) != 2
        or any(
            not isinstance(component, list) or not component
            for component in component_ids
        )
    ):
        raise ValueError(
            f"axis-v4 review edge {edge_index} needs two candidate components"
        )

    flattened: list[int] = []
    for component in component_ids:
        for candidate_id in component:
            if (
                not isinstance(candidate_id, int)
                or isinstance(candidate_id, bool)
                or candidate_id not in known_ids
            ):
                raise ValueError(
                    f"axis-v4 review edge {edge_index} references an unknown candidate"
                )
            flattened.append(candidate_id)
    return flattened


def _find_root(parent: dict[int, int], candidate_id: int) -> int:
    parent.setdefault(candidate_id, candidate_id)
    while parent[candidate_id] != candidate_id:
        parent[candidate_id] = parent[parent[candidate_id]]
        candidate_id = parent[candidate_id]
    return candidate_id


def _union_component(parent: dict[int, int], candidate_ids: list[int]) -> None:
    anchor = candidate_ids[0]
    for candidate_id in candidate_ids[1:]:
        left_root = _find_root(parent, anchor)
        right_root = _find_root(parent, candidate_id)
        if left_root == right_root:
            continue
        keep, drop = sorted((left_root, right_root))
        parent[drop] = keep


def _serialize_review_contexts(parent: dict[int, int]) -> dict[int, str]:
    components: dict[int, list[int]] = {}
    for candidate_id in sorted(parent):
        components.setdefault(_find_root(parent, candidate_id), []).append(
            candidate_id
        )
    ordered = sorted(
        components.values(),
        key=lambda members: (min(members), members),
    )
    contexts: dict[int, str] = {}
    for context_index, members in enumerate(ordered, start=1):
        context_id = f"RC{context_index:03d}"
        for candidate_id in members:
            contexts[candidate_id] = context_id
    return contexts
