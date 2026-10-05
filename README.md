# captions

![The captions landing page](docs/hero.png)

Upload a video, get scroll-stopping captions back as an MP4.

Built for the Glido Labs round 2 take-home. Captions transcribes a video word by word, splits it into short phrases, highlights each word as it is spoken, and renders the result with HyperFrames.

- Default: the look measured from the Eclipse reference reel. Key words in a bold display font, and one big word every few seconds behind the speaker's head.
- Custom: the same look with your highlight colour, one of three fonts, and words behind the speaker on or off.

```
upload > ffmpeg > ElevenLabs Scribe or Whisper > phrases and key words > speaker cut-out > HyperFrames > MP4
```

## Most impressive parts of this project

- Text behind the speaker works on any video. The speaker's head outline is tracked ten times a second, and each big word is placed against it using proportions measured once on the reference.
- The look was measured, not eyeballed. Fonts were matched by pixel comparison, colours sampled and timing tracked frame by frame. Our text lands within 4 to 20 pixels of the reference.
- It never fails silently. A big word that cannot go behind the speaker moves into the caption line, and the editor says why and offers a retry.
- Any video becomes a 9:16 reel whose crop follows the speaker like a camera operator would: still while they stay near the middle, a smooth pan when the camera drifts, a jump on a camera cut. Close-ups and empty shots are shown whole over a blurred fill.
- It was tested on clips it was never tuned on. The first run on three Creative Commons clips found five bugs, all fixed.
- Hinglish is spelled the way creators write it, matching all 55 Hindi words in the reference.
- It is careful with paid credits. Each video is transcribed once, long videos need confirmation, and the whole project used 1.6 minutes of audio.
- The preview is the render. The browser preview loads the same HTML that HyperFrames renders.

## Challenges faced during the project

- The first version was called generic. Instead of adjusting by eye, I measured the reference. An AI vision model's description of the style was wrong on font, colour, inactive words and outline, so it was not used.
- Matching fonts. Every candidate scored the same at first, because fonts loaded from file paths never rendered in headless Chrome. Embedding them fixed it, and Montserrat and Anton won clearly.
- Placement that only fit one video. The first version read the head from one frame and used fixed screen positions. Rewriting it around the outline in every frame made it work elsewhere.
- Renders that froze on an 8 GB laptop. Two causes looked like one: clip durations with floating point tails made the renderer wait for a frame that never came, and a long-running Chrome ran out of memory. Durations are now whole frames, and long videos are captured in 10 second segments.
- Unfamiliar clips. They exposed a crop centred on the wall between two people, a close-up blown up into a giant face, a cut-out model that returns nothing for extreme close-ups, an unusual frame rate, and words sharing one timestamp that were never highlighted.
- Fast talkers. Big words flashed for half a second. They now stay at least 0.9 seconds, the shortest in the reference, while the captions continue underneath.
- Hindi transcription. The transcriber returns Devanagari, so the romanizer needed rules for silent vowels, word-final long vowels, number words (barah becomes 12) and the danda.

## How the second version improved on the first

A 20 second sports interview exposed the first version's limits. Its big word UNDERSTANDING was drawn across the speaker's face, the preview's play button did nothing, and the render took 5 and a half minutes. Each problem was traced to its cause by stepping through the output frame by frame.

