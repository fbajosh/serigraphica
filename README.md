# Serigraphica

Serigraphica is an Electron desktop app for correcting photographs of serigraphs, prints, and other rectangular artwork shot while clipped to a board or easel. The app is built around manual guide geometry: the user marks the visible paper/artwork boundaries, then the software projects a mesh, dewarps the image, optionally fills clip/shadow regions, and exports a corrected image.

The current implementation is intentionally local-first:

- Renderer: React + canvas in `src/renderer`.
- Shell: Electron in `electron`.
- Image processing: Python sidecar using OpenCV/NumPy in `python`.
- Outputs: generated previews and exports are written under `output/`.

## Workflow

1. Open or drag an image into the app.
2. Use `Draw` to mark rectangles. Draw one outer rectangle and one or more nested inner rectangles. Each rectangle is four corners first, then optional side nodes/Bezier handles can refine curved sides.
3. Review the mesh. The largest rectangle is treated as the outer guide; smaller non-overlapping rectangles are treated as inner guide constraints.
4. Adjust `Grid Density` for visual mesh resolution and `Grid Curve` for visible mesh-line smoothing through nested constraints.
5. Run `Dewarp` to preview the corrected image.
6. Optionally use `Fill` after dewarp to draw four-point masks around clips, clamp shadows, or other edge artifacts.
7. Export to `output/<original>_corrected.jpg` or choose a path with `Export As`.

Guide paths are saved in browser local storage, keyed by image filename, so reopening the same filename reloads the saved rectangles.

## Guide Editing

The guide model is a set of manually drawn rectangle paths:

- `Draw` mode starts a new rectangle by clicking four corners.
- Completed rectangles can be edited by dragging corner nodes.
- Clicking an existing side inserts a side node.
- Side nodes have symmetric handles for Bezier-style curve editing.
- Right-clicking a side node deletes it. Corner nodes are protected.
- The largest rectangle by area is automatically classified as the outer guide.
- Smaller rectangles are automatically classified as inner guide constraints.
- Rectangles are assumed to be nested, non-overlapping, non-proportional, and physically parallel counterparts on the same sheet.

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
