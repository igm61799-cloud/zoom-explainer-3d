---
name: zoom-explainer-3d
description: Make a coded 3D "infinite zoom" explainer video (MP4) where one continuous camera move travels across many orders of magnitude, with a live measurement on screen and familiar objects shown beside the subject for scale. Everything is drawn by code (Three.js, headless Chrome on the GPU, ffmpeg), with no video-generation models. Use this whenever the user wants a 3D explanation or scale video, a "zoom into X down to atoms", a "powers of ten" or "halved N times" style clip, a size-comparison animation, or shares a reference video of a continuous zoom with a changing number and asks for something like it; also for "make a 3D explainer about how small / big / thin / sharp / deep X really is", and when they say things like "zrób film 3D jak ten", "zoom do atomów", "porównanie skali". Prefer it over improvised one-off Three.js whenever the result must be a real video file. Not for 2D motion graphics cut to a voiceover (use voiceover-to-animation) and not for AI-generated footage.
---

# 3D zoom explainer

A format that explains scale better than any chart: start on an object everyone knows, fly into it without a single cut, keep one number on screen that tells the viewer how far they have gone, and end on a fact they did not expect. The reference result for this skill is "Nothing is really sharp": a razor blade, 26 halvings, one iron atom, and the line that its edge is still about 300 atoms wide.

`assets/template/` is that finished project. Start from it rather than from an empty file: the hard parts (zooming eight orders of magnitude without precision loss, detail that changes with scale, depth of field, a deterministic renderer) are already solved there and took several rounds to get right.

## The formula

Keep all five. Each one is doing work.

1. **One continuous shot.** The whole point is that the viewer never loses their place. A cut resets their sense of scale.
2. **One live measurement.** A thin bar anchored on the subject, a number that changes every frame, a count of halvings (or doublings), and two or three words for what is in view. The bar is the only thing the viewer has to read, so it must be honest: its length in the scene really is the number shown.
3. **The subject changes character at every scale.** Polish becomes grinding marks, then chips, then crystal grains, then a rounded edge, then atoms. If the surface looks the same for three seconds, the zoom reads as nothing happening.
4. **Things for scale.** As the zoom passes each size, a familiar object of that size sits beside the subject with its name and size: grain of salt, hair, red blood cell, bacterium, virus, transistor, antibody, DNA. They turn an abstract number into "smaller than a virus".
5. **A payoff.** Pull back fast to where you started and show the one number the trip was for.

## Workflow

### 1. Research before modelling

The video is only worth making if it is true. Look up the real dimensions (web search, primary sources where possible) and write down, for the subject and for each scale object: the size, the source, and anything you are simplifying. Geometry is then built from those numbers, so the picture cannot drift away from the facts. Report the sources and the simplifications to the user at the end; they will be asked.

Choose 6 to 9 scale objects, each at least about 3x smaller than the previous one. Closer than that and their labels collide; further apart than about 30x and the screen sits empty for seconds.

### 2. Show the plan when it helps

If the user asked to see the plan first, or the brief leaves real choices open (voiceover or silent, language, what the payoff is), give a short table: time, scale, what is in view, object for scale. Otherwise proceed; a plan nobody asked for only delays the first render.

### 3. Set up the project

```bash
cp -r <skill>/assets/template <project>/ && cd <project> && npm install
node render.mjs --stills 1,10,20,30,40
```

The second command should print the GPU name and write five JPEGs to `out/`. If it reports SwiftShader or llvmpipe, rendering is on the CPU and will take hours: fix the GPU flags before going further (see `references/pitfalls.md`).

### 4. Adapt the scene

`main.js` is one file, in sections. Read `references/techniques.md` before changing anything structural; it explains why each part is built the way it is. What usually changes for a new topic:

| Section in `main.js` | What to replace |
|---|---|
| constants | Physical data in metres, start size `L0`, number of halvings `HMAX`, timeline |
| subject surface | The cross-section `prof()`, the outline cut-out, the table of surface features `FEATS` (wavelength, type, strength) |
| finest scale | The atom lattice (or whatever the last stage is made of) |
| things for scale | The `addObj(name, sizeText, sizeInMetres, geometry, material, placement)` list |
| overlay | `LABELS` (what is in view at each zoom level), the final caption |
| camera keys | `K_AZ`, `K_EL`, `K_TY`, `K_D`, `K_AP` as functions of zoom level |

For a subject with a different shape (a chip, a leaf, a sheet of paper), keep the machinery and replace the profile and the features. For an outward zoom, run the same timeline in reverse and say "doubled".

### 5. Look at stills before rendering the film

Render 8 to 10 stills spread across the timeline, tile them into contact sheets with ffmpeg and read them. Then fix what you see and repeat. This loop is where the quality comes from; every problem in the first version of the reference film was visible in stills and none of them was visible in the code. Check in particular:

- **Exposure.** The first pass is nearly always blown out. Metal should be mostly dark with defined highlights.
- **Anything cut off by the frame edge**, especially scale objects near the top.
- **Labels over bright areas or over each other.** Keep the measurement label in empty black.
- **Whether each stage reads as what its label says.** If the label says "grains" and the picture is stripes, one of them is wrong.
- **The first and last frame**, since those are the thumbnail and the punchline.

```bash
ffmpeg -y -i a.jpg -i b.jpg -i c.jpg -i d.jpg -filter_complex "[0][1]hstack[t];[2][3]hstack[u];[t][u]vstack,scale=1920:-1" sheet.jpg
```

### 6. Render and verify the result

```bash
node render.mjs --full --o video.mp4            # add --audio vo.wav if there is narration
```

Run it in the background; a 45 second film at 1080p takes a few minutes on a discrete GPU. Then check the file itself, not the stills you made earlier: probe duration and size, extract an overview grid, and extract six consecutive frames from a busy section to look for flicker. Fine procedural detail compresses badly, so expect large files and make a smaller copy when needed:

```bash
ffmpeg -i video.mp4 -vf "fps=1/3,scale=640:-1,tile=4x4" -frames:v 1 overview.jpg
ffmpeg -ss 13 -i video.mp4 -vf "crop=960:540:480:270,tile=3x2" -frames:v 1 consecutive.jpg
ffmpeg -i video.mp4 -vf scale=1280:720 -c:v libx264 -preset slow -crf 25 -maxrate 4200k -bufsize 8400k small.mp4
```

Say plainly what you verified and what you did not. Frame grids prove the picture is right; they do not prove the motion feels right, so say that the user should watch it.

## Defaults

- **Silent.** No music, no sound effects, no voiceover unless asked. The format carries itself, and the reference it comes from had no narration.
- **Text is data and names only.** The measurement, the halving count, what is in view, the names and sizes of scale objects, one final number. If narration is added, drop every label that the voice already says, because reading and listening to the same words splits attention.
- **1920x1080, 30 fps, 40 to 50 seconds**, rendered at 1.5x and downscaled. For vertical video change `W` and `H` and re-check every still; the composition does not transfer by itself.
- **Labels in the language of the user's audience**, which is not always the language they are chatting in. Ask if unclear.

## Adding a voiceover

Only when asked. Write the script as short lines that each belong to one stage, generate or receive the audio, get word timings (faster-whisper works well), and then drive the zoom from the audio: the zoom level becomes a keyframed function of time that holds while a line explains a stage and travels between lines. Pass the audio to `render.mjs --audio`. Let something small happen during each hold (a light sweep, an object arriving, atoms vibrating), otherwise a paused zoom looks frozen.

## Reference files

- `references/techniques.md` - how the template works and why: scaling around the focus point, scale-windowed procedural detail, sphere impostors, depth of field, objects anchored in physical space, the deterministic renderer. Read before structural changes.
- `references/pitfalls.md` - failures already met and their fixes. Read when a render looks wrong or a tool misbehaves.
- `MASTER_PROMPT.md` - a fill-in prompt for starting a new video, plus topic ideas that fit the formula.
