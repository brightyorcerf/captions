# captions

![The captions landing page](docs/hero.png)

Upload a video, get scroll-stopping captions back as an MP4.

Captions is a caption engine built for the Glido Labs round 2 take-home. It transcribes a video word by word, splits the words into short on-screen phrases, highlights each word as it is spoken, and renders the result with HyperFrames. There are two looks:

- Default, measured from the Eclipse reference reel. Key words are set in a bold display font, and one big word every few seconds sits behind the speaker's head.
- Custom, which is the default look with your own highlight colour, one of three caption fonts, and key words behind the speaker switched on or off.

```
upload > ffmpeg > ElevenLabs Scribe or Whisper > phrases and key words > speaker cut-out > HyperFrames > MP4
         audio    word timestamps                 3 to 4 word lines     only for big words  HTML + GSAP
```

## Most impressive parts of this project

- Text behind the speaker works on any video, not just the reference. For each big word, the pipeline cuts the speaker out of the frame and records the outline of their head every tenth of a second. The word is then placed against that outline: the head covers 55 percent of a long word's height, and a short word such as a number tucks a third of its width behind the head. These rules were measured once on the reference and hold wherever the speaker stands and however they move.
- The look was measured, not eyeballed. Fonts were identified by comparing pixels of words cut from the reference against candidate fonts, colours were sampled, and big-word timing and placement were tracked frame by frame. Our captions land within 4 to 20 pixels of the reference. The full spec is in [docs/eclipse-spec.md](docs/eclipse-spec.md).
- It never fails silently. If the speaker cannot be cut out, nobody is found, or the head is too low or touches the top of the frame, that word moves into the caption line instead of covering the speaker's face, and the editor explains why and offers a retry.
- Any video becomes a vertical 9:16 reel. The speaker's head is found in 12 sampled frames and the frame is cropped around it. Close-ups and videos with nobody in them are shown whole over a blurred fill instead of being cropped into an enlarged face.
- It was tested on clips it was never tuned on. A rule checker runs on any rendered job, and it passes on three Creative Commons clips with very different framing (see Testing). The first run on those clips found five bugs, all fixed.
- Hinglish is spelled the way creators write it. The transcriber returns Hindi in Devanagari script; a romanizer converts it to the Latin spellings creators use, and all 55 Hindi words in the reference match its own captions.
- It is careful with paid credits. Each video is transcribed once and cached, anything over five minutes is refused unless confirmed, every paid call is logged with a running total, and the samples ship with their transcripts so they run without a key. Visitors can also paste their own ElevenLabs key on the website.
- The preview is the render. The browser preview loads the same HTML file that HyperFrames renders, so what you approve is what you export. Renders are deterministic and work offline, because fonts and GSAP are pinned packages copied into each job.

## Challenges faced during the project

- The first version was called generic. A reviewer said the output did not match the reference closely enough. Instead of adjusting by eye, I measured the reference frame by frame. A description of the style from an AI vision model claimed Poppins, a gold highlight, grey inactive words and a thick black outline; the measurements contradicted all four, so it was not used.
- Identifying the fonts. The first font comparison gave every candidate the same score, because fonts loaded from local file paths never actually rendered in the headless browser. Embedding the fonts directly in the test page fixed it, and Montserrat and Anton won clearly.
- Placement that only worked on one video. The first text-behind-speaker version read the head position from a single frame and used fixed screen positions tuned to the reference. Rewriting it around the speaker's outline in every frame made it work on other framings. One measurement was also wrong at first: the reference's "12" is partly hidden by her head, so its visible width understated how far it tucks behind the head.
- Renders that froze on an 8 GB laptop. Two separate causes looked like one problem. Cut-out clips declared durations with floating point tails (1.4000000000000021 seconds), so the renderer waited forever for a frame that did not exist. Separately, a single long-running Chrome grew until the machine ran out of memory. The fix was to declare durations in whole frames and to capture long videos in 10 second segments with a fresh browser for each.
- Clips the system had never seen. Running three unfamiliar clips exposed a crop centred on the wall between two people, a close-up blown up into a giant face, a background-removal model that returns nothing for extreme close-ups, a video tool that rejected an unusual frame rate, and transcripts with several words sharing one timestamp, which meant those words were never highlighted on screen.
- Fast talkers. When someone speaks quickly, a big word was visible for only half a second and its highlight flashed for a quarter of a second. Big words now stay on screen for at least 0.9 seconds, the shortest duration in the reference, while the caption line continues underneath.
- Hindi transcription. The transcriber returns Hindi in Devanagari, while Hinglish reels are captioned in Latin script. The romanizer needed rules for silent vowels, long vowels at word ends, Hindi number words (barah becomes 12), and punctuation such as the danda.
- Limited credits. Development reused cached transcripts wherever possible. Transcribing all three test clips cost 1.6 minutes of audio, once.

