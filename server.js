'use strict';
require('dotenv').config();

const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const natural         = require('natural');
const { MongoClient } = require('mongodb');
const crypto          = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  let ollamaStatus = 'not_configured';
  if (OLLAMA_URL) {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      ollamaStatus = r.ok ? 'connected' : 'error';
    } catch {
      ollamaStatus = 'offline';
    }
  }
  res.json({
    status: 'OK',
    ollama: ollamaStatus,
    model: OLLAMA_MODEL,
    intents: knowledge.length
  });
});

// ── Knowledge base ─────────────────────────────────────────────────────────
const knowledge = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'knowledge.json'), 'utf8')
);

// ═════════════════════════════════════════════════════════════════════════
//  NLP PRE-PROCESSING
//  Normalisation → Tokenization → Stop-word removal → Stemming
// ═════════════════════════════════════════════════════════════════════════

const tokenizer = new natural.WordTokenizer();

const EN_STOP = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'to','of','in','on','at','for','with','by','from','about','into','through',
  'i','me','my','we','our','you','your','he','his','she','her','it','its','they','their',
  'what','which','who','this','that','these','those','am','not','no','so','if','or',
  'and','but','how','when','where','why','please','want','need','help','tell','know',
  'get','like','just','also','more','some','any','all','very','really','actually',
  'im','ive','id','ill','cant','dont','doesnt','isnt','arent','wasnt','wont','havent'
]);

const CY_STOP = new Set([
  'y','yr','a','ac','ar','at','i','o','am','dan','dros','drwy','heb','tan','wrth',
  'yn','ym','yng','eu','ein','ei','fy','dy','eich','yw','ydy','mae','oedd','roedd',
  'bydd','fydd','bod','oes','sydd','sy','hefyd','dim','nid','os','neu','ond','fel',
  'pan','nad','rwy','rwyf','rydw','dw','dwi','chi','ni','nhw','fe','hi','ef'
]);

