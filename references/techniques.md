# How the template works, and why

Contents: 1. Zooming without losing precision · 2. One frame function · 3. The subject surface · 4. Detail that changes with scale · 5. Lighting and shading · 6. Atoms as impostors · 7. Things for scale · 8. Depth of field, bloom, grain · 9. The measurement overlay · 10. Camera · 11. Rendering

All section names refer to the comment banners in `assets/template/main.js`.

## 1. Zooming without losing precision

The film covers 22 mm down to 0.25 nm, a factor of about 10^8. GPU floats carry about 7 digits, so moving a camera towards a point that small turns the picture into noise long before the atoms.

The template never moves the camera closer. The camera stays about 3 units from the origin for the whole film, and the world is rebuilt every frame in **view units**: `view = metres * 2^h / L0`, where `h` is the number of halvings so far and `L0` is the bar length at the start. The focus point (the tip of the edge) is the origin, so scaling around it keeps everything near the camera numerically small. The measurement bar is always exactly 1 view unit long, which is why its number is simply `L0 / 2^h`.

All physical quantities live in JavaScript doubles (metres or nanometres). Only the final, already-scaled view-unit values go to the GPU. When adding anything new, follow the same rule: compute in doubles, send small numbers.

## 2. One frame function

`drawFrame(t)` draws the frame for time `t` and nothing else depends on wall-clock time or on the previous frame. That makes rendering deterministic: any still can be rendered alone, a failed render can resume, and motion blur is just an average of several sub-frames. Keep it that way. If something needs randomness, seed it.

`hAt(t)` maps time to zoom level. In the silent version it is a ramp with eased ends, a hold on the last stage and a fast eased pull-back. For narration, replace it with keyframes taken from word timings.

## 3. The subject surface

The blade is one grid mesh, parametrised by arclength across the cross-section (`SIG`, both flanks) and by position along the edge (`ZS`). Both use power-law spacing, so vertices are dense near the focus point and sparse far away, in view units, at every zoom level.

Each frame `updateWedge(h)` evaluates the physical cross-section `prof(arclength in metres)` at the grid's arclengths divided by the current scale, and writes positions and normals. The profile is the real geometry: a 40 nm radius cap, a 17 degree wedge, a flat 0.1 mm body. Because it is evaluated in doubles at the current scale, the same mesh is a flat plate at the start, a wedge in the middle and a nearly flat hill at the atom scale.

The blade outline and slot at the start are a signed-distance function in millimetres evaluated in the fragment shader, with `discard` outside. It switches off once the frame is entirely inside the blade.

For a new subject, replace `prof()` and the outline function. A flat subject (a chip, a page) is the easy case: a constant profile.

## 4. Detail that changes with scale

`FEATS` is a table of physical surface features: wavelength in metres, type (isotropic roughness, directional lines, crystal grains, atom bumps), strength, and where they apply. Every frame `updateFeatures(h)` converts each wavelength to cycles per view unit and passes on only the ones in a visible band (roughly 0.06 to 900). The fragment shader sums them as a height field and takes two extra samples for the normal.

Two fades make this stable:

- **Coarse end, in JS:** a feature fades out as its wavelength grows past the size of the frame, where it would only tilt the whole picture.
- **Fine end, in the shader:** each feature's weight falls to zero as `frequency * pixel footprint` approaches the Nyquist limit. This is what stops shimmer; it is computed per pixel from screen-space derivatives, so distant parts of the surface lose fine detail first, like a mip-map.

Features with large cells (grains, atom bumps) use a stricter threshold, because a mosaic resolved at 3 pixels per cell looks like dirt.

Edge chipping is separate (`CHIPS`): 1D noise along the edge that lowers the apex in the vertex shader, so the silhouette against black becomes ragged at the micro scale. It is offset so the apex at the focus point never moves, which keeps the bar honest.

Tune by looking at stills. Strengths that look subtle in code look like crumpled foil on screen.

## 5. Lighting and shading

`envMap(direction, roughness)` is an analytic studio: a handful of soft lobes on black, plus one thin strip and a dim floor. There is no texture to load and it is identical every run. Metal is shaded as reflection of this environment times Fresnel, with a small cavity term so grooves read as grooves.

On polished metal the reflection is either inside a light or outside it, so the lobes must fall off smoothly (exponential, not a hard box) or flat surfaces turn solid white. A flat face reflects what is *below* the horizon when the camera is above it; put light there.

