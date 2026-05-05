# Serigraphica Implementation Plan

This plan captures the next build sequence for the manual rectangle, mesh, dewarp, and fill workflow. Do not update `prd.md` as part of this work unless explicitly requested.

## Core Model

The user draws one or more closed rectangles on a photograph of a real physical sheet of paper. These rectangles are not loose suggestions. They are fixed slices through the same continuous paper surface.

Required interpretation:

- The largest rectangle is the outer paper boundary.
- Every smaller rectangle is an interior slice of the same paper surface.
- Rectangles are not expected to be proportional to each other. An inner rectangle can be more square while the outer rectangle is more rectangular, and that difference is real input data, not an error to normalize away.
- Rectangles are concentric in the physical sense: smaller slices sit inside larger slices and cannot overlap or cross.
- Each rectangle edge corresponds to the matching edge of every other rectangle: top maps to top, right to right, bottom to bottom, left to left.
- Rectangle drawing order and winding direction must not matter. Clockwise, counter-clockwise, or arbitrary first corner should resolve to the same canonical top/right/bottom/left edge assignment.
- Inner rectangles must be hard positional constraints, not low-weight guides.
- Inner rectangles must retain their own target aspect and relative dimensions in the dewarped coordinate system. Do not derive an inner target rectangle by taking the outer rectangle and applying a proportional inset.
- The final mesh must be one smooth field across the paper. It cannot be a separate inner warp pasted into an outer warp.
- Mesh cells must never fold, overlap, swirl, or cross. If the generated mesh violates this, the app should fail visibly instead of exporting a bad image.

## Phase 1: Dewarp Geometry Reset

Goal: replace the current soft-weighted TPS behavior with a deterministic nested-ring mapping that respects every rectangle as a hard constraint.

### Current Issue

The current dewarp appears to:

- Rotate the output depending on path order or inferred corner order.
- Undervalue inner rectangles because their constraints are weighted lower than outer constraints.
- Allow grid lines to cross or swirl, especially when rectangles are drawn with different winding directions.
- Treat inner rectangles as shape hints instead of exact measurements.

### Target Algorithm

Implement a canonical rectangle normalization step before mesh generation.

1. Derive outer rectangle by largest area.
2. Canonicalize the outer rectangle corners to `top-left`, `top-right`, `bottom-right`, `bottom-left` by location, not by click order.
3. Build an outer reference frame from the canonical outer rectangle.
4. For each smaller rectangle:
   - Transform its corners into the outer reference frame.
   - Sort corners into `top-left`, `top-right`, `bottom-right`, `bottom-left`.
   - Reassign its sides to canonical `top`, `right`, `bottom`, `left`.
   - Preserve side nodes and handles by assigning each segment to the nearest canonical side, rather than assuming the original node order is meaningful.
5. Sort rectangles by area descending: outer, inner 1, inner 2, etc.
6. Validate nesting:
   - Each smaller rectangle must be inside the previous larger rectangle.
   - Rectangles must not overlap each other except by containment.
   - Each canonical side must remain ordered relative to its counterpart.
7. Construct target-space rectangles independently, not as proportional copies:
   - The outer target rectangle defines the output canvas orientation and gross bounds.
   - Each inner target rectangle gets its own width/height from its measured physical edge lengths, not from the outer rectangle's aspect ratio.
   - Each inner target rectangle gets its target position from its canonical location inside the outer reference frame.
   - Preserve the fact that an inner rectangle may be more square or more rectangular than the outer rectangle.
   - Clamp only enough to maintain nesting and non-overlap; do not force matching proportions.
8. Generate the mesh as bands between consecutive rectangles:
   - Band 0: outer to inner 1.
   - Band 1: inner 1 to inner 2.
   - Continue until the smallest inner rectangle.
   - Optionally fill the center region inside the smallest rectangle as its own rectangular patch.
9. For each band, interpolate between matching sides:
   - Top-to-top, right-to-right, bottom-to-bottom, left-to-left.
   - Sample both side curves at matching normalized arc-length parameters.
   - Use a Coons-style patch per band so the mesh hits both boundaries exactly.
10. Smooth transitions between bands:
   - Boundaries shared by adjacent bands must be identical.
   - Derivatives should be damped/smoothed enough to avoid visible kinks, but never at the cost of missing a user-entered rectangle.
