require('dotenv').config();
const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const natural         = require('natural');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Knowledge base ────────────────────────────────────────────────────────
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, 'knowledge.json'), 'utf8'));

// ═════════════════════════════════════════════════════════════════════════
//  STEP 1 — NLP PRE-PROCESSING
//  Tokenization → Stop-word removal → Stemming / Lemmatization → Normalisation
// ═════════════════════════════════════════════════════════════════════════

const tokenizer = new natural.WordTokenizer();

// English stop words
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

// Welsh stop words
const CY_STOP = new Set([
  'y','yr','a','ac','ar','at','i','o','am','dan','dros','drwy','heb','tan','wrth',
  'yn','ym','yng','eu','ein','ei','fy','dy','eich','yw','ydy','mae','oedd','roedd',
  'bydd','fydd','bod','oes','sydd','sy','hefyd','dim','nid','os','neu','ond','fel',
  'pan','nad','rwy','rwyf','rydw','dw','dwi','chi','ni','nhw','fe','hi','ef'
]);

/**
 * Full NLP pre-processing pipeline (matches Fig. 2 flowchart):
 * 1. Normalisation  — lowercase, strip punctuation (preserve Welsh diacritics)
 * 2. Tokenization   — WordTokenizer
 * 3. Stop-word removal — language-aware
 * 4. Stemming/Lemmatization — PorterStemmer for English; Welsh kept as-is
 */
