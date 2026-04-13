require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const natural    = require('natural');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Knowledge base + TF-IDF ───────────────────────────────────────────────
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, 'knowledge.json'), 'utf8'));

const tfidf     = new natural.TfIdf();
const intentMap = [];

knowledge.forEach(intent => {
  intent.patterns.forEach(pattern => {
    tfidf.addDocument(pattern.toLowerCase());
    intentMap.push(intent.tag);
  });
});

// ── Welsh detection ───────────────────────────────────────────────────────
const WELSH_WORDS = new Set([
  'sut','beth','ble','pryd','pam','pwy','sydd','mae','oes','ydy','yw','yn','ac','ar',
  'am','gyda','gan','yr','y','i','o','helo','shwmae','bore','prynhawn','nos','da',
  'diolch','hwyl','iawn','cymraeg','cymru','pcydds','ewch','helpwch','faint','pa','fy',
  'dy','ei','eu','ein','eich','wyt','wythnos','blwyddyn','myfyriwr','myfyrwyr','campws',
  'coleg','prifysgol','cwrs','cyrsiau','llety','llyfrgell','astudio','gofynion','mynediad',
  'cais','ffioedd','cymorth','lles','anabledd','graddio','canlyniadau','amserlen','argraffu',
  'gwasanaethau','dwyieithog','cyfrwng','gyfrwng','ardderchog','gwych','perffaith','nid',
  'neu','hefyd','dim','gallaf','gallwch','gall','bydd','eisiau','isio','moyn','angen',
  'hoffwn','hoffech','wneud','mynd','dod','cael','bod','siarad','ysgrifennu','darllen',
  'gwneud','helpu','gofyn','ateb','cyfeiriad','rhif','cyswllt','ymgeisio',
  'derbyniadau','benthyciad','ysgoloriaeth','bwrsari','neuaddau','preswyl','campysau',
  'graddau','marciau','arholiad','aseiniad'
]);

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-z\u00C0-\u024F\s']/g, ' ').split(/\s+/);
  let count = 0;
  for (const w of words) { if (WELSH_WORDS.has(w)) count++; }
  return count >= 1 ? 'cy' : 'en';
}

// ── Intent matching ───────────────────────────────────────────────────────
function findBestIntent(msg) {
  const query = msg.toLowerCase();
  let bestScore = 0, bestIndex = -1;
  tfidf.tfidfs(query, (i, score) => {
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  });
  if (bestIndex === -1 || bestScore < 0.05) return null;
  return { tag: intentMap[bestIndex], score: bestScore };
}

function getResponse(tag, lang) {
  const intent = knowledge.find(i => i.tag === tag);
  if (!intent) return null;
  const pool = intent.responses[lang] || intent.responses['en'];
  return pool[Math.floor(Math.random() * pool.length)];
}

const FALLBACK = {
  en: "I'm not sure I understand that. Could you rephrase? You can ask me about admissions, courses, fees, accommodation, campus locations, IT support, wellbeing, or the library.",
  cy: "Nid wyf yn siŵr fy mod yn deall hynny. Allwch chi aileirio? Gallwch ofyn i mi am dderbyniadau, cyrsiau, ffioedd, llety, lleoliadau campws, cymorth TG, lles, neu'r llyfrgell."
};

// ── Chat endpoint ─────────────────────────────────────────────────────────
app.post('/api/chat', (req, res) => {
  const { message, lang: forcedLang } = req.body;
  if (!message || typeof message !== 'string')
    return res.status(400).json({ error: 'message is required' });

  const detectedLang = forcedLang || detectLanguage(message.trim());
  const altLang      = detectedLang === 'cy' ? 'en' : 'cy';
  const result       = findBestIntent(message.trim());

  if (!result) {
    return res.json({
      response:    FALLBACK[detectedLang],
      altResponse: FALLBACK[altLang],
      tag: 'unknown', lang: detectedLang, confidence: 0
    });
  }

  res.json({
    response:    getResponse(result.tag, detectedLang),
    altResponse: getResponse(result.tag, altLang),
    tag:         result.tag,
    lang:        detectedLang,
    confidence:  result.score
  });
});

// ── MongoDB feedback storage ───────────────────────────────────────────────
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

// ── Admin auth middleware ──────────────────────────────────────────────────
function requireAdminAuth(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword)
    return res.status(503).json({ error: 'Admin access not configured.' });

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal RAG Admin"');
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const [, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (password !== adminPassword) {
    res.set('WWW-Authenticate', 'Basic realm="U-Pal RAG Admin"');
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  next();
}

// ── Feedback endpoints ────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { satisfaction, correctLanguage, helpfulAnswer, comments } = req.body;
  if (!satisfaction) return res.status(400).json({ error: 'satisfaction is required' });

  const entry = {
    timestamp:       new Date().toISOString(),
    satisfaction:    Math.min(5, Math.max(1, Number(satisfaction))),
    correctLanguage: Boolean(correctLanguage),
    helpfulAnswer:   Boolean(helpfulAnswer),
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

app.get('/api/feedback', requireAdminAuth, async (req, res) => {
  try {
    const data = await readFeedback();
    res.json(data);
  } catch (err) {
    console.error('Feedback read error:', err.message);
    res.status(500).json({ error: 'Could not read feedback' });
  }
});

// ── Admin dashboard ───────────────────────────────────────────────────────
app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Logout (clears browser Basic Auth cache) ──────────────────────────────
app.get('/api/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="U-Pal RAG Admin"');
  res.status(401).json({ message: 'Logged out' });
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'OK', intents: knowledge.length }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`U-Pal RAG running at http://localhost:${PORT}`));
}

module.exports = app;