11. Add foldover validation:
   - Compute signed area for every mesh quad.
   - All cells must preserve the same orientation.
   - Reject or warn if any cell has near-zero area or opposite sign.

### Non-Proportional Rectangle Handling

This is a core requirement. The mesh must not assume that an inner rectangle is a scaled-down version of the outer rectangle.

Correct behavior:

- Use each rectangle's own measured side lengths to determine its target dimensions.
- Use canonical position inside the outer frame only to place the target rectangle, not to resize it proportionally.
- If an inner rectangle is more square than the outer rectangle, the dewarped result should keep it more square.
- The area between outer and inner rectangles must absorb that shape difference smoothly through the mesh.

Incorrect behavior:

- Computing inner target width as `outerWidth * normalizedInnerWidth`.
- Computing inner target height as `outerHeight * normalizedInnerHeight`.
- Forcing inner and outer aspect ratios to match.
- Treating differences between inner and outer proportions as warp error.

### Important Detail: Output Orientation

Dewarp must not rotate the image unexpectedly.

Use the canonical outer frame as the output orientation:

- Output top edge corresponds to the physical top edge of the outer rectangle in the original image.
- Output right edge corresponds to the physical right edge.
- First clicked point, path winding, and side-node order must not rotate the output.

### Implementation Areas

Likely files:

- `src/renderer/components/Canvas.tsx`
- `src/renderer/App.tsx`
- `src/shared/types.ts`
- `python/transform.py`
- `python/sidecar.py`

Recommended shared concepts:

- `CanonicalRectPath`
- `CanonicalSide`
- `CanonicalRectangleSet`
- `normalizeRectangles(rectangles)`
- `validateNestedRectangles(canonicalSet)`
- `buildNestedRingMesh(canonicalSet, density)`
- `validateMeshNoFoldovers(mesh)`

Keep the JS preview mesh and Python export mesh mathematically aligned. If one changes, the other should change in the same way.

### Acceptance Criteria

- Dewarp output does not rotate when the same rectangle is drawn from a different starting corner.
- Dewarp output does not swirl when one rectangle is clockwise and another is counter-clockwise.
- Mesh lines never cross for valid nested rectangles.
- Every drawn rectangle edge is hit exactly by the mesh.
- Inner rectangles are visibly respected as hard constraints.
- Inner rectangles remain smaller than the outer rectangle while preserving their own aspect/dimensions rather than being forced into the outer rectangle's proportions.
- Invalid rectangle layouts fail with a clear status message rather than producing a corrupted preview/export.

## Phase 2: Mesh and Top Bar UI

Goal: make mesh visibility and drawing workflow match the current intended use.

### Mesh Defaults

- Mesh should default to visible once the first rectangle is completed.
- Mesh should update live as rectangles, nodes, or handles move.
- Mesh button label should be dynamic:
  - `Hide Mesh` when mesh is visible.
  - `Show Mesh` when mesh is hidden.
- If the dewarp preview is active and the user clicks Mesh, return to the original image with mesh visible. This should behave like pressing Dewarp again, but specifically returns to the mesh screen.

### Add/Pan Workflow

Remove the separate `Pan` button from the top bar.

Use one dynamic button:

- Shows `Add` when not actively adding a rectangle.
- Shows `Pan` when Add mode is active.
- Clicking `Add` enters rectangle-add mode.
- Clicking `Pan` exits add mode and returns to pan/edit mode.

### Save/Reset

Top bar order for this cluster:

- `Add` / `Pan`
- `Reset`
- `Save`

`Reset` resets all rectangles. `Save` saves current paths by filename.

### Dewarp Button Width

The Dewarp button should have two width states:

- Compact width for `Dewarp`.
- Wider width for `Dewarping...NN%`.

Do not permanently reserve the wider progress width when the button simply says `Dewarp`.

### Acceptance Criteria

- Completing the first rectangle turns mesh on.
- Mesh button says exactly what clicking it will do.
- Add/Pan is one button and does not leave the user trapped in add mode.
- Save works from the top bar.
- Dewarp button only expands during active dewarp progress.

## Phase 3: Saved Paths Behavior

