"""Perspective and mesh-based dewarp export."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import cv2
import numpy as np

MESH_CURVE_SAMPLE_STEPS = 18
MESH_CONSTRAINT_STEPS = 8
TPS_SMOOTHING = 0.012
OUTER_MESH_WEIGHT = 1.8
INNER_MESH_WEIGHT = 0.28
OUTER_PRIOR_WEIGHT = 0.08
PARALLEL_RAIL_WEIGHT = 0.14


Point = tuple[float, float]
ProgressCallback = Callable[[float, str], None]
BOUNDARY_SAMPLE_COUNT = 513
FILL_FEATHER_RADIUS = 18


def _emit_progress(progress: ProgressCallback | None, percent: float, stage: str) -> None:
    if progress is None:
        return
    progress(max(0.0, min(100.0, percent)), stage)


def _write_image(output_path: str, img: np.ndarray, quality: int) -> bool:
    ext = Path(output_path).suffix.lower()
    if ext == ".png":
        return cv2.imwrite(output_path, img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    return cv2.imwrite(output_path, img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])


def _order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(-1, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float64)


def _dist(a: Point, b: Point) -> float:
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def _add(a: Point, b: Point) -> Point:
    return (a[0] + b[0], a[1] + b[1])


def _sub(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1])


def _mul(a: Point, scalar: float) -> Point:
    return (a[0] * scalar, a[1] * scalar)


def _lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t)


def _mesh_curve_strength(mesh_curve: float | int | None) -> float:
    try:
        value = float(mesh_curve if mesh_curve is not None else 75.0)
    except (TypeError, ValueError):
        value = 75.0
    return max(0.0, min(1.0, value / 100.0))


def _hermite_array(p0: np.ndarray, m0: np.ndarray, p1: np.ndarray, m1: np.ndarray, t: np.ndarray) -> np.ndarray:
    t2 = t * t
    t3 = t2 * t
    h00 = 2.0 * t3 - 3.0 * t2 + 1.0
    h10 = t3 - 2.0 * t2 + t
    h01 = -2.0 * t3 + 3.0 * t2
    h11 = t3 - t2
    return (
        p0 * h00[:, None]
        + m0 * h10[:, None]
        + p1 * h01[:, None]
        + m1 * h11[:, None]
    )


def _node_point(node: dict) -> Point:
    point = node["point"]
    return (float(point[0]), float(point[1]))


def _node_handle(node: dict) -> Point:
    handle = node.get("handle") or [0, 0]
    return (float(handle[0]), float(handle[1]))


def _node_out_handle(node: dict) -> Point:
    point = _node_point(node)
    if node.get("corner"):
        return point
    return _add(point, _node_handle(node))


def _node_in_handle(node: dict) -> Point:
    point = _node_point(node)
    if node.get("corner"):
        return point
    return _sub(point, _node_handle(node))


def _cubic_point(a: Point, b: Point, c: Point, d: Point, t: float) -> Point:
    mt = 1 - t
    mt2 = mt * mt
    t2 = t * t
    return (
        mt2 * mt * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t2 * t * d[0],
        mt2 * mt * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t2 * t * d[1],
    )


def _path_corner(path: dict, index: int) -> Point:
    return _node_point(path["nodes"][path["cornerIndices"][index]])


def _path_area(path: dict) -> float:
    corners = [_path_corner(path, i) for i in range(4)]
    area = 0.0
    for i, a in enumerate(corners):
        b = corners[(i + 1) % len(corners)]
        area += a[0] * b[1] - b[0] * a[1]
    return abs(area) / 2


def _derive_rectangles(rectangles: list[dict]) -> tuple[dict, list[dict]]:
    if not rectangles:
        raise RuntimeError("at least one rectangle is required")
    sorted_rectangles = sorted(rectangles, key=_path_area, reverse=True)
    return sorted_rectangles[0], sorted_rectangles[1:]


def _side_segment_indices(path: dict, side_index: int) -> list[int]:
    start = int(path["cornerIndices"][side_index])
    end = int(path["cornerIndices"][(side_index + 1) % 4])
    out: list[int] = []
    index = start
    for _ in range(len(path["nodes"])):
        out.append(index)
        index = (index + 1) % len(path["nodes"])
        if index == end:
            break
    return out


def _path_segment_point(path: dict, index: int, t: float) -> Point:
    nodes = path["nodes"]
    a = nodes[index]
    b = nodes[(index + 1) % len(nodes)]
    return _cubic_point(_node_point(a), _node_out_handle(a), _node_in_handle(b), _node_point(b), t)


def _path_segment_point_directed(path: dict, index: int, direction: int, t: float) -> Point:
    if direction == 1:
        return _path_segment_point(path, index, t)
    previous_index = (index - 1 + len(path["nodes"])) % len(path["nodes"])
    return _path_segment_point(path, previous_index, 1 - t)


def _point_on_side(path: dict, side_index: int, t: float) -> Point:
    segments = _side_segment_indices(path, side_index)
    if not segments:
        return _path_corner(path, side_index)

    previous = _path_segment_point(path, segments[0], 0)
    total = 0.0
    samples: list[tuple[Point, float]] = [(previous, 0.0)]
    for segment_index in segments:
        for step in range(1, MESH_CURVE_SAMPLE_STEPS + 1):
            point = _path_segment_point(path, segment_index, step / MESH_CURVE_SAMPLE_STEPS)
            total += _dist(previous, point)
            samples.append((point, total))
            previous = point

    if total <= 1e-6:
        return samples[0][0]

    target = total * max(0.0, min(1.0, t))
    for i in range(1, len(samples)):
        if samples[i][1] < target:
            continue
        prev_point, prev_len = samples[i - 1]
        cur_point, cur_len = samples[i]
        span = cur_len - prev_len
        local_t = 0.0 if span <= 1e-6 else (target - prev_len) / span
        return _lerp(prev_point, cur_point, local_t)
    return samples[-1][0]


def _coons_point(path: dict, u: float, v: float) -> Point:
    tl = _path_corner(path, 0)
    tr = _path_corner(path, 1)
    br = _path_corner(path, 2)
    bl = _path_corner(path, 3)
    top = _point_on_side(path, 0, u)
    right = _point_on_side(path, 1, v)
    bottom = _point_on_side(path, 2, 1 - u)
    left = _point_on_side(path, 3, 1 - v)
    edge_blend = _add(_lerp(top, bottom, v), _lerp(left, right, u))
    corner_blend = _add(
        _add(_mul(tl, (1 - u) * (1 - v)), _mul(tr, u * (1 - v))),
        _add(_mul(br, u * v), _mul(bl, (1 - u) * v)),
    )
    return _sub(edge_blend, corner_blend)


def _boundary_length(boundary) -> float:
    total = 0.0
    previous = boundary(0.0)
    steps = MESH_CONSTRAINT_STEPS * 3
    for i in range(1, steps + 1):
        point = boundary(i / steps)
        total += _dist(previous, point)
        previous = point
    return total


def _boundaries(path: dict) -> dict:
    return {
        "top": lambda u: _point_on_side(path, 0, u),
        "right": lambda v: _point_on_side(path, 1, v),
        "bottom": lambda u: _point_on_side(path, 2, 1 - u),
        "left": lambda v: _point_on_side(path, 3, 1 - v),
    }


def _affine_param_for_outer(outer_path: dict, point: Point) -> Point:
    tl = _path_corner(outer_path, 0)
    tr = _path_corner(outer_path, 1)
    bl = _path_corner(outer_path, 3)
    ux, uy = tr[0] - tl[0], tr[1] - tl[1]
    vx, vy = bl[0] - tl[0], bl[1] - tl[1]
    px, py = point[0] - tl[0], point[1] - tl[1]
    det = ux * vy - uy * vx
    if abs(det) < 1e-6:
        return (0.5, 0.5)
    return (
        max(0.0, min(1.0, (px * vy - py * vx) / det)),
        max(0.0, min(1.0, (ux * py - uy * px) / det)),
    )


def _path_center(path: dict) -> Point:
    corners = [_path_corner(path, i) for i in range(4)]
    return (
        sum(point[0] for point in corners) / len(corners),
        sum(point[1] for point in corners) / len(corners),
    )


def _basis_param(tl: Point, tr: Point, bl: Point, point: Point) -> Point:
    ux, uy = tr[0] - tl[0], tr[1] - tl[1]
    vx, vy = bl[0] - tl[0], bl[1] - tl[1]
    px, py = point[0] - tl[0], point[1] - tl[1]
    det = ux * vy - uy * vx
    if abs(det) < 1e-6:
        return (0.5, 0.5)
    return ((px * vy - py * vx) / det, (ux * py - uy * px) / det)


def _pick_canonical_corner_indices(path: dict, outer: dict | None = None) -> list[int]:
    entries = []
    for node_index in path["cornerIndices"]:
        point = _node_point(path["nodes"][int(node_index)])
        coord = _basis_param(outer["corners"][0], outer["corners"][1], outer["corners"][3], point) if outer else point
        entries.append({"node_index": int(node_index), "point": point, "coord": coord})

    def pick(score, reverse: bool = False) -> int:
        return sorted(entries, key=score, reverse=reverse)[0]["node_index"]

    ordered = [
        pick(lambda entry: entry["coord"][0] + entry["coord"][1]),
        pick(lambda entry: entry["coord"][0] - entry["coord"][1], True),
        pick(lambda entry: entry["coord"][0] + entry["coord"][1], True),
        pick(lambda entry: entry["coord"][0] - entry["coord"][1]),
    ]
    if len(set(ordered)) == 4:
        return ordered

    center = (
        sum(entry["coord"][0] for entry in entries) / len(entries),
        sum(entry["coord"][1] for entry in entries) / len(entries),
    )
    by_angle = sorted(entries, key=lambda entry: np.arctan2(entry["coord"][1] - center[1], entry["coord"][0] - center[0]))
    start_index = min(range(len(by_angle)), key=lambda i: by_angle[i]["coord"][0] + by_angle[i]["coord"][1])
    return [entry["node_index"] for entry in (by_angle[start_index:] + by_angle[:start_index])]


def _directed_route_length(path: dict, start_index: int, end_index: int, direction: int) -> float:
    total = 0.0
    index = start_index
    previous = _path_segment_point_directed(path, index, direction, 0)
    for _ in range(len(path["nodes"])):
        for step in range(1, MESH_CURVE_SAMPLE_STEPS + 1):
            point = _path_segment_point_directed(path, index, direction, step / MESH_CURVE_SAMPLE_STEPS)
            total += _dist(previous, point)
            previous = point
        index = (index + direction + len(path["nodes"])) % len(path["nodes"])
        if index == end_index:
            break
    return total


def _route_boundary(path: dict, start_index: int, end_index: int):
    forward_length = _directed_route_length(path, start_index, end_index, 1)
    reverse_length = _directed_route_length(path, start_index, end_index, -1)
    direction = 1 if forward_length <= reverse_length else -1

    def boundary(t: float) -> Point:
        previous = _path_segment_point_directed(path, start_index, direction, 0)
        total = 0.0
        samples: list[tuple[Point, float]] = [(previous, 0.0)]
        index = start_index
        for _ in range(len(path["nodes"])):
            for step in range(1, MESH_CURVE_SAMPLE_STEPS + 1):
                point = _path_segment_point_directed(path, index, direction, step / MESH_CURVE_SAMPLE_STEPS)
                total += _dist(previous, point)
                samples.append((point, total))
                previous = point
            index = (index + direction + len(path["nodes"])) % len(path["nodes"])
            if index == end_index:
                break
        if total <= 1e-6:
            return samples[0][0]
        target = total * max(0.0, min(1.0, t))
        for i in range(1, len(samples)):
            if samples[i][1] < target:
                continue
            prev_point, prev_len = samples[i - 1]
            cur_point, cur_len = samples[i]
            span = cur_len - prev_len
            return _lerp(prev_point, cur_point, 0 if span <= 1e-6 else (target - prev_len) / span)
        return samples[-1][0]

    return boundary


def _canonicalize_path(path: dict, outer: dict | None = None) -> dict:
    corner_indices = _pick_canonical_corner_indices(path, outer)
    corners = [_node_point(path["nodes"][index]) for index in corner_indices]
    boundaries = {
        "top": _route_boundary(path, corner_indices[0], corner_indices[1]),
        "right": _route_boundary(path, corner_indices[1], corner_indices[2]),
        "bottom": _route_boundary(path, corner_indices[3], corner_indices[2]),
        "left": _route_boundary(path, corner_indices[0], corner_indices[3]),
    }
    return {"path": path, "corner_indices": corner_indices, "corners": corners, "boundaries": boundaries}


def _target_rect_corners(rect: dict) -> list[Point]:
    return [
        (rect["x0"], rect["y0"]),
        (rect["x1"], rect["y0"]),
        (rect["x1"], rect["y1"]),
        (rect["x0"], rect["y1"]),
    ]


def _connection_boundary(a: Point, b: Point):
    return lambda t: _lerp(a, b, t)


def _sample_boundary(boundary) -> np.ndarray:
    return np.array([boundary(i / (BOUNDARY_SAMPLE_COUNT - 1)) for i in range(BOUNDARY_SAMPLE_COUNT)], dtype=np.float64)


def _make_patch(target: list[Point], boundaries: dict, elastic: bool = False, before=None, after=None) -> dict:
    samples = {name: _sample_boundary(boundary) for name, boundary in boundaries.items()}
    if before is not None:
        samples["before"] = _sample_boundary(before)
    if after is not None:
        samples["after"] = _sample_boundary(after)
    return {
        "target": np.array(target, dtype=np.float64),
        "samples": samples,
        "elastic": elastic,
    }


def _band_patches(parent: dict, child: dict) -> list[dict]:
    ptl, ptr, pbr, pbl = _target_rect_corners(parent)
    ctl, ctr, cbr, cbl = _target_rect_corners(child)
    p = parent["path"]
    c = child["path"]
    return [
        _make_patch([ptl, ptr, ctr, ctl], {
            "top": p["boundaries"]["top"],
            "right": _connection_boundary(p["corners"][1], c["corners"][1]),
            "bottom": c["boundaries"]["top"],
            "left": _connection_boundary(p["corners"][0], c["corners"][0]),
        }, True, None, c["boundaries"]["bottom"]),
        _make_patch([ptr, pbr, cbr, ctr], {
            "top": p["boundaries"]["right"],
            "right": _connection_boundary(p["corners"][2], c["corners"][2]),
            "bottom": c["boundaries"]["right"],
            "left": _connection_boundary(p["corners"][1], c["corners"][1]),
        }, True, None, c["boundaries"]["left"]),
        _make_patch([pbl, pbr, cbr, cbl], {
            "top": p["boundaries"]["bottom"],
            "right": _connection_boundary(p["corners"][2], c["corners"][2]),
            "bottom": c["boundaries"]["bottom"],
            "left": _connection_boundary(p["corners"][3], c["corners"][3]),
        }, True, None, c["boundaries"]["top"]),
        _make_patch([ptl, pbl, cbl, ctl], {
            "top": p["boundaries"]["left"],
            "right": _connection_boundary(p["corners"][3], c["corners"][3]),
            "bottom": c["boundaries"]["left"],
            "left": _connection_boundary(p["corners"][0], c["corners"][0]),
        }, True, None, c["boundaries"]["right"]),
    ]


def _build_nested_mesh_layout(outer_path: dict, inner_paths: list[dict]) -> dict:
    outer = _canonicalize_path(outer_path)
    width = max(1.0, (_boundary_length(outer["boundaries"]["top"]) + _boundary_length(outer["boundaries"]["bottom"])) / 2)
    height = max(1.0, (_boundary_length(outer["boundaries"]["left"]) + _boundary_length(outer["boundaries"]["right"])) / 2)
    min_gap = max(8.0, min(width, height) * 0.025)
    rects = [{"path": outer, "x0": 0.0, "y0": 0.0, "x1": width, "y1": height}]

    for path in sorted(inner_paths, key=_path_area, reverse=True):
        canonical = _canonicalize_path(path, outer)
        measured_width = max(1.0, (_boundary_length(canonical["boundaries"]["top"]) + _boundary_length(canonical["boundaries"]["bottom"])) / 2)
        measured_height = max(1.0, (_boundary_length(canonical["boundaries"]["left"]) + _boundary_length(canonical["boundaries"]["right"])) / 2)
        params = [_basis_param(outer["corners"][0], outer["corners"][1], outer["corners"][3], corner) for corner in canonical["corners"]]
        cx = width * (sum(param[0] for param in params) / len(params))
        cy = height * (sum(param[1] for param in params) / len(params))
        parent = rects[-1]
        max_width = max(1.0, parent["x1"] - parent["x0"] - min_gap * 2)
        max_height = max(1.0, parent["y1"] - parent["y0"] - min_gap * 2)
        scale = min(1.0, max_width / measured_width, max_height / measured_height)
        target_width = measured_width * scale
        target_height = measured_height * scale
        x0 = max(parent["x0"] + min_gap, min(parent["x1"] - min_gap - target_width, cx - target_width / 2))
        y0 = max(parent["y0"] + min_gap, min(parent["y1"] - min_gap - target_height, cy - target_height / 2))
        rects.append({"path": canonical, "x0": x0, "y0": y0, "x1": x0 + target_width, "y1": y0 + target_height})

    patches = []
    for i in range(len(rects) - 1):
        patches.extend(_band_patches(rects[i], rects[i + 1]))
    smallest = rects[-1]
    smallest_parent = rects[-2] if len(rects) > 1 else None
    patches.append(_make_patch(
        _target_rect_corners(smallest),
        smallest["path"]["boundaries"],
        smallest_parent is not None,
        smallest_parent["path"]["boundaries"]["top"] if smallest_parent else None,
        smallest_parent["path"]["boundaries"]["bottom"] if smallest_parent else None,
    ))
    outer_patch = _make_patch(_target_rect_corners(rects[0]), rects[0]["path"]["boundaries"])
    return {"width": width, "height": height, "rects": rects, "patches": patches, "outer_patch": outer_patch}


def _cross_array(a: np.ndarray, b: np.ndarray, points: np.ndarray) -> np.ndarray:
    return (b[0] - a[0]) * (points[:, 1] - a[1]) - (b[1] - a[1]) * (points[:, 0] - a[0])


def _points_in_quad(points: np.ndarray, corners: np.ndarray) -> np.ndarray:
    values = np.stack([
        _cross_array(corners[i], corners[(i + 1) % 4], points)
        for i in range(4)
    ], axis=1)
    eps = 1e-6
    return np.all(values >= -eps, axis=1) | np.all(values <= eps, axis=1)


def _bilinear_point_array(corners: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    p0, p1, p2, p3 = corners
    return (
        p0[None, :] * ((1 - u) * (1 - v))[:, None]
        + p1[None, :] * (u * (1 - v))[:, None]
        + p2[None, :] * (u * v)[:, None]
        + p3[None, :] * (((1 - u) * v))[:, None]
    )


def _invert_bilinear_array(corners: np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    p0, p1, p2, p3 = corners
    ux, uy = p1 - p0
    vx, vy = p3 - p0
    det = ux * vy - uy * vx
    if abs(det) < 1e-8:
        u = np.full(points.shape[0], 0.5, dtype=np.float64)
        v = np.full(points.shape[0], 0.5, dtype=np.float64)
    else:
        px = points[:, 0] - p0[0]
        py = points[:, 1] - p0[1]
        u = (px * vy - py * vx) / det
        v = (ux * py - uy * px) / det

    valid = np.ones(points.shape[0], dtype=bool)
    for _ in range(6):
        current = _bilinear_point_array(corners, u, v)
        f = current - points
        du = (p1 - p0)[None, :] * (1 - v)[:, None] + (p2 - p3)[None, :] * v[:, None]
        dv = (p3 - p0)[None, :] * (1 - u)[:, None] + (p2 - p1)[None, :] * u[:, None]
        jdet = du[:, 0] * dv[:, 1] - du[:, 1] * dv[:, 0]
        step_valid = np.abs(jdet) > 1e-8
        valid &= step_valid
        safe = np.where(step_valid, jdet, 1.0)
        u -= (f[:, 0] * dv[:, 1] - f[:, 1] * dv[:, 0]) / safe
        v -= (du[:, 0] * f[:, 1] - du[:, 1] * f[:, 0]) / safe
    return np.clip(u, 0.0, 1.0), np.clip(v, 0.0, 1.0), valid


def _interp_sample(samples: np.ndarray, values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, 0.0, 1.0) * (samples.shape[0] - 1)
    idx = np.floor(clipped).astype(np.int32)
    idx1 = np.minimum(idx + 1, samples.shape[0] - 1)
    frac = clipped - idx
    return samples[idx] * (1 - frac)[:, None] + samples[idx1] * frac[:, None]


def _elastic_cross_array(samples: dict, u: np.ndarray, v: np.ndarray, mesh_curve: float | int | None) -> np.ndarray:
    start = _interp_sample(samples["top"], u)
    end = _interp_sample(samples["bottom"], u)
    delta = end - start
    strength = _mesh_curve_strength(mesh_curve)
    previous = _interp_sample(samples["before"], u) if "before" in samples else None
    next_point = _interp_sample(samples["after"], u) if "after" in samples else None
    start_tangent = (end - previous) * 0.5 if previous is not None else delta
    end_tangent = (next_point - start) * 0.5 if next_point is not None else delta
    m0 = delta * (1.0 - strength) + start_tangent * strength
    m1 = delta * (1.0 - strength) + end_tangent * strength
    return _hermite_array(start, m0, end, m1, v)


def _coons_patch_array(patch: dict, u: np.ndarray, v: np.ndarray, mesh_curve: float | int | None) -> np.ndarray:
    samples = patch["samples"]
    if patch.get("elastic") and _mesh_curve_strength(mesh_curve) > 0:
        base = _elastic_cross_array(samples, u, v, mesh_curve)
        left_base = _elastic_cross_array(samples, np.zeros_like(u), v, mesh_curve)
        right_base = _elastic_cross_array(samples, np.ones_like(u), v, mesh_curve)
        left = _interp_sample(samples["left"], v)
        right = _interp_sample(samples["right"], v)
        return base + (left - left_base) * (1.0 - u)[:, None] + (right - right_base) * u[:, None]

    top = _interp_sample(samples["top"], u)
    right = _interp_sample(samples["right"], v)
    bottom = _interp_sample(samples["bottom"], u)
    left = _interp_sample(samples["left"], v)
    tl = samples["top"][0]
    tr = samples["top"][-1]
    br = samples["bottom"][-1]
    bl = samples["bottom"][0]
    edge_blend = top * (1 - v)[:, None] + bottom * v[:, None] + left * (1 - u)[:, None] + right * u[:, None]
    corner_blend = (
        tl[None, :] * ((1 - u) * (1 - v))[:, None]
        + tr[None, :] * (u * (1 - v))[:, None]
        + br[None, :] * (u * v)[:, None]
        + bl[None, :] * (((1 - u) * v))[:, None]
    )
    return edge_blend - corner_blend


def _transform_nested_chunk(layout: dict, points: np.ndarray, mesh_curve: float | int | None) -> tuple[np.ndarray, np.ndarray]:
    out = np.empty_like(points, dtype=np.float64)
    assigned = np.zeros(points.shape[0], dtype=bool)
    for patch in layout["patches"]:
        candidates = np.where(~assigned & _points_in_quad(points, patch["target"]))[0]
        if candidates.size == 0:
            continue
        u, v, valid = _invert_bilinear_array(patch["target"], points[candidates])
        valid_candidates = candidates[valid]
        if valid_candidates.size == 0:
            continue
        out[valid_candidates] = _coons_patch_array(patch, u[valid], v[valid], mesh_curve)
        assigned[valid_candidates] = True

    if not np.all(assigned):
        fallback = layout["outer_patch"]
        missing = np.where(~assigned)[0]
        u = np.clip(points[missing, 0] / max(1.0, layout["width"]), 0.0, 1.0)
        v = np.clip(points[missing, 1] / max(1.0, layout["height"]), 0.0, 1.0)
        out[missing] = _coons_patch_array(fallback, u, v, mesh_curve)
    return out[:, 0], out[:, 1]


def _mesh_layout(outer_path: dict, inner_paths: list[dict]) -> dict:
    outer = _boundaries(outer_path)
    width = max(1.0, (_boundary_length(outer["top"]) + _boundary_length(outer["bottom"])) / 2)
    height = max(1.0, (_boundary_length(outer["left"]) + _boundary_length(outer["right"])) / 2)
    min_gap = max(8.0, min(width, height) * 0.025)
    inner_rects = []
    for path in inner_paths:
        boundaries = _boundaries(path)
        measured_width = max(1.0, (_boundary_length(boundaries["top"]) + _boundary_length(boundaries["bottom"])) / 2)
        measured_height = max(1.0, (_boundary_length(boundaries["left"]) + _boundary_length(boundaries["right"])) / 2)
        params = [_affine_param_for_outer(outer_path, _path_corner(path, i)) for i in range(4)]
        left_u = (params[0][0] + params[3][0]) / 2
        right_u = (params[1][0] + params[2][0]) / 2
        top_v = (params[0][1] + params[1][1]) / 2
        bottom_v = (params[2][1] + params[3][1]) / 2
        inner_width = min(width - min_gap * 2, max(min_gap, abs(right_u - left_u) * width, measured_width * 0.35))
        inner_height = min(height - min_gap * 2, max(min_gap, abs(bottom_v - top_v) * height, measured_height * 0.35))
        cx = width * ((left_u + right_u) / 2)
        cy = height * ((top_v + bottom_v) / 2)
        x0 = max(min_gap, min(width - min_gap - inner_width, cx - inner_width / 2))
        y0 = max(min_gap, min(height - min_gap - inner_height, cy - inner_height / 2))
        inner_rects.append({
            "path": path,
            "x0": x0,
            "x1": x0 + inner_width,
            "y0": y0,
            "y1": y0 + inner_height,
        })
    return {"width": width, "height": height, "inner_rects": inner_rects}


def _tps_kernel_points(points: np.ndarray, targets: np.ndarray) -> np.ndarray:
    diff = points[:, None, :] - targets[None, :, :]
    r2 = np.sum(diff * diff, axis=2)
    out = np.zeros_like(r2, dtype=np.float64)
    mask = r2 > 1e-9
    out[mask] = r2[mask] * np.log(r2[mask])
    return out


def _build_tps_model(targets: list[Point], sources: list[Point], weights: list[float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    target_arr = np.array(targets, dtype=np.float64)
    source_arr = np.array(sources, dtype=np.float64)
    weight_arr = np.array(weights, dtype=np.float64)
    n = target_arr.shape[0]
    if n < 4 or source_arr.shape[0] != n or weight_arr.shape[0] != n:
        raise RuntimeError("invalid TPS constraints")

    size = n + 3
    matrix = np.zeros((size, size), dtype=np.float64)
    matrix[:n, :n] = _tps_kernel_points(target_arr, target_arr)
    scale = max(1.0, float(np.max(np.linalg.norm(target_arr, axis=1))))
    regularization = scale * scale * TPS_SMOOTHING
    matrix[np.arange(n), np.arange(n)] += regularization / np.maximum(0.01, weight_arr)
    matrix[:n, n] = 1.0
    matrix[:n, n + 1] = target_arr[:, 0]
    matrix[:n, n + 2] = target_arr[:, 1]
    matrix[n, :n] = 1.0
    matrix[n + 1, :n] = target_arr[:, 0]
    matrix[n + 2, :n] = target_arr[:, 1]

    rhs_x = np.zeros(size, dtype=np.float64)
    rhs_y = np.zeros(size, dtype=np.float64)
    rhs_x[:n] = source_arr[:, 0]
    rhs_y[:n] = source_arr[:, 1]
    weights_x = np.linalg.solve(matrix, rhs_x)
    weights_y = np.linalg.solve(matrix, rhs_y)
    return target_arr, weights_x, weights_y


def _transform_tps_chunk(points: np.ndarray, targets: np.ndarray, weights_x: np.ndarray, weights_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n = targets.shape[0]
    kernel = _tps_kernel_points(points, targets)
    x = weights_x[n] + weights_x[n + 1] * points[:, 0] + weights_x[n + 2] * points[:, 1] + kernel @ weights_x[:n]
    y = weights_y[n] + weights_y[n + 1] * points[:, 0] + weights_y[n + 2] * points[:, 1] + kernel @ weights_y[:n]
    return x, y


def _add_constraint(
    targets: list[Point],
    sources: list[Point],
    weights: list[float],
    seen: set[tuple[int, int]],
    target: Point,
    source: Point,
    weight: float,
) -> None:
    key = (round(target[0] * 1000), round(target[1] * 1000))
    if key in seen:
        return
    seen.add(key)
    targets.append(target)
    sources.append(source)
    weights.append(weight)


def _build_dewarp_model(outer_path: dict, inner_paths: list[dict]) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray]:
    layout = _mesh_layout(outer_path, inner_paths)
    targets: list[Point] = []
    sources: list[Point] = []
    weights: list[float] = []
    seen: set[tuple[int, int]] = set()
    outer = _boundaries(outer_path)

    for i in range(MESH_CONSTRAINT_STEPS + 1):
        t = i / MESH_CONSTRAINT_STEPS
        _add_constraint(targets, sources, weights, seen, (layout["width"] * t, 0.0), outer["top"](t), OUTER_MESH_WEIGHT)
        _add_constraint(targets, sources, weights, seen, (layout["width"], layout["height"] * t), outer["right"](t), OUTER_MESH_WEIGHT)
        _add_constraint(targets, sources, weights, seen, (layout["width"] * t, layout["height"]), outer["bottom"](t), OUTER_MESH_WEIGHT)
        _add_constraint(targets, sources, weights, seen, (0.0, layout["height"] * t), outer["left"](t), OUTER_MESH_WEIGHT)
        for inner_rect in layout["inner_rects"]:
            boundaries = _boundaries(inner_rect["path"])
            x0, x1 = inner_rect["x0"], inner_rect["x1"]
            y0, y1 = inner_rect["y0"], inner_rect["y1"]
            _add_constraint(targets, sources, weights, seen, (x0 + (x1 - x0) * t, y0), boundaries["top"](t), INNER_MESH_WEIGHT)
            _add_constraint(targets, sources, weights, seen, (x1, y0 + (y1 - y0) * t), boundaries["right"](t), INNER_MESH_WEIGHT)
            _add_constraint(targets, sources, weights, seen, (x0 + (x1 - x0) * t, y1), boundaries["bottom"](t), INNER_MESH_WEIGHT)
            _add_constraint(targets, sources, weights, seen, (x0, y0 + (y1 - y0) * t), boundaries["left"](t), INNER_MESH_WEIGHT)
            inner_x = x0 + (x1 - x0) * t
            inner_y = y0 + (y1 - y0) * t
            for rail_t in (1 / 3, 2 / 3):
                _add_constraint(
                    targets,
                    sources,
                    weights,
                    seen,
                    (inner_x, y0 * rail_t),
                    _lerp(outer["top"](inner_x / layout["width"]), boundaries["top"](t), rail_t),
                    PARALLEL_RAIL_WEIGHT,
                )
                _add_constraint(
                    targets,
                    sources,
                    weights,
                    seen,
                    (inner_x, y1 + (layout["height"] - y1) * rail_t),
                    _lerp(boundaries["bottom"](t), outer["bottom"](inner_x / layout["width"]), rail_t),
                    PARALLEL_RAIL_WEIGHT,
                )
                _add_constraint(
                    targets,
                    sources,
                    weights,
                    seen,
                    (x0 * rail_t, inner_y),
                    _lerp(outer["left"](inner_y / layout["height"]), boundaries["left"](t), rail_t),
                    PARALLEL_RAIL_WEIGHT,
                )
                _add_constraint(
                    targets,
                    sources,
                    weights,
                    seen,
                    (x1 + (layout["width"] - x1) * rail_t, inner_y),
                    _lerp(boundaries["right"](t), outer["right"](inner_y / layout["height"]), rail_t),
                    PARALLEL_RAIL_WEIGHT,
                )

    for y in range(1, 5):
        v = y / 5
        for x in range(1, 5):
            u = x / 5
            _add_constraint(
                targets,
                sources,
                weights,
                seen,
                (layout["width"] * u, layout["height"] * v),
                _coons_point(outer_path, u, v),
                OUTER_PRIOR_WEIGHT,
            )

    model = _build_tps_model(targets, sources, weights)
    return layout, *model


def export_corrected(
    image_path: str,
    corners: list[list[float]],
    output_path: str,
    quality: int = 92,
) -> dict:
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")

    src = _order_corners(np.array(corners, dtype=np.float64))
    tl, tr, br, bl = src

    # Output dimensions: average opposing side lengths so a slight
    # imbalance between top/bottom or left/right doesn't blow up either axis.
    width = int(round((np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2))
    height = int(round((np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2))
    width = max(width, 1)
    height = max(height, 1)

    dst = np.array([
        [0, 0],
        [width - 1, 0],
        [width - 1, height - 1],
        [0, height - 1],
    ], dtype=np.float64)

    H = cv2.getPerspectiveTransform(src.astype(np.float32), dst.astype(np.float32))
    warped = cv2.warpPerspective(
        img,
        H,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    ok = _write_image(output_path, warped, quality)
    if not ok:
        raise RuntimeError(f"failed to write output: {output_path}")

    return {
        "outputPath": output_path,
        "outputWidth": width,
        "outputHeight": height,
    }


def _fill_mask_from_shapes(shape: tuple[int, int], fill_shapes: list[dict]) -> np.ndarray:
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    for fill_shape in fill_shapes:
        points = fill_shape.get("points") or []
        if len(points) < 3:
            continue
        pts = np.array([[float(point[0]), float(point[1])] for point in points], dtype=np.float32)
        pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
        pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
        cv2.fillPoly(mask, [np.round(pts).astype(np.int32)], 255)
    return mask


def _expanded_fill_mask(mask: np.ndarray, radius: int = FILL_FEATHER_RADIUS) -> np.ndarray:
    if not np.any(mask):
        return mask
    size = radius * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    return cv2.dilate(mask, kernel, iterations=1)


def _sample_mask_from_regions(shape: tuple[int, int], sample_regions: list[dict], fill_mask: np.ndarray) -> np.ndarray:
    h, w = shape
    sample_mask = np.zeros((h, w), dtype=np.uint8)
    for region in sample_regions or []:
        try:
            x0 = int(np.floor(float(region["x0"])))
            y0 = int(np.floor(float(region["y0"])))
            x1 = int(np.ceil(float(region["x1"])))
            y1 = int(np.ceil(float(region["y1"])))
        except (KeyError, TypeError, ValueError):
            continue
        x0 = max(0, min(w, x0))
        x1 = max(0, min(w, x1))
        y0 = max(0, min(h, y0))
        y1 = max(0, min(h, y1))
        if x1 <= x0 or y1 <= y0:
            continue
        sample_mask[y0:y1, x0:x1] = 255
    sample_mask[fill_mask > 0] = 0
    return sample_mask


def _best_sample_patch(sample_img: np.ndarray, sample_mask: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray | None:
    x, y, bw, bh = bbox
    candidates = cv2.findNonZero(sample_mask)
    if candidates is None or candidates.shape[0] < max(64, min(bw * bh, 2048)):
        return None
    sx, sy, sw, sh = cv2.boundingRect(candidates)
    sample = sample_img[sy:sy + sh, sx:sx + sw]
    valid = sample_mask[sy:sy + sh, sx:sx + sw]
    if sample.size == 0 or np.count_nonzero(valid) < 64:
        return None

    if sw >= bw and sh >= bh:
        px = sx + max(0, min(sw - bw, x - sx))
        py = sy + max(0, min(sh - bh, y - sy))
        patch = sample_img[py:py + bh, px:px + bw]
        patch_valid = sample_mask[py:py + bh, px:px + bw]
        if patch.shape[:2] == (bh, bw) and np.count_nonzero(patch_valid) >= bw * bh * 0.65:
            return patch.copy()

    rows = max(1, int(np.ceil(bh / sh)))
    cols = max(1, int(np.ceil(bw / sw)))
    tiled = np.tile(sample, (rows + 1, cols + 1, 1))
    return tiled[:bh, :bw].copy()


def _local_ring_mask(labels: np.ndarray, label: int, fill_mask: np.ndarray, bbox: tuple[int, int, int, int]) -> tuple[np.ndarray, tuple[int, int]] | None:
    x, y, bw, bh = bbox
    h, w = labels.shape[:2]
    pad = int(max(32, min(220, max(bw, bh) * 1.25)))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(w, x + bw + pad)
    y1 = min(h, y + bh + pad)
    component = (labels[y0:y1, x0:x1] == label).astype(np.uint8) * 255
    if not np.any(component):
        return None

    for radius in (21, 41, 81, 121):
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius, radius))
        ring = cv2.dilate(component, kernel, iterations=1)
        ring[component > 0] = 0
        ring[fill_mask[y0:y1, x0:x1] > 0] = 0
        if np.count_nonzero(ring) >= 160:
            return ring, (x0, y0)
    return None


def _lab_pixels(img: np.ndarray, selector: np.ndarray) -> np.ndarray | None:
    pixels = img[selector]
    if pixels.shape[0] < 16:
        return None
    return cv2.cvtColor(pixels.reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)


def _match_patch_to_local_paper(
    img: np.ndarray,
    patch: np.ndarray,
    component: np.ndarray,
    labels: np.ndarray,
    label: int,
    fill_mask: np.ndarray,
    bbox: tuple[int, int, int, int],
) -> np.ndarray:
    ring_info = _local_ring_mask(labels, label, fill_mask, bbox)
    if ring_info is None:
        return patch

    ring_mask, (x0, y0) = ring_info
    ring_img = img[y0:y0 + ring_mask.shape[0], x0:x0 + ring_mask.shape[1]]
    target_lab = _lab_pixels(ring_img, ring_mask > 0)
    source_lab = _lab_pixels(patch, component)
    if target_lab is None or source_lab is None:
        return patch

    source_mean = source_lab.mean(axis=0)
    target_mean = target_lab.mean(axis=0)
    source_std = source_lab.std(axis=0)
    target_std = target_lab.std(axis=0)
    std_ratio = np.clip(target_std / np.maximum(source_std, 1.0), 0.82, 1.18)

    patch_lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
    adjusted_lab = (patch_lab - source_mean[None, None, :]) * std_ratio[None, None, :] + target_mean[None, None, :]
    adjusted_lab = np.clip(adjusted_lab, 0, 255).astype(np.uint8)
    return cv2.cvtColor(adjusted_lab, cv2.COLOR_LAB2BGR)


def _composite_patch_with_feather(target: np.ndarray, patch: np.ndarray, core: np.ndarray, expanded: np.ndarray) -> None:
    core_mask = core.astype(np.uint8)
    expanded_mask = expanded.astype(np.uint8)
    if not np.any(core_mask) or not np.any(expanded_mask):
        return

    h, w = expanded_mask.shape[:2]
    feather_radius = float(max(5, min(24, max(h, w) * 0.08, FILL_FEATHER_RADIUS)))
    distance = cv2.distanceTransform(expanded_mask, cv2.DIST_L2, 5)
    alpha = np.clip(distance / feather_radius, 0.0, 1.0)
    alpha = alpha * alpha * (3.0 - 2.0 * alpha)
    alpha = cv2.GaussianBlur(alpha, (0, 0), feather_radius / 3)
    alpha[core] = 1.0
    alpha[~expanded] = 0.0

    alpha3 = alpha[:, :, None].astype(np.float32)
    blended = patch.astype(np.float32) * alpha3 + target.astype(np.float32) * (1.0 - alpha3)
    target[expanded] = np.clip(blended, 0, 255).astype(np.uint8)[expanded]


def _fill_with_sample_texture(img: np.ndarray, core_mask: np.ndarray, expanded_mask: np.ndarray, sample_regions: list[dict]) -> np.ndarray | None:
    sample_mask = _sample_mask_from_regions(img.shape[:2], sample_regions, expanded_mask)
    if np.count_nonzero(sample_mask) < 256:
        return None

    result = img.copy()
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats((core_mask > 0).astype(np.uint8), 8)
    used = False
    for label in range(1, component_count):
        x, y, bw, bh, area = stats[label]
        if area <= 0:
            continue
        pad = FILL_FEATHER_RADIUS
        x0 = max(0, int(x) - pad)
        y0 = max(0, int(y) - pad)
        x1 = min(img.shape[1], int(x + bw) + pad)
        y1 = min(img.shape[0], int(y + bh) + pad)
        patch = _best_sample_patch(result, sample_mask, (x0, y0, x1 - x0, y1 - y0))
        if patch is None:
            continue
        component = (labels[y0:y1, x0:x1] == label)
        size = FILL_FEATHER_RADIUS * 2 + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
        expanded_component = cv2.dilate(component.astype(np.uint8) * 255, kernel, iterations=1) > 0
        patch = _match_patch_to_local_paper(
            img,
            patch,
            component,
            labels,
            label,
            expanded_mask,
            (x0, y0, x1 - x0, y1 - y0),
        )
        target = result[y0:y1, x0:x1]
        _composite_patch_with_feather(target, patch, component, expanded_component)
        used = True

    if not used:
        return None
    return result


def _lama_candidate_sizes(crop_shape: tuple[int, int]) -> list[int]:
    h, w = crop_shape
    longest = max(h, w)
    dynamic_size = int(np.ceil(max(512, min(1024, longest)) / 32) * 32)
    sizes = [dynamic_size, 512]
    return list(dict.fromkeys(sizes))


def _run_lama_crop(net: cv2.dnn.Net, img: np.ndarray, mask: np.ndarray, size: int) -> np.ndarray:
    h, w = img.shape[:2]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    interpolation = cv2.INTER_AREA if max(h, w) > size else cv2.INTER_CUBIC
    resized_img = cv2.resize(rgb, (size, size), interpolation=interpolation).astype(np.float32) / 255.0
    resized_mask = cv2.resize(mask, (size, size), interpolation=cv2.INTER_NEAREST).astype(np.float32) / 255.0
    image_blob = np.transpose(resized_img, (2, 0, 1))[None, :, :, :]
    mask_blob = resized_mask[None, None, :, :]
    net.setInput(image_blob, "image")
    net.setInput(mask_blob, "mask")
    out = net.forward()
    if out.ndim != 4 or out.shape[1] != 3:
        raise RuntimeError("unexpected LaMa ONNX output")
    out_img = np.transpose(out[0], (1, 2, 0))
    out_img = np.clip(out_img, 0.0, 1.0)
    out_img = (out_img * 255).astype(np.uint8)
    out_img = cv2.resize(out_img, (w, h), interpolation=cv2.INTER_CUBIC)
    return cv2.cvtColor(out_img, cv2.COLOR_RGB2BGR)


def _inpaint_with_lama_onnx(img: np.ndarray, mask: np.ndarray, model_path: str) -> np.ndarray:
    if not model_path or not Path(model_path).exists():
        raise RuntimeError("LaMa ONNX model not found")

    net = cv2.dnn.readNetFromONNX(model_path)
    result = img.copy()
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    h, w = img.shape[:2]

    for label in range(1, num_labels):
        x, y, bw, bh, area = stats[label]
        if area <= 0:
            continue
        pad = int(max(96, min(320, max(bw, bh) * 0.8)))
        x0 = max(0, int(x) - pad)
        y0 = max(0, int(y) - pad)
        x1 = min(w, int(x + bw) + pad)
        y1 = min(h, int(y + bh) + pad)
        crop_img = result[y0:y1, x0:x1]
        crop_mask = np.where(labels[y0:y1, x0:x1] == label, 255, 0).astype(np.uint8)
        crop_out = None
        last_error: Exception | None = None
        for size in _lama_candidate_sizes(crop_img.shape[:2]):
            try:
                crop_out = _run_lama_crop(net, crop_img, crop_mask, size)
                break
            except Exception as err:
                last_error = err
        if crop_out is None:
            raise RuntimeError(f"LaMa crop inference failed: {last_error}")
        result_crop = result[y0:y1, x0:x1]
        result[y0:y1, x0:x1] = np.where(crop_mask[:, :, None] > 0, crop_out, result_crop)

    return result


def export_filled(
    image_path: str,
    fill_shapes: list[dict],
    output_path: str,
    quality: int = 92,
    model_path: str | None = None,
    sample_regions: list[dict] | None = None,
) -> dict:
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")
    if not fill_shapes:
        raise RuntimeError("at least one fill shape is required")

    h, w = img.shape[:2]
    core_mask = _fill_mask_from_shapes((h, w), fill_shapes)
    if not np.any(core_mask):
        raise RuntimeError("fill mask is empty")
    expanded_mask = _expanded_fill_mask(core_mask)

    method = "opencv-inpaint"
    try:
        result = _inpaint_with_lama_onnx(img, core_mask, model_path or "")
        method = "lama-onnx-crop"
    except Exception:
        sampled = _fill_with_sample_texture(img, core_mask, expanded_mask, sample_regions or [])
        if sampled is not None:
            result = sampled
            method = "sample-texture"
        else:
            result = cv2.inpaint(img, expanded_mask, 5, cv2.INPAINT_TELEA)

    ok = _write_image(output_path, result, quality)
    if not ok:
        raise RuntimeError(f"failed to write output: {output_path}")

    return {
        "outputPath": output_path,
        "outputWidth": w,
        "outputHeight": h,
        "method": method,
    }


def export_dewarped(
    image_path: str,
    rectangles: list[dict],
    output_path: str,
    quality: int = 92,
    mesh_curve: float | int | None = 75.0,
    progress: ProgressCallback | None = None,
) -> dict:
    _emit_progress(progress, 2, "Loading image")
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")
    if not rectangles:
        raise RuntimeError("at least one rectangle is required")

    _emit_progress(progress, 6, "Reading rectangles")
    outer_path, inner_paths = _derive_rectangles(rectangles)
    if not inner_paths:
        corners = [_path_corner(outer_path, i) for i in range(4)]
        _emit_progress(progress, 35, "Perspective fallback")
        result = export_corrected(image_path, [[x, y] for x, y in corners], output_path, quality)
        _emit_progress(progress, 100, "Complete")
        return result

    _emit_progress(progress, 10, "Building mesh")
    layout = _build_nested_mesh_layout(outer_path, inner_paths)
    _emit_progress(progress, 18, "Generating map")
    width = max(1, int(round(layout["width"])))
    height = max(1, int(round(layout["height"])))

    map_x = np.empty((height, width), dtype=np.float32)
    map_y = np.empty((height, width), dtype=np.float32)
    xs = np.linspace(0, layout["width"], width, dtype=np.float64)
    y_coords = np.linspace(0, layout["height"], height, dtype=np.float64)
    chunk_rows = 48
    last_reported = 18
    for y0 in range(0, height, chunk_rows):
        y1 = min(height, y0 + chunk_rows)
        ys = y_coords[y0:y1]
        grid_x, grid_y = np.meshgrid(xs, ys)
        points = np.column_stack((grid_x.ravel(), grid_y.ravel()))
        src_x, src_y = _transform_nested_chunk(layout, points, mesh_curve)
        map_x[y0:y1, :] = src_x.reshape((y1 - y0, width)).astype(np.float32)
        map_y[y0:y1, :] = src_y.reshape((y1 - y0, width)).astype(np.float32)
        percent = 18 + 67 * (y1 / height)
        rounded_percent = int(round(percent))
        if rounded_percent > last_reported:
            last_reported = rounded_percent
            _emit_progress(progress, rounded_percent, "Generating map")

    _emit_progress(progress, 88, "Resampling image")
    warped = cv2.remap(
        img,
        map_x,
        map_y,
        interpolation=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    _emit_progress(progress, 96, "Writing image")
    ok = _write_image(output_path, warped, quality)
    if not ok:
        raise RuntimeError(f"failed to write output: {output_path}")

    _emit_progress(progress, 100, "Complete")
    return {
        "outputPath": output_path,
        "outputWidth": width,
        "outputHeight": height,
    }
