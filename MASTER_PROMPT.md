# Master prompt: 3D zoom explainer

Paste this into a coding agent (Claude Code or similar) and fill in the brackets. It works on its own; with the `zoom-explainer-3d` skill installed it also has a working template to start from.

```text
Make a 3D "infinite zoom" explainer video about: [TOPIC / CLAIM, e.g. "nothing is really sharp"].

THE FORMULA
- One continuous shot. The camera flies from [START OBJECT, at human scale] down to
  [END SCALE, e.g. a single atom] (or outward, if the idea is growth). No cuts.
- One live measurement on screen the whole time: a thin bar with a number that keeps
  changing ("2.20 cm -> 0.250 nm"), a count of how many times it was halved (or doubled),
  and two or three words naming what is in view right now.
- A payoff at the end: pull back fast to the start object and show the one surprising
  number the whole trip was for. [PAYOFF, or "find the best one in the research"]
- Things for scale: as the zoom passes each size, a familiar object of that size sits
  next to the subject with its name and size
  ([OBJECTS, e.g. grain of salt, human hair, red blood cell, bacterium, virus,
  chip transistor, antibody, DNA], or pick 6-9 spaced at least 3x apart in size).

TRUTH
- Every number on screen is real. Research the dimensions first, give me the sources,
  and tell me where you simplified (coatings left out, colours that are conventions...).
- Geometry follows the data: if the edge radius is 40 nm, it is 40 nm in the model, and
  the scale objects are placed at their true size relative to it.

LOOK
- Black background, studio lighting, real 3D with depth of field. It should feel like
  macro photography that keeps going past what a lens can do.
- The surface must change character at every scale (polish -> grinding marks -> chips ->
  crystal grains -> rounded edge -> atoms), so the zoom is felt, not just counted.
- No text that repeats a voiceover. On-screen text is data and names only.
- No music, no sound effects, no voiceover unless I ask.

FORMAT
- [16:9 1920x1080 | 9:16 1080x1920], 30 fps, about [45] seconds, H.264 MP4.
- Labels in [English].

HOW TO BUILD IT
- All code, no video-generation models: Three.js scene, a pure function that draws the
  frame for any time t, headless Chrome with the GPU, frames piped into ffmpeg.
- Zoom by scaling the world around the focus point, never by moving the camera into tiny
  numbers. Detail is procedural and fades in and out by physical size.

HOW TO WORK
1. Research the real sizes. Show me a short table: time | scale | what is in view |
   object for scale. Wait for my OK only if something in my brief is unclear; otherwise go.
2. Build, then render 8-10 stills across the timeline and look at them yourself. Fix
   exposure, framing, clipped objects and overlapping labels before rendering the film.
3. Render the full video, extract frames from the result and check them again, including
   a few consecutive frames for flicker.
4. Give me the MP4 (plus a copy under 30 MB if the main file is larger), the sources, and
   an honest list of what you checked and what you did not.
```

## Variations that work with the same formula

| Idea | Direction | Measurement | Payoff |
|---|---|---|---|
| Fold a sheet of paper 42 times | outward, doubling | thickness | it reaches the Moon |
| Inside a phone processor | inward | feature size | billions of transistors, each a few dozen atoms wide |
| One second, halved | time instead of distance, scene slows down | duration | light crosses less than 30 cm |
| An atom is almost empty | inward | distance to the nucleus | a pea in a stadium |
| How deep is the ocean | downward | depth and pressure | the deepest point vs. Everest |

## What to change in the prompt when it goes wrong

- **Looks flat or cartoonish:** ask for "macro photography, physically plausible metal, depth of field, no outlines".
- **Too much text:** repeat "data and names only" and name the label you want removed.
- **Zoom feels like nothing is moving:** ask for "surface detail that changes at every scale and dust drifting past the camera".
- **Objects for scale overlap:** ask for "each object at least 3x smaller than the previous one, offset to the side of the subject, one name on screen at a time where possible".
