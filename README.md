# captions

Upload a video, get scroll-stopping captions back as an MP4. The **Default** look is measured from the Eclipse reference reel and puts key words behind the speaker; **Custom** lets you pick the highlight colour, the caption font and whether words go behind the speaker.
Built for Glido Labs' round-2 take-home.

```
upload ─▶ ffmpeg ─▶ Scribe / Whisper ─▶ chunk + roles ─▶ matte ─▶ HyperFrames composition ─▶ MP4
          (audio)   word timestamps     3–4 word lines   speaker   HTML + GSAP timeline
                                        keywords,        cut-out   (same file previews
                                        callouts         per callout in the browser)
```

## Highlights

- **Text behind the speaker, on any video.** The reference's signature move is a giant keyword that the speaker's head eclipses. The pipeline cuts the speaker out *only* during callout windows (one model run, cached), extracts their outline every 1/10 s, and places each word against that outline: the head hides 55 % of a wide word's letters, and a narrow word tucks a third of itself behind the head. These are rules relative to the speaker, measured once on the reference, so they hold wherever the speaker stands and however they move.
- **Never silently wrong.** If the cut-out fails, finds nobody, or finds the head too low, that word moves into the caption line as a keyword (never across the face) and the editor shows why, with a Retry button. `--strict` makes the CLI fail instead.
- **Vertical by default.** Any landscape or square upload becomes a 1080×1920 frame cropped around the speaker's head, found from 12 sampled frames. `--layout original` keeps the source frame.
- **Preview is the render.** The browser preview loads the exact HTML file HyperFrames renders, so what you approve is what you export.
- **Styles are data, not code.** The default look is a `style.json` + `style.css` folder. **Custom** (highlight colour, one of three measured fonts, words behind the speaker on/off) is a validated override on top of it, from the upload form or the CLI. The brief's alternative look is a two-token edit.
- **Every boundary comes from the transcript.** There are no frame numbers or hard-coded timings. Line limits come from video width and font metrics, so a 10-second portrait clip and a 3-minute landscape talk run through the same code.
- **Hinglish done the way creators write it.** Scribe returns Hindi as Devanagari; `romanize.js` converts it to creator-style Latin. Its test fixture is every Hindi word of the reference reel, and all 55 match the reference's own captions.
- **Fix it in the browser.** Click a word to correct it, right-click to make it a keyword or callout. Re-rendering costs no API call, and the transcript cache is keyed on audio, provider, language and keyterms.
- **Deterministic, offline renders.** GSAP and fonts are pinned npm dependencies copied into each job, with no CDNs at render time. Generated compositions pass `hyperframes lint` with 0 errors and 0 warnings.
- **Checked against the real thing, and against clips it was never tuned on.** The reference reel was compared frame by frame with the original (callouts within 4–20 px). `tools/check.mjs` checks the same rules on any composed job, and they pass on [a test set](#testing) of unseen clips.
- **Careful with paid credits.** Every video is transcribed once (cached by audio hash). Anything over 5 minutes is refused unless you pass `--yes`, every paid call is logged with a running total, and the samples ship their transcripts so they run without a key.

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

No key in `.env`? Paste your ElevenLabs key on the upload form instead. It is sent in a request header with that upload only, kept in memory for that job, and never written to disk, logged or returned by the API.

Batch / headless mode uses the same pipeline:

```bash
npm run caption -- samples/input/*.mp4 --out out/
npm run caption -- talk.mp4 --language hi --keyterms "Glido,FramesNFlights"
npm run caption -- talk.mp4 --accent "#ff4d6d" --font poppins --no-behind   # custom look
npm run caption -- wide.mp4 --layout original      # keep a landscape frame
```

| Flag | Effect |
|---|---|
| `--keyterms` | Brand names: spelled right by the transcriber, always shown as in-line keywords, never behind the speaker |
| `--layout 9:16|original` | Defaults to 9:16, cropped around the speaker |
| `--accent`, `--font`, `--no-behind` | Custom look: highlight colour (`#rrggbb`), caption font (`montserrat|inter|poppins`), no words behind the speaker |
| `--yes` | Allow sending more than `MAX_STT_MINUTES` (default 5) of audio to the paid API |
| `--strict` | Exit non-zero if any callout could not go behind the speaker |
| `--no-render` | Stop after composing (for `hyperframes snapshot` or `tools/check.mjs`) |

A transcript file next to the video (`clip.transcript.json`) is used instead of the API.

Tests: `npm test`. They cover the chunker (10-second, fast-talker and 3-minute transcripts, pauses, orphans, callout-aware limits), keyword picking (Hinglish stopwords, callout spacing, brands, one keyword per sentence) and the romanizer. See [Testing](#testing) for the checks on real video.

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

### The default style

Measured from the reference reel, not eyeballed: fonts identified by pixel-overlap scoring, colours sampled, callout timing and placement tracked frame by frame. The full spec, the method and an A/B against the reference are in **[docs/eclipse-spec.md](docs/eclipse-spec.md)**. The name comes from the signature move: **a giant keyword sits behind the speaker, and their head eclipses it.**

| Element | Reference (measured) | Token |
|---|---|---|
| Caption line | Montserrat 700, 6.94 % of the short edge, pure white, faint soft shadow, no stroke, 1–4 words, **hard cut** in and out | `fontScale`, `position`, `chunk`, `motion.in/out: 0` |
| Active word | `#FEE300` text + translucent yellow box 0.2 em around the ink, no pop | `colors.active`, `highlight`, `motion` |
| Keywords | Anton caps inside the line, 1.11 em, 0.025 em tracking (MANGWAYA, LAZULI). At least one per sentence of 3+ words; brand names (ASTROTALK) always | `roles.emphasisMin`, `--keyterms`, `style.css` |
| Callout | Anton caps at a fixed 0.298 × width, left-anchored, shrunk only past 90.6 %; numbers and short words 1.22× and beside the head. **Behind the speaker's head**: the head hides 55 % of the letters' height. Lives exactly as long as its phrase, hard cut, white → yellow + box while spoken. About one per 10 s, English words or numbers only in Hinglish (*barah* → **12**), never a brand. | `callout.*`, `roles.callout*` |
| Layout | 9:16, 1080×1920, cropped around the speaker | `layout` |

The brief's suggested variant (1.2x pop, previous word dimmed to 50%) is a two-token change: `motion.activeScale: 1.2`, `motion.dimOpacity: 0.5`.

#### Text behind the subject

Matting is the slowest step, so it is kept small:

- **Only callout windows** are matted, which is a few seconds per minute of video.
- **All windows go through one model run.** The u2net model takes about 15 s just to start, so each callout does not pay that again.
- It runs at **half resolution and 15 fps**. Its alpha is then merged onto the full-resolution 30 fps frames with `ffmpeg alphamerge`, so the speaker stays sharp. Edges can lag the head by up to 1/30 s, which is not noticeable behind a word.
- The result is **cached per window**, so editing a word re-renders without re-matting.
- From each cut-out, the **speaker's outline** (top of the person per column, every 1/10 s) goes into the composition. `runtime/captions.js` places each word against it once the font has loaded (rules in [docs/eclipse-spec.md](docs/eclipse-spec.md#as-rules-for-any-video)), checks every sampled frame, and reports how much of each word is hidden.

On a 4-core i5, one 2.7 s callout takes about 41 s and two take about 61 s. If matting fails, finds no person, or finds the head below mid-frame or touching the top edge, the word is shown in the caption line instead, and the job carries a warning (editor banner with Retry; `--strict` in the CLI).

### Hinglish

Scribe may return Hindi speech in Devanagari script. Hinglish reels, the reference included, are captioned in Latin script. When Devanagari appears, `server/romanize.js` transliterates it in the creator spelling style (मैंने → *maine*, मंगवाया → *mangwaya*, वालों → *walon*). It uses a dictionary for common words and rule-based schwa deletion for the rest, and it has tests.

## Styles are data

A style is a folder in `styles/`:

- `style.json`: fonts, font scale, glyph width, placement per orientation, chunk limits, colours, glow and motion timings
- `style.css`: look (font family, stroke, background, casing)

Fonts are listed as `"family/weight"` (e.g. `"montserrat/700"`) and come from the matching `@fontsource/*` npm package. They are copied into each job along with GSAP, so renders need no network and can't change when a CDN does.

**Custom** is not another folder: it is an override on the default style, checked on the server before the upload is read (`customizeStyle` in `server/pipeline.js`):

| Setting | Effect | Allowed |
|---|---|---|
| Highlight | active word colour and its translucent box | `#rrggbb` |
| Font | caption line font; keywords and callouts stay Anton | Montserrat, Inter, Poppins: bundled, with each one's average glyph width measured so line breaking stays right |
| Words behind speaker | off skips the speaker cut-out entirely | on / off |

## Samples

`samples/input/` holds source clips and `samples/output/` the rendered results. The landing page lists whatever is in `samples/output/`.

`interview-two-people` and `interview-cutaways` are renders of Creative Commons interviews from the [test set](#testing): landscape sources cropped to 9:16 around the speaker, with words behind the head (credits in [samples/CREDITS.md](samples/CREDITS.md)). `samples/input/synthetic-portrait.mp4` is a generated clip (macOS `say` speech over a gradient) with its transcript next to it, so the full pipeline runs without a key.

The CLI names outputs `<video>.default.mp4`, or `<video>.custom.mp4` when a custom setting is passed.

**Reference check.** The Eclipse reference reel (50 s, Hinglish, already captioned) is client footage, so it is kept out of the repo. Drop it in `reference/` (gitignored) and run:

```bash
npm run caption -- reference/eclipse.mp4 --keyterms "Astrotalk" --no-render
node tools/measure/abtest.mjs jobs/<job-id> reference/eclipse.mp4 22.9,27.0,28.9,46.0,47.9
npx hyperframes snapshot jobs/<job-id> --at 22.9,28.9,47.9 --against reference/eclipse.mp4
```

`--no-render` stops after composing, which is enough to compare. `abtest.mjs` reports how far our text lands from the reference's, in pixels. `snapshot --against` writes `render | reference` pair sheets to look at. On this reel:

- every Hindi word is spelled the way the reference spells it (Scribe returns Devanagari, `romanize.js` converts it);
- the caption line lands within 5 px of the reference, and callouts within 3–13 px in position and 3 px in height, behind the speaker's head (table in [docs/eclipse-spec.md](docs/eclipse-spec.md#ab-result));
- 3 of the 5 callouts are the same words at the same moments (PISCES, SPECIFICALLY, 12). The other two are an editor's taste: the reference picked OBSIDIAN and TIGER. Right-click a word in the editor to change it.

## Testing

Three layers, from cheapest to most real:

1. **Unit tests** (`npm test`): chunker, keyword picking, romanizer, timestamp clean-up. No video, no API.
2. **Rule checks on any video** (`node tools/check.mjs jobs/<id>...`): loads the composed page in headless Chrome and checks rules that don't depend on the clip:
   - every callout is partly hidden by the speaker in every sampled frame, never mostly hidden;
   - every fallback is listed with its reason;
   - all text stays inside the frame, and callouts stay clear of the caption line;
   - at each word's timestamp, exactly that word is highlighted;
   - every sentence of 3+ words has a keyword.
3. **Pixel A/B against the reference** (`tools/measure/abtest.mjs`, `hyperframes snapshot --against`), see [Samples](#samples).

**Unseen clips.** The rules were tuned on the reference only, then run unchanged on clips with different framing. The clips are Creative Commons footage from Wikimedia Commons, not committed: [Jacob Markstrom interview](https://commons.wikimedia.org/wiki/File:Jacob_Markstrom_interview_(1).webm) (rinkside93, CC BY 3.0), [Interview with Jeff Nippard](https://commons.wikimedia.org/wiki/File:Interview_with_Jeff_Nippard_%E2%80%93_Science_communication_and_neck_training_(science-based_bodybuilding).webm) (JPS Health & Fitness, CC BY 3.0), and [Wikipedia 20 – Darya & Avner](https://commons.wikimedia.org/wiki/File:Wikipedia_20_-_Darya_%26_Avner.webm) (Wikimedia Foundation, CC BY-SA 3.0).

| Clip | What makes it hard | 9:16 | Callouts behind the speaker | Sync | Keywords |
|---|---|---|---|---|---|
| Reference, re-framed as 1920×1080 with the speaker off-centre | landscape, off-centre | cropped on her head | 5/5 (hidden 12–36 %) | 136/136 | 11/11 |
| Markstrom, 640×360 | extreme close-up, head cut by the top edge | whole frame over a blurred fill | 0/4: all fell back to the line, with a warning each (no room above the head) | 158/158 | 6/6 |
| Nippard, 854×480 | two people side by side, crosstalk | cropped on one person | 4/4 (hidden 9–15 %) | 167/167 | 16/16 |
| Darya & Avner, 15 s | mostly cutaway footage and screen captures | cropped on the speaker | 1/1 | 37/37 | 4/4 |

The first run of these clips found five bugs, all fixed:
- a crop centred on the wall between two people;
- an enlarged-face crop for a close-up;
- a frame-sampling crash;
- words with one shared timestamp that were never visible while highlighted;
- a render stall caused by clip durations with float tails.

Transcribing all three cost 1.6 minutes of API time, once.

## Performance

Measured on a 4-core Intel i5-7500 with 8 GB of RAM: rendering runs at about **4x the video's length** (8.8 s clip → 31–37 s). A 3-minute video takes about 12 minutes. Transcription takes a few seconds on top, and runs only once per video thanks to the cache. Matting adds about 15 s per second of callout (see above).

On a 4-core i7-1165G7 laptop with 8 GB of RAM (Windows): the 8.8 s sample renders in about 160 s. For the 50 s reference reel, matting its 7 callouts (16.7 s of video) took about 12 minutes, roughly 44 s per second of callout. With 8 GB or less, HyperFrames switches to its low-memory profile (one worker, sequential capture). One long-lived Chrome then grows until capture stalls, so clips over 20 s are captured in 10 s segments with a fresh browser each. The 50 s reference with five cut-out layers renders in about 5 minutes this way.

Rendering runs in parallel across Chrome workers (`--workers auto`), so more cores means faster renders. HyperFrames' Lambda renderer is the next step for batch work.

## Security

- API keys live only in `.env`, which is gitignored. `.env.example` documents them. Keys are read server-side and never reach the browser.
- Uploads are limited by extension and size (1 GB), then validated with `ffprobe` (must have a video stream, ≤ 10 min).
- Transcript edits can change word text and role only. Timings stay server-owned. Style names are checked against the `styles/` folder, and custom settings against fixed formats and a font allowlist, before the upload is read.
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
