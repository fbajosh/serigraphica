"""Edge-snap refinement using precomputed gradient components.

Given gradient components (gx, gy) at a working resolution, a quadrilateral
in full-resolution coordinates, and a polarity sign, refine each side into
a dense polyline that follows the polarity-correct strongest gradient inside
the painted search band.

The painted mask is a hard constraint: every returned side point and corner
is projected back into the painted region. This matters more than making
pretty geometric intersections; a fitted edge outside the user's indicated
search region is always wrong.

Algorithm per side a→b:
  - direction d = (b-a)/|b-a|, inward normal n = (-dy, dx).
  - Sample N positions along the side.
  - At each, cast ±band_radius along n and track the position with the
    strongest signed edge score. The score combines local gradient direction
    with a two-sided canvas-vs-noncanvas step response so subtle white /
    off-white paper edges still win over unrelated shading.
  - Per-side floor: half the median of strictly-positive responses. If too
    few samples cleared zero, fall back to the nearest painted point.
  - Smooth with a moving-average filter, then project every point back into
    the painted mask.
"""

from __future__ import annotations

import cv2
import numpy as np

SAMPLES_PER_SIDE = 97
TARGET_SAMPLE_SPACING = 5.0
MAX_RENDER_SEGMENT_SPACING = 2.5
POLY_MAX_DEGREE = 7
ROBUST_RESIDUAL_SCALE = 3.0
POLY_RELATIVE_SIMPLICITY_TOLERANCE = 0.08
POLY_ABSOLUTE_SIMPLICITY_TOLERANCE = 0.4
SMOOTH_WINDOW = 5
TOP_CENTER_MIN = 0.34
TOP_CENTER_MAX = 0.66
TOP_CENTER_PRIOR_WEIGHT = 8.0
ENDPOINT_ANCHOR_WEIGHT = 40.0
ENDPOINT_TAPER_MIN = 8.0
ENDPOINT_TAPER_BAND_FRACTION = 0.9
ENDPOINT_STRAIGHT_FRACTION = 0.45
EDGE_STEP_PROBE = 3.0
EDGE_STEP_WEIGHT = 1.5


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


def _mask_points(mask: np.ndarray) -> np.ndarray:
    pts = cv2.findNonZero(mask)
    if pts is None:
        return np.empty((0, 2), dtype=np.float64)
    return pts.reshape(-1, 2).astype(np.float64)


def _point_in_mask(mask: np.ndarray, pt: np.ndarray) -> bool:
    h, w = mask.shape[:2]
    x = int(round(float(pt[0])))
    y = int(round(float(pt[1])))
    return 0 <= x < w and 0 <= y < h and mask[y, x] > 0


def _project_point_to_mask(mask: np.ndarray, mask_pts: np.ndarray, pt: np.ndarray) -> np.ndarray:
    """Return pt if it is in the painted mask, else the nearest painted pixel."""
    if _point_in_mask(mask, pt):
        return pt.astype(np.float64)
    if len(mask_pts) == 0:
        return pt.astype(np.float64)
    deltas = mask_pts - pt.reshape(1, 2)
    idx = int(np.argmin(np.einsum("ij,ij->i", deltas, deltas)))
    return mask_pts[idx].astype(np.float64)


def _project_polyline_to_mask(mask: np.ndarray, mask_pts: np.ndarray, poly: np.ndarray) -> np.ndarray:
    return np.array([_project_point_to_mask(mask, mask_pts, p) for p in poly], dtype=np.float64)


def _densify_polyline_in_mask(
    mask: np.ndarray,
    mask_pts: np.ndarray,
    poly: np.ndarray,
    spacing: float = MAX_RENDER_SEGMENT_SPACING,
) -> np.ndarray:
    if len(poly) <= 1:
        return _project_polyline_to_mask(mask, mask_pts, poly)
    out: list[np.ndarray] = [_project_point_to_mask(mask, mask_pts, poly[0])]
    for a, b in zip(poly, poly[1:]):
        length = float(np.linalg.norm(b - a))
        steps = max(1, int(np.ceil(length / spacing)))
        for step in range(1, steps + 1):
            t = step / steps
            p = a + (b - a) * t
            out.append(_project_point_to_mask(mask, mask_pts, p))
    return np.array(out, dtype=np.float64)


