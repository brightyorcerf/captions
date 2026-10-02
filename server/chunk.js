// Turns word-level timestamps into 3–5 word on-screen phrases.
// Every boundary comes from the transcript (punctuation, pauses, text width);
// there are no frame numbers anywhere, so any length of video works.

// Words a phrase should not end on ("going to the" / "next to")
const WEAK = new Set('a an the of to and or but in on at for with from by as my your our their his her its is are was be i'.split(' '));

const textLen = ws => ws.reduce((n, w) => n + w.text.length, 0) + ws.length - 1;
const bare = t => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

export const DEFAULTS = { minWords: 3, maxWords: 5, maxChars: 26, maxGap: 0.35, hold: 0.25 };

/**
 * @param {{text:string,start:number,end:number}[]} words
 * @returns {{start:number,end:number,wordIdx:number[]}[]}
 */
export function chunk(words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const groups = []; // { idx: number[], soft: boolean }  soft = split only because the phrase was full
  let cur = [];

  const push = soft => { if (cur.length) groups.push({ idx: cur, soft }); cur = []; };

  words.forEach((w, i) => {
    if (cur.length) {
      const prev = words[i - 1];
      const hard =
        w.start - prev.end > o.maxGap ||                       // speaker paused
        /[.!?…]["')\]]*$/.test(prev.text) ||                     // sentence ended
        (/[,;:—–]["')\]]*$/.test(prev.text) && cur.length >= o.minWords); // clause ended
      const ws = [...cur, i].map(k => words[k]);
      const full = cur.length >= o.maxWords || textLen(ws) > o.maxChars;

      if (hard) push(false);
      else if (full) {
        // don't strand "the"/"of" at the end of a line: carry it into the next phrase
        const carry = cur.length > 1 && WEAK.has(bare(words[cur.at(-1)].text)) ? [cur.pop()] : [];
        push(true);
        cur = carry;
      }
    }
    cur.push(i);
  });
  push(false);

  // Rebalance orphans after a forced split: [5][1] -> [3][3], or merge when it fits
  for (let g = 1; g < groups.length; g++) {
    const a = groups[g - 1], b = groups[g];
    if (!a.soft || b.idx.length >= o.minWords) continue;
    const all = [...a.idx, ...b.idx];
    if (all.length <= o.maxWords && textLen(all.map(k => words[k])) <= o.maxChars) {
      a.idx = all; a.soft = b.soft; groups.splice(g--, 1);
    } else {
      const cut = Math.ceil(all.length / 2);
      const left = all.slice(0, cut), right = all.slice(cut);
      if (textLen(left.map(k => words[k])) <= o.maxChars && textLen(right.map(k => words[k])) <= o.maxChars) {
        a.idx = left; b.idx = right;
      }
    }
  }

  // Timing: show from first word, hold briefly after the last, but always clear before the next phrase
  return groups.map(({ idx }, g) => {
    const start = words[idx[0]].start;
    const next = groups[g + 1] ? words[groups[g + 1].idx[0]].start : Infinity;
    return { start, end: Math.min(words[idx.at(-1)].end + o.hold, next), wordIdx: idx };
  });
}
