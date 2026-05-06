"""Starter guide detection for Serigraphica.

This is intentionally only a first-pass guide generator. The user remains the
source of truth, but detection should provide a useful outer rectangle, the
largest nested inner rectangle, and one editable side node per edge.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


WORK_MAX_DIM = 1500
MIN_AREA_FRAC = 0.018
MIN_PAIR_INNER_AREA_RATIO = 0.05
MAX_PAIR_INNER_AREA_RATIO = 0.86
EPSILON_SWEEP = (0.006, 0.009, 0.012, 0.016, 0.022, 0.03, 0.04, 0.055, 0.075)
SIDE_HANDLE_FRACTION = 0.09


PointArray = np.ndarray


@dataclass(frozen=True)
class QuadCandidate:
    corners: PointArray
    area: float
    area_frac: float
    confidence: float
    centeredness: float
    rectangularity: float
    score: float


def _order_corners(pts: PointArray) -> PointArray:
    pts = pts.reshape(-1, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(-1)
    tl = pts[int(np.argmin(s))]
    br = pts[int(np.argmax(s))]
    tr = pts[int(np.argmin(d))]
    bl = pts[int(np.argmax(d))]
    return np.array([tl, tr, br, bl], dtype=np.float64)


def _polygon_area(corners: PointArray) -> float:
    return float(abs(cv2.contourArea(corners.astype(np.float32))))


def _centeredness(corners: PointArray, width: int, height: int) -> float:
    cx = float(np.mean(corners[:, 0]))
    cy = float(np.mean(corners[:, 1]))
    dx = (cx - width / 2.0) / max(width / 2.0, 1.0)
    dy = (cy - height / 2.0) / max(height / 2.0, 1.0)
    return float(max(0.0, 1.0 - 0.55 * np.hypot(dx, dy)))


def _bilinear(img: PointArray, x: float, y: float) -> float:
    h, w = img.shape[:2]
    if x < 0 or y < 0 or x >= w - 1 or y >= h - 1:
        return 0.0
    x0 = int(x)
    y0 = int(y)
    fx = x - x0
    fy = y - y0
    return float(
        img[y0, x0] * (1 - fx) * (1 - fy)
        + img[y0, x0 + 1] * fx * (1 - fy)
        + img[y0 + 1, x0] * (1 - fx) * fy
        + img[y0 + 1, x0 + 1] * fx * fy
    )


def _build_edge_maps(work: PointArray) -> tuple[PointArray, PointArray]:
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(work, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced_luma = clahe.apply(gray)
    enhanced_lab_l = clahe.apply(lab[:, :, 0])

    blur_luma = cv2.GaussianBlur(enhanced_luma, (5, 5), 0)
    blur_lab_l = cv2.GaussianBlur(enhanced_lab_l, (5, 5), 0)
    blur_sat = cv2.GaussianBlur(hsv[:, :, 1], (5, 5), 0)

    edges = cv2.bitwise_or(cv2.Canny(blur_luma, 18, 58), cv2.Canny(blur_luma, 48, 145))
    edges = cv2.bitwise_or(edges, cv2.Canny(blur_lab_l, 18, 58))
    edges = cv2.bitwise_or(edges, cv2.Canny(blur_sat, 20, 90))

    gx = cv2.Sobel(blur_luma, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blur_luma, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    mag_norm = cv2.normalize(mag, None, 0.0, 1.0, cv2.NORM_MINMAX)

    contour_edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contour_edges = cv2.morphologyEx(contour_edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)
    score_map = (contour_edges > 0).astype(np.float32) + mag_norm.astype(np.float32) * 0.35
    return contour_edges, score_map


def _approx_quad(contour: PointArray) -> PointArray | None:
    hull = cv2.convexHull(contour)
    peri = cv2.arcLength(hull, True)
    if peri < 1.0:
        return None
    for eps in EPSILON_SWEEP:
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return _order_corners(approx)
    rect = cv2.minAreaRect(hull)
    box = cv2.boxPoints(rect)
    if cv2.contourArea(box.astype(np.float32)) < 1.0:
        return None
    return _order_corners(box)


def _edge_score(edge_map: PointArray, p1: PointArray, p2: PointArray) -> float:
    h, w = edge_map.shape[:2]
    length = max(int(np.linalg.norm(p2 - p1)), 1)
    samples = np.linspace(0.0, 1.0, length)
    xs = np.clip(np.round(p1[0] + (p2[0] - p1[0]) * samples).astype(np.int32), 0, w - 1)
    ys = np.clip(np.round(p1[1] + (p2[1] - p1[1]) * samples).astype(np.int32), 0, h - 1)
    hits = 0
    for dx in range(-2, 3):
        xx = np.clip(xs + dx, 0, w - 1)
        hits += int(np.count_nonzero(edge_map[ys, xx]))
    return float(hits / max(length * 5, 1))


def _quad_confidence(edge_map: PointArray, corners: PointArray) -> float:
    return float(np.mean([_edge_score(edge_map, corners[i], corners[(i + 1) % 4]) for i in range(4)]))


def _looks_like_frame(corners: PointArray, width: int, height: int, area_frac: float) -> bool:
    min_x, min_y = np.min(corners, axis=0)
    max_x, max_y = np.max(corners, axis=0)
    span_x = (max_x - min_x) / max(width, 1)
    span_y = (max_y - min_y) / max(height, 1)
    near_border = min_x < width * 0.01 and min_y < height * 0.01 and max_x > width * 0.99 and max_y > height * 0.99
    return bool(area_frac > 0.965 or (near_border and span_x > 0.96 and span_y > 0.96))


def _find_candidates(work: PointArray, edge_map: PointArray) -> list[QuadCandidate]:
    h, w = work.shape[:2]
    image_area = float(w * h)
    contours, _ = cv2.findContours(edge_map, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[QuadCandidate] = []
    for contour in contours:
        contour_area = abs(cv2.contourArea(contour))
        if contour_area < image_area * MIN_AREA_FRAC * 0.5:
            continue
        corners = _approx_quad(contour)
        if corners is None:
            continue
        area = _polygon_area(corners)
        area_frac = area / image_area
        if area_frac < MIN_AREA_FRAC or _looks_like_frame(corners, w, h, area_frac):
            continue
        hull_area = max(abs(cv2.contourArea(cv2.convexHull(contour))), 1.0)
        rectangularity = float(min(1.0, hull_area / max(area, 1.0)))
        confidence = _quad_confidence(edge_map, corners)
        centered = _centeredness(corners, w, h)
        score = area_frac * (0.32 + confidence) * (0.72 + 0.28 * centered) * (0.55 + 0.45 * rectangularity)
        candidates.append(QuadCandidate(corners, area, area_frac, confidence, centered, rectangularity, float(score)))
    return _dedupe_candidates(candidates, max(w, h))


def _dedupe_candidates(candidates: list[QuadCandidate], max_dim: int) -> list[QuadCandidate]:
    ordered = sorted(candidates, key=lambda c: c.score, reverse=True)
    kept: list[QuadCandidate] = []
    for candidate in ordered:
        center = np.mean(candidate.corners, axis=0)
        duplicate = False
        for existing in kept:
            existing_center = np.mean(existing.corners, axis=0)
            area_ratio = min(candidate.area, existing.area) / max(candidate.area, existing.area)
            center_dist = float(np.linalg.norm(center - existing_center))
            corner_dist = float(np.mean(np.linalg.norm(candidate.corners - existing.corners, axis=1)))
            if area_ratio > 0.9 and (center_dist < max_dim * 0.035 or corner_dist < max_dim * 0.045):
                duplicate = True
                break
        if not duplicate:
            kept.append(candidate)
    return kept


def _inside_score(inner: QuadCandidate, outer: QuadCandidate) -> float:
    contour = outer.corners.astype(np.float32)
    points = list(inner.corners)
    points.append(np.mean(inner.corners, axis=0))
    inside = 0
    for point in points:
        if cv2.pointPolygonTest(contour, (float(point[0]), float(point[1])), False) >= -2:
            inside += 1
    return inside / len(points)


def _select_guides(candidates: list[QuadCandidate]) -> list[QuadCandidate]:
    if not candidates:
        return []
    pairs: list[tuple[float, QuadCandidate, QuadCandidate]] = []
    for outer in candidates:
        for inner in candidates:
            if outer is inner or inner.area >= outer.area:
                continue
            ratio = inner.area / max(outer.area, 1.0)
            if ratio < MIN_PAIR_INNER_AREA_RATIO or ratio > MAX_PAIR_INNER_AREA_RATIO:
                continue
            containment = _inside_score(inner, outer)
            if containment < 0.8:
                continue
            pair_score = (
                outer.area_frac * 3.0
                + inner.area_frac * 1.8
                + outer.confidence * 0.65
                + inner.confidence * 0.85
                + outer.centeredness * 0.25
                + containment * 0.35
            )
            pairs.append((float(pair_score), outer, inner))
    if pairs:
        _, outer, inner = max(pairs, key=lambda p: p[0])
        return [outer, inner]
    return [max(candidates, key=lambda c: (c.area_frac, c.score))]


def _fit_side_node(score_map: PointArray, p0: PointArray, p1: PointArray) -> tuple[PointArray, PointArray]:
    side = p1 - p0
    side_len = float(np.linalg.norm(side))
    if side_len < 1.0:
        return (p0 + p1) * 0.5, np.array([0.0, 0.0], dtype=np.float64)
    direction = side / side_len
    normal = np.array([-direction[1], direction[0]], dtype=np.float64)
    band = min(46.0, max(7.0, side_len * 0.035))
    offsets = np.linspace(-band, band, max(15, int(band * 2) + 1))
    ts: list[float] = []
    ys: list[float] = []
    weights: list[float] = []
    for t in np.linspace(0.08, 0.92, 39):
        center = p0 + side * t
        best_offset = 0.0
        best_score = 0.0
        for offset in offsets:
            point = center + normal * offset
            score = _bilinear(score_map, float(point[0]), float(point[1]))
            if score > best_score:
                best_score = score
                best_offset = float(offset)
        if best_score > 0.18:
            ts.append(float(t))
            ys.append(best_offset)
            weights.append(best_score * best_score)

    offset_at_mid = 0.0
    offset_derivative = 0.0
    if len(ts) >= 7:
        fit_t = np.array([0.0, *ts, 1.0], dtype=np.float64)
        fit_y = np.array([0.0, *ys, 0.0], dtype=np.float64)
        anchor_weight = max(float(np.median(weights)) if weights else 1.0, 0.8)
        fit_w = np.array([anchor_weight, *weights, anchor_weight], dtype=np.float64)
        degree = min(3, len(fit_t) - 1)
        try:
            coeff = np.polyfit(fit_t, fit_y, degree, w=np.sqrt(np.maximum(fit_w, 1e-3)))
            offset_at_mid = float(np.polyval(coeff, 0.5))
            offset_derivative = float(np.polyval(np.polyder(coeff), 0.5))
        except np.linalg.LinAlgError:
            offset_at_mid = 0.0
            offset_derivative = 0.0
    offset_at_mid = float(np.clip(offset_at_mid, -band * 0.85, band * 0.85))
    point = p0 + side * 0.5 + normal * offset_at_mid
    tangent = side + normal * offset_derivative
    tangent_len = float(np.linalg.norm(tangent))
    if tangent_len < 1.0:
        tangent = direction
    else:
        tangent = tangent / tangent_len
    handle = tangent * (side_len * SIDE_HANDLE_FRACTION)
    return point.astype(np.float64), handle.astype(np.float64)


def _candidate_to_path(candidate: QuadCandidate, score_map: PointArray, scale: float) -> dict:
    corners = candidate.corners
    nodes: list[dict] = []
    corner_indices: list[int] = []
    for index in range(4):
        corner_indices.append(len(nodes))
        corner = corners[index] / scale
        nodes.append({
            "point": [float(corner[0]), float(corner[1])],
            "handle": [0.0, 0.0],
            "corner": True,
        })
        p0 = corners[index]
        p1 = corners[(index + 1) % 4]
        side_point, handle = _fit_side_node(score_map, p0, p1)
        side_point = side_point / scale
        handle = handle / scale
        nodes.append({
            "point": [float(side_point[0]), float(side_point[1])],
            "handle": [float(handle[0]), float(handle[1])],
            "corner": False,
        })
    return {
        "nodes": nodes,
        "cornerIndices": [corner_indices[0], corner_indices[1], corner_indices[2], corner_indices[3]],
    }


def detect_guides(image_path: str) -> dict:
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")
    full_h, full_w = img.shape[:2]
    scale = WORK_MAX_DIM / max(full_w, full_h)
    if scale < 1.0:
        work = cv2.resize(img, (int(full_w * scale), int(full_h * scale)), interpolation=cv2.INTER_AREA)
    else:
        work = img.copy()
        scale = 1.0
    edge_map, score_map = _build_edge_maps(work)
    candidates = _find_candidates(work, edge_map)
    selected = _select_guides(candidates)
    rectangles = [_candidate_to_path(candidate, score_map, scale) for candidate in selected]
    confidence = float(np.mean([candidate.confidence for candidate in selected])) if selected else 0.0
    return {
        "rectangles": rectangles,
        "imageWidth": int(full_w),
        "imageHeight": int(full_h),
        "confidence": confidence,
        "candidates": len(candidates),
        "method": "contour-quad-edgefit-v1",
    }