| | First approach | Problem it caused | New approach | Result |
|---|---|---|---|---|
| Speaker cut-out | hyperframes' `u2net_human_seg`, 700 ms a frame | Lost the head for half a second at a time, so big words showed through the face | MODNet portrait matting, run in-process with onnxruntime | Head solid in every frame, 130 ms a frame |
| 9:16 crop | One fixed crop at the speaker's average position | When the camera panned, the speaker ended up at the frame edge, where the cut-out was worst | A crop that follows the speaker: holds still near the middle, pans smoothly when they drift, catches up on a fast move, jumps on a camera cut | Speaker stays framed through the whole interview |
| Head height | The highest point of the outline | A hair tuft counted as the head, so the word sat above it | Thin spikes ignored | Words sit 55% behind the head, as on the reference |
| Unsafe moments | A big word behind the speaker whatever happened on screen | Dissolves and montages left words over a crowd or a stranger | Speaker must be present and steady, and no camera cut while the word is up; otherwise it goes in the caption line with a reason | Every word behind a speaker passes the rule checks |
| Captions | Verbatim | "uh,", "m-moved", "BEAUTIFULLY." | Fillers dropped, stutters collapsed, big words without punctuation | Reads like a finished reel |
| Render | One capture worker, which hyperframes uses on 8 GB machines | 230 s for 20 s of video | Up to 3 workers as free memory allows, falling back to 1 if a parallel render fails | 130 s |
| Pipeline order | Transcribe after cropping and re-encoding | Waiting on work it doesn't need | Transcription starts as soon as the audio exists | Overlaps with the crop |
| Preview | The video's own controls, under the caption layers | Controls never received a click; fullscreen dropped the captions | Custom control bar above every layer; fullscreen enlarges the whole preview | Play, seek, mute and fullscreen all work |

End to end, the 20 second clip went from 5 min 23 s to 2 min 15 s through the website. The project's own rule checker failed the first version on it, and passes the second on it and on the 78 second interview.

## Quick start

You need Node 22 or later and ffmpeg on your PATH (`brew install ffmpeg`, `winget install Gyan.FFmpeg` or `sudo apt install ffmpeg`).

```bash
npm install
cp .env.example .env    # optional: ELEVENLABS_API_KEY or OPENAI_API_KEY
npm start               # http://localhost:3030
```

Without a key in `.env`, paste an ElevenLabs key on the upload page. It is used for that upload only and never stored, logged or returned.

After the first render, click a word to fix its spelling, or right-click to cycle it between normal, key word and big word. Re-rendering reuses the cached transcript.

## Command line

```bash
npm run caption -- samples/input/*.mp4 --out out/
npm run caption -- talk.mp4 --language hi --keyterms "Glido,FramesNFlights"
npm run caption -- talk.mp4 --accent "#ff4d6d" --font poppins --no-behind
```

| Flag | Effect |
|---|---|
| `--keyterms` | Brand names: spelled correctly, always key words, never behind the speaker |
| `--layout 9:16` or `original` | Default is 9:16 |
| `--accent`, `--font`, `--no-behind` | Custom look |
| `--yes` | Allow more than `MAX_STT_MINUTES` (default 5) of paid transcription |
| `--strict` | Fail if any big word could not go behind the speaker |
| `--no-render` | Stop after composing, for `tools/check.mjs` or `hyperframes snapshot` |

A `clip.transcript.json` next to `clip.mp4` is used instead of the API.

## How it works

| Step | File | What it does |
|---|---|---|
| Upload | `server/index.js` | Streams to disk with type and size checks. Plain `node:http`. |
| Audio | `server/pipeline.js`, `server/follow.js` | Probes the video, extracts 16 kHz mono audio, finds camera cuts, crops to 9:16 following the speaker |
| Transcribe | `server/transcribe.js` | ElevenLabs Scribe v2 or Whisper word timestamps, cached by audio hash. Starts as soon as the audio exists, while the video is still being cropped |
| Tidy | `server/tidy.js` | Drops filler sounds (uh, um) and collapses stutters (m-moved to moved) |
| Chunk | `server/chunk.js` | Splits words into phrases |
| Roles | `server/roles.js` | Picks key words and big words |
| Cut out | `server/segment.js` | MODNet portrait matting, only while a big word is on screen |
| Compose | `server/pipeline.js` | Writes a HyperFrames project |
| Animate | `runtime/captions.js` | One GSAP timeline from the timestamps; places big words against the outline |
| Render | `hyperframes render` | Captures frames in headless Chrome and encodes the MP4 |

### Phrases

