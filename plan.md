# Serigraphica Plan: Autodetected Starter Guides

This plan replaces the previous broad implementation plan with the next focused feature: automatically generate starter guide rectangles when no saved lines exist. The user still owns the final geometry and can adjust, clear, redraw, or redetect everything manually.

Do not update `prd.md` as part of this work unless explicitly requested.

## Previous Plan Status

The previous plan is not completely done.

Done or mostly done:

- Manual multi-rectangle guide workflow.
- Rectangle role inference by area: largest outer, smaller inner constraints.
- Saved guide auto-load by filename.
- Mesh projection from nested rectangles.
- Dewarp preview/export with progress and cancellation.
- Increased zoom range.
- Fill masks, fill preview, unfill/refill, and export integration.
- Output folder and ignored model/output artifacts.

Still incomplete or still evolving:

- Full physical thin-sheet / Euler-elastica-style dewarp model.
- Guaranteed no-fold/no-cross mesh validation.
- Perfect parity between visible grid-line spline behavior and Python dewarp remap.
- Automated tests for canonicalization, nesting, foldover detection, and sidecar workflows.

## Goal

When an image opens:

1. If saved guide lines exist for that filename, load them.
2. If no saved guide lines exist, automatically detect starter guide lines.
3. The starter guides include:
   - outer polygon corners,
   - outermost-inner polygon corners,
   - one Bezier side node per edge on each detected polygon.
4. The user can manually adjust all detected nodes and handles.
5. The user can clear detected/manual guides and rerun detection.

This is a starting-point feature, not a return to fully automated edge detection. Detection proposes editable guide geometry; the user remains responsible for final placement.

## UI Changes

### Guides Section

Change current guide controls to:

- `Draw | Pan | Detect`
- rectangle list
- `Clear Lines | Save Lines`
- `Hide Mesh | Hide Handles`

Specific changes:

- Rename `Reset Lines` to `Clear Lines`.
- Add `Detect` next to `Pan`.
- `Detect` is disabled when no image is loaded or another operation is busy.
- `Clear Lines` removes all current rectangles, draft points, dewarp/fill outputs, and mesh state as the current reset behavior does.
- If the user clicks `Detect` when lines already exist, detection should move/update existing lines to match the new detection.
- If the user wants a fully manual flow, they can click `Clear Lines`, then use `Draw`.

### Open Image Behavior

On image load:

1. Load saved guide paths by filename if they exist.
2. If saved paths exist, do not run autodetect.
3. If saved paths do not exist, run guide detection automatically.
4. If detection succeeds, show the detected rectangles and turn mesh on.
5. If detection fails, leave the image open in `Draw` mode and show an actionable status message.

### Existing Lines + Detect

Detection produces up to two rectangles:

- detected outer,
- detected outermost-inner.

When lines already exist:

- Update the current largest rectangle with detected outer.
- Update the current largest non-outer rectangle with detected outermost-inner.
- If either target rectangle is missing, create it.
- Preserve additional smaller inner rectangles for now. Future detection can support additional inner rectangles, but this feature only detects the outer and largest inner.

## Data Model

Add a sidecar result type conceptually shaped like:

```ts
type DetectGuidesResult = {
  rectangles: RectPath[]
  confidence: number
  diagnostics?: {
    outerConfidence?: number
    innerConfidence?: number
    messages?: string[]
  }
}
```

Detected `RectPath` format:

- Four protected corner nodes.
- One editable side node per edge.
- Corner indices point to the four corner nodes.
- Side nodes are inserted between corners.

Recommended node order:

```text
TL, top side node, TR, right side node, BR, bottom side node, BL, left side node
```

Recommended `cornerIndices`:

```ts
[0, 2, 4, 6]
```

Side node handles:

- Use symmetric handles.
- Estimate side-node tangent from the detected side polyline.
- Handle length should be conservative, roughly `15-25%` of the adjacent side segment length.
- Corners remain corner nodes with zero handles.

## Sidecar API

Add an Electron/preload/sidecar method:

```ts
detectGuides(imagePath: string): Promise<DetectGuidesResult>
```

Python sidecar method:

```json
{
  "method": "detect_guides",
  "params": {
    "path": "/path/to/image.jpg"
  }
}
```

Return:

```json
{
  "rectangles": [...],
  "confidence": 0.0,
  "diagnostics": {...}
}
```

## Detection Algorithm

The detector should optimize for useful starter geometry, not perfect final geometry.

### Preprocessing

Use OpenCV in Python:

1. Load image in color.
2. Downscale to a working size for speed, preserving scale factor.
3. Convert to multiple color spaces as needed:
   - grayscale for gradient edges,
   - Lab for paper/background and print/paper contrast,
   - HSV if saturation helps isolate printed artwork.
4. Build edge maps:
   - Canny edge detector,
   - Sobel/Scharr gradient magnitude,
   - optional adaptive threshold edges.
5. Morphologically close small gaps, but keep enough detail to preserve page/artwork borders.

### Outer Polygon Corners

