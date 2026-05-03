"""Edge-snap refinement using precomputed gradient components.

Given gradient components (gx, gy) at a working resolution, a quadrilateral
in full-resolution coordinates, and a polarity sign, refine each side into
a polyline that follows the polarity-correct strongest gradient inside the
search band, then refine the four corners by intersecting fitted lines from
each pair of adjacent sides.

Why corner refinement matters: the initial corners come from the convex
hull of painted pixels, which lands at the *extreme* points of a ring of
strokes — typically outside the actual painted region in the diagonal
corner gaps. Side refinement moves the side curves to real edges, but the
endpoints stay pinned to the bad initial corners. Fitting a line to each
refined side (using interior samples that ignore the pinned endpoints) and
taking adjacent-line intersections puts each corner where the two real
edges actually meet.

Algorithm per side a→b:
  - direction d = (b-a)/|b-a|, inward normal n = (-dy, dx).
  - Sample N positions along the side.
  - At each, cast ±band_radius along n and track the position with maximum
    sign · (grad · n).
  - Per-side floor: half the median of strictly-positive responses. If too
    few samples cleared zero, fall back to the straight line.
  - Smooth with a moving-average filter that preserves the (initial) endpoints.

Then fit one line per refined side using the middle 2/3 of samples, and
intersect the four pairs of adjacent lines to get refined corners.
"""

from __future__ import annotations

import cv2
import numpy as np

SAMPLES_PER_SIDE = 19
SMOOTH_WINDOW = 5


def _bilinear(img: np.ndarray, x: float, y: float) -> float:
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


def _refine_side(
    gx: np.ndarray,
    gy: np.ndarray,
    paint_mask: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    band_radius: int,
    n_samples: int,
    sign: float,
) -> np.ndarray:
    direction = b - a
    side_length = float(np.linalg.norm(direction))
    if side_length < 1.0:
        return np.array([a, b], dtype=np.float64)
    direction = direction / side_length
    nx, ny = -direction[1], direction[0]  # inward normal

    band_radius = max(int(band_radius), 2)
    h_mask, w_mask = paint_mask.shape[:2]

    peaks_signed: list[float] = []
    peaks_dist: list[int] = []
    centers: list[np.ndarray] = []
    for i in range(n_samples):
        t = i / (n_samples - 1)
        center = a + direction * side_length * t
        best_dist = 0
        best_signed = -1e9
        any_in_mask = False
        for d in range(-band_radius, band_radius + 1):
            sx = center[0] + nx * d
            sy = center[1] + ny * d
            ix = int(round(sx))
            iy = int(round(sy))
            if ix < 0 or iy < 0 or ix >= w_mask or iy >= h_mask:
                continue
            if paint_mask[iy, ix] == 0:
                continue
            any_in_mask = True
            gxv = _bilinear(gx, sx, sy)
            gyv = _bilinear(gy, sx, sy)
            signed = sign * (gxv * nx + gyv * ny)
            if signed > best_signed:
                best_signed = signed
                best_dist = d
        if not any_in_mask:
            # The perpendicular ray at this position never crossed the
            # painted region — keep the straight-line position so the line
            # fit that follows isn't biased by phantom data.
            peaks_signed.append(0.0)
            peaks_dist.append(0)
        else:
            peaks_signed.append(best_signed)
            peaks_dist.append(best_dist)
        centers.append(center.copy())

    positive = [s for s in peaks_signed if s > 0]
    if len(positive) < n_samples // 3:
        pts = np.array(centers, dtype=np.float64)
        pts[0] = a
        pts[-1] = b
        return pts
    floor = max(float(np.median(positive)) * 0.5, 1.0)

    points: list[np.ndarray] = []
    for signed, dist, center in zip(peaks_signed, peaks_dist, centers):
        if signed < floor:
            points.append(center.copy())
        else:
            points.append(np.array([center[0] + nx * dist, center[1] + ny * dist]))

    pts = np.array(points, dtype=np.float64)
    pts[0] = a
    pts[-1] = b
    return pts