def _smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, float(t)))
    return t * t * (3.0 - 2.0 * t)


def _taper_side_to_corners(poly: np.ndarray, a: np.ndarray, b: np.ndarray, guard: float) -> np.ndarray:
    """Force each side to leave and enter its corners without endpoint spurs."""
    if len(poly) <= 2:
        return poly
    direction = b - a
    side_length = float(np.linalg.norm(direction))
    if side_length < 1.0:
        return poly
    direction = direction / side_length
    normal = np.array([-direction[1], direction[0]], dtype=np.float64)
    guard = min(max(float(guard), ENDPOINT_TAPER_MIN), side_length * 0.25)
    straight_guard = guard * ENDPOINT_STRAIGHT_FRACTION
    blend_guard = max(1.0, guard - straight_guard)
    out = poly.copy()
    for idx, point in enumerate(out):
        x = float((point - a) @ direction)
        y = float((point - a) @ normal)
        x = min(side_length, max(0.0, x))
        if x < straight_guard:
            y = 0.0
        elif x < guard:
            y *= _smoothstep((x - straight_guard) / blend_guard)
        elif side_length - x < straight_guard:
            y = 0.0
        elif side_length - x < guard:
            y *= _smoothstep((side_length - x - straight_guard) / blend_guard)
        out[idx] = a + x * direction + y * normal
    out[0] = a
    out[-1] = b
    return out.astype(np.float64)


def _choose_polynomial_fit(
    xn: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray,
    max_degree: int,
) -> tuple[np.ndarray, int] | None:
    """Pick the simplest polynomial whose error is close to the best fit."""
    max_degree = max(1, int(max_degree))
    fits: list[tuple[int, np.ndarray, float]] = []
    safe_weights = np.maximum(weights, 1e-3)
    weight_sum = float(np.sum(safe_weights))
    if weight_sum <= 0:
        return None
    for degree in range(1, max_degree + 1):
        if len(xn) < degree + 1:
            break
        try:
            coeff = np.polyfit(xn, y, degree, w=np.sqrt(safe_weights))
        except np.linalg.LinAlgError:
            continue
        residuals = np.polyval(coeff, xn) - y
        rmse = float(np.sqrt(np.sum(safe_weights * residuals * residuals) / weight_sum))
        fits.append((degree, coeff, rmse))
    if not fits:
        return None
    best_rmse = min(rmse for _, _, rmse in fits)
    allowed = best_rmse * (1.0 + POLY_RELATIVE_SIMPLICITY_TOLERANCE) + POLY_ABSOLUTE_SIMPLICITY_TOLERANCE
    for degree, coeff, rmse in fits:
        if rmse <= allowed:
            return coeff, degree
    degree, coeff, _ = min(fits, key=lambda item: item[2])
    return coeff, degree