Filler sounds are dropped first, and a stutter like "m-moved" reads "moved". Boundaries come only from the transcript, so a 10 second clip and a 3 minute talk use the same code. A phrase ends at a pause over 350 ms, a sentence end, a comma after three words, or when it is full (four words, or the characters that fit on one line). Lines never end on weak words like "the", short leftovers are rebalanced, and words sharing a timestamp are spread one frame apart.

### The default look

| Element | Measured from the reference |
|---|---|
| Caption line | Montserrat Bold, 6.94 percent of the short edge, white, faint shadow, one to four words |
| Active word | `#FEE300` with a translucent yellow box |
| Key words | Anton capitals at 1.11 times line size, at least one per sentence of three or more words |
| Big words | Anton capitals at 29.8 percent of frame width, about one per 10 seconds, nouns, English words or numbers, never brands |

Full measurements are in [docs/eclipse-spec.md](docs/eclipse-spec.md). The look lives in `styles/default` (`style.json` and `style.css`), so changing it means editing data, not code. Custom is a validated set of overrides on it (`customizeStyle` in `server/pipeline.js`); each font is bundled with its measured glyph width so line breaking stays correct.

### Text behind the speaker

The head covers 55 percent of a long word's height; a short word such as a number tucks a third of its width behind the head. If the cut-out fails, finds nobody, or the head is too low or touches the top edge, the word goes into the caption line with a warning.