Goal: remove manual debug-path loading friction.

### Open Image Behavior

When an image opens:

1. Determine filename.
2. Check saved paths by filename.
3. If saved paths exist, load them automatically.
4. If image dimensions differ from the saved metadata, still load but show a warning in status/debug info.

### Right Panel Cleanup

Remove:

- `Load` button.
- `Delete` button.

Keep:

- Saved path metadata display.
- Current rectangle count.
- Saved rectangle count.
- Saved timestamp.
- Size metadata.
- Last save/load status.

### Acceptance Criteria

- Opening a previously saved image restores its paths without pressing Load.
- User can save updated paths from the top bar.
- There is no Delete button for saved paths.
- Right panel still provides enough debug visibility to know what was loaded.

## Phase 4: Cancelable Dewarp

Goal: clicking the progress-state Dewarp button cancels the active dewarp.

### Behavior

- During dewarp, the button reads `Dewarping...NN%`.
- Clicking it cancels the operation.
- After cancel:
  - Return to original image/mesh view.
  - Clear dewarp progress.
  - Set status to `Dewarp cancelled`.
  - Keep rectangles and mesh unchanged.

### Practical Implementation

The current Python sidecar dewarp is a blocking CPU operation. The simplest reliable cancel path is:

1. Add a cancel command in Electron.
2. If a dewarp is active, kill/restart the sidecar process.
3. Reject the pending sidecar call with a cancellation error.
4. Renderer catches that error and treats it as user cancellation, not failure.

Later improvement:

- Add cooperative cancellation inside Python map generation.
- That requires the sidecar to process cancel requests while dewarp is running, likely through threading, multiprocessing, or a separate worker process.

### Acceptance Criteria

- Clicking `Dewarping...NN%` stops the operation.
- The app remains usable after cancel.
- A later dewarp can be started without restarting the app.
- Cancel does not clear rectangles or saved paths.

## Phase 5: Zoom Limit

Goal: allow closer inspection while editing nodes and fill masks.

Tasks:

- Find the current max zoom clamp in `Canvas`.
- Double the maximum zoom.
- Ensure all zoom paths use the same limit:
  - Wheel/trackpad zoom.
  - Button-driven zoom.
  - Programmatic zoom helpers.

Acceptance criteria:

- User can zoom in twice as far as before.
- Fit and 100% still work.
- Panning remains stable at max zoom.

## Phase 6: Fill Feature

Goal: allow the user to mask clips, clamps, and shadows along the paper edge, then fill those regions with plausible canvas-paper texture before dewarp.

### Model Choice

Use the OpenCV Hugging Face LaMa package instead of the original full PyTorch LaMa repository:

- Repository: `https://huggingface.co/opencv/inpainting_lama`
- Model file: `inpainting_lama_2025jan.onnx`
- Python wrapper uses OpenCV DNN with `cv.dnn.readNetFromONNX`.

This is likely simpler than integrating `advimman/lama` because it avoids the full PyTorch/Hydra project. Caveat: the Hugging Face README indicates OpenCV `>=5.0.0`; the current local venv has OpenCV `4.13.0`. Verify compatibility early. If OpenCV 4.13 cannot run the ONNX model, use ONNX Runtime or upgrade/build OpenCV 5.

### Fill Use Case

The input image is a photograph of a serigraph: silkscreen ink on off-white canvas paper clipped to a board/easel. The user marks clips, clamps, and shadows to remove. These regions are usually near the edge of the sheet:

- One side of the masked area may touch the image edge.
- The other sides are surrounded by off-white textured canvas.
- Clips may be white but include shadows and hard metal edges.

### UI

Add a `Fill` section to the right panel.

Controls:

- `Add`
- `Reset`
- `Fill` / `Unfill` / `Refill`

Shape behavior:

- User clicks `Add`, then clicks four points to define a polygon.
- No bezier handles.
- No protected corners.
- Right-click deletes points.
- Once four points are placed, the shape is complete.
- Clicking again after completion starts another shape when Fill Add mode is active.
- Unlimited shapes are allowed.
- Shapes cannot overlap.
- `Reset` removes all fill shapes and clears fill preview.

Button state:

