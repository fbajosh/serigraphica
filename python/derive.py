"""Derive 4-corner rectangles from user-painted strokes.

The user paints rough brush strokes along the visible edges of a rectangle.
We rasterize those strokes into a binary mask, take the convex hull of the
painted pixels, and reduce that hull to 4 corners with a tolerance sweep.
The painting is the geometric hint — no separate detection step needed.

After getting 4 corners we hand off to refine.refine_quad to produce per-side
polylines that snap to the strongest local gradient. The brush radius doubles
as the search-band radius for refinement: bigger brush = wider snap window.
"""

from __future__ import annotations

import cv2
import numpy as np

from refine import refine_quad

EPSILON_SWEEP = (0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.1)


def _order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(-1, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float64)


def _rasterize_strokes(width: int, height: int, strokes: list[dict]) -> np.ndarray:
    mask = np.zeros((height, width), dtype=np.uint8)
    for stroke in strokes:
        pts = stroke.get("points") or []
        radius = max(int(round(float(stroke.get("radius", 20)))), 1)
        if not pts:
            continue
        ipts = [(int(round(p[0])), int(round(p[1]))) for p in pts]
        for x, y in ipts:
            cv2.circle(mask, (x, y), radius, 255, -1)
        for a, b in zip(ipts, ipts[1:]):
            cv2.line(mask, a, b, 255, radius * 2)
    return mask


def _quad_from_mask(mask: np.ndarray) -> np.ndarray | None:
    ys, xs = np.where(mask > 0)
    if xs.size < 4:
        return None
    pts = np.column_stack([xs, ys]).astype(np.int32).reshape(-1, 1, 2)
    hull = cv2.convexHull(pts)
    if hull is None or len(hull) < 4:
        return None
    peri = cv2.arcLength(hull, True)
    for eps in EPSILON_SWEEP:
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return _order_corners(approx)
    box = cv2.boxPoints(cv2.minAreaRect(hull))
    return _order_corners(box)


def _max_radius(strokes: list[dict]) -> float:
    return max((float(s.get("radius", 20)) for s in strokes), default=20.0)


def _refine_with_strokes(
    image_path: str, quad: np.ndarray, strokes: list[dict], polarity: str
) -> dict:
    band = _max_radius(strokes)
    return refine_quad(image_path, quad.tolist(), band, polarity)


def derive_from_strokes(
    image_path: str,
    image_width: int,
    image_height: int,
    outer_strokes: list[dict],
    inner_strokes: list[dict],
) -> dict:
    out: dict[str, dict | None] = {"outer": None, "inner": None}
    if outer_strokes:
        mask = _rasterize_strokes(image_width, image_height, outer_strokes)
        quad = _quad_from_mask(mask)
        if quad is not None:
            out["outer"] = _refine_with_strokes(image_path, quad, outer_strokes, "outer")
    if inner_strokes:
        mask = _rasterize_strokes(image_width, image_height, inner_strokes)
        quad = _quad_from_mask(mask)
        if quad is not None:
            out["inner"] = _refine_with_strokes(image_path, quad, inner_strokes, "inner")
    return out