## Quick start

You need Node 22 or later and ffmpeg on your PATH.

| OS | Install ffmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg`, or unzip a [gyan.dev build](https://www.gyan.dev/ffmpeg/builds/) and add its bin folder to PATH |
| Linux | `sudo apt install ffmpeg` |

```bash
npm install
cp .env.example .env    # optional: add ELEVENLABS_API_KEY or OPENAI_API_KEY
npm start               # http://localhost:3030
```

If there is no key in `.env`, paste an ElevenLabs key into the field on the upload page. The key is sent in a request header with that upload only, kept in memory for that job, and never written to disk, logged or sent back.

On the upload page, choose Default or Custom, and 9:16 vertical or the original frame. After the first render, click a word in the transcript to fix its spelling, or right-click it to cycle between normal, key word and big word behind the speaker. Re-rendering does not call the transcription API again.

## Command line

The CLI runs the same pipeline without the browser.

```bash
npm run caption -- samples/input/*.mp4 --out out/
npm run caption -- talk.mp4 --language hi --keyterms "Glido,FramesNFlights"
npm run caption -- talk.mp4 --accent "#ff4d6d" --font poppins --no-behind
npm run caption -- wide.mp4 --layout original
```

| Flag | Effect |
|---|---|
| `--keyterms` | Brand names. They are spelled correctly by the transcriber, always shown as in-line key words, and never placed behind the speaker. |
| `--layout 9:16` or `--layout original` | The default is 9:16, cropped around the speaker. |
| `--accent`, `--font`, `--no-behind` | Custom look: highlight colour as `#rrggbb`, caption font (`montserrat`, `inter` or `poppins`), and no words behind the speaker. |
| `--yes` | Allows sending more than `MAX_STT_MINUTES` (default 5) of audio to the paid API. |
| `--strict` | Exits with an error if any big word could not go behind the speaker. |
| `--no-render` | Stops after building the composition, for inspection with `tools/check.mjs` or `hyperframes snapshot`. |

If a file named `clip.transcript.json` sits next to `clip.mp4`, it is used instead of the API. Outputs are named `<video>.default.mp4`, or `<video>.custom.mp4` when a custom setting is passed.

## How it works

| Step | File | What it does |
|---|---|---|
| Upload | `server/index.js` | Streams the upload to disk with type and size checks. Plain `node:http`, no framework. |
| Audio | `server/pipeline.js` | Reads size, duration and rotation with ffprobe, extracts 16 kHz mono audio, and crops to 9:16 around the speaker. |
| Transcribe | `server/transcribe.js` | Calls ElevenLabs Scribe v2 or OpenAI Whisper and returns word timestamps. Results are cached by audio hash. |
| Chunk | `server/chunk.js` | Splits words into on-screen phrases. |
| Roles | `server/roles.js` | Picks key words and big words. Every pick can be changed in the editor. |
| Cut out | `server/pipeline.js` | Removes the background around the speaker, only while a big word is on screen. |
| Compose | `server/pipeline.js` | Writes a HyperFrames project: the source video, the caption layer, the data and the style. |
| Animate | `runtime/captions.js` | Builds one paused GSAP timeline from the timestamps and places big words against the speaker's outline. |
| Render | `hyperframes render` | Captures the page frame by frame in headless Chrome and encodes the MP4. |

### Phrases

Every boundary comes from the transcript. There are no frame numbers, so a 10 second clip and a 3 minute talk run through the same code.

1. A phrase ends at a pause longer than 350 ms, at the end of a sentence, or at a comma once it has at least three words.
2. A phrase also ends when it is full: four words, or as many characters as fit on one line. The character limit comes from the video width, the font size and the font's measured average glyph width.
3. A line never ends on a weak word such as "the" or "of"; that word moves to the next phrase.
4. A short leftover phrase is rebalanced with the one before it.
5. Words that the transcriber returns with the same timestamp are spread one frame apart, so each is highlighted on screen.

### The default look

| Element | Measured from the reference |
|---|---|
| Caption line | Montserrat Bold at 6.94 percent of the short edge, white, faint soft shadow, no outline, one to four words, appears and disappears without animation |
| Active word | Yellow `#FEE300` with a translucent yellow box 0.2 em around the letters |
| Key words | Anton in capitals, 1.11 times the line size, at least one per sentence of three or more words. Brand names are always key words. |
| Big words | Anton in capitals at 29.8 percent of the frame width, left aligned, behind the speaker's head. About one every 10 seconds, nouns, English words or numbers, never a brand. On screen for the length of their phrase and at least 0.9 seconds. |
| Layout | 1080 by 1920, cropped around the speaker |

The full measurements, the method and the comparison with the reference are in [docs/eclipse-spec.md](docs/eclipse-spec.md).

### Text behind the speaker

Background removal is the slowest step, so it is kept small:

- Only the moments when a big word is on screen are processed, which is a few seconds per minute of video.
- All of those moments go through one model run, because the model takes about 15 seconds to start.
- The model runs at half resolution and 15 fps. Its mask is then applied to the full resolution frames, so the speaker stays sharp.
- Results are cached, so editing a word re-renders without repeating the cut-out.

The speaker's outline from each cut-out goes into the composition, and `runtime/captions.js` places each word against it once the font has loaded. If the cut-out fails, finds nobody, or finds the head below the middle of the frame or touching its top edge, the word is shown in the caption line instead and the job carries a warning.

### Custom look

Custom is not a separate style. It is a set of overrides on the default style, checked on the server before the upload is read (`customizeStyle` in `server/pipeline.js`).

| Setting | Effect | Allowed values |
|---|---|---|
| Highlight | Colour of the active word and its box | `#rrggbb` |
| Font | Font of the caption line. Key words and big words stay in Anton. | Montserrat, Inter or Poppins. Each is bundled and its glyph width measured, so line breaking stays correct. |
| Key words behind speaker | When off, there are no big words and no cut-out | On or off |

The default look itself is a folder, `styles/default`, holding `style.json` (sizes, colours, timings, placement rules) and `style.css`. Changing the look means editing those files, not the code. The brief's alternative look, with a 1.2x pop and the previous word dimmed to 50 percent, is a change to two values: `motion.activeScale` and `motion.dimOpacity`.

### Hinglish

When the transcript contains Devanagari, `server/romanize.js` converts it to the Latin spellings creators use, for example मैंने to maine, मंगवाया to mangwaya and वालों to walon. It combines a dictionary of common words with rules for silent vowels, and its tests include every Hindi word in the reference.

## Testing

There are three layers, from cheapest to most realistic.

1. Unit tests (`npm test`, 30 tests) cover phrase splitting, key word picking, the romanizer, timestamp clean-up and custom style validation. They need no video and no API key.
2. Rule checks (`node tools/check.mjs jobs/<id>`) load a composed job in headless Chrome and check rules that hold for any video:
   - every big word is partly hidden by the speaker in every sampled frame, but never mostly hidden;
   - every word that could not go behind the speaker is listed with the reason;
   - all text stays inside the frame, and big words stay clear of the caption line;
   - at each word's timestamp, exactly that word is highlighted;
   - every sentence of three or more words has a key word.
3. A pixel comparison with the reference (`tools/measure/abtest.mjs` and `hyperframes snapshot --against`) reports how far our text lands from the reference's.

### Unseen clips

The rules were tuned on the reference only and then run unchanged on clips with different framing. The clips are Creative Commons footage from Wikimedia Commons and are not committed:

- [Jacob Markstrom interview](https://commons.wikimedia.org/wiki/File:Jacob_Markstrom_interview_(1).webm), by rinkside93, CC BY 3.0
- [Interview with Jeff Nippard](https://commons.wikimedia.org/wiki/File:Interview_with_Jeff_Nippard_%E2%80%93_Science_communication_and_neck_training_(science-based_bodybuilding).webm), by JPS Health & Fitness, CC BY 3.0
- [Wikipedia 20, Darya and Avner](https://commons.wikimedia.org/wiki/File:Wikipedia_20_-_Darya_%26_Avner.webm), by the Wikimedia Foundation, CC BY-SA 3.0

| Clip | What makes it hard | 9:16 result | Big words behind the speaker | Highlight sync | Key words |
|---|---|---|---|---|---|
| Reference, reframed to 1920 by 1080 with the speaker off centre | Landscape, speaker off centre | Cropped on her head | 5 of 5, 12 to 36 percent hidden | 136 of 136 | 11 of 11 |
| Markstrom, 640 by 360 | Extreme close-up, head cut off by the top edge | Whole frame over a blurred fill | 0 of 4. All moved to the line with a warning, because there is no room above the head. | 158 of 158 | 6 of 6 |
| Nippard, 854 by 480 | Two people side by side, overlapping speech | Cropped on one person | 4 of 4, 9 to 15 percent hidden | 167 of 167 | 16 of 16 |
| Darya and Avner, 15 seconds | Mostly cutaway shots and screen captures | Cropped on the speaker | 1 of 1 | 37 of 37 | 4 of 4 |

### Checking against the reference

The Eclipse reference reel is client footage, so it is not in the repo. Put it in `reference/` (gitignored) and run:

```bash
npm run caption -- reference/eclipse.mp4 --keyterms "Astrotalk" --no-render
node tools/measure/abtest.mjs jobs/<job-id> reference/eclipse.mp4 22.9,27.0,28.9,46.0,47.9
npx hyperframes snapshot jobs/<job-id> --at 22.9,28.9,47.9 --against reference/eclipse.mp4
```

On the reference, every Hindi word is spelled as the reference spells it, the caption line lands within 5 pixels of the reference, and big words land within 4 to 20 pixels, behind her head. Three of the five big words are the same words at the same moments (PISCES, SPECIFICALLY and 12). The reference chose OBSIDIAN and TIGER for the other two; any word can be changed in the editor.

## Samples

`samples/output/` holds the renders shown on the landing page. Both are Creative Commons interviews from the test set, cropped to 9:16 with words behind the speaker. Credits are in [samples/CREDITS.md](samples/CREDITS.md).

`samples/input/synthetic-portrait.mp4` is a generated clip, synthetic speech over a gradient, with its transcript next to it, so the full pipeline can run without an API key.

## Performance

On a 4-core Intel i7-1165G7 laptop with 8 GB of RAM running Windows, the 50 second reference renders in about 5 minutes, and a 40 second interview with four big words takes about 4 to 6 minutes including the cut-out. Removing the background costs roughly 15 to 45 seconds per second of big words on screen, depending on the machine. Transcription takes a few seconds and happens once per video.

With 8 GB of RAM or less, HyperFrames uses one worker. A single long-running Chrome then grows until capture stalls, so videos longer than 20 seconds are captured in 10 second segments with a fresh browser each. More cores and memory mean faster renders, and HyperFrames' Lambda renderer is the next step for batch work.

## Security

- Server keys live only in `.env`, which is gitignored, and are never sent to the browser. A key typed on the website is used for that upload only and is never stored, logged or returned.
- Uploads are limited by file type and size (1 GB), then checked with ffprobe: there must be a video stream, and the video must be 10 minutes or shorter.
- Transcript edits can change word text and roles only. Timings stay on the server. Style names and custom settings are validated against fixed formats and a font allowlist before the upload is read.
- The server listens on 127.0.0.1 by default. Set `HOST` to expose it on a network.
- Uploads are re-encoded to H.264 with a keyframe every second, because phone HEVC files and files with sparse keyframes otherwise freeze or fail to preview.
- Generated compositions pass `hyperframes lint` with no errors or warnings.

## Decisions and trade-offs

| Choice | Reason | Alternative |
|---|---|---|
| HyperFrames | Plain HTML and GSAP, deterministic renders, Apache 2.0 licence. The preview page is the render input, so preview and export match. | Remotion, which is React only and needs a company licence |
| ElevenLabs Scribe v2 by default | Word timestamps with punctuation, more than 90 languages including Hindi, key terms for brand names, about $0.22 per hour | OpenAI Whisper, whose words come without punctuation, so it is re-attached from the full text |
| No framework, database or queue | A single-user tool with a handful of routes. Jobs live in memory and files on disk. | A queue with HyperFrames Lambda rendering, for many channels at once |
| Transcript cache | Editing a word or changing the look re-renders without another API call | None needed |
| Fixed 9:16 crop instead of following the speaker | A steady frame reads better than a jittery one, and talking heads rarely cross the frame | A smoothed, panning crop that follows the active speaker |
