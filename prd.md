# Serigraph Geometry Correction App Requirements

## Purpose

Build a desktop application that corrects geometric distortion in photographed serigraphs and similar rectangular artwork. The application should detect the paper boundary and print boundary, allow the user to correct those boundaries, and generate a flattened, cropped, rotation-corrected output suitable for cataloging, sharing, archiving, or further editing.

The application is not intended to be a general-purpose photo editor. It is a constrained geometry correction tool for artwork photographed under imperfect real-world conditions: handheld camera position, slight page curvature, easel angle, wind movement, sunlight, shadows, and non-flat paper.

## Problem

Photographing serigraphs, posters, documents, and prints often produces geometric distortion even when the image quality is otherwise acceptable. Common issues include:

- The camera is not perfectly square to the artwork
- The paper is not perfectly flat
- The print may be bowed or warped due to wind or handling
- The outer paper edge and inner print edge are visible but not perfectly straight in the photo
- Existing free tools can correct simple perspective but do not provide a guided, repeatable workflow for artwork with both outer and inner rectangular constraints
- Manual correction in graphics software is tedious, inconsistent, and difficult to apply across batches

The key observation is that most target images contain two known rectangular structures:

1. The outer edge of the paper
2. The inner edge of the printed image or plate mark

In the corrected output, both structures should be straight, parallel, and rectangular. The software should use those visible boundaries as geometric constraints.

## Goals

- Correct perspective distortion from handheld or off-axis photography
- Correct mild local warping caused by non-flat paper or wind movement
- Detect outer paper edges and inner print edges automatically when possible
- Let the user quickly repair failed edge detection
- Crop the output to the corrected outer paper rectangle
- Preserve as much image quality as possible during resampling
- Support batch workflows for many images from the same photo session
- Keep the workflow faster than correcting each image manually in Lightroom, Photoshop, GIMP, or similar tools
- Support a future web version, but optimize the first version for desktop file workflows

## Non-goals

- Replacing Lightroom, Photoshop, GIMP, or darktable as a general photo editor
- Full color correction, retouching, masking, healing, or compositing
- True 3D reconstruction of paper shape
- Perfect archival-grade correction from a single distorted image
- Automatic correction of severely folded, wrinkled, occluded, or motion-blurred artwork
- Automatic removal of glare, shadows, or specular highlights
- RAW development as a primary feature in the first version

## Target users

### Primary user

A person photographing physical prints, serigraphs, posters, documents, or flat artwork in imperfect conditions who wants corrected images without paying for Lightroom or manually deforming each image in a graphics editor.

### Secondary users

- Artists digitizing their own work
- Galleries or small archives photographing works informally
- Sellers preparing product images for online listings
- Designers documenting physical prints
- Researchers or collectors digitizing paper-based visual material

## Primary workflow

1. User opens a folder or imports a set of image files
2. App displays the first image and runs automatic detection
3. App proposes:
   - Outer paper boundary
   - Inner print boundary where detectable
   - Corrected crop preview
   - Warp mesh preview
4. User zooms into boundary points and edges, then accepts, adjusts, or redraws boundary constraints
5. User adds optional straight-line constraints inside the artwork if they would help guide dewarping
6. User selects global correction preferences such as dewarping strength, mesh density, and smoothing
7. App generates corrected preview for the current image
8. User accepts or edits the correction for each image individually
9. App runs detection, preview generation, and final export across multiple images where useful
10. App exports corrected files to a chosen output folder
11. App preserves correction settings in sidecar files so work can be reopened later

## Core objects

### Image

An imported source file. The app should initially optimize for JPEG input because the expected working files are large DSLR JPEGs.

Initial input support:

- JPEG
- PNG if low-complexity to support

Deferred input support:

- RAW
- TIFF
- HEIC

RAW support is not required for the first version unless RAW materially improves detection or output quality. If RAW files are supported later, the app should use an existing raw development library rather than building raw processing from scratch.

### Boundary

A detected or user-defined edge of a rectangular structure. There are two boundary groups:

- Outer paper boundary
- Inner print boundary

Each boundary group contains four sides:

- Top
- Right
- Bottom
- Left

Each side may be represented as:

- Straight line
- Polyline
- Smooth curve fitted from points
- User-painted edge region converted into a fitted curve

### Mesh

A geometric grid projected across the source image, then mapped to a corrected rectangular coordinate system.

The mesh should support adjustable resolution and smoothing. Higher mesh resolution allows more local correction but increases the risk of overfitting.

### Correction profile

A saved set of detection, boundary, crop, mesh, and export settings associated with one image.