def _fit_smooth_side_curve(
    evidence_points: np.ndarray,
    evidence_weights: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    direction: np.ndarray,
    normal: np.ndarray,
    side_length: float,
    n_samples: int,
    straight_center: bool,
) -> tuple[np.ndarray, int] | None:
    if len(evidence_points) < 4 or side_length < 1.0:
        return None
    x = (evidence_points - a) @ direction
    y = (evidence_points - a) @ normal
    keep = (x >= -side_length * 0.05) & (x <= side_length * 1.05)
    x = x[keep]
    y = y[keep]
    weights = evidence_weights[keep]
    if len(x) < 4:
        return None

    order = np.argsort(x)
    x = x[order]
    y = y[order]
    weights = weights[order]
    if straight_center:
        side_t = x / side_length
        outside_center = (side_t < TOP_CENTER_MIN) | (side_t > TOP_CENTER_MAX)
        line_x = x[outside_center] if int(np.count_nonzero(outside_center)) >= 2 else x
        line_y = y[outside_center] if int(np.count_nonzero(outside_center)) >= 2 else y
        line_w = weights[outside_center] if int(np.count_nonzero(outside_center)) >= 2 else weights
        try:
            line_coeff = np.polyfit(line_x, line_y, 1, w=np.sqrt(np.maximum(line_w, 1e-3)))
            prior_x = np.linspace(side_length * TOP_CENTER_MIN, side_length * TOP_CENTER_MAX, 16)
            prior_y = np.polyval(line_coeff, prior_x)
            x = np.concatenate([x, prior_x])
            y = np.concatenate([y, prior_y])
            weights = np.concatenate([
                weights,
                np.full_like(prior_x, max(float(np.median(weights)), 1.0) * TOP_CENTER_PRIOR_WEIGHT),
            ])
            order = np.argsort(x)
            x = x[order]
            y = y[order]
            weights = weights[order]
        except np.linalg.LinAlgError:
            pass
    anchor_weight = max(float(np.median(weights)), 1.0) * ENDPOINT_ANCHOR_WEIGHT
    x = np.concatenate([x, np.array([0.0, side_length], dtype=np.float64)])
    y = np.concatenate([y, np.array([0.0, 0.0], dtype=np.float64)])
    weights = np.concatenate([weights, np.array([anchor_weight, anchor_weight], dtype=np.float64)])
    order = np.argsort(x)
    x = x[order]
    y = y[order]
    weights = weights[order]
    xn = (2.0 * x / side_length) - 1.0
    max_degree = min(POLY_MAX_DEGREE, max(1, len(np.unique(np.round(xn, 3))) - 1))

    try:
        chosen = _choose_polynomial_fit(xn, y, weights, max_degree)
        if chosen is None:
            return None
        coeff, degree = chosen
        residuals = np.abs(np.polyval(coeff, xn) - y)
        median_residual = float(np.median(residuals))
        mad = float(np.median(np.abs(residuals - median_residual)))
        threshold = max(1.5, median_residual + ROBUST_RESIDUAL_SCALE * max(mad, 1e-6))
        robust = residuals <= threshold
        if int(np.count_nonzero(robust)) >= max(4, degree + 1) and int(np.count_nonzero(~robust)) > 0:
            x = x[robust]
            y = y[robust]
            weights = weights[robust]
            xn = (2.0 * x / side_length) - 1.0
            max_degree = min(max_degree, max(1, len(np.unique(np.round(xn, 3))) - 1))
            chosen = _choose_polynomial_fit(xn, y, weights, max_degree)
            if chosen is None:
                return None
            coeff, degree = chosen
    except np.linalg.LinAlgError:
        return None

    sample_count = max(int(n_samples), int(np.ceil(side_length / TARGET_SAMPLE_SPACING)) + 1)
    xs = np.linspace(0.0, side_length, sample_count)
    xsn = (2.0 * xs / side_length) - 1.0
    ys = np.polyval(coeff, xsn)
    pts = a.reshape(1, 2) + xs.reshape(-1, 1) * direction.reshape(1, 2) + ys.reshape(-1, 1) * normal.reshape(1, 2)
    return pts.astype(np.float64), int(degree)


