"""Derive 4-corner rectangles from user-painted strokes.

Pipeline:
  1. Rasterize the painted strokes per role into a binary mask.
  2. Convex-hull + epsilon-sweep approxPolyDP gives 4 corners per role.
  3. Detect the canvas (off-white paper) color from the region between
     the two derived quads — that ring is *known* paper, free of print.
  4. Build a "distance from canvas color" map in CIELAB and compute its
     spatial gradient.
  5. Refine each side with edge-snap, using a polarity sign that matches
     the role: outer rect — distance increases outward, inner rect —
     distance increases inward.

Why distance-from-canvas instead of plain intensity gradient: the outer
paper edge can sit on anything (off-white on white, off-white on dark,
off-white on off-white). Plain polarity-on-intensity gives wrong-direction
matches. Polarity in canvas-distance space is stable: every visible paper
edge means "canvas → not canvas" regardless of what the not-canvas is.
The off-white-on-off-white case has no detectable edge anywhere along the
side, and the per-side floor naturally falls back to the straight line.
"""

from __future__ import annotations

import cv2
import numpy as np

from refine import refine_quad_from_gradients

WORK_MAX_DIM = 1500
EPSILON_SWEEP = (0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.1)
DISTANCE_BLUR = 5


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


def _detect_canvas_color(
    work_lab: np.ndarray,
    outer_q_work: np.ndarray | None,
    inner_q_work: np.ndarray | None,
) -> np.ndarray | None:
    """Median LAB color of the canvas region.

    Region preference: between the two quads (outer ∧ ¬inner) when both are
    present, else interior of whichever single quad we have, else None.
    Median is robust to small contaminants (text on the canvas, dust, etc.).
    """
    h, w = work_lab.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    if outer_q_work is not None:
        cv2.fillPoly(mask, [outer_q_work.astype(np.int32)], 255)
    elif inner_q_work is not None:
        # Sample an annulus around the inner quad — the canvas is what
        # surrounds the print.
        cv2.fillPoly(mask, [inner_q_work.astype(np.int32)], 255)
        mask = cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=12)
        inner_only = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(inner_only, [inner_q_work.astype(np.int32)], 255)
        mask = cv2.bitwise_and(mask, cv2.bitwise_not(inner_only))
    if outer_q_work is not None and inner_q_work is not None:
        inner_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(inner_mask, [inner_q_work.astype(np.int32)], 255)
        mask = cv2.bitwise_and(mask, cv2.bitwise_not(inner_mask))
    if int(np.count_nonzero(mask)) < 200:
        return None
    pixels = work_lab[mask > 0].reshape(-1, 3)
    return np.median(pixels, axis=0).astype(np.float32)


def _build_distance_gradients(
    image_path: str,
    canvas_color: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
    """Return (gx, gy, scale, work_lab). When canvas_color is None we fall
    back to luminance gradient so refinement still runs (degraded)."""
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")
    full_h, full_w = img.shape[:2]
    scale = WORK_MAX_DIM / max(full_w, full_h)
    if scale < 1.0:
        work = cv2.resize(
            img,
            (int(full_w * scale), int(full_h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    else:
        work = img
        scale = 1.0
    work_lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)

    if canvas_color is not None:
        diff = work_lab - canvas_color
        field = np.sqrt((diff * diff).sum(axis=2))
    else:
        field = work_lab[:, :, 0]  # luminance fallback

    blurred = cv2.GaussianBlur(field, (DISTANCE_BLUR, DISTANCE_BLUR), 0)
    gx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    return gx, gy, scale, work_lab


def derive_from_strokes(
    image_path: str,
    image_width: int,
    image_height: int,
    outer_strokes: list[dict],
    inner_strokes: list[dict],
) -> dict:
    out: dict[str, dict | None] = {"outer": None, "inner": None, "canvas_color_lab": None}

    outer_quad = None
    inner_quad = None
    full_outer_mask = None
    full_inner_mask = None
    if outer_strokes:
        full_outer_mask = _rasterize_strokes(image_width, image_height, outer_strokes)
        outer_quad = _quad_from_mask(full_outer_mask)
    if inner_strokes:
        full_inner_mask = _rasterize_strokes(image_width, image_height, inner_strokes)
        inner_quad = _quad_from_mask(full_inner_mask)

    if outer_quad is None and inner_quad is None:
        return out

    # Need a working-resolution view of the image first to detect canvas
    # color in the right coordinate system.
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {image_path}")
    full_h, full_w = img.shape[:2]
    scale = WORK_MAX_DIM / max(full_w, full_h)
    if scale < 1.0:
        work = cv2.resize(
            img,
            (int(full_w * scale), int(full_h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    else:
        work = img
        scale = 1.0
    work_lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)

    outer_q_work = outer_quad * scale if outer_quad is not None else None
    inner_q_work = inner_quad * scale if inner_quad is not None else None
    canvas_color = _detect_canvas_color(work_lab, outer_q_work, inner_q_work)

    # Reuse the same work_lab/scale we just computed to build gradient
    # components on the distance field.
    if canvas_color is not None:
        diff = work_lab - canvas_color
        field = np.sqrt((diff * diff).sum(axis=2))
    else:
        field = work_lab[:, :, 0]
    blurred = cv2.GaussianBlur(field, (DISTANCE_BLUR, DISTANCE_BLUR), 0)
    gx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)

    work_h, work_w = work_lab.shape[:2]

    def _work_mask(full_mask: np.ndarray) -> np.ndarray:
        m = cv2.resize(full_mask, (work_w, work_h), interpolation=cv2.INTER_NEAREST)
        # Tolerate the hull's corner-corner line drifting just outside the
        # painted region by a few px (anti-aliasing, downsampling).
        return cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=1)

    # Polarity in distance-from-canvas space:
    #   outer rect: distance high outside paper → grad·outward > 0 → grad·inward < 0 → sign = -1
    #   inner rect: distance high inside print  → grad·inward  > 0 → sign = +1
    #
    # Search band is generous (3× brush radius) but the painted mask bounds
    # where samples actually count, so the search adapts to where the user
    # actually painted instead of a fixed-radius window from the hull edge.
    if outer_quad is not None and full_outer_mask is not None:
        mask = _work_mask(full_outer_mask)
        band = _max_radius(outer_strokes) * 3.0
        out["outer"] = refine_quad_from_gradients(
            gx, gy, mask, scale, outer_quad.tolist(), band, sign=-1.0
        )
    if inner_quad is not None and full_inner_mask is not None:
        mask = _work_mask(full_inner_mask)
        band = _max_radius(inner_strokes) * 3.0
        out["inner"] = refine_quad_from_gradients(
            gx, gy, mask, scale, inner_quad.tolist(), band, sign=+1.0
        )

    if canvas_color is not None:
        # Surface canvas color so the renderer can show what was detected.
        out["canvas_color_lab"] = [float(c) for c in canvas_color]

    return out