function preprocess(text, lang) {
  const norm     = text.toLowerCase()
    .replace(/[^\w\u00C0-\u024F\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens   = tokenizer.tokenize(norm) || norm.split(/\s+/);
  const stopSet  = lang === 'cy' ? CY_STOP : EN_STOP;
  const filtered = tokens.filter(t => t.length > 1 && !stopSet.has(t));
  const stemmed  = lang === 'en'
    ? filtered.map(t => natural.PorterStemmer.stem(t))
    : filtered;
  return stemmed.join(' ');
}

// ═════════════════════════════════════════════════════════════════════════
//  WELSH / ENGLISH AUTO-DETECTION
// ═════════════════════════════════════════════════════════════════════════

const WELSH_WORDS = new Set([
  // Question words
  'sut','beth','ble','pryd','pam','pwy','faint','pa',
  // Verbs
  'sydd','mae','oes','ydy','yw','wyt','bydd','gallaf','gallwch','gall',
  'hoffwn','hoffech','allaf','allech','allwch','ydych','ydw',
  // Prepositions / particles
  'gyda','drwy','trwy','dros','rhwng','oherwydd','achos',
  // Greetings / expressions
  'shwmae','diolch','hwyl','iawn','cymraeg','cymru','pcydds',
  // Unique Welsh vocabulary
  'myfyriwr','myfyrwyr','prifysgol','cwrs','cyrsiau','llety','llyfrgell',
  'gofynion','mynediad','ffioedd','cymorth','lles','anabledd',
  'graddio','canlyniadau','amserlen','argraffu','gwasanaethau',
  'eisiau','isio','moyn','angen','wneud','mynd','dod','cael',
  'siarad','ysgrifennu','darllen','helpu','gofyn','ateb',
  'cyfeiriad','cyswllt','ymgeisio','derbyniadau','benthyciad',
  'ysgoloriaeth','bwrsari','neuaddau','preswyl','campysau',
  'graddau','marciau','arholiad','aseiniad','tymor','modiwl',
  'darlith','darlithydd','tiwtorial','adborth','cofrestru'
]);

// Words that are unambiguously Welsh — a single one is enough to flip.
// (Things like 'iawn' overlap with English 'I own' transcriptions so they
// stay in WELSH_WORDS and need count>=2, but 'shwmae' / 'diolch' etc never
// appear in English text and should flip the conversation on their own.)
const WELSH_STRONG = new Set([
  'shwmae','shwmai','shw','helo','helô',
  'diolch','diolchwch','diolchus',
  'hwyl','hwylfawr',
  'bore','prynhawn','noswaith','nos','da',
  'dwi','rwyf','dwin','wyt','ydw','ydy','yw',
  'cymraeg','cymru','pcydds',
  'myfyriwr','myfyrwyr','prifysgol','llyfrgell','llety',
  'ffioedd','bwrsari','bwrsariaeth','neuaddau','preswyl',
  'cwrs','cyrsiau','modiwl','darlith','darlithydd','tiwtorial',
  'aseiniad','arholiad','graddio','cofrestru',
  'anabledd','dyslecsia','lles','cymorth',
  'caerfyrddin','abertawe','llambed','caerdydd',
  // Common sentence particles and demonstratives
  'hyn','hynny','hwn','honno','yna','yma',
  // 'n-clitics (common in spoken Welsh)
  "hynny'n","dwi'n","rwy'n","ti'n","wedi'n","mae'n",
  // Frequently mutated common words — hard to detect otherwise
  'ddefnyddiol','defnyddiol','angenrheidiol','gwybodaeth',
  'fwrdd','ddim','fawr','yn',
  // Common Welsh verbs/nouns in student context
  'rhaglen','myfyriwr','astudio','darllen','ysgrifennu',
  'ymgeisio','derbyn','dewis','dechrau','gorffen',
]);

// Common English words that almost never appear in Welsh — used as a
// positive English signal so we can recognise English sentences even when
// they don't contain the -ing/-tion suffix.
const ENGLISH_HINTS = new Set([
  // Pronouns + question words
  'how','where','when','why','what','which','who','whose',
  'you','your','yours','my','mine','our','ours','their',
  'this','that','these','those','there','here',
  // Verbs and auxiliaries (English-specific forms)
  'can','could','would','should','will','shall','may','might','must',
  'do','does','did','doing','done',
  'have','has','had','having',
  'is','are','was','were','been','being',
  'get','got','getting','make','makes','made','take','took',
  // Common English prepositions/conjunctions
  'the','with','from','about','into','onto','over','under',
  'because','though','although','while','unless','until',
  // Common request/help vocabulary
  'help','helps','helping','please','thanks','thank','hello','hi','hey',
  'need','needs','want','wants','looking','find','tell','show',
  'know','knows','say','says','said','actually','really','very',
  // University-context English
  'apply','application','hardship','bursary','accommodation','library',
  'financial','english','welsh','explain','question','answer',
]);

function detectLanguage(text, runningLang) {
  const lower = text.toLowerCase();
  const words = lower
    .replace(/[^a-z\u00C0-\u024F\s']/g, ' ').split(/\s+/).filter(Boolean);
  let welshTotal = 0, welshStrong = 0, englishHits = 0;
  for (const w of words) {
    if (WELSH_STRONG.has(w))   { welshStrong++; welshTotal++; continue; }
    if (WELSH_WORDS.has(w))    { welshTotal++; continue; }
    if (ENGLISH_HINTS.has(w))  { englishHits++; }
  }

  // Welsh-diacritic check — ŵ/ŷ/â/ê/ô/û appear in Welsh but never in English.
  const hasWelshDiacritic = /[ŵŷâêîôûẁỳẃýÿï]/i.test(text);

  // -ing / -tion morphology is an English-only signal.
  const englishMorph = (lower.match(/\b[a-z]+(ing|tion)\b/g) || []).length;
  const englishSignal = englishHits + englishMorph;

  // Clear Welsh signal wins (diacritic, single strong word, or multiple matches).
  if (welshStrong >= 1 && welshStrong >= englishSignal) return 'cy';
  if (hasWelshDiacritic) return 'cy';
  if (welshTotal >= 2 && englishSignal === 0) return 'cy';

  // Clear English signal wins.
  if (englishSignal >= 1 && welshTotal === 0) return 'en';
  if (englishSignal > welshTotal) return 'en';

  // Genuinely ambiguous (e.g. "ok", "yes", or a word we don't recognise).
  // Stay with the running conversation language so short replies feel natural.
  if (runningLang === 'cy' || runningLang === 'en') return runningLang;

  return 'en';
}

// ═════════════════════════════════════════════════════════════════════════
//  INTENT CLASSIFICATION — TF-IDF + Naive Bayes
// ═════════════════════════════════════════════════════════════════════════

const tfidf     = new natural.TfIdf();
const intentMap = [];

knowledge.forEach(intent => {
  intent.patterns.forEach(pattern => {
    tfidf.addDocument(preprocess(pattern, detectLanguage(pattern)));
    intentMap.push(intent.tag);
  });
});

const bayesClassifier = new natural.BayesClassifier();
knowledge.forEach(intent => {
  intent.patterns.forEach(pattern => {
    bayesClassifier.addDocument(
      preprocess(pattern, detectLanguage(pattern)), intent.tag
    );
  });
});
bayesClassifier.train();

const THRESHOLD_FALLBACK = 0.05;
const THRESHOLD_CLARIFY  = 0.18;

function findBestIntent(msg, lang) {
  const processed = preprocess(msg, lang);
  let best = 0, bestIdx = -1;
  tfidf.tfidfs(processed, (i, score) => {
    if (score > best) { best = score; bestIdx = i; }
  });
  if (bestIdx === -1 || best < THRESHOLD_FALLBACK) return null;
  const tag = intentMap[bestIdx];
  let bayesTag = null;
  try { bayesTag = bayesClassifier.classify(processed); } catch (_) {}
  const score = best * (bayesTag === tag ? 1.35 : 1.0);
  return { tag, score, needsClarification: score < THRESHOLD_CLARIFY };
}

// ─── Response helpers ──────────────────────────────────────────────────────
function getResponse(tag, lang) {
  const intent = knowledge.find(i => i.tag === tag);
  if (!intent) return null;
  const pool = intent.responses[lang] || intent.responses['en'];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Get top N matching intents for richer context to send to Ollama
function getTopIntents(msg, lang, n = 3) {
  const processed = preprocess(msg, lang);
  const scores = [];
  tfidf.tfidfs(processed, (i, score) => scores.push({ i, score }));
  scores.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const results = [];
  for (const { i, score } of scores) {
    const tag = intentMap[i];
    if (!seen.has(tag) && score > 0.05) {
      seen.add(tag);
      const intent = knowledge.find(k => k.tag === tag);
      if (intent) results.push({ tag, score, intent });
    }
    if (results.length >= n) break;
  }
  return results;
}

const FALLBACK = {
  en: "I'm not sure I understand that. Could you rephrase? You can ask me about admissions, courses, fees, accommodation, campus locations, IT support, wellbeing, or the library.",
  cy: "Nid wyf yn siŵr fy mod yn deall hynny. Allwch chi aileirio? Gallwch ofyn i mi am dderbyniadau, cyrsiau, ffioedd, llety, lleoliadau campws, cymorth TG, lles, neu'r llyfrgell."
};

const CLARIFICATION = {
  en: "I want to make sure I help you correctly. Are you asking about admissions, courses, fees, accommodation, IT support, campus locations, wellbeing, the library, or something else?",
  cy: "Rwyf am wneud yn siŵr fy mod yn eich helpu'n gywir. Ydych chi'n gofyn am dderbyniadau, cyrsiau, ffioedd, llety, cymorth TG, lleoliadau campws, lles, y llyfrgell, neu rywbeth arall?"
};

// ═════════════════════════════════════════════════════════════════════════
//  OLLAMA INTEGRATION
//  Ollama runs on the dev machine and is exposed via a Cloudflare tunnel.
//  Set OLLAMA_URL in Vercel env vars. If not set, we fall back to
//  pre-written responses from knowledge.json — the site works either way.
// ═════════════════════════════════════════════════════════════════════════

const OLLAMA_URL   = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

async function askOllama(userMessage, context, lang) {
  if (!OLLAMA_URL) return null; // not configured — use pre-written responses

  const langInstruction = lang === 'cy'
    ? 'You MUST reply entirely in Welsh (Cymraeg). Use natural, friendly Welsh.'
    : 'Reply in English. Be warm and conversational.';

  const system = `You are U-Pal, a friendly student support assistant for the University of Wales Trinity Saint David (UWTSD / PCYDDS).
${langInstruction}
Answer the student's question using ONLY the information in the CONTEXT section below.
Keep your reply to 2-4 short sentences. Sound like a helpful person, not a robot.
If the context does not cover what the student asked, say so honestly and suggest they contact Student Services.
Never invent phone numbers, email addresses, URLs, or facts not in the context.`;

  const prompt = `CONTEXT:\n${context}\n\nSTUDENT QUESTION: ${userMessage}\n\nAnswer:`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        system,
        stream: false,
        options: { temperature: 0.4, num_predict: 300 }
      })
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.response || '').trim() || null;
  } catch (e) {
    // Ollama is offline or tunnel is down — silent fallback
    console.warn('[Ollama] unavailable:', e.message);
    return null;
  }
}

function buildContext(topIntents, lang) {
  return topIntents.map(({ intent }) => {
    const responses = intent.responses[lang] || intent.responses['en'] || [];
    return responses.join(' ');
  }).join('\n\n');
}

// ═════════════════════════════════════════════════════════════════════════
//  CRISIS SAFETY OVERRIDE — always runs before NLP
// ═════════════════════════════════════════════════════════════════════════

const CRISIS_KEYWORDS = [
  'going to die','want to die','wanna die','want to kill myself','kill myself',
  'end my life','end it all','take my life','take my own life',
  'dont want to live',"don't want to live","don't want to be alive",
  'no reason to live','not worth living','life not worth',
  'thinking about suicide','thinking of suicide','suicidal','suicide',
  'self harm','self-harm','selfharm','hurt myself','harm myself',
  'overdose','cutting myself','in crisis','mental health crisis',
  'having a breakdown','cant cope anymore',"can't cope anymore",
  'breaking down','losing my mind',
  'eisiau marw','eisiau lladd fy hun','lladd fy hun','diwedd fy mywyd',
  'meddyliau hunanladdol','hunan-niweidio','hunan niweidio',
  'argyfwng','alla i ddim ymdopi'
];

function isCrisis(text) {
  const lower = text.toLowerCase();
  return CRISIS_KEYWORDS.some(kw => lower.includes(kw));
}

// ═════════════════════════════════════════════════════════════════════════
//  CHAT ENDPOINT
// ═════════════════════════════════════════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  try {
    const { message, runningLang } = req.body;
    if (!message || typeof message !== 'string')
      return res.status(400).json({ error: 'message is required' });

    const raw  = message.trim();
    const lang = detectLanguage(raw, runningLang);
    const alt  = lang === 'cy' ? 'en' : 'cy';

    // 1. Safety override — crisis phrases always bypass Ollama
    if (isCrisis(raw)) {
      return res.json({
        response:    getResponse('wellbeing_crisis', lang),
        altResponse: getResponse('wellbeing_crisis', alt),
        tag: 'wellbeing_crisis', lang, confidence: 1.0, source: 'safety'
      });
    }

    // 2. Intent classification
    const result = findBestIntent(raw, lang);

    // No match at all
    if (!result) {
      return res.json({
        response: FALLBACK[lang], altResponse: FALLBACK[alt],
        tag: 'fallback', lang, confidence: 0, source: 'fallback'
      });
    }

    // 3. Get top matching intents for context
    const topIntents = getTopIntents(raw, lang, 3);
    const context    = buildContext(topIntents, lang);

    // 4. Try Ollama first — it generates a natural response grounded in context
    if (OLLAMA_URL && context) {
      const ollamaReply = await askOllama(raw, context, lang);
      if (ollamaReply) {
        // Ollama succeeded — send its natural reply
        return res.json({
          response:    ollamaReply,
          altResponse: null, // Ollama handles the language directly
          tag:         result.tag,
          lang,
          confidence:  result.score,
          source:      'ollama'
        });
      }
      // Ollama failed/offline — fall through to pre-written responses below
    }

    // 5. Pre-written response fallback (also used when Ollama isn't configured)
    if (result.needsClarification) {
      return res.json({
        response: CLARIFICATION[lang], altResponse: CLARIFICATION[alt],
        tag: 'clarification', lang, confidence: result.score, source: 'clarification'
      });
    }

    return res.json({
      response:    getResponse(result.tag, lang),
      altResponse: getResponse(result.tag, alt),
      tag:         result.tag,
      lang,
      confidence:  result.score,
      source:      'knowledge'
    });

  } catch (err) {
    console.error('[/api/chat]', err.message);
    return res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  FEEDBACK — MongoDB or local file fallback
// ═════════════════════════════════════════════════════════════════════════

const MONGODB_URI   = process.env.MONGODB_URI;
const FEEDBACK_FILE = path.join(process.env.VERCEL ? '/tmp' : __dirname, 'feedback.json');
let   mongoClient   = null;

async function getCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
  }
  return mongoClient.db('upal-rag').collection('feedback');
}

