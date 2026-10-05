// Devanagari -> Hinglish-style Latin ("मैंने लाइफ में" -> "maine life mein"), the way creators
// actually caption Hindi reels. Scribe may return Hindi audio in Devanagari; Eclipse wants Latin.
// ponytail: rule-based with a small dictionary of common words; an LLM pass would handle edge spellings.

const COMMON = {
  'है': 'hai', 'हैं': 'hain', 'में': 'mein', 'मैं': 'main', 'मैंने': 'maine', 'को': 'ko', 'के': 'ke', 'का': 'ka',
  'की': 'ki', 'ये': 'ye', 'यह': 'ye', 'वो': 'wo', 'वह': 'wo', 'और': 'aur', 'नहीं': 'nahi', 'था': 'tha', 'थी': 'thi',
  'थे': 'the', 'भी': 'bhi', 'लिए': 'liye', 'क्या': 'kya', 'तो': 'to', 'से': 'se', 'हम': 'hum', 'आप': 'aap', 'यार': 'yaar',
  'बहुत': 'bahut', 'अच्छा': 'accha', 'कुछ': 'kuch', 'एक': 'ek', 'हाँ': 'haan', 'हां': 'haan', 'जो': 'jo', 'ना': 'na',
  'क्योंकि': 'kyunki', 'उन्हीं': 'unhi', 'यानी': 'yaani',
};

// spoken numbers are shown as digits, like the reference ("बारह" -> 12). एक/दो are left alone: they also mean "a"/"give".
const NUMBERS = {
  'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11,
  'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15, 'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19,
  'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'पचास': 50, 'सौ': 100, 'हज़ार': 1000, 'हजार': 1000,
};

const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'w', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'rh', 'फ़': 'f',
};
const VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' };
const MATRAS = { 'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o' };
const VIRAMA = '्', NUKTA = '़', NASAL = new Set(['ं', 'ँ']), VISARGA = 'ः';
const DIGITS = '०१२३४५६७८९';

export const hasDevanagari = s => /[ऀ-ॿ]/.test(s);

function word(w) {
  if (NUMBERS[w]) return String(NUMBERS[w]);
  if (COMMON[w]) return COMMON[w];
  const ch = [...w.normalize('NFC')];
  // pass 1: syllables. v = vowel text, implicit = the inherent 'a' nobody wrote
  const syl = [];
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i];
    if (ch[i + 1] === NUKTA) c += ch[++i];
    if (CONS[c]) {
      const next = ch[i + 1];
      if (MATRAS[next]) { syl.push({ c: CONS[c], v: MATRAS[next], long: next === 'ा' }); i++; }
      else if (next === VIRAMA) { syl.push({ c: CONS[c], v: '' }); i++; }
      else syl.push({ c: CONS[c], v: 'a', implicit: true });
    } else if (VOWELS[c]) {
      // after another vowel: भाई bhai, हुआ hua, आएगा aayega (but हुए hue)
      const prev = syl.at(-1)?.v;
      let v = VOWELS[c];
      if (prev && c === 'आ') v = 'a';
      else if (prev && c === 'ई') v = 'i';
      else if (prev?.endsWith('a') && c === 'ए') v = 'ye';
      syl.push({ c: '', v });
    }
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
  // pass 3: creator conventions
  syl.forEach((x, i) => {
    const next = syl[i + 1];
    // a before a silent h: पहली pehli, रहना rehna (रहा keeps raha: its h is voiced)
    if (x.implicit && x.v === 'a' && next?.c === 'h' && !next.v && syl[i + 2]?.c) x.v = 'e';
    // long ee/oo only inside a word; at the end it's i/u: मीन meen, यानी yani
    if (i === last && x.c && (x.v === 'ee' || x.v === 'oo')) x.v = x.v === 'ee' ? 'i' : 'u';
  });
  // closed monosyllable: long aa (बार baar, बात baat); open stays short (था tha)
  const voiced = syl.filter(x => x.v);
  if (voiced.length === 1 && voiced[0].long && voiced[0] !== syl[last]) voiced[0].v = 'aa';
  return syl.map(x => x.c + x.v + (x.nasal ? 'n' : '')).join('');
}

/** Romanises one transcript token, keeping surrounding punctuation and capitalising if it starts a sentence. */
export function romanize(text, capitalise = false) {
  // the danda (।, U+0964) sits inside the Devanagari block but is punctuation: keep it out of the word
  const m = /^([^ऀ-ॣ०-ॿ]*)([ऀ-ॣ०-ॿ]+)(.*)$/u.exec(text);
  if (!m) return text.replace(/।/g, '.');
  const [, pre, core, post] = m;
  let r = word(core);
  if (capitalise) r = r[0].toUpperCase() + r.slice(1);
  return pre + r + post.replace(/।/g, '.');
}

/** In-place: romanise every Devanagari word; sentence starts get a capital, like the reference.
 *  Romanised words are flagged `hi` so role picking can tell Hindi from English-in-Hinglish. */
export function romanizeWords(words) {
  words.forEach((w, i) => {
    if (!hasDevanagari(w.text)) return;
    const hindi = /[ऀ-ॣ०-ॿ]/.test(w.text); // letters, not just a trailing danda ("Pisces।")
    const start = i === 0 || /[.!?।]$/.test(words[i - 1].text);
    w.text = romanize(w.text, start);
    if (hindi && !/^\d/.test(w.text)) w.hi = true;
  });
  return words;
}