def _smooth_polyline(poly: np.ndarray, window: int = SMOOTH_WINDOW) -> np.ndarray:
    if len(poly) <= 3 or window < 3:
        return poly
    pad = window // 2
    out = poly.copy()
    for i in range(1, len(poly) - 1):
        lo = max(0, i - pad)
        hi = min(len(poly), i + pad + 1)
        out[i] = poly[lo:hi].mean(axis=0)
    out[0] = poly[0]
    out[-1] = poly[-1]
    return out


def _fit_line_middle(poly: np.ndarray) -> np.ndarray:
    """Least-squares line through the middle 2/3 of the polyline.

    The endpoints are pinned to the (often-bad) initial corners; trim them
    so they don't bias the fit. Returns (vx, vy, x0, y0) where (vx, vy) is
    a unit direction vector and (x0, y0) is a point on the line.
    """
    n = len(poly)
    trim = max(1, n // 6)
    pts = poly[trim:n - trim] if n - 2 * trim >= 2 else poly
    pts32 = pts.astype(np.float32).reshape(-1, 1, 2)
    return cv2.fitLine(pts32, cv2.DIST_L2, 0, 0.01, 0.01).flatten()


def _line_intersect(la: np.ndarray, lb: np.ndarray) -> tuple[float, float] | None:
    vx1, vy1, x1, y1 = la
    vx2, vy2, x2, y2 = lb
    det = float(vx1 * (-vy2) - (-vx2) * vy1)
    if abs(det) < 1e-6:
        return None  # parallel
    t = ((x2 - x1) * (-vy2) - (y2 - y1) * (-vx2)) / det
    return (float(x1 + t * vx1), float(y1 + t * vy1))


def _refine_corners(
    sides_work: list[np.ndarray], fallback: np.ndarray
) -> np.ndarray:
    """Replace corners with intersections of adjacent fitted side lines.

    Side index 0 is top (TL→TR), 1 right (TR→BR), 2 bottom (BR→BL),
    3 left (BL→TL). Corner i is where side (i-1)%4 meets side i.
    """
    lines = [_fit_line_middle(s) for s in sides_work]
    pairs = [(3, 0), (0, 1), (1, 2), (2, 3)]
    out = fallback.copy()
    for idx, (a, b) in enumerate(pairs):
        pt = _line_intersect(lines[a], lines[b])
        if pt is not None:
            out[idx] = pt
    return out


SIDE_PAIRS = [(0, 1), (1, 2), (2, 3), (3, 0)]


def refine_quad_from_gradients(
    gx: np.ndarray,
    gy: np.ndarray,
    paint_mask: np.ndarray,
    scale: float,
    corners: list[list[float]],
    band_radius: float,
    sign: float,
    n_samples: int = SAMPLES_PER_SIDE,
    iterations: int = 2,
) -> dict:
    """Refine a 4-corner quad using precomputed gradient components.

    ``paint_mask`` (working-resolution, uint8) bounds the search so we
    never look outside where the user actually painted. ``corners`` are in
    full-resolution coordinates; gradients and mask are at working
    resolution where ``work = full * scale``.

    Each iteration refines all four sides with the current corners, then
    refines the corners by intersecting fitted side lines. Stops early if
    corner movement falls below 1.5 px.
    """
    work_corners = np.array(corners, dtype=np.float64) * scale
    work_band = max(int(round(float(band_radius) * scale)), 3)

    sides_work: list[np.ndarray] = []
    for _ in range(iterations):
        sides_work = []
        for i, j in SIDE_PAIRS:
            poly = _refine_side(
                gx, gy, paint_mask, work_corners[i], work_corners[j], work_band, n_samples, sign
            )
            poly = _smooth_polyline(poly)
            sides_work.append(poly)
        new_corners = _refine_corners(sides_work, work_corners)
        delta = float(np.max(np.abs(new_corners - work_corners)))
        work_corners = new_corners
        if delta < 1.5:
            break

    for s, (i, j) in enumerate(SIDE_PAIRS):
        sides_work[s][0] = work_corners[i]
        sides_work[s][-1] = work_corners[j]

    sides_full = [(s / scale).tolist() for s in sides_work]
    corners_full = (work_corners / scale).tolist()
    return {"corners": corners_full, "sides": sides_full}