async function saveFeedback(entry) {
  if (MONGODB_URI) {
    const col = await getCollection();
    await col.insertOne(entry);
  } else {
    let existing = [];
    if (fs.existsSync(FEEDBACK_FILE))
      existing = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    existing.push(entry);
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(existing, null, 2), 'utf8');
  }
}

async function readFeedback() {
  if (MONGODB_URI) {
    const col = await getCollection();
    return col.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).toArray();
  }
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')).reverse();
}

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN
// ═════════════════════════════════════════════════════════════════════════

function requireAdminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).json({ error: 'Admin access not configured.' });
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const [, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (password !== pw) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  next();
}

app.post('/api/feedback', async (req, res) => {
  const { satisfaction, correctLanguage, helpfulAnswer, comments } = req.body;
  if (!satisfaction) return res.status(400).json({ error: 'satisfaction is required' });
  const entry = {
    timestamp:       new Date().toISOString(),
    satisfaction:    Math.min(5, Math.max(1, Number(satisfaction))),
    helpfulAnswer:   helpfulAnswer === true || helpfulAnswer === false ? helpfulAnswer : null,
    correctLanguage: correctLanguage === true || correctLanguage === false ? correctLanguage : null,
    comments:        comments ? String(comments).slice(0, 300) : ''
  };
  try {
    await saveFeedback(entry);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

app.get('/api/feedback', requireAdminAuth, async (req, res) => {
  try { res.json(await readFeedback()); }
  catch (err) { res.status(500).json({ error: 'Could not read feedback' }); }
});

app.get('/admin', requireAdminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/logout', (_req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
  res.status(401).json({ message: 'Logged out' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`U-Pal running on http://localhost:${PORT}`));
}

module.exports = app;
