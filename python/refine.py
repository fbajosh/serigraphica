"""Edge-snap refinement.

Given a quadrilateral (4 corners in TL/TR/BR/BL order), a search-band radius,
and a polarity ('outer' or 'inner'), refine each side into a polyline that
follows the polarity-correct strongest local gradient.

Polarity matters because the typical input has nested rectangles with
opposite brightness profiles:

  - 'outer' (paper boundary): paper is bright, the surrounding board/wall
    is darker (or at least different). The edge we want crosses bright→dark
    going OUTward, i.e. grad·inward_normal > 0.
  - 'inner' (print boundary): print is darker than the surrounding paper.
    The edge crosses dark→bright going outward, i.e. grad·inward_normal < 0.

Using the signed projection (instead of |grad|) suppresses false positives
from sub-features inside the print, sharp shadow lines on the board, etc.

Algorithm per side a→b:
  - Direction d = (b-a)/|b-a|, inward normal n = (-dy, dx).
  - Sample N positions along the side.
  - At each, cast ±band_radius along n, compute gx,gy at each step, and
    track the position with maximum signed response s = sign·(grad·n)
    where sign is +1 for 'outer' and -1 for 'inner'.
  - If the per-sample max is below a noise floor (relative to the side's
    median of positive responses), default to the straight-line position.
  - Smooth with a moving average that preserves the corner endpoints.
"""

from __future__ import annotations

import cv2
import numpy as np

WORK_MAX_DIM = 1500
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

    # Per sample: find position of max signed response and record it.
    peaks_signed: list[float] = []
    peaks_dist: list[int] = []
    centers: list[np.ndarray] = []
    for i in range(n_samples):
        t = i / (n_samples - 1)
        center = a + direction * side_length * t
        best_dist = 0
        best_signed = -1e9
        for d in range(-band_radius, band_radius + 1):
            sx = center[0] + nx * d
            sy = center[1] + ny * d
            gxv = _bilinear(gx, sx, sy)
            gyv = _bilinear(gy, sx, sy)
            signed = sign * (gxv * nx + gyv * ny)
            if signed > best_signed:
                best_signed = signed
                best_dist = d
        peaks_signed.append(best_signed)
        peaks_dist.append(best_dist)
        centers.append(center.copy())

    # Floor: half the median of strictly positive responses. If too few
    # samples cleared zero, treat the whole side as ambiguous and use the
    # straight line.
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


def _gradient_components(image_path: str) -> tuple[np.ndarray, np.ndarray, float]:
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
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    return gx, gy, scale


def refine_quad(
    image_path: str,
    corners: list[list[float]],
    band_radius: float,
    polarity: str,
    n_samples: int = SAMPLES_PER_SIDE,
) -> dict:
    """Refine each side into a polyline that snaps to the polarity-correct
    strongest gradient within ``band_radius`` of the side."""
    if polarity not in ("outer", "inner"):
        raise ValueError(f"polarity must be 'outer' or 'inner', got {polarity!r}")
    sign = 1.0 if polarity == "outer" else -1.0

    gx, gy, scale = _gradient_components(image_path)
    work_corners = np.array(corners, dtype=np.float64) * scale
    work_band = max(int(round(float(band_radius) * scale)), 3)

    side_pairs = [(0, 1), (1, 2), (2, 3), (3, 0)]
    sides_full: list[list[list[float]]] = []
    for i, j in side_pairs:
        poly = _refine_side(gx, gy, work_corners[i], work_corners[j], work_band, n_samples, sign)
        poly = _smooth_polyline(poly)
        poly[0] = work_corners[i]
        poly[-1] = work_corners[j]
        sides_full.append((poly / scale).tolist())

    return {"corners": corners, "sides": sides_full}
