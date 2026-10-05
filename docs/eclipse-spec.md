# Eclipse: measured spec

Everything below was measured from the Eclipse reference reel (1080×1920, 30 fps, 50.2 s), not eyeballed.
The reel is client footage and is not committed. Put it at `reference/eclipse.mp4` to re-run the measurements.
Values in `styles/eclipse/style.json` and `style.css` come from this page.

## How it was measured

| What | Method | Script |
|---|---|---|
| Fonts | Crop single words from the reel, binarise them, then render each candidate font/weight with the same text. Normalise both to their ink bounding box and score pixel IoU. | `tools/measure/fontmatch.mjs` |
| Colours, shadow, stroke | Median of core glyph pixels (pixels whose neighbours are also text); luminance just outside glyph edges vs 30 px away | `tools/measure/pixels.mjs` |
| Callouts | Scan every frame of the top 45 % for white/yellow text ink, with static background whites removed. Report each callout's lifetime, bounding box and colour per frame. | `tools/measure/callouts.mjs` |
| Sizes | Ink width ÷ the font's measured ink width per em (canvas `measureText`) | — |
| Placement vs head | Callout bounding box vs the top of the speaker matte at the same moment | — |

## Fonts

| Text | Winner (IoU) | Runner-up | Not it |
|---|---|---|---|
| Caption line: "Kyunki", "hain", "lage", "crystals", "black" | **Montserrat 700**: 0.91–0.93, aspect within 1 % | Montserrat 600: 0.85–0.88 | Poppins 800/900 never made the top 3 |
| Keywords: MANGWANA, AVAILABLE, BRACELETS, LAZULI, ASTROTALK | **Anton 400**: 0.86–0.90 | Big Shoulders Display 900: 0.73–0.80 | Bebas Neue, Oswald, League Gothic |

## Caption line

| Property | Value |
|---|---|
| Font size | 75 px at 1080 wide = **6.94 % of the short edge** |
| Letter-spacing | none (aspect matches Montserrat 700 to within 1 %) |
| Gap between words (ink to ink) | about 39 px ≈ 0.52 em |
| Vertical position | ink centre at **77.9 %** of frame height |
| Horizontal | centred |
| Words per line | 1–4, one line |
| Inactive words | `#FFFFFF`, full opacity (measured `#FFFEFF`) |
| Shadow | soft and faint: pixels just under glyphs are about 20 % darker than the background. **No stroke.** |
| Enter / exit | **hard cut**: ink goes 0 → full in one frame, with no fade or slide |
| Between phrases | back-to-back phrases swap in one frame; the screen is empty during pauses |

## Active word

| Property | Value |
|---|---|
| Text colour | **`#FEE300`** (median of 3 words: `#FDE400`, `#FEE300`, `#FEE300`) |
| Box | translucent yellow rounded rectangle, about 15 px ≈ **0.2 em** padding around the ink, about 100 px tall (≈ 1.33 em) |
| Timing | on at the word's start timestamp, off when the next word starts |

## Keywords inside the line

| Property | Value |
|---|---|
| How many | about 15 of the reel's ~40 lines; every sentence of 3+ words has one or two, 2-word sentences ("Ye dekho.") have none |
| Which words | content words, Hindi included (MANGWAYA, RASHI, MANGWANA), and the **brand** (ASTROTALK): the brand stays in the line, it never goes behind the speaker |
| Font | Anton, uppercase |
| Size | about 84 px = **1.11 em** of the line |
| Letter-spacing | about **0.025 em** (ink is 2–4 % wider than Anton's default) |
| Colour | white, or yellow + box when active, like any word |

## Callouts (text behind the speaker)

| Time | Word | Lifetime | Width | Left edge | Top |
|---|---|---|---|---|---|
| 12.07–13.87 s | OBSIDIAN | 1.83 s | 87 % | 6.3 % | 15.4 % |
| 22.53–23.40 s | PISCES. | 0.90 s | 83 % | 8.1 % | 11.5 % |
| 25.40–26.63 s | TIGER | 1.27 s | 56 % | 5.6 % | 9.4 % |
| 28.33–29.30 s | SPECIFICALLY | 1.00 s | 90 % | 4.8 % | 24.0 % |
| 47.33–48.53 s | 12 | 1.23 s | 24 % | 11.1 % | 26.5 % |

| Property | Value |
|---|---|
| Font | Anton, uppercase, about 0.02 em letter-spacing |
| Size | **fixed at 0.298 × frame width** (about 322 px). It shrinks only when the word would exceed 90.6 % of the width (SPECIFICALLY). |
| Horizontal | **left-anchored at 6.5 %**. Long words fill the width and only look centred. |
| Vertical | the head hides the bottom **55 %** of the letters' height (PISCES: 0.54, measured against the speaker's outline under the word) |
| Narrow callouts (under 40 % of the width, e.g. **12**) | 1.22× bigger, beside the head rather than above it: **34 % of the word's width tucked behind the head's edge**, the top of the number level with the top of the head |
| Box when active | translucent yellow, about **0.2 em around the ink on every side**, the same rule as the line's active-word box. Behind SPECIFICALLY it spans almost the full width. |
| Caption line meanwhile | lifted about 0.8 em (measured 38–80 px higher than usual) |
| Layering | video → callout → cut-out speaker → caption line |
| Lifetime | **exactly its phrase**: appears when the phrase starts, disappears when it ends (0.9–1.8 s) |
| Enter / exit | **hard cut**, no animation while on screen (ink count is flat) |
| Colour | white → yellow `#FEE300` + translucent box while its word is spoken → white |
| Caption line content | shows the rest of the phrase; the callout word is lifted out of it but still counts toward the 4-word phrase limit ("jo [SPECIFICALLY]", "sare [12] rashiyon") |
| Numbers | spoken numbers are shown as digits (*barah* → **12**) |
| Word choice | nouns, product names, numbers and English words inside Hinglish (OBSIDIAN, PISCES, TIGER, SPECIFICALLY, 12); never Hindi verbs |
| Density | 5 in 50 s, so about one per 10 s; the strongest candidates win, at least 2.5 s apart, never the same word twice |

