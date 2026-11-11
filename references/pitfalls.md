# Pitfalls already met

Each of these cost a render or more while building the reference film.

## Picture

| Symptom | Cause | Fix |
|---|---|---|
| Whole subject is a white glowing blob | Environment lobes too bright and hard-edged; bloom then spreads it | Exponential lobes with peak around 1.5, dark base, check a still before anything else |
| An object is simply missing | Its shader failed to compile and the error was filtered out of the log | Read the full page console. In three.js fragment shaders `projectionMatrix` must be declared by hand |
| Flat discs where spheres should be | You are looking at the fallback bump texture; the real spheres are not drawing (see above) | Fix the shader, then confirm the mesh under them sinks and darkens |
| Crystal grains look like stained glass | Dark grooves on cell borders plus strong per-cell tint | No border groove, small tilt per cell, tint of a few percent |
| Dirty crosshatch in the foreground | Cell pattern resolved at 2 to 3 pixels | Stricter fine-end fade for cell-type features |
| Smooth areas look like crumpled foil | Isotropic roughness too strong at large scales | Strength around 0.007 at millimetre scale, 0.06 at micron scale |
| Pale, washed-out colours on the last stage | Diffuse lighting sums above 1, tone mapping desaturates | Scale diffuse to roughly 0.4 to 0.5 |
| Label unreadable | It sits on bright metal | Move it into black space above the subject |
| Scale objects cut off at the top | Subject's top edge too high in frame | Raise the look-at point, pull the camera back |
| Scale objects hide one another | They sit in a line along the view direction | Offset alternate objects sideways; keep sizes 3x apart |
| Objects appear on the wrong side | Sign of the camera's right vector guessed wrong | Render one still and look instead of reasoning about it |
| Long object looks like a ball | It is seen end-on | Rotate it broadside to the camera |
| Nothing seems to move during the zoom | Surface is self-similar and no particles | Add scale-windowed detail and radial dust |

## Motion and files

- **Shimmer on fine lines.** Fade each feature out per pixel before it reaches two pixels per cycle, and render at 1.5x. Verify with six consecutive frames from the finished file, not with stills rendered separately.
- **Strobing in the pull-back.** At 10+ halvings per second every frame is a different picture. Average several sub-frames per output frame.
- **Huge files.** Fine procedural detail and grain do not compress. 45 seconds at CRF 15 was 300 MB; CRF 19 is about 130 MB and looks the same. Make a 720p copy with a bitrate cap when the file has to travel.

## Tools

- **Software rendering.** If the GPU line says SwiftShader or llvmpipe, a frame takes seconds instead of milliseconds. On Windows use `--use-angle=d3d11`; on a laptop with two GPUs add `--force_high_performance_gpu`.
- **Modules will not load from `file://`.** Serve the folder over localhost, as `render.mjs` does.
- **Large inline patches through a shell heredoc can break** on quotes inside shader strings. Write the patch to a file and run that.
- **Do not filter the render log down to a few lines** while developing. The one line you hide will be the shader error.

## Facts

- Numbers quoted from memory drift. The first pitch for the reference film said the edge was "a few dozen atoms" wide; the measured tip radius gave about 300. Look it up before it goes on screen.
- Say what was left out. Real razor blades have coatings on the steel; the film shows bare steel and the final report says so.
