# eclipse captions

Upload a talking-head video, get word-timed, animated **Eclipse** captions back as an MP4.
Built for Glido Labs' round-2 take-home.

```
upload ─▶ ffmpeg ─▶ Scribe / Whisper ─▶ chunk + roles ─▶ matte ─▶ HyperFrames composition ─▶ MP4
          (audio)   word timestamps     3–4 word lines   speaker   HTML + GSAP timeline
                                        keywords,        cut-out   (same file previews
                                        callouts         per callout in the browser)
```

## Quick start

Requires Node 22+ and ffmpeg/ffprobe on your `PATH`:

| OS | Install ffmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` (or unzip a [gyan.dev build](https://www.gyan.dev/ffmpeg/builds/) and add its `bin` to `PATH`) |
| Linux | `sudo apt install ffmpeg` |

```bash
npm install
cp .env.example .env           # add ELEVENLABS_API_KEY or OPENAI_API_KEY
npm start                      # http://localhost:3030
```

Batch / headless mode uses the same pipeline:

```bash
npm run caption -- samples/input/*.mp4 --style eclipse --out out/
npm run caption -- talk.mp4 --style glido --language hi --keyterms "Glido,FramesNFlights"
```

Tests: `npm test`. They cover the chunker (10-second, fast-talker and 3-minute transcripts, pauses, orphans, callout-aware limits) and keyword picking (Hinglish stopwords, callout spacing).

## How it works

| Step | File | Notes |
|---|---|---|
| Upload | `server/index.js` | Raw-body streaming upload with type and size checks. Plain `node:http`, no framework. |
| Audio | `server/pipeline.js` | `ffprobe` reads size, duration and phone rotation. `ffmpeg` extracts 16 kHz mono audio, about 10x smaller than the video. |
| Transcribe | `server/transcribe.js` | Adapters normalise ElevenLabs Scribe v2 and OpenAI Whisper to `{text,start,end}[]`. Results are cached by content hash. |
| Chunk | `server/chunk.js` | Pure function, unit-tested. See below. |
| Roles | `server/roles.js` | Picks keyword and callout words. Pure function, unit-tested. The editor can override every pick. |
| Matte | `server/pipeline.js` | Cuts the speaker out, but only during callout windows, using `hyperframes remove-background`. Cached. |
| Compose | `server/pipeline.js` | Writes a HyperFrames project: source `<video>` + caption layer + JSON data + style. |
| Animate | `runtime/captions.js` | Builds one paused GSAP timeline from timestamps. The renderer seeks it frame by frame. |
| Render | `hyperframes render` | Headless Chrome + FFmpeg. Deterministic output. |

### Chunking

Every boundary comes from the transcript JSON. There are no frame numbers anywhere, so a 10-second clip and a 3-minute talk go through the same code.

1. Hard break on a pause > 350 ms, a sentence end (`.?!`), or a clause end (`,;:`) once the phrase has ≥ 3 words.
2. Soft break when the phrase is full: 5 words, or wider than fits on the configured number of lines. `maxChars` is derived from video width, font scale and the style's average glyph width, so portrait and landscape get different limits.
3. Never end a line on a weak word (`the`, `of`, `to` …). It is carried into the next phrase.
4. Rebalance orphans after a soft break: `[5][1]` becomes `[3][3]`, or the two are merged if they fit.
5. A phrase shows from its first word to `last word end + hold`, but is always cleared before the next phrase starts.

### The Eclipse style

Measured from the reference video (`reference/`, not committed). The name comes from its signature move: **a giant keyword sits behind the speaker, and their head eclipses it.**

| Element | Reference behaviour | How it's built | Token |
|---|---|---|---|
| Caption line | Montserrat bold, sentence case as spoken, soft shadow, 3–4 words on one line, about 76% down | `chunk()` with `maxLines: 1`; `maxChars` derived from width | `fontScale`, `charWidth`, `position`, `chunk` |
| Active word | turns yellow `#FAE600` with a translucent yellow box, very slight pop | GSAP tween at `word.start`: colour, `backgroundColor`, `scale` | `colors.active`, `highlight`, `motion.activeScale` |
| Spoken / upcoming words | stay white, full opacity | tween back at the next word's start | `colors.text`, `motion.dimOpacity: 1` |
| Keywords | condensed Anton uppercase inside the line (MANGWAYA, LAZULI) | `role: 'emphasis'` from `roles.js` | `roles.emphasisMin` |
| Callout | one word per beat, shown huge at the top, fitted to about 89% width, **behind the speaker's head**. White → yellow + box while spoken → white. Outlives its phrase. | `role: 'callout'`. The speaker is matted for that window only. The callout is placed from the matte's head line and layered video → callout → cut-out → captions. | `callout.*`, `roles.callout*` |

The brief's suggested variant (1.2x pop, previous word dimmed to 50%) is a two-token change: `motion.activeScale: 1.2`, `motion.dimOpacity: 0.5`.

#### Text behind the subject

Matting is the slowest step, so it is kept small:

- **Only callout windows** are matted, which is a few seconds per minute of video.
- **All windows go through one model run.** The u2net model takes about 15 s just to start, so each callout does not pay that again.
- It runs at **half resolution and 15 fps**. Its alpha is then merged onto the full-resolution 30 fps frames with `ffmpeg alphamerge`, so the speaker stays sharp. Edges can lag the head by up to 1/30 s, which is not noticeable behind a word.
- The result is **cached per window**, so editing a word re-renders without re-matting.

On a 4-core i5, one 2.7 s callout takes about 41 s and two take about 61 s. If matting fails, the callout still renders, just in front of the speaker.

### Hinglish

Scribe may return Hindi speech in Devanagari script. Hinglish reels, the reference included, are captioned in Latin script. When Devanagari appears, `server/romanize.js` transliterates it in the creator spelling style (मैंने → *maine*, मंगवाया → *mangwaya*, वालों → *walon*). It uses a dictionary for common words and rule-based schwa deletion for the rest, and it has tests.

## Styles are data

A style is a folder in `styles/`:

- `style.json`: fonts, font scale, glyph width, placement per orientation, chunk limits, colours, glow and motion timings
- `style.css`: look (font family, stroke, background, casing)

Fonts are listed as `"family/weight"` (e.g. `"montserrat/700"`) and come from the matching `@fontsource/*` npm package. They are copied into each job along with GSAP, so renders need no network and can't change when a CDN does.

`styles/glido` is a second style in Glido's brand colours. Adding it needed no code changes, and the UI style picker lists whatever folders exist.

## Samples

`samples/input/` holds the source clips and `samples/output/` holds the rendered results, one per style. The landing page lists whatever is in `samples/output/`.

`synthetic-portrait.mp4` is a generated clip: macOS `say` speech over a gradient. It exercises the full render path without real footage.

## Performance

Measured on a 4-core Intel i5-7500 with 8 GB of RAM: rendering runs at about **4x the video's length** (8.8 s clip → 31–37 s). A 3-minute video takes about 12 minutes. Transcription takes a few seconds on top, and runs only once per video thanks to the cache. Matting adds about 15 s per second of callout (see above).

Rendering runs in parallel across Chrome workers (`--workers auto`), so more cores means faster renders. HyperFrames' Lambda renderer is the next step for batch work.

## Security

- API keys live only in `.env`, which is gitignored. `.env.example` documents them. Keys are read server-side and never reach the browser.
- Uploads are limited by extension and size (1 GB), then validated with `ffprobe` (must have a video stream, ≤ 10 min).
- Transcript edits can change word text and role only. Timings stay server-owned. Style names are checked against the `styles/` folder.
- The server binds to `127.0.0.1` by default. Set `HOST` to expose it on a network.
- Uploads are re-encoded to H.264 with 1 s keyframes before rendering. Phone HEVC and sparse-keyframe files otherwise freeze or fail to preview.
- Generated compositions pass `hyperframes lint` with 0 errors and 0 warnings.

## Decisions & trade-offs

| Choice | Why | Alternative |
|---|---|---|
| HyperFrames | Plain HTML + GSAP, deterministic renders, Apache-2.0. The preview page is the render input, so preview and export match. | Remotion: React-only and needs a company licence |
| ElevenLabs Scribe v2 default | Word timestamps with punctuation, 90+ languages (Hindi for Glido's multilingual channels), keyterms for brand names, about $0.22/hr | Whisper: words come without punctuation, which is re-attached from the full text |
| No framework, no DB, no queue | Single-user tool with six routes. Jobs live in memory and files on disk. | A queue + HyperFrames Lambda rendering when this needs to run for many channels at once |
| Transcript cache | Editing a word or switching styles re-renders without another API call | — |