### As rules, for any video

The reference has one speaker, centred. To work on any clip, the placement is stated relative to the speaker, not the frame. For each callout window, the pipeline extracts the speaker's outline (the top of the person in each of 108 columns, every 1/10 s), and the runtime places the word against it once the font has loaded:

| Rule | Value | Token |
|---|---|---|
| Wide word: start at the left margin; shift right only if it would not reach the head | margin 6.5 % | `callout.left`, `callout.tuck` |
| Wide word: share of the letters' height hidden under the outline beneath the word | 55 % of the median outline; kept between 15 % and 85 % in every sampled frame when the speaker moves | `depth`, `minDepth`, `maxDepth` |
| Narrow word: beside the head on the left, or the right if that side has clearly more room (> 1.3×) | 34 % of its width behind the head edge, top level with the head top | `tuck`, `narrowOffset` |
| Readable: share of the word's area the speaker hides, in every sampled frame | 3–60 % (the reference: 12–36 %) | `minHidden`, `maxHidden` |
| No cut-out, no person found, head below mid-frame, or head touching the top edge | the word becomes an in-line keyword and the job gets a warning | — |

`tools/check.mjs` reports these per callout for any composed job.

## A/B result

`tools/measure/abtest.mjs` clones a composed job onto a black background with transparent cut-outs, snapshots it, and measures text ink boxes with the same thresholds as the reference.

```bash
npm run caption -- reference/eclipse.mp4 --style eclipse --keyterms "Astrotalk" --no-render
node tools/measure/abtest.mjs jobs/<job-id> reference/eclipse.mp4 22.9,27.0,28.9,46.0,47.9
```

Ours minus the reference, in pixels at 1080×1920 (the line rows are from before the keyword-density change, which re-split some phrases):

| Moment | Element | Δ left | Δ width | Δ top | Δ height |
|---|---|---|---|---|---|
| 27.0 s | line "crystals lage hue hain" | −5 | +10 | −2 | 0 |
| 46.0 s | line "Kyunki unki WEBSITE" | +4 | −3 | −1 | +6 |
| 47.9 s | line "sare rashiyon" | −2 | +4 | −22 | 0 |
| 22.9 s | callout PISCES. | −16 | −1 | +4 | −1 |
| 28.9 s | callout SPECIFICALLY | +20 | −1 | −14 | −2 |
| 47.9 s | callout 12 | +5 | n/a (the head hides part of the reference) | +6 | 0 |

Callout rows are from the outline-based placement above, which states every rule relative to the speaker rather than the frame.

Same callouts as the reference at the same moments: PISCES (22.2–23.6 s vs 22.5–23.4 s), SPECIFICALLY (28.3 s) and 12 (47.3–48.6 s vs 47.3–48.5 s). The other two picks are editorial: the reference chose OBSIDIAN and TIGER; the heuristic picks CRYSTALS and AESTHETIC (ASTROTALK is no longer a candidate: brand names stay in the line, as in the reference). Any word can be changed in the editor.

## Checked and rejected

An external description of the style (from a vision model) claimed Poppins ExtraBold/Black, a `#FFD700` highlight, grey or 60–70 % opacity inactive words, and a thick black stroke. The measurements above contradict all four.