The cut-out is [MODNet](https://github.com/ZHKKKe/MODNet) (portrait matting, Apache 2.0), run in-process with onnxruntime. The 25 MB model is downloaded on first use to `~/.cache/captions` and checked against a pinned hash. Only the seconds with a big word are processed, in one pass at the model's 512 px, and the matte is applied to full-resolution frames. Results are cached. It replaced hyperframes' `u2net_human_seg`, which lost the head for half a second at a time on the sports interview, so a big word showed in front of the face. MODNet kept the head solid on every frame and runs at about 130 ms a frame on CPU instead of 700 ms.

The head's height is measured ignoring spikes a few columns wide, such as a hair tuft or a raised finger. A big word is never left up across a camera cut: it is shown on the side of the cut where it is spoken, or in the caption line if that leaves less than half a second.

### Following the speaker

The head is located twice a second with the cut-out model on small frames (once a second past a minute). The crop holds still while the head stays within 12 percent of the crop's centre, pans at most 0.35 crop widths a second when it drifts out, and jumps on a camera cut found by ffmpeg's scene score. On the sports interview the camera pans as the speaker talks: a fixed crop left him at the frame edge, and his big word ended up across his face.

### Hinglish

When the transcript contains Devanagari, `server/romanize.js` converts it to creator spellings (मैंने to maine, वालों to walon) using a dictionary plus rules.

## Testing

1. Unit tests (`npm test`, 40 tests): phrases, roles, romanizer, timestamps, filler cleanup, the following crop, custom style validation. No video or key needed.
2. Rule checks (`node tools/check.mjs jobs/<id>`) on any composed job: big words partly but never mostly hidden, every fallback explained, text inside the frame, the right word highlighted at each timestamp, a key word in every sentence.
3. Pixel comparison with the reference (`tools/measure/abtest.mjs`, `hyperframes snapshot --against`).

### Unseen clips

Tuned on the reference only, then run unchanged on Creative Commons clips from Wikimedia Commons (not committed): [Jacob Markstrom interview](https://commons.wikimedia.org/wiki/File:Jacob_Markstrom_interview_(1).webm) (rinkside93, CC BY 3.0), [Interview with Jeff Nippard](https://commons.wikimedia.org/wiki/File:Interview_with_Jeff_Nippard_%E2%80%93_Science_communication_and_neck_training_(science-based_bodybuilding).webm) (JPS Health & Fitness, CC BY 3.0), [Wikipedia 20, Darya and Avner](https://commons.wikimedia.org/wiki/File:Wikipedia_20_-_Darya_%26_Avner.webm) (Wikimedia Foundation, CC BY-SA 3.0).

| Clip | Hard because | 9:16 result | Big words behind | Highlight sync | Key words |
|---|---|---|---|---|---|
| Reference, reframed to landscape | Speaker off centre | Cropped on her head | 5 of 5 | 136 of 136 | 11 of 11 |
| Markstrom | Extreme close-up | Whole frame, blurred fill | 0 of 4, all moved to the line with a warning | 158 of 158 | 6 of 6 |
| Nippard | Two people, overlapping speech | Follows one person, never swings to the other | 4 of 4 | 166 of 166 | 16 of 16 |
| Darya and Avner | Mostly cutaways, 8 camera cuts | Follows the speaker, jumps on each cut | 1 of 1 | 37 of 37 | 4 of 4 |

Nippard and Darya and Avner were rerun with the second version (the samples in `samples/output/`). Nippard also caught a regression on the way: the first following crop swung between the two men, because it followed whichever head was highest. It now tells two people apart from a camera move (two people alternate, a move goes one way) and stays on the main one.

### Checking against the reference

The reference reel is client footage and not in the repo. Put it in `reference/` (gitignored) and run:

```bash
npm run caption -- reference/eclipse.mp4 --keyterms "Astrotalk" --no-render
node tools/measure/abtest.mjs jobs/<job-id> reference/eclipse.mp4 22.9,27.0,28.9,46.0,47.9
npx hyperframes snapshot jobs/<job-id> --at 22.9,28.9,47.9 --against reference/eclipse.mp4
```

Three of the five big words match the reference's choices (PISCES, SPECIFICALLY, 12); the other two can be changed in the editor.

## Samples

`samples/output/` holds the two interview renders on the landing page ([credits](samples/CREDITS.md)). `samples/input/synthetic-portrait.mp4` ships with its transcript, so the pipeline runs without a key.

## Performance

On a 4-core i7-1165G7 with 8 GB of RAM (`node tools/timeit.mjs <video>` prints each step's time):

| Clip | Before | Now | Where it went |
|---|---|---|---|
| 20 s sports interview | 5 min 23 s | 2 min 34 s | Cut-out 68 s to 8 s (MODNet), render 230 s to 130 s (parallel capture) |
| 78 s sports interview | | 7 min | Render 356 s, cut-out 30 s for 8 big words |

HyperFrames pins one capture worker on machines with 8 GB or less. The pipeline runs up to 3, as many as the free memory allows. A parallel render that fails (Chrome timing out on a busy machine) is resumed with one worker. Transcription starts as soon as the audio exists, while the video is still being cropped. HyperFrames' Lambda renderer is the next step for batch work.

## Security

- Server keys live only in the gitignored `.env` and never reach the browser.
- Uploads are limited by type and size (1 GB), then checked with ffprobe for a video stream and a 10 minute limit.
- Transcript edits change only word text and roles. Style settings are validated against fixed formats and a font allowlist before the upload is read.
- The server listens on 127.0.0.1 unless `HOST` is set.
- Uploads are re-encoded to H.264 with a keyframe every second, so phone HEVC files preview reliably.

## Decisions and trade-offs

| Choice | Reason | Alternative |
|---|---|---|
| HyperFrames | Plain HTML and GSAP, deterministic, Apache 2.0 | Remotion: React only, company licence |
| ElevenLabs Scribe v2 | Punctuated word timestamps, Hindi, key terms, about $0.22 per hour | Whisper, with punctuation re-attached |
| No framework, database or queue | Single-user tool with a handful of routes | A queue with Lambda rendering |
| 9:16 crop that follows with a dead zone | Still most of the time, yet keeps the speaker framed through camera pans | A fixed crop, which lost the speaker to the frame edge |
| MODNet via onnxruntime | Kept the head solid where u2net lost it, about 5 times faster on CPU | hyperframes' built-in `u2net_human_seg` |
