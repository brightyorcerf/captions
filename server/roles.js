// Picks which words get special treatment in the default style:
//   'callout'  – one big word at the top of the frame, behind the speaker
//   'emphasis' – condensed uppercase inside the caption line
// Heuristic only: long, capitalised or sentence-final content words win; brand names (keyterms) are always
// in-line keywords; every sentence gets at least one keyword. The editor can override any choice.

// English + romanised Hindi function words that never deserve emphasis
const STOP = new Set(`a an the of to and or but in on at for with from by as is are was were be been it this that these those
i you he she we they my your our their his her its me him us them so just very really then than there here what which who
hai hain ka ki ke ko se mein me ye yeh wo woh aur toh to bhi na nahi tha thi the kya jo liye par pe ek koi kuch sab
maine mujhe hum tum aap apne apna apni unhi unka uska iska yaar bas abhi`.split(/\s+/));

const bare = t => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function score(words, i) {
  const t = words[i].text;
  const b = bare(t);
  if (/^\d+$/.test(b)) return 20; // numbers make the strongest callouts ("12")
  if (b.length < 5 || STOP.has(b)) return 0;
  const sentenceStart = i === 0 || /[.!?…]["')\]]*$/.test(words[i - 1].text);
  const capital = /^\p{Lu}/u.test(t) && !sentenceStart; // proper noun / brand
  return b.length + (capital ? 3 : 0) + (/[.!?]$/.test(t) ? 1 : 0);
}

const ROLE_DEFAULTS = { calloutMin: 8, calloutGap: 6, emphasisMin: 7, sentencePause: 0.7, sentenceMin: 3 };

/**
 * Mutates words: sets word.role = 'callout' | 'emphasis' (or deletes it).
 * @param {{text:string,start:number}[]} words
 * @param {{wordIdx:number[]}[]} phrases
 */
export function assignRoles(words, phrases, opts = {}) {
  const o = { ...ROLE_DEFAULTS, ...opts };
  let prevEmphasis = false;
  for (const w of words) delete w.role;
  // brand names (the keyterms) stay in the line as keywords and never go behind the speaker
  // (reference: ASTROTALK is an in-line keyword; the words behind her are OBSIDIAN, TIGER, 12...)
  const brands = new Set((o.keyterms ?? []).map(bare).filter(Boolean));
  const isBrand = i => brands.has(bare(words[i].text));

  // Callouts are rationed: keep only the strongest candidates across the whole video (about one per
  // `calloutEvery` seconds, the reference's density), at least `calloutGap` apart, never the same word twice.
  // calloutLatinOnly: in Hinglish, callouts are English words or numbers (OBSIDIAN, TIGER, 12), never Hindi verbs.
  const calloutPhrases = new Set();
  if (o.callout !== false) {
    const duration = words.at(-1)?.end ?? 0;
    const budget = o.calloutEvery ? Math.max(1, Math.round(duration / o.calloutEvery)) : Infinity;
    const candidates = phrases.flatMap((p, n) => n === 0 ? [] : p.wordIdx
      .filter(i => !(o.calloutLatinOnly && words[i].hi) && !isBrand(i))
      .map(i => ({ i, n, s: score(words, i) })).filter(c => c.s >= o.calloutMin))
      .sort((a, b) => b.s - a.s || words[a.i].start - words[b.i].start);
    const picked = [], used = new Set();
    for (const c of candidates) {
      if (picked.length >= budget) break;
      if (calloutPhrases.has(c.n) || used.has(bare(words[c.i].text))) continue;
      if (picked.some(p => Math.abs(words[p.i].start - words[c.i].start) < o.calloutGap)) continue;
      picked.push(c); used.add(bare(words[c.i].text)); calloutPhrases.add(c.n);
      words[c.i].role = 'callout';
    }
  }

  const lineWords = p => p.wordIdx.filter(i => words[i].role !== 'callout');
  for (const p of phrases) for (const i of lineWords(p)) if (isBrand(i)) words[i].role = 'emphasis';

  // strong words: at most one per line, never on two lines in a row (unless a brand forced it)
  phrases.forEach((p, n) => {
    if (calloutPhrases.has(n) || lineWords(p).some(i => words[i].role)) { prevEmphasis = lineWords(p).some(i => words[i].role); return; }
    const [best] = lineWords(p).map(i => [i, score(words, i)]).sort((a, b) => b[1] - a[1]);
    if (best && best[1] >= o.emphasisMin && !prevEmphasis) {
      words[best[0]].role = 'emphasis';
      prevEmphasis = true;
    } else prevEmphasis = false;
  });

  // every sentence of 3+ words gets at least one keyword in the keyword font (reference: one or two per
  // sentence, none in "Ye dekho.").
  // A sentence ends at . ? ! or a long pause, so unpunctuated transcripts still get them.
  const lineIdx = phrases.flatMap(lineWords).sort((a, b) => a - b);
  let sentence = [];
  const close = () => {
    if (sentence.length >= o.sentenceMin && !sentence.some(i => words[i].role === 'emphasis')) {
      const [best] = sentence.map(i => [i, score(words, i)]).sort((a, b) => b[1] - a[1]);
      // all short words ("What was it like there?"): the longest one that isn't a function word
      const [plain] = sentence.map(i => [i, bare(words[i].text)]).filter(([, b]) => b.length >= 3 && !STOP.has(b))
        .sort((a, b) => b[1].length - a[1].length);
      const pick = best?.[1] > 0 ? best[0] : plain?.[0];
      if (pick !== undefined) words[pick].role = 'emphasis';
    }
    sentence = [];
  };
  lineIdx.forEach((i, k) => {
    const next = lineIdx[k + 1];
    if (sentence.length && words[i].start - words[sentence.at(-1)].end > o.sentencePause) close();
    sentence.push(i);
    if (/[.!?…]["')\]]*$/.test(words[i].text) || next === undefined) close();
  });
  return words;
}