- `Fill`: no fill has been run yet.
- `Unfill`: fill has been applied and no shapes changed.
- `Refill`: fill was applied, then user moved, added, or removed fill shapes.

### Data Model

Add types:

- `FillPoint = [number, number]`
- `FillShape = { points: [FillPoint, FillPoint, FillPoint, FillPoint] }`
- `FillState = 'empty' | 'dirty' | 'filled'`

Renderer state:

- `fillShapes`
- `draftFillPoints`
- `fillModeActive`
- `filledImage`
- `fillState`

### Image Pipeline

Fill should happen before dewarp.

Pipeline:

1. Original loaded image.
2. Optional filled image generated from fill masks.
3. Mesh/dewarp operates on the filled image when present.
4. Export uses filled image when present.

This keeps rectangle coordinates stable because filling does not alter dimensions.

### Mask Generation

Python sidecar should:

1. Read original image.
2. Rasterize fill polygons into a binary mask.
3. Optionally dilate/feather the mask slightly to remove hard clip edges and shadows.
4. Run LaMa inpainting.
5. Return a same-size filled preview image.

For performance and texture quality:

- Prefer crop-based inpainting around each mask or connected mask group.
- Expand crop bounds by a generous margin so the model sees enough canvas texture.
- Composite the filled crop back into the full image.
- Avoid resizing the entire source image to 512x512 if possible, because that may soften paper grain.

### Sidecar API

Add methods:

- `preview_filled`
- `export_filled` if needed, though preview output can also be used as the active image source.

Parameters:

- `path`
- `fill_shapes`
- `output_path`
- optional model path/settings

Return:

- `outputPath`
- `outputWidth`
- `outputHeight`

### Model Storage

Recommended:

- Add `models/` to `.gitignore`.
- Add `models/.gitkeep` if the folder should exist.
- Store `inpainting_lama_2025jan.onnx` locally but do not commit the 92 MB model.
- Add clear error messaging if the model is missing.

Do not add automatic network downloading until explicitly requested. The app can first report the required model path and expected filename.

### Acceptance Criteria

- User can draw multiple four-point fill masks.
- Right-click deletes fill points.
- Fill masks cannot overlap.
- Fill preview replaces clips/shadows without changing image dimensions.
- `Unfill` restores the original image.
- Editing fill shapes after filling changes button to `Refill`.
- Dewarp/export use the filled image if Fill is active.
- Missing model produces a clear, actionable error.

## Phase 7: Verification Strategy

### Unit/Smoke Tests

Add or run checks for:

- Rectangle canonicalization with clockwise and counter-clockwise inputs.
- Same rectangle from different starting corners.
- Nested rectangle validation.
- Mesh foldover detection.
- Fill polygon overlap detection.
- Sidecar dewarp progress and cancel behavior.

### Manual Tests

Use saved outlines and representative raw input images.

Test cases:

- One outer rectangle only.
- Outer plus one inner rectangle.
- Outer plus multiple inner rectangles.
- Inner rectangles drawn in opposite winding order from outer.
- Rectangles drawn from different first corners.
- Highly warped but valid nested rectangles.
- Invalid overlapping rectangles.
- Dewarp cancel at early and late progress.
- Fill before dewarp.
- Unfill/refill cycle.

### Commands

Run after each major phase:

```sh
npm run typecheck
python/.venv/bin/python3 -m py_compile python/sidecar.py python/transform.py
npm run build
git diff --check
```

For Python algorithm changes, add a direct smoke script that constructs synthetic nested rectangles, generates a dewarp output, and asserts:

- output dimensions are positive,
- progress reaches 100%,
- mesh validation has no foldovers,
- canonicalization is invariant to winding/start point.

## Suggested Build Order

1. Implement rectangle canonicalization and validation.
2. Replace preview mesh with nested-ring mesh.
3. Replace Python dewarp mesh with the same nested-ring algorithm.
4. Add foldover detection and visible error handling.
5. Update mesh/top-bar UI and saved-path behavior.
6. Add cancelable dewarp.
7. Increase max zoom.
8. Add Fill shape drawing UI.
9. Add Fill sidecar mask generation.
10. Integrate OpenCV LaMa/ONNX fill.
11. Connect filled image into dewarp/export pipeline.
12. Final manual testing across real saved outlines.