Find a starter outer paper rectangle:

1. Search for large contours in the edge/threshold maps.
2. Prefer contours/quads with:
   - large area,
   - roughly rectangular topology,
   - four strong corner regions,
   - location near the paper boundary,
   - plausible aspect ratio,
   - non-self-intersection.
3. Also run line-segment detection or Hough-style line candidates as a fallback.
4. Build candidate quadrilaterals from contour approximation and/or line intersections.
5. Score candidates by:
   - area,
   - edge support along the candidate sides,
   - corner strength,
   - color/brightness contrast across the side,
   - nesting relationship with inner candidates.
6. Canonicalize selected corners to top-left, top-right, bottom-right, bottom-left in image space.

### Outermost-Inner Polygon Corners

Find the largest inner rectangle inside the outer paper rectangle:

1. Restrict search to the selected outer polygon interior.
2. Detect prominent rectangular contours corresponding to the artwork/print boundary.
3. Prefer the largest valid candidate that is fully inside the outer polygon.
4. Reject candidates that touch or nearly touch the outer edge.
5. Score candidates by:
   - area inside outer,
   - strong edge support,
   - printed-art/paper contrast,
   - corner strength,
   - rectangular consistency,
   - containment inside outer.
6. Canonicalize selected corners independently of detection order.

### Side Curve / Bezier Node Placement

For each detected polygon edge:

1. Extract a narrow search corridor around the edge chord.
2. Within the corridor, trace the strongest supported edge path between the two detected corners.
3. Use dynamic programming, shortest path over edge cost, or sampled maximum-gradient tracking to get an edge polyline.
4. Smooth the polyline lightly to remove noise.
5. Choose the side node:
   - Prefer the point of maximum perpendicular deviation from the straight chord.
   - If deviation is tiny, use the arc-length midpoint.
6. Estimate tangent at the side node from neighboring polyline samples.
7. Convert tangent to the symmetric handle vector used by the current guide editor.

Important behavior:

- The Bezier node is just an editable starting estimate.
- Do not overfit high-frequency texture, clip shadows, or printed design details.
- One side node per edge is enough for this feature.

## Integration Steps

1. Add shared API/types for `detectGuides`.
2. Add Electron preload method and main-process IPC handler.
3. Add Python sidecar `detect_guides` handler.
4. Implement Python detection in a new module, likely `python/detect_guides.py`.
5. Convert detector output into current `RectPath` shape.
6. Add renderer `handleDetectGuides`.
7. Call `handleDetectGuides` automatically from image-open flow only when no saved paths exist.
8. Add `Detect` button beside `Pan`.
9. Rename `Reset Lines` to `Clear Lines`.
10. Ensure detection clears dewarp/fill outputs because guide geometry changed.
11. Ensure saved paths always take precedence over autodetection.
12. Add status messages for:
    - detecting,
    - detected outer only,
    - detected outer + inner,
    - failed detection,
    - redetected existing lines.

## Error Handling

Detection should fail gracefully:

- If no outer polygon is detected, return no rectangles and a diagnostic message.
- If outer is detected but inner is not, return the outer rectangle and warn that the inner rectangle must be drawn manually.
- If confidence is low, still allow showing candidates but mark the status as low confidence.
- Never overwrite saved paths automatically.
- Never run detection after saved paths load unless the user presses `Detect`.

## Acceptance Criteria

- Opening a file with saved lines loads saved lines and does not autodetect.
- Opening a file without saved lines runs autodetection automatically.
- Detection creates an editable outer rectangle when it finds the paper boundary.
- Detection creates an editable outermost-inner rectangle when it finds the largest inner artwork boundary.
- Each detected polygon has four corners plus one side Bezier node per edge.
- Detected side nodes and handles can be manually adjusted with the existing guide editor.
- `Clear Lines` replaces the old `Reset Lines` label and clears all guide geometry.
- `Detect` appears next to `Pan`.
- Pressing `Detect` with existing lines updates the outer and largest inner guides instead of requiring the user to clear first.
- Additional smaller inner rectangles are preserved when redetecting.
- Detection failure leaves the image open and usable for manual drawing.

## Verification

Run after implementation:

```sh
npm run typecheck
python/.venv/bin/python3 -m py_compile python/sidecar.py python/transform.py python/detect_guides.py
npm run build
git diff --check
```

Manual test cases:

- Image with saved lines: confirms saved paths load and detect does not run.
- Image without saved lines and clear paper/artwork edges: detects outer + inner.
- Image without saved lines and no visible inner boundary: detects outer only and warns.
- Press `Clear Lines`, then `Detect`: recreates detected starter guides.
- Press `Detect` after manually moving guides: moves outer/largest-inner to new detected geometry.
- Press `Detect` with additional smaller inner rectangles present: outer/largest-inner update, smaller inner rectangles remain.
- Low contrast outer paper edge.
- Inner print boundary with gaps or clips.
- Rotated/counter-clockwise detected corner order: canonical output remains top/right/bottom/left.