Correction geometry is per image because every photographed serigraph may have a different shape, angle, curl, and degree of local distortion. Batch workflows should not assume that a transformation from one image can be reused directly on another.

Global settings may still apply across a folder or project, including:

- Dewarping strength
- Mesh density
- Smoothing level
- Export format
- Export quality
- Detection sensitivity

Correction profiles should be stored as sidecar JSON files so source images remain untouched.

## Functional requirements

### Import and file handling

- User can import individual images
- User can import an entire folder
- User can navigate imported images in sequence
- User can see source filename and basic metadata
- User can choose an output folder
- User can choose output format: JPEG, with PNG support if low-complexity
- User can choose whether to overwrite existing exports, rename automatically, or skip existing files
- Source files must never be modified

### Automatic edge detection

The app should attempt to detect two rectangular structures:

1. Outer paper edge
2. Inner print edge

The detection engine should identify candidate edges using image gradients, contrast boundaries, line detection, and geometric consistency. The first implementation should use classical computer vision before introducing machine-learning models.

The detector should output:

- Four candidate outer sides
- Four candidate inner sides where visible
- Confidence score per side
- Confidence score per rectangle
- Whether a side appears straight, curved, broken, or ambiguous

The app should not require both rectangles to be detected. It should still operate with:

- Outer rectangle only
- Inner rectangle only
- Three detected sides plus one inferred side
- Manual boundaries only

### Manual boundary correction

The user must be able to override automatic detection quickly.

Required tools:

- Pinch zoom and trackpad-friendly zoom
- Pan while zoomed
- Drag corner points
- Drag side control points
- Add control points to a side
- Delete control points from a side
- Mark a detected side as wrong
- Redraw a side manually as a line or polyline
- Paint over an area to tell the detector where to search for an edge
- Lock a side so it is not changed by future detection passes
- Reset one side, one rectangle, or all boundaries

The user must be able to zoom tightly into points and edges before placing or adjusting them. Precise correction will fail if point placement feels clumsy.

The manual correction workflow should favor speed over precision-drawing complexity.

### Supplemental straight-line constraints

The user should be able to add internal straight-line constraints when visible artwork features are known to be straight. This is useful when the border geometry alone is not enough to guide dewarping.

Required behavior:

- User can draw a straight-line constraint using pen-tool-like interaction
- User can mark whether the line should be horizontal, vertical, or simply straight in the corrected output
- User can edit line endpoints after placement
- User can delete a supplemental line
- User can set line influence or allow the app to infer a conservative influence

These internal constraints should guide local dewarping but should not overpower the outer paper boundary. They are advisory geometry, not arbitrary retouching tools.

### Edge refinement

After the user marks or paints an approximate edge region, the app should refine the side by searching locally for the strongest plausible edge.

Refinement should consider:

- Local contrast
- Continuity
- Smoothness
- Expected rectangular geometry
- Parallelism between opposite sides
- Consistency between outer and inner rectangles

The user should be able to adjust how strongly the app follows detected edge detail versus smoothing the edge.

### Perspective correction

The app should compute a global perspective correction from the outer paper rectangle when available. The outer rectangle is the primary reference because it is likely to show the greatest visible deformation and therefore provides the strongest evidence about the paper’s true photographed shape.

If the outer paper rectangle is not available, the app may use the inner print rectangle.

The corrected coordinate system should make the chosen reference rectangle:

- Rectangular
- Horizontally and vertically aligned
- Properly cropped
- Proportionally scaled according to user settings

The app should provide an option to preserve the detected aspect ratio or use a manually specified aspect ratio. Known physical paper size is not expected and should not be required. Paper dimensions may be variable and non-standard, but the final corrected shape should always be rectangular.

### Local dewarping

The app must support local dewarping beyond simple perspective correction. Dewarping is a core product requirement, not a later optional enhancement.

The local warp should use boundary constraints from the outer paper edge, inner print edge, and any supplemental straight-line constraints provided by the user. The engine should interpolate the interior geometry smoothly, rather than allowing arbitrary local distortion.

Required modes:

- Perspective only
- Gentle flatten
- Standard flatten
- Aggressive flatten
- Custom mesh settings

Custom mesh settings should include:

- Horizontal mesh divisions
- Vertical mesh divisions
- Warp smoothing
- Boundary-follow strength
- Inner-rectangle influence
- Maximum local displacement limit

The default mode should be conservative enough to avoid obvious artifacts, but the MVP must still include a practical dewarping path. The app should avoid inventing correction from weak evidence.

### Preview

The app should provide a live or near-live preview of correction results.

Preview requirements:

- Toggle source image
- Toggle corrected image
- Overlay detected boundaries
- Overlay mesh
- Show crop area
- Show before/after comparison
- Zoom and pan
- Fit-to-screen view
- 100% view

