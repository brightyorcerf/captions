// Picks which words get special treatment in Eclipse:
//   'callout'  – one big word at the top of the frame, behind the speaker
//   'emphasis' – condensed uppercase inside the caption line
// Heuristic only: long, capitalised or sentence-final content words win. The editor can override any choice.

// English + romanised Hindi function words that never deserve emphasis
const STOP = new Set(`a an the of to and or but in on at for with from by as is are was were be been it this that these those
i you he she we they my your our their his her its me him us them so just very really then than there here what which who
hai hain ka ki ke ko se mein me ye yeh wo woh aur toh to bhi na nahi tha thi the kya jo liye par pe ek koi kuch sab
maine mujhe hum tum aap apne apna apni unhi unka uska iska yaar bas abhi`.split(/\s+/));

const bare = t => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function score(words, i) {
  const t = words[i].text;
  const b = bare(t);
  if (b.length < 5 || STOP.has(b)) return 0;
  const sentenceStart = i === 0 || /[.!?…]["')\]]*$/.test(words[i - 1].text);
  const capital = /^\p{Lu}/u.test(t) && !sentenceStart; // proper noun / brand
  return b.length + (capital ? 3 : 0) + (/[.!?]$/.test(t) ? 1 : 0);
}

const ROLE_DEFAULTS = { calloutMin: 8, calloutGap: 6, emphasisMin: 7 };

/**
 * Mutates words: sets word.role = 'callout' | 'emphasis' (or deletes it).
 * @param {{text:string,start:number}[]} words
 * @param {{wordIdx:number[]}[]} phrases
 */
export function assignRoles(words, phrases, opts = {}) {
  const o = { ...ROLE_DEFAULTS, ...opts };
  let lastCallout = -Infinity, prevEmphasis = false;
  for (const w of words) delete w.role;

  phrases.forEach((p, n) => {
    const [best] = p.wordIdx.map(i => [i, score(words, i)]).sort((a, b) => b[1] - a[1]);
    if (!best || best[1] === 0) { prevEmphasis = false; return; }
    const [i, s] = best;
    if (o.callout !== false && n > 0 && s >= o.calloutMin && words[i].start - lastCallout >= o.calloutGap) {
      words[i].role = 'callout';
      lastCallout = words[i].start;
      prevEmphasis = false;
    } else if (s >= o.emphasisMin && !prevEmphasis) {
      words[i].role = 'emphasis';
      prevEmphasis = true;
    } else prevEmphasis = false;
  });
  return words;
}
