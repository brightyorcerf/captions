# eclipse captions

Upload a talking-head video, get word-timed, animated **Eclipse** captions back as an MP4.
Built for Glido Labs' round-2 take-home.

```
upload ─▶ ffmpeg (audio) ─▶ Scribe / Whisper ─▶ chunker ─▶ HyperFrames composition ─▶ MP4
                              word timestamps    3–5 word     HTML + GSAP timeline
                                                 phrases      (same file previews in the browser)
```

## Quick start

```bash
brew install ffmpeg            # Node 22+ is also required
npm install
cp .env.example .env           # add ELEVENLABS_API_KEY or OPENAI_API_KEY
npm start                      # http://localhost:3030
```

Batch / headless mode uses the same pipeline:

```bash
npm run caption -- samples/input/*.mp4 --style eclipse --out out/
npm run caption -- talk.mp4 --style glido --language hi --keyterms "Glido,FramesNFlights"
```

Tests: `npm test`. These cover the chunker: 10-second, fast-talker and 3-minute transcripts, pauses, and orphan words.

## How it works

| Step | File | Notes |
|---|---|---|
| Upload | `server/index.js` | Raw-body streaming upload with type and size checks. Plain `node:http`, no framework. |
| Audio | `server/pipeline.js` | `ffprobe` reads size, duration and phone rotation. `ffmpeg` extracts 16 kHz mono audio, about 10x smaller than the video. |
| Transcribe | `server/transcribe.js` | Adapters normalise ElevenLabs Scribe v2 and OpenAI Whisper to `{text,start,end}[]`. Results are cached by content hash. |
| Chunk | `server/chunk.js` | Pure function, unit-tested. See below. |
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

### The Eclipse spec

No reference video came with the brief, so Eclipse is defined from the written spec. The name sets the metaphor: one word catches the light while the rest of the phrase sits in shadow. Every value is a token in `styles/eclipse/style.json`, so matching a reference later means editing JSON, not code.

| Property | Value | Token |
|---|---|---|
| Typography | Montserrat 800, uppercase, thin dark stroke for legibility | `style.css` |
| Size | 8.5% of the short edge (about 92 px at 1080×1920) | `fontScale` |
| Placement | 70% down on portrait, 80% on landscape, which stays clear of reel UI | `position` |
| Phrase | 3–5 words, up to 2 balanced lines | `chunk`, `maxLines` |
| Active word | scales to **1.2x**, turns neon lime `#b6ff3b` with a two-layer glow | `motion.activeScale`, `colors`, `glow` |
| Previous word | eases back to **1.0x** at **50%** opacity | `motion.dimOpacity` |
| Upcoming words | wait in shadow at 50% opacity | `motion.dimOpacity` |
| Timing | pop 140 ms `back.out`, phrase in 180 ms, out 120 ms, cleared before the next phrase | `motion` |

## Styles are data

A style is a folder in `styles/`:

- `style.json`: font scale, glyph width, placement per orientation, chunk limits, colours, glow and motion timings
- `style.css`: font and look (stroke, background, casing)

`styles/glido` is a second style in Glido's brand colours. Adding it needed no code changes, and the UI style picker lists whatever folders exist.

## Samples

`samples/input/` holds the source clips and `samples/output/` holds the rendered results, one per style. The landing page lists whatever is in `samples/output/`.

`synthetic-portrait.mp4` is a generated clip: macOS `say` speech over a gradient. It exercises the full render path without real footage.

## Performance

Measured on a 4-core Intel i5-7500 with 8 GB of RAM: rendering runs at about **4x the video's length** (8.8 s clip → 31–37 s). A 3-minute video takes about 12 minutes. Transcription takes a few seconds on top, and runs only once per video thanks to the cache.

Rendering runs in parallel across Chrome workers (`--workers auto`), so more cores means faster renders. HyperFrames' Lambda renderer is the next step for batch work.

## Security

- API keys live only in `.env`, which is gitignored. `.env.example` documents them. Keys are read server-side and never reach the browser.
- Uploads are limited by extension and size (1 GB), then validated with `ffprobe` (must have a video stream, ≤ 10 min).
- Transcript edits can change word text only. Timings stay server-owned. Style names are checked against the `styles/` folder.

## Decisions & trade-offs

| Choice | Why | Alternative |
|---|---|---|
| HyperFrames | Plain HTML + GSAP, deterministic renders, Apache-2.0. The preview page is the render input, so preview and export match. | Remotion: React-only and needs a company licence |
| ElevenLabs Scribe v2 default | Word timestamps with punctuation, 90+ languages (Hindi for Glido's multilingual channels), keyterms for brand names, about $0.22/hr | Whisper: words come without punctuation, which is re-attached from the full text |
| No framework, no DB, no queue | Single-user tool with six routes. Jobs live in memory and files on disk. | A queue + HyperFrames Lambda rendering when this needs to run for many channels at once |
| Transcript cache | Editing a word or switching styles re-renders without another API call | — |