For performance, preview may use a lower-resolution proxy image. Final export should use full-resolution source data.

### Batch processing

The app should support batch processing because the main use case involves many images from the same photo session. However, batch processing should not imply that the same transformation is reused across images. Each image will usually have a different shape, perspective, curl, and degree of deformation.

Batch requirements:

- Run automatic detection across multiple images
- Generate previews across multiple images
- Export multiple accepted images
- Apply global detection and dewarping preferences across a project
- Apply global export settings across a project
- Queue multiple images for export
- Show batch progress
- Flag images with low-confidence detection for user review
- Allow user to process only accepted images

Correction geometry should remain per image. Batch value comes from automating detection, preview generation, review triage, and export, not from repeating the same warp.

### Export

The app should export corrected images using the selected crop and warp.

Export requirements:

- JPEG export with quality setting
- PNG export if low-complexity
- No TIFF requirement for the first version
- Preserve or write selected metadata where possible
- Append suffix to filename by default, such as `_corrected`
- Optionally export sidecar JSON correction profile
- Optionally export preview image with mesh overlay for quality review

### Project persistence

The app should allow the user to close and reopen work without losing manual corrections.

Minimum persistence requirements:

- Save imported image list
- Save detected and edited boundaries
- Save mesh/correction settings
- Save crop and aspect-ratio settings
- Save export settings
- Save per-image status: unreviewed, accepted, needs review, exported

A simple project file plus per-image sidecar JSON is acceptable.

## Image-processing requirements

### Detection pipeline

Initial detection should likely follow this sequence:

1. Load image and create downsampled working copy
2. Correct orientation from metadata
3. Optionally apply lens correction if metadata/profile is available
4. Convert to luminance or suitable color space
5. Enhance edge visibility using local contrast or gradient methods
6. Detect candidate edges
7. Cluster candidate edges into four-sided structures
8. Score candidate rectangles based on geometry and confidence
9. Identify likely outer and inner rectangles
10. Fit each side as a line, polyline, or smoothed curve
11. Present result to user

### Geometry model

The correction engine should support at least two geometric stages:

1. Global homography for perspective correction
2. Local mesh warp for mild paper deformation

The global homography maps the selected source rectangle to a clean output rectangle.

The local mesh warp should interpolate from detected boundary curves into a regular rectangular output grid. It should preserve smoothness and avoid abrupt local distortions.

Possible approaches:

- Piecewise bilinear mesh warp
- Triangulated mesh warp
- Thin-plate spline interpolation
- Coons patch interpolation from boundary curves

The first implementation should prioritize robustness and debuggability over theoretical elegance.

### Aspect ratio handling

The app should support multiple aspect-ratio modes:

- Use detected outer paper aspect ratio
- Use detected inner print aspect ratio
- Enter manual aspect ratio
- Choose from saved presets
- Unlock aspect ratio and allow free correction

Known physical paper size should not be required. Paper size may be variable and non-standard, but the output should still be rectified to a clean rectangle.

### Quality constraints

The app should preserve visual quality as much as possible.

Requirements:

- Use high-quality interpolation for final export
- Avoid repeated destructive resampling
- Always calculate final export from original source image, not from prior previews
- Avoid excessive sharpening or contrast modification unless explicitly added later
- Do not alter color unless required for detection preview only
- Preserve as much source quality as practical from large JPEG inputs
- Allow smaller exported files when acceptable, with a target range that can reasonably reduce large source JPEGs while maintaining visual fidelity

## User interface requirements

### Main layout

The desktop interface should include:

- Image browser or filmstrip
- Main image canvas
- Right-side correction panel
- Bottom or side batch status area
- Export controls

### Canvas interactions

The image canvas should support:

- Pan
- Zoom
- Fit to view
- 100% view
- Drag corners
- Drag side points
- Add/delete control points
- Paint edge hints
- Toggle overlays
- Switch between source and corrected preview

### Correction panel

The correction panel should include:

- Detection confidence status
- Boundary group selection: outer paper, inner print
- Edge tools: detect, refine, redraw, lock, reset
- Correction mode: perspective only, gentle, standard, aggressive, custom
- Mesh density settings
- Smoothing settings
- Aspect ratio settings
- Crop settings
- Export settings

### Status and error handling

The app should communicate uncertainty clearly.

Examples:

- “Outer paper detected, inner print uncertain”
- “Top edge confidence low”
- “Manual review recommended”
- “Export complete”
- “Source file missing”
- “Image too small for reliable detection”

## Performance requirements

The app should feel interactive on modern consumer laptops.

Initial targets:

- Load common JPEG images within a few seconds
- Run initial detection on a typical DSLR image within several seconds
- Generate preview updates quickly enough for iterative editing
- Use proxy-resolution previews when full-resolution processing would be slow
- Export full-resolution corrected images in batch without blocking the interface completely

Performance should be measured separately for:

- Import
- Detection
- Preview update
- Final export
- Batch export

## Platform requirements

Initial platform target:

- macOS desktop

Preferred future support:

- Web version for smaller files or browser-based workflows

Windows should be supported through the future web version if needed. There is no requirement for a native Windows application.

The architecture should avoid assumptions that make future web deployment impossible, but the first version should optimize for macOS desktop file access and local processing.

## Suggested technical architecture

### First prototype

- Python
- OpenCV
- Simple desktop UI or notebook-style prototype
- Local files only
- Manual four-corner correction plus early boundary detection

### Production desktop candidate

- Tauri or Electron for desktop shell
- React for UI
- OpenCV-based processing engine
- Python backend for faster experimentation, or Rust/C++ backend for packaged performance
- Sidecar JSON for correction profiles

### Future web version

- Browser UI with WebAssembly processing, or server-side processing
- Drag-and-drop image upload
- Same correction-profile schema where possible
- Reduced batch ambitions unless local file system access is available

## MVP scope

The first useful version should include:

- Import folder of images
- Display image canvas
- Automatic outer rectangle detection
- Manual corner dragging
- Trackpad-friendly pinch zoom and pan
- Four-point perspective correction
- Conservative local dewarping
- Mesh overlay
- Crop to corrected outer rectangle
- JPG export with quality setting
- Basic batch detection, review, and export
- Save sidecar JSON settings

Dewarping should be included in the MVP because it is the main reason to build the tool instead of using an existing perspective-correction editor.

## MVP plus scope

After the MVP works reliably, add:

- Inner print rectangle detection
- Manual side drawing and edge hint painting
- Curved side fitting improvements
- Supplemental straight-line constraints inside the artwork
- Batch review queue based on confidence
- Aspect-ratio presets
- PNG export if not already included

## Later scope

Potential later features:

- RAW support if it materially improves detection or export quality
- Lens profile correction
- Color calibration card support
- Glare/shadow reduction tools
- Automatic background removal outside paper edge
- Export to web gallery or catalog format
- Cloud/web version
- Machine-learning edge detector trained on user-labeled examples
- OCR/document mode for text-heavy materials

## Success criteria

The app is successful if:

- A user can correct a typical photographed serigraph faster than using a general image editor
- The corrected output looks rectangular, cropped, and visually natural
- Mild paper curvature is improved without obvious artifacts
- The user can fix failed detection in under a minute per image
- Batch correction reduces total processing time across a photo session
- The app avoids destructive edits and allows work to be reopened later

## Risks

### Detection reliability

Real-world images may contain shadows, texture, design elements, glare, and weak paper contrast. Automatic detection may fail often without good manual correction tools.

### Overcorrection

Aggressive mesh warping may introduce artifacts or distort the artwork itself. The default correction should be conservative.

### False geometric assumptions

The app can make borders straight, but it cannot know the true interior geometry of a warped sheet from a single image unless there are enough constraints. This should be handled honestly in the product design.

### Performance on large images

DSLR images can be large. The app should use proxy previews and defer full-resolution processing until export.

### UI complexity

The difference between line, curve, mesh, crop, and warp controls may confuse users. Presets should hide complexity by default.

## Open questions

- Does RAW materially improve edge detection or final output quality enough to justify first-version support?
- How should the app measure acceptable visual quality loss when exporting from large source JPEGs?
- What default JPEG quality setting best balances visual fidelity and file size?
- Should PNG export be included in the first version or deferred?
- How much influence should supplemental straight-line constraints have over the dewarp mesh?
- What is the right default balance between dewarping strength and artifact avoidance?
- Should global dewarp settings be stored per project, per folder, or as reusable presets?

## Recommended build sequence

1. Build a Python/OpenCV prototype for four-corner perspective correction
2. Add automatic outer rectangle detection
3. Add manual corner and side adjustment with strong zoom/pan interaction
4. Add conservative mesh dewarping from outer boundary geometry
5. Add full-resolution JPG export from original image
6. Add folder import and batch detection/export
7. Add sidecar correction profiles
8. Add inner rectangle detection
9. Add curved edge fitting
10. Add supplemental straight-line constraints
11. Wrap in macOS desktop UI

The key engineering principle is to make the manual correction path excellent while still including practical dewarping early. Automatic detection will fail in real-world image sets. The product wins if failure recovery is fast, predictable, and less painful than using a general-purpose graphics editor.