Non-metal things (atoms, scale objects) use `diffEnv(normal)`, a few directional terms matching the lobes, scaled well below 1 so colours stay saturated after tone mapping.

## 6. Atoms as impostors

About 270 000 atoms are drawn as instanced quads. The fragment shader intersects the view ray with the sphere, discards misses, shades the hit point and writes its true depth to `gl_FragDepth`. Spheres are therefore perfectly round at any size, cost two triangles each, and intersect each other correctly.

The lattice is real: bcc iron, 0.2866 nm, rotated by a fixed orientation, kept where it lies in a thin shell under the rounded tip. One atom near the focus is shifted so its top is exactly at the origin, which lets the film end with the bar spanning one atom.

Atoms only cover a patch around the focus. Beyond it the mesh carries an atom-like bump texture in matching colours; atoms shrink to nothing towards the patch boundary and the mesh sinks under them inside it. With fog and depth of field the seam does not show.

`projectionMatrix` is not declared automatically in three.js fragment shaders. Declare it yourself when computing depth there.

## 7. Things for scale

Each object has a true size `D` in metres and a position expressed in multiples of that size: resting on or floating beside the subject, a couple of diameters from the focus point. Every frame its mesh is scaled by `D * scale` and placed at `position * D * scale`.

Nothing else animates them. Because they are anchored in physical space, the zoom itself makes each one appear as a dot, grow, slide outward and leave the frame, and that motion is exactly consistent with the surface around it. A name and size are drawn above each object while its on-screen size is between about 0.2 and 1 bar lengths.

Placement rules that came out of testing:

- Sizes at least about 3x apart, so at most two labels are on screen at once.
- Put objects on the far side of the bar from the measurement label.
- When the camera looks along a ridge, objects lined up on the ridge hide each other. Offset alternate ones sideways into empty space.
- Turn long objects (bacteria, DNA, waves) broadside to the camera; end-on they read as blobs.
- Leave sky for them: the subject's top edge should sit near the middle of the frame, not near the top.

Geometry is ordinary three.js primitives merged into one buffer with a per-vertex colour, shaded by one small material with a "kind" switch for surface patterns (hair cuticle, organic mottling) and an emissive term for things that glow.

## 8. Depth of field, bloom, grain

Every material writes linear HDR colour and, in the alpha channel, a blur amount computed from distance to the focal plane. One post pass then gathers 72 samples on a rotated spiral and accepts a sample if its own blur radius reaches the centre pixel. It is not physically exact, but it gives soft foregrounds and backgrounds with one pass and no depth pre-pass, and it works with `discard` and impostors because every material fills in alpha itself.

Dust particles are additive points that leave alpha untouched and size themselves by their own blur amount, so out-of-focus specks become bokeh discs. They move radially at the zoom rate and wrap, which is most of what makes the zoom feel like travel.

After that: a restrained bloom, ACES tone mapping, a vignette and a little grain. Grain hides banding in dark gradients but costs bitrate.

The final image is drawn into a 2D canvas at output size (the WebGL canvas is 1.5x larger, which is the anti-aliasing), and the overlay is drawn on top with ordinary canvas text.

## 9. The measurement overlay

The bar is two 3D points, the focus point and one view unit below it, projected to the screen each frame. The number is formatted to three significant figures with the unit switching by magnitude. The label sits in the black above the subject rather than beside the bar, because text over bright detailed metal is unreadable even with a shadow.

`LABELS` gives the words for each range of zoom level, cross-faded at the boundaries.

## 10. Camera

Azimuth, elevation, look-at height, distance and aperture are small keyframe tables indexed by zoom level `h`, not by time, so retiming the film never breaks the framing. A slow sine drift on top keeps holds alive. The move that matters: start as a face-on product shot, swing to look along the surface so the subject becomes a landscape with a horizon, and swing further along the ridge at the stage where its rounded shape is the point.

## 11. Rendering

`render.mjs` serves the folder over localhost (ES modules do not load from `file://`), launches headless Chrome with GPU flags, waits for `window.READY`, then calls `window.frame(t)` for each frame, receives a JPEG data URL and pipes the bytes into ffmpeg. Page console output is forwarded, which is the only place shader compile errors appear.

During the pull-back each output frame is the average of ten sub-frames, which gives real motion blur for the part of the film that moves fastest.
