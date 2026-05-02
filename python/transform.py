"""Perspective correction and JPG export."""

from __future__ import annotations

import cv2
import numpy as np


def _order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(-1, 2).astype(np.float64)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], dtype=np.float64)


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

    ok = cv2.imwrite(output_path, warped, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise RuntimeError(f"failed to write output: {output_path}")

    return {
        "outputPath": output_path,
        "outputWidth": width,
        "outputHeight": height,
    }
