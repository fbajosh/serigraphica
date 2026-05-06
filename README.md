# Serigraphica

Serigraphica is an Electron desktop app for correcting photographs of serigraphs, prints, and other rectangular artwork shot while clipped to a board or easel. The app is built around manual guide geometry: the user marks the visible paper/artwork boundaries, then the software projects a mesh, dewarps the image, optionally fills clip/shadow regions, and exports a corrected image.

The current implementation is intentionally local-first:

- Renderer: React + canvas in `src/renderer`.
- Shell: Electron in `electron`.
- Image processing: Python sidecar using OpenCV/NumPy in `python`.
- Outputs: generated previews and exports are written under `output/`.

## Workflow

1. Open or drag an image into the app.
2. If saved guide paths exist for the filename, Serigraphica loads them automatically. If not, it runs starter guide detection for the outer rectangle and largest inner rectangle.
3. Use `Draw` to refine rectangles. Draw one outer rectangle and one or more nested inner rectangles. Each rectangle is four corners first, then optional side nodes/Bezier handles can refine curved sides.
4. Use `Redetect` if you want the detector to refit around the current manually adjusted guide points.
5. Review the mesh. The largest rectangle is treated as the outer guide; smaller non-overlapping rectangles are treated as inner guide constraints.
6. Adjust `Grid Density` for visual mesh resolution and `Grid Curve` for visible mesh-line smoothing through nested constraints.
7. Run `Dewarp` to preview the corrected image.
8. Optionally use `Fill` after dewarp to draw four-point masks around clips, clamp shadows, or other edge artifacts.
9. Export to `output/<original>_corrected.jpg` or choose a path with `Export As`.

Guide paths are saved in browser local storage, keyed by image filename, so reopening the same filename reloads the saved rectangles instead of running detection.

## Guide Editing

The guide model is a set of detected or manually drawn rectangle paths:

- `Draw` mode starts a new rectangle by clicking four corners.
- Completed rectangles can be edited by dragging corner nodes.
- Clicking an existing side inserts a side node.
- Side nodes have symmetric handles for Bezier-style curve editing.
- Auto-detected nodes store their original detector position and handle as their auto baseline.
- Dragging a node, dragging a handle, or inserting a side node marks that node as user-touched.
- Touched nodes use a dashed black outer ring so they are visually distinguishable from auto nodes.
- `Redetect` sends the current guide paths to the Python detector. Touched nodes are treated as fixed constraints when candidate outer/inner rectangles are scored and refit.
- Untouched nodes are detector-owned and may move on redetect.
- Right-clicking a touched side node deletes it.
- Right-clicking a touched corner resets it to its original auto position and marks it auto again.
- Untouched corner nodes are protected.
- The largest rectangle by area is automatically classified as the outer guide.
- Smaller rectangles are automatically classified as inner guide constraints.
- Rectangles are assumed to be nested, non-overlapping, non-proportional, and physically parallel counterparts on the same sheet.

## Starter Detection

Starter guide detection is implemented in `python/detect_guides.py`.

The detector is deliberately a starting-point tool, not an authority over the user. Its job is to place usable editable guides:

1. The image is downscaled to a bounded working resolution.
2. Multiple edge maps are combined from CLAHE-enhanced luminance, Lab luminance, and HSV saturation.
3. OpenCV contour extraction finds rectangular candidates with `findContours`, convex hulls, `approxPolyDP`, and `minAreaRect` fallback.
4. Candidate corners are canonicalized as top-left, top-right, bottom-right, bottom-left independent of drawing or contour order.
5. The detector selects an outer/inner pair by area, containment, centeredness, rectangularity, edge support, and nested-size constraints.
6. Each selected candidate is converted into the current `RectPath` format: four protected corner nodes plus one editable Bezier side node per edge.
7. Side nodes are placed by scanning along the local side normal for the strongest edge evidence and fitting a low-degree polynomial offset along the side.

When `Redetect` is run after manual edits, the current guide paths are passed back into the sidecar. Touched corners contribute hard point constraints to candidate scoring. Touched side nodes constrain the corresponding candidate edge by distance-to-segment and handle alignment. The selected detector result is then merged in the renderer: touched nodes stay fixed, untouched nodes are replaced or transformed from the new detector-owned path.

## Mesh Algorithm

The mesh is built from nested guide rectangles:

