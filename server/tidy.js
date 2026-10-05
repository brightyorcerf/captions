// Captions read as the speaker meant, not as they stumbled: filler sounds are dropped and stutters
// collapsed before phrases are built. Timing is untouched; a dropped filler just leaves a gap.

const FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'uhm', 'erm', 'er', 'hmm', 'mm', 'mhm']);
// "re-read", "co-op": a short prefix repeated by the next part is a real word, not a stutter
const PREFIXES = new Set(['re', 'co', 'de', 'ex', 'bi', 'un', 'pre', 'non', 'sub', 'mid', 'pro']);
const SENTENCE_END = /[.!?…]["')\]]*$/;

const split = text => /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(text).slice(1);
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

/** "m-moved" -> "moved", "I-I" -> "I", "Th-the" -> "The"; "fifty-five", "so-so" and "re-read" stay. */
export function unstutter(core) {
  for (;;) {
    const m = /^(\p{L}{1,3})-(\p{L}.*)$/u.exec(core);
    if (!m) return core;
    const [, part, rest] = m, p = part.toLowerCase();
    if (PREFIXES.has(p) || !rest.toLowerCase().startsWith(p) || (rest.length === part.length && part.length > 1)) return core;
    core = part[0] === part[0].toUpperCase() ? capitalise(rest) : rest;
  }
}

/** @param {{text:string,start:number,end:number}[]} words  @returns a new array; the input is not changed */
export function tidyWords(words) {
  const out = [];
  let capNext = false;
  for (const w of words) {
    const [lead, core, trail] = split(w.text);
    if (FILLERS.has(core.toLowerCase())) {
      const prev = out.at(-1);
      // "...the games, uh." keeps its full stop: phrases and key words break on sentence ends
      if (prev && SENTENCE_END.test(trail) && !SENTENCE_END.test(prev.text)) prev.text = prev.text.replace(/[,;:—–]+$/, '') + trail.replace(/["')\]]+$/, '');
      // "Um, so we" starts a sentence: "So we"
      if (/^\p{Lu}/u.test(core) && (!prev || SENTENCE_END.test(prev.text))) capNext = true;
      continue;
    }
    const fixed = unstutter(core);
    out.push({ ...w, text: lead + (capNext ? capitalise(fixed) : fixed) + trail });
    capNext = false;
  }
  return out;
}
