// Devanagari -> Hinglish-style Latin ("मैंने लाइफ में" -> "maine life mein"), the way creators
// actually caption Hindi reels. Scribe may return Hindi audio in Devanagari; Eclipse wants Latin.
// ponytail: rule-based with a small dictionary of common words; an LLM pass would handle edge spellings.

const COMMON = {
  'है': 'hai', 'हैं': 'hain', 'में': 'mein', 'मैं': 'main', 'मैंने': 'maine', 'को': 'ko', 'के': 'ke', 'का': 'ka',
  'की': 'ki', 'ये': 'ye', 'यह': 'yeh', 'वो': 'wo', 'वह': 'woh', 'और': 'aur', 'नहीं': 'nahi', 'था': 'tha', 'थी': 'thi',
  'थे': 'the', 'भी': 'bhi', 'लिए': 'liye', 'क्या': 'kya', 'तो': 'toh', 'से': 'se', 'हम': 'hum', 'आप': 'aap', 'यार': 'yaar',
  'बहुत': 'bahut', 'अच्छा': 'accha', 'कुछ': 'kuch', 'एक': 'ek', 'हाँ': 'haan', 'हां': 'haan', 'जो': 'jo', 'ना': 'na',
};

const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'w', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'rh', 'फ़': 'f',
};
const VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' };
const MATRAS = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o' };
const VIRAMA = '्', NUKTA = '़', NASAL = new Set(['ं', 'ँ']), VISARGA = 'ः';
const DIGITS = '०१२३४५६७८९';

export const hasDevanagari = s => /[ऀ-ॿ]/.test(s);

function word(w) {
  if (COMMON[w]) return COMMON[w];
  const ch = [...w.normalize('NFC')];
  // pass 1: syllables. v = vowel text, implicit = the inherent 'a' nobody wrote
  const syl = [];
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i];
    if (ch[i + 1] === NUKTA) c += ch[++i];
    if (CONS[c]) {
      const next = ch[i + 1];
      if (MATRAS[next]) { syl.push({ c: CONS[c], v: MATRAS[next] }); i++; }
      else if (next === VIRAMA) { syl.push({ c: CONS[c], v: '' }); i++; }
      else syl.push({ c: CONS[c], v: 'a', implicit: true });
    } else if (VOWELS[c]) syl.push({ c: '', v: VOWELS[c] });
    else if (NASAL.has(c) && syl.length) syl.at(-1).nasal = true;
    else if (c === VISARGA) syl.push({ c: 'h', v: '' });
    else if (DIGITS.includes(c)) syl.push({ c: String(DIGITS.indexOf(c)), v: '' });
    else syl.push({ c: c === '।' ? '.' : c, v: '' }); // latin, punctuation
  }
  // pass 2: schwa deletion, right to left. drop an implicit 'a' at the word end, then between a
  // vowel and a consonant+vowel ("पहली" -> pahli, "मंगवाया" -> mangwaya, "समझ" -> samajh)
  const last = syl.findLastIndex(x => x.c || x.v);
  for (let i = last; i > 0; i--) {
    const x = syl[i];
    if (!x.implicit || x.nasal) continue;
    if (i === last) x.v = '';
    else if (syl[i - 1].v && syl[i + 1]?.c && syl[i + 1].v) x.v = '';
  }
  return syl.map(x => x.c + x.v + (x.nasal ? 'n' : '')).join('');
}

/** Romanises one transcript token, keeping surrounding punctuation and capitalising if it starts a sentence. */
export function romanize(text, capitalise = false) {
  const m = /^([^ऀ-ॿ]*)([ऀ-ॿ]+)(.*)$/u.exec(text);
  if (!m) return text.replace(/।/g, '.');
  const [, pre, core, post] = m;
  let r = word(core);
  if (capitalise) r = r[0].toUpperCase() + r.slice(1);
  return pre + r + post.replace(/।/g, '.');
}

/** In-place: romanise every Devanagari word; sentence starts get a capital, like the reference. */
export function romanizeWords(words) {
  words.forEach((w, i) => {
    if (!hasDevanagari(w.text)) return;
    const start = i === 0 || /[.!?।]$/.test(words[i - 1].text);
    w.text = romanize(w.text, start);
  });
  return words;
}
