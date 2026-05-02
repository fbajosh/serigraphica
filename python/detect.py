"""Outer rectangle detection for serigraphs photographed on a white easel board.

Geometry of the typical input (per the photo set this app targets):

    background (house/sky/grass)
      └── white easel board (often spans most of frame)
            └── white serigraph paper sheet (weak edge to board, white-on-white)
                  └── colored inner print rectangle (high contrast against paper)

The detector tries to land on either the paper or the inner print, whichever
is most reliably visible. Per project direction, the inner colored print is an
acceptable default — the user can drag corners outward to the paper when
needed.

Pipeline:
  1. Downsample to a working resolution.
  2. CLAHE on grayscale to surface low-contrast paper-vs-board edges.
  3. Multi-threshold Canny (low + median) unioned for robustness across
     under/overexposed areas.
  4. Find external contours, take convex hull (binder clips and shadow
     notches break direct 4-vertex approximation), sweep epsilons until
     approxPolyDP yields exactly 4 convex vertices.
  5. Reject candidates whose area exceeds REJECT_AREA_FRAC of the frame
     (those are the easel board or merged background, not the artwork).
  6. Score each candidate as area_frac × (EDGE_FLOOR + edge_confidence)
     × centeredness, pick the best.
  7. Map back to source resolution.
"""

from __future__ import annotations

import cv2
import numpy as np

WORK_MAX_DIM = 1500
EPSILON_SWEEP = (0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07)
MIN_AREA_FRAC = 0.04   # ignore contours below 4% of the frame
REJECT_AREA_FRAC = 0.85  # reject candidates larger than this — they're background/board
EDGE_FLOOR = 0.3       # confidence weight floor so a mediocre-edge but large rect still scores


def _order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(-1, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float64)


def _approx_quad(contour: np.ndarray) -> np.ndarray | None:
    hull = cv2.convexHull(contour)
    peri = cv2.arcLength(hull, True)
    for eps in EPSILON_SWEEP:
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return approx
    return None


def _edge_score(edges: np.ndarray, p1: np.ndarray, p2: np.ndarray) -> float:
    """Fraction of pixels along p1→p2 that lie on a Canny edge (±2 px band)."""
    h, w = edges.shape
    length = max(int(np.linalg.norm(p2 - p1)), 1)
    samples = np.linspace(0, 1, length)
    xs = np.clip(np.round(p1[0] + (p2[0] - p1[0]) * samples).astype(int), 0, w - 1)
    ys = np.clip(np.round(p1[1] + (p2[1] - p1[1]) * samples).astype(int), 0, h - 1)
    tolerance = 2
    hits = 0
    for dx in range(-tolerance, tolerance + 1):
        xx = np.clip(xs + dx, 0, w - 1)
        hits += int(np.count_nonzero(edges[ys, xx]))
    return hits / (length * (2 * tolerance + 1))


def _quad_confidence(edges: np.ndarray, corners: np.ndarray) -> float:
    return float(np.mean([
        _edge_score(edges, corners[i], corners[(i + 1) % 4]) for i in range(4)
    ]))


def _centeredness(corners: np.ndarray, w: int, h: int) -> float:
    """1.0 when quad center == image center, decaying as it moves toward an edge."""
    cx = float(np.mean(corners[:, 0]))
    cy = float(np.mean(corners[:, 1]))
    dx = (cx - w / 2) / (w / 2)
    dy = (cy - h / 2) / (h / 2)
    # Penalize off-center quads gently — center=1.0, image edge≈0.
    return float(max(0.0, 1.0 - 0.5 * np.hypot(dx, dy)))


def _build_edge_map(work: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 0)
    e_low = cv2.Canny(blurred, 20, 60)
    e_med = cv2.Canny(blurred, 50, 150)
    edges = cv2.bitwise_or(e_low, e_med)
    return cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)


def detect_outer_rect(image_path: str) -> dict:
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
    work_h, work_w = work.shape[:2]
    image_area = float(work_w * work_h)

    edges = _build_edge_map(work)
    # RETR_LIST so nested contours are visible — the inner colored print is
    # often inside a much larger paper/board contour and would be hidden by
    # RETR_EXTERNAL.
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[tuple[float, np.ndarray, float]] = []  # (score, corners, confidence)
    for c in contours:
        contour_area = cv2.contourArea(c)
        if contour_area < image_area * MIN_AREA_FRAC:
            continue
        approx = _approx_quad(c)
        if approx is None:
            continue
        corners = _order_corners(approx)
        # Reject on the final quad area: the convex hull can balloon a small
        # contour into a near-frame quad if the contour wraps around clutter.
        quad_area = cv2.contourArea(corners.astype(np.float32))
        area_frac = quad_area / image_area
        if area_frac < MIN_AREA_FRAC or area_frac > REJECT_AREA_FRAC:
            continue
        confidence = _quad_confidence(edges, corners)
        center_w = _centeredness(corners, work_w, work_h)
        score = area_frac * (EDGE_FLOOR + confidence) * (0.5 + 0.5 * center_w)
        candidates.append((score, corners, confidence))

    if candidates:
        candidates.sort(key=lambda t: t[0], reverse=True)
        _, corners, confidence = candidates[0]
    else:
        # No clean rectangular structure detected. Return a centered inset
        # so the user has draggable handles in roughly the right area.
        inset = 0.1
        corners = np.array([
            [work_w * inset, work_h * inset],
            [work_w * (1 - inset), work_h * inset],
            [work_w * (1 - inset), work_h * (1 - inset)],
            [work_w * inset, work_h * (1 - inset)],
        ], dtype=np.float64)
        confidence = 0.0

    full_corners = corners / scale
    return {
        "corners": full_corners.tolist(),
        "imageWidth": full_w,
        "imageHeight": full_h,
        "confidence": float(confidence),
    }