function preprocess(text, lang) {
  // 1. Normalisation
  const norm = text
    .toLowerCase()
    .replace(/[^\w\u00C0-\u024F\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Tokenization
  const tokens = tokenizer.tokenize(norm) || norm.split(/\s+/);

  // 3. Stop-word removal
  const stopSet = lang === 'cy' ? CY_STOP : EN_STOP;
  const filtered = tokens.filter(t => t.length > 1 && !stopSet.has(t));

  // 4. Stemming (English only — PorterStemmer is not suitable for Welsh morphology)
  const stemmed = lang === 'en'
    ? filtered.map(t => natural.PorterStemmer.stem(t))
    : filtered;

  return stemmed.join(' ');
}

// ═════════════════════════════════════════════════════════════════════════
//  WELSH LANGUAGE DETECTION
// ═════════════════════════════════════════════════════════════════════════

// Only words that are DISTINCTLY Welsh — never appear as standalone English words.
// Short ambiguous words ('i','am','o','a','ar','yn','da','ac','y','yr','gan','nos','bore')
// are intentionally excluded to prevent false-positive Welsh detection on English sentences.
const WELSH_WORDS = new Set([
  // Question words (uniquely Welsh)
  'sut','beth','ble','pryd','pam','pwy','faint','pa',
  // Verbs (uniquely Welsh)
  'sydd','mae','oes','ydy','yw','wyt','bydd','gallaf','gallwch','gall',
  'hoffwn','hoffech','allaf','allech','allwch','ydych','ydw',
  // Prepositions / particles (long enough to be unambiguous)
  'gyda','drwy','trwy','dros','rhwng','oherwydd','achos',
  // Greetings / expressions
  'shwmae','diolch','hwyl','iawn','cymraeg','cymru','pcydds',
  // Unique Welsh vocabulary
  'myfyriwr','myfyrwyr','prifysgol','cwrs','cyrsiau','llety','llyfrgell',
  'gofynion','mynediad','ffioedd','cymorth','lles','anabledd',
  'graddio','canlyniadau','amserlen','argraffu','gwasanaethau',
  'dwyieithog','cyfrwng','gyfrwng','ardderchog','gwych','perffaith',
  'eisiau','isio','moyn','angen','wneud','mynd','dod','cael','bod',
  'siarad','ysgrifennu','darllen','gwneud','helpu','gofyn','ateb',
  'cyfeiriad','cyswllt','ymgeisio','derbyniadau','benthyciad',
  'ysgoloriaeth','bwrsari','neuaddau','preswyl','campysau',
  'graddau','marciau','arholiad','aseiniad','tymor','modiwl','modiwlau',
  'darlith','darlithydd','tiwtorial','adborth','cofrestru','cofrestriad',
  'prynhawn','wythnos','blwyddyn','rwan','heddiw','fory',
  'ewch','helpwch','fy','dy','eu','ein','eich','nid','hefyd','dim'
]);

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-z\u00C0-\u024F\s']/g, ' ').split(/\s+/);
  let count = 0;
  for (const w of words) { if (WELSH_WORDS.has(w)) count++; }
  // Require at least 2 distinctly Welsh tokens to avoid false positives
  // on English sentences that happen to contain one ambiguous short word
  return count >= 2 ? 'cy' : 'en';
}

// ═════════════════════════════════════════════════════════════════════════
//  STEP 2 — SENTENCE VECTORIZATION  (TF-IDF)
//  STEP 3 — INTENT CLASSIFICATION   (TF-IDF + Naive Bayes combined)
// ═════════════════════════════════════════════════════════════════════════

const tfidf     = new natural.TfIdf();
const intentMap = [];

// Train TF-IDF on preprocessed patterns
knowledge.forEach(intent => {
  intent.patterns.forEach(pattern => {
    const patLang = detectLanguage(pattern);
    tfidf.addDocument(preprocess(pattern, patLang));
    intentMap.push(intent.tag);
  });
});

// Train Naive Bayes classifier (secondary scorer)
const bayesClassifier = new natural.BayesClassifier();
knowledge.forEach(intent => {
  intent.patterns.forEach(pattern => {
    const patLang = detectLanguage(pattern);
    bayesClassifier.addDocument(preprocess(pattern, patLang), intent.tag);
  });
});
bayesClassifier.train();

// ── Confidence thresholds (Dialogflow-style) ──────────────────────────────
const THRESHOLD_FALLBACK  = 0.05;  // below → no intent recognised → fallback
const THRESHOLD_CLARIFY   = 0.18;  // below → low confidence → ask clarification

/**
 * findBestIntent — combines TF-IDF vectorization with Naive Bayes classification.
 * Returns: { tag, score, needsClarification } or null (fallback)
 */
function findBestIntent(msg, lang) {
  const processed = preprocess(msg, lang);

  // TF-IDF scoring
  let tfidfScore = 0, tfidfIndex = -1;
  tfidf.tfidfs(processed, (i, score) => {
    if (score > tfidfScore) { tfidfScore = score; tfidfIndex = i; }
  });

  if (tfidfIndex === -1 || tfidfScore < THRESHOLD_FALLBACK) return null;

  const tfidfTag = intentMap[tfidfIndex];

  // Naive Bayes — if it agrees with TF-IDF, boost confidence score
  let bayesTag = null;
  try { bayesTag = bayesClassifier.classify(processed); } catch (_) {}
  const boost      = bayesTag && bayesTag === tfidfTag ? 1.35 : 1.0;
  const finalScore = tfidfScore * boost;

  return {
    tag:               tfidfTag,
    score:             finalScore,
    needsClarification: finalScore < THRESHOLD_CLARIFY
  };
}

// ── Response helpers ──────────────────────────────────────────────────────
function getResponse(tag, lang) {
  const intent = knowledge.find(i => i.tag === tag);
  if (!intent) return null;
  const pool = intent.responses[lang] || intent.responses['en'];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Fallback — shown when no intent recognised (below THRESHOLD_FALLBACK)
const FALLBACK = {
  en: "I'm not sure I understand that. Could you rephrase? You can ask me about admissions, courses, fees, accommodation, campus locations, IT support, wellbeing, or the library.",
  cy: "Nid wyf yn siŵr fy mod yn deall hynny. Allwch chi aileirio? Gallwch ofyn i mi am dderbyniadau, cyrsiau, ffioedd, llety, lleoliadau campws, cymorth TG, lles, neu'r llyfrgell."
};

// Clarification — shown when intent is low-confidence (between thresholds)
const CLARIFICATION = {
  en: "I want to make sure I help you correctly. Are you asking about admissions, courses, fees, accommodation, IT support, campus locations, wellbeing, the library, or something else?",
  cy: "Rwyf am wneud yn siŵr fy mod yn eich helpu'n gywir. Ydych chi'n gofyn am dderbyniadau, cyrsiau, ffioedd, llety, cymorth TG, lleoliadau campws, lles, y llyfrgell, neu rywbeth arall?"
};

// ═════════════════════════════════════════════════════════════════════════
//  CHAT ENDPOINT
//  Flow: Pre-process → Vectorize → Classify → Recognised? → Response
// ═════════════════════════════════════════════════════════════════════════
app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message is required' });

  const raw          = message.trim();
  const detectedLang = detectLanguage(raw);           // auto-detect every time
  const altLang      = detectedLang === 'cy' ? 'en' : 'cy';
  const result       = findBestIntent(raw, detectedLang);

  // ── Is Intent Recognised? — NO → Fallback ────────────────────────────
  if (!result) {
    return res.json({
      response:    FALLBACK[detectedLang],
      altResponse: FALLBACK[altLang],
      tag: 'fallback', lang: detectedLang, confidence: 0
    });
  }

  // ── Is Intent Recognised? — LOW confidence → Ask Clarification ───────
  if (result.needsClarification) {
    return res.json({
      response:    CLARIFICATION[detectedLang],
      altResponse: CLARIFICATION[altLang],
      tag: 'clarification', lang: detectedLang, confidence: result.score
    });
  }

  // ── Intent Recognised — Generate Response ────────────────────────────
  res.json({
    response:    getResponse(result.tag, detectedLang),
    altResponse: getResponse(result.tag, altLang),
    tag:         result.tag,
    lang:        detectedLang,
    confidence:  result.score
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  MONGODB FEEDBACK STORAGE
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
//  ADMIN AUTH MIDDLEWARE
// ═════════════════════════════════════════════════════════════════════════
function requireAdminAuth(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword)
    return res.status(503).json({ error: 'Admin access not configured.' });

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const [, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (password !== adminPassword) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  next();
}

// ── Feedback POST ─────────────────────────────────────────────────────────
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
    console.error('Feedback save error:', err.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// ── Feedback GET (admin only) ─────────────────────────────────────────────
app.get('/api/feedback', requireAdminAuth, async (req, res) => {
  try {
    res.json(await readFeedback());
  } catch (err) {
    console.error('Feedback read error:', err.message);
    res.status(500).json({ error: 'Could not read feedback' });
  }
});

// ── Admin dashboard ───────────────────────────────────────────────────────
app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Logout ────────────────────────────────────────────────────────────────
app.get('/api/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
  res.status(401).json({ message: 'Logged out' });
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:  'OK',
  intents: knowledge.length,
  docs:    intentMap.length
}));

if (require.main === module) {
  app.listen(PORT, () => console.log(`U-Pal RAG running at http://localhost:${PORT}`));
}

module.exports = app;