def _refine_side(
    gx: np.ndarray,
    gy: np.ndarray,
    paint_mask: np.ndarray,
    mask_pts: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    band_radius: int,
    n_samples: int,
    sign: float,
    straight_center: bool = False,
    edge_field: np.ndarray | None = None,
) -> tuple[np.ndarray, dict]:
    a = _project_point_to_mask(paint_mask, mask_pts, a)
    b = _project_point_to_mask(paint_mask, mask_pts, b)
    direction = b - a
    side_length = float(np.linalg.norm(direction))
    if side_length < 1.0:
        return np.array([a, b], dtype=np.float64), {
            "state": "fallback",
            "sampleCount": 2,
            "maskHitSamples": 0,
            "positiveSamples": 0,
            "acceptedSamples": 0,
            "edgeCoverage": 0.0,
            "medianResponse": 0.0,
            "responseFloor": 0.0,
            "meanOffset": 0.0,
            "maxOffset": 0.0,
            "polynomialDegree": 0,
            "straightCenterPrior": bool(straight_center),
        }
    direction = direction / side_length
    nx, ny = -direction[1], direction[0]  # inward normal

    band_radius = max(int(band_radius), 2)
    h_mask, w_mask = paint_mask.shape[:2]

    peaks_signed: list[float] = []
    peaks_point: list[np.ndarray] = []
    centers: list[np.ndarray] = []
    mask_hit_samples = 0
    n_samples = max(int(n_samples), int(np.ceil(side_length / TARGET_SAMPLE_SPACING)) + 1)
    for i in range(n_samples):
        t = i / (n_samples - 1)
        center = a + direction * side_length * t
        best_signed = -1e9
        best_point = center.copy()
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
            signed_gradient = sign * (gxv * nx + gyv * ny)
            if edge_field is not None:
                inside = _bilinear(edge_field, sx + nx * EDGE_STEP_PROBE, sy + ny * EDGE_STEP_PROBE)
                outside = _bilinear(edge_field, sx - nx * EDGE_STEP_PROBE, sy - ny * EDGE_STEP_PROBE)
                signed_step = sign * (inside - outside)
                signed = signed_gradient + EDGE_STEP_WEIGHT * signed_step
            else:
                signed = signed_gradient
            if signed > best_signed:
                best_signed = signed
                best_point = np.array([sx, sy], dtype=np.float64)
        if not any_in_mask:
            peaks_signed.append(0.0)
            peaks_point.append(center.copy())
        else:
            mask_hit_samples += 1
            peaks_signed.append(best_signed)
            peaks_point.append(_project_point_to_mask(paint_mask, mask_pts, best_point))
        centers.append(center.copy())

    positive = [s for s in peaks_signed if s > 0]
    median_response = float(np.median(positive)) if positive else 0.0
    if len(positive) < n_samples // 3:
        pts = np.array(centers, dtype=np.float64)
        pts = _project_polyline_to_mask(paint_mask, mask_pts, pts)
        return pts, {
            "state": "fallback",
            "sampleCount": int(n_samples),
            "maskHitSamples": int(mask_hit_samples),
            "positiveSamples": int(len(positive)),
            "acceptedSamples": 0,
            "edgeCoverage": 0.0,
            "medianResponse": median_response,
            "responseFloor": 0.0,
            "meanOffset": 0.0,
            "maxOffset": 0.0,
            "polynomialDegree": 0,
            "straightCenterPrior": bool(straight_center),
        }
    floor = max(median_response * 0.5, 1.0)

    evidence_points: list[np.ndarray] = []
    evidence_weights: list[float] = []
    accepted_distances: list[float] = []
    for signed, point, center in zip(peaks_signed, peaks_point, centers):
        if signed >= floor:
            projected = _project_point_to_mask(paint_mask, mask_pts, point)
            evidence_points.append(projected)
            evidence_weights.append(float(signed))
            accepted_distances.append(float(np.linalg.norm(projected - center)))

    accepted = len(accepted_distances)
    smooth = None
    if accepted >= max(4, n_samples // 5):
        smooth = _fit_smooth_side_curve(
            np.array(evidence_points, dtype=np.float64),
            np.array(evidence_weights, dtype=np.float64),
            a,
            b,
            direction,
            np.array([nx, ny], dtype=np.float64),
            side_length,
            n_samples,
            straight_center,
        )
    if smooth is None:
        pts = np.array(evidence_points if evidence_points else centers, dtype=np.float64)
        polynomial_degree = 0
    else:
        pts, polynomial_degree = smooth
    pts = _project_polyline_to_mask(paint_mask, mask_pts, pts)
    return pts, {
        "state": "fitted" if accepted > 0 else "fallback",
        "sampleCount": int(n_samples),
        "maskHitSamples": int(mask_hit_samples),
        "positiveSamples": int(len(positive)),
        "acceptedSamples": int(accepted),
        "edgeCoverage": float(accepted / n_samples),
        "medianResponse": median_response,
        "responseFloor": float(floor),
        "meanOffset": float(np.mean(accepted_distances)) if accepted_distances else 0.0,
        "maxOffset": float(np.max(accepted_distances)) if accepted_distances else 0.0,
        "polynomialDegree": int(polynomial_degree),
        "straightCenterPrior": bool(straight_center),
    }


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


def _fit_line(points: np.ndarray) -> np.ndarray | None:
    if len(points) < 2:
        return None
    pts32 = points.astype(np.float32).reshape(-1, 1, 2)
    return cv2.fitLine(pts32, cv2.DIST_L2, 0, 0.01, 0.01).flatten()


def _line_intersect(la: np.ndarray, lb: np.ndarray) -> np.ndarray | None:
    vx1, vy1, x1, y1 = la
    vx2, vy2, x2, y2 = lb
    det = float(vx1 * (-vy2) - (-vx2) * vy1)
    if abs(det) < 1e-6:
        return None
    t = ((x2 - x1) * (-vy2) - (y2 - y1) * (-vx2)) / det
    return np.array([float(x1 + t * vx1), float(y1 + t * vy1)], dtype=np.float64)


def _side_end_window(poly: np.ndarray, from_start: bool, distance: float) -> np.ndarray:
    pts = poly if from_start else poly[::-1]
    out = [pts[0]]
    traveled = 0.0
    for a, b in zip(pts, pts[1:]):
        traveled += float(np.linalg.norm(b - a))
        out.append(b)
        if traveled >= distance and len(out) >= 6:
            break
        if len(out) >= 50:
            break
    return np.array(out, dtype=np.float64)


def _refine_corners_from_side_ends(
    sides_work: list[np.ndarray],
    fallback: np.ndarray,
    paint_mask: np.ndarray,
    mask_pts: np.ndarray,
    max_shift: float,
) -> np.ndarray:
    """Solve corners from local adjacent side evidence, constrained to paint.

    Whole-side intersections can jump to unrelated line extensions. This uses
    only the near-corner portion of each adjacent side, then projects the
    accepted corner back into the painted mask.
    """
    pairs = [(3, 0), (0, 1), (1, 2), (2, 3)]
    out = fallback.copy()
    window = max(18.0, float(max_shift) * 1.25)
    max_projection = max(4.0, float(max_shift) * 0.35)
    for idx, (prev_side, next_side) in enumerate(pairs):
        prev_pts = _side_end_window(sides_work[prev_side], from_start=False, distance=window)
        next_pts = _side_end_window(sides_work[next_side], from_start=True, distance=window)
        prev_line = _fit_line(prev_pts)
        next_line = _fit_line(next_pts)
        if prev_line is None or next_line is None:
            continue
        candidate = _line_intersect(prev_line, next_line)
        if candidate is None:
            continue
        if float(np.linalg.norm(candidate - fallback[idx])) > max_shift:
            continue
        projected = _project_point_to_mask(paint_mask, mask_pts, candidate)
        if float(np.linalg.norm(projected - candidate)) > max_projection:
            continue
        out[idx] = projected
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
    role: str = "",
    n_samples: int = SAMPLES_PER_SIDE,
    iterations: int = 2,
    edge_field: np.ndarray | None = None,
) -> dict:
    """Refine a 4-corner quad using precomputed gradient components.

    ``paint_mask`` (working-resolution, uint8) bounds the search so we
    never look outside where the user actually painted. ``corners`` are in
    full-resolution coordinates; gradients and mask are at working
    resolution where ``work = full * scale``.

    Corners are projected into the painted mask and then held fixed. The
    previous line-intersection corner refinement could jump outside the
    painted region, which violates the user's search constraint.
    """
    mask_pts = _mask_points(paint_mask)
    work_corners = _project_polyline_to_mask(
        paint_mask,
        mask_pts,
        np.array(corners, dtype=np.float64) * scale,
    )
    work_band = max(int(round(float(band_radius) * scale)), 3)

    sides_work: list[np.ndarray] = []
    side_diagnostics: list[dict] = []
    initial_corners = work_corners.copy()
    for _ in range(max(1, iterations)):
        previous_corners = work_corners.copy()
        sides_work = []
        side_diagnostics = []
        for side_index, (i, j) in enumerate(SIDE_PAIRS):
            poly, diag = _refine_side(
                gx,
                gy,
                paint_mask,
                mask_pts,
                work_corners[i],
                work_corners[j],
                work_band,
                n_samples,
                sign,
                straight_center=(role == "outer" and side_index == 0),
                edge_field=edge_field,
            )
            if int(diag.get("polynomialDegree", 0)) == 0:
                poly = _smooth_polyline(poly)
            poly = _project_polyline_to_mask(paint_mask, mask_pts, poly)
            poly = _taper_side_to_corners(
                poly,
                work_corners[i],
                work_corners[j],
                work_band * ENDPOINT_TAPER_BAND_FRACTION,
            )
            poly = _project_polyline_to_mask(paint_mask, mask_pts, poly)
            poly = _densify_polyline_in_mask(paint_mask, mask_pts, poly)
            sides_work.append(poly)
            side_diagnostics.append(diag)
        work_corners = _refine_corners_from_side_ends(
            sides_work,
            work_corners,
            paint_mask,
            mask_pts,
            max_shift=max(float(work_band), 8.0),
        )
        next_sides: list[np.ndarray] = []
        for s, (i, j) in enumerate(SIDE_PAIRS):
            poly = sides_work[s].copy()
            poly[0] = work_corners[i]
            poly[-1] = work_corners[j]
            poly = _taper_side_to_corners(
                poly,
                work_corners[i],
                work_corners[j],
                work_band * ENDPOINT_TAPER_BAND_FRACTION,
            )
            poly = _project_polyline_to_mask(paint_mask, mask_pts, poly)
            poly = _densify_polyline_in_mask(paint_mask, mask_pts, poly)
            poly = _taper_side_to_corners(
                poly,
                work_corners[i],
                work_corners[j],
                work_band * ENDPOINT_TAPER_BAND_FRACTION,
            )
            poly = _project_polyline_to_mask(paint_mask, mask_pts, poly)
            poly[0] = work_corners[i]
            poly[-1] = work_corners[j]
            next_sides.append(poly)
        sides_work = next_sides
        if float(np.max(np.linalg.norm(work_corners - previous_corners, axis=1))) < 1.0:
            break

    for s, (i, j) in enumerate(SIDE_PAIRS):
        sides_work[s] = _taper_side_to_corners(
            sides_work[s],
            work_corners[i],
            work_corners[j],
            work_band * ENDPOINT_TAPER_BAND_FRACTION,
        )
        sides_work[s] = _project_polyline_to_mask(paint_mask, mask_pts, sides_work[s])
        sides_work[s][0] = work_corners[i]
        sides_work[s][-1] = work_corners[j]

    sides_full = [(s / scale).tolist() for s in sides_work]
    corners_full = (work_corners / scale).tolist()
    corner_shifts = (np.linalg.norm(work_corners - initial_corners, axis=1) / scale).tolist()
    return {
        "corners": corners_full,
        "sides": sides_full,
        "diagnostics": {
            "sides": side_diagnostics,
            "scale": float(scale),
            "bandRadius": float(work_band / scale),
            "cornerShifts": [float(v) for v in corner_shifts],
        },
    }