1. Each guide path is canonicalized into top, right, bottom, and left boundaries independent of drawing order. The side boundaries are sampled from the user-edited cubic Bezier paths.
2. The largest rectangle defines the output coordinate space.
3. Inner rectangles are placed in that output space according to their position inside the outer rectangle while preserving their own measured width and height. The rectangles are not assumed to be proportional to each other.
4. The space between each parent rectangle and child rectangle is divided into band patches: top, right, bottom, and left.
5. Mesh lines are drawn through actual rectangle crossings. For example, a vertical grid line crossing an inner rectangle is constrained by outer top, inner top, inner bottom, and outer bottom.
6. `Grid Curve` controls spline tension for the visible mesh lines between those fixed constraints. At `0%`, lines are closest to piecewise-linear interpolation. Higher values smooth the derivative through the inner rectangle perimeter.

The visible grid currently uses a constraint-line spline model:

- Vertical grid lines are built as cubic Hermite splines through corresponding top/bottom crossings of the nested rectangles.
- Horizontal grid lines are built as cubic Hermite splines through corresponding left/right crossings.
- The Hermite tangents are estimated from neighboring rectangle constraints, similar in spirit to Catmull-Rom tangent estimation, so the curve passes through every marked rectangle but avoids sharp derivative changes at inner perimeters.
- Band patches use cubic Hermite cross-curves between corresponding parent/child rectangle edges where a line segment must interpolate from one marked boundary to the next.
- The mesh layout uses transfinite interpolation concepts: hard boundary constraints define the surface, and the interior is interpolated from those boundary curves.

The conceptual target is an elastic sheet model: the marked rectangles are hard constraints, and the mesh estimates a smooth paper surface between them. The current implementation is an approximation rather than a full Euler-elastica solver.

## Dewarp Algorithm

Dewarping is implemented in `python/transform.py`.

The sidecar receives the guide rectangles and builds an output-to-source remap:

- If only one rectangle is available, the app falls back to a standard perspective transform.
- With nested rectangles, the app builds a nested mesh layout from the outer and inner paths.
- For each output pixel, the sidecar finds the mesh patch containing that output coordinate.
- It inverts the patch coordinate with bilinear inversion.
- It evaluates a Coons patch / Coons-style transfinite interpolation to find the corresponding source pixel from the patch boundary curves.
- OpenCV `remap` resamples the original image into the corrected output image.

The Python dewarp path accepts the `Grid Curve` value and applies cubic Hermite cross-curves between corresponding parent/child rectangle edges in band patches. The visible projected mesh also has a newer global constraint-line spline for display. These should be kept aligned as the dewarp engine evolves so the preview mesh and exported image describe the same surface.

Longer term, the intended physical model is closer to a thin-sheet or Euler-elastica-style surface approximation: the user-marked rectangles are fixed observations of the same bent sheet, and the unknown surface between them should minimize abrupt curvature rather than introduce folds.

## Fill Algorithm

Fill runs after dewarp. It is designed for removing clips, clamp shadows, and edge artifacts from the corrected image.

The user draws one or more four-point fill polygons. These masks cannot overlap. When fill runs:

1. The polygon mask is rasterized with OpenCV polygon filling.
2. The mask is expanded outward with morphological dilation so the selected artifact is fully replaced while the blend extends outside the drawn polygon.
3. If a LaMa ONNX model exists at `models/inpainting_lama_2025jan.onnx`, OpenCV DNN runs crop-based LaMa inpainting.
4. If the model is absent or fails, the app uses a sample-texture synthesis fallback.
5. The fallback samples paper texture from a clean band between the outer rectangle and the largest inner rectangle.
6. The sampled patch is color-matched in CIELAB/Lab color space to local surrounding paper.
7. The replacement is composited with outward alpha feathering generated from a distance transform and Gaussian blur.
8. If no sample fallback is available, OpenCV Telea inpainting is used as a final fallback.

Fill previews are written as PNGs under `output/`; final export can apply fill after dewarp.

## Development

Install JavaScript dependencies:

```sh
npm install
```

Install Python dependencies:

```sh
python3 -m venv python/.venv
python/.venv/bin/pip install -r python/requirements.txt
```

Run the app:

```sh
npm run dev
```

## Files And Outputs

- `raw_input/`: ignored input image folder.
- `output/`: generated previews and corrected exports.
- `models/`: optional local model weights, ignored except `.gitkeep`.
- `prd.md` and `plan.md`: local planning documents ignored by git.
- `LICENSE`: MIT license.

## Current Limitations

- The dewarp model is still an approximation of a bent sheet, not a full physical optimization.
- The visible mesh and dewarp remap should be kept in sync as the global constraint-line spline is refined.
- Saved guide paths are stored in local storage by filename, not as sidecar project files.
- Fill is best for edge-adjacent artifacts on paper texture; complex image content under a mask may need manual review.
