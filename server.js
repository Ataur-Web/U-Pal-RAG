'use strict';
require('dotenv').config();

const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const natural         = require('natural');
const { MongoClient } = require('mongodb');
const https           = require('https');
const crypto          = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (runs first, no dependencies) ────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'OK', ts: Date.now() });
});

// ── Knowledge base ────────────────────────────────────────────────────────
const knowledge = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'knowledge.json'), 'utf8')
);

// ═════════════════════════════════════════════════════════════════════════
//  DIALOGFLOW REST — Inline (no separate file, avoids Vercel bundle issues)
//  Uses Node built-ins only: https + crypto. No npm packages needed.
// ═════════════════════════════════════════════════════════════════════════

const DF_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || null;
let   DF_CREDS      = null;

if (DF_PROJECT_ID && process.env.GOOGLE_CREDENTIALS) {
  try {
    DF_CREDS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    console.warn('[Dialogflow] Could not parse GOOGLE_CREDENTIALS:', e.message);
  }
}

// Token cache
let _dfToken  = null;
let _dfExpiry = 0;

function _b64url(data) {
  const s = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _makeJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const hdr  = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pay  = _b64url(JSON.stringify({
    iss: creds.client_email, sub: creds.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/dialogflow',
    iat: now, exp: now + 3600
  }));
  const unsigned = `${hdr}.${pay}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${_b64url(sign.sign(creds.private_key))}`;
}

function _fetchToken(jwt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req  = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const p = JSON.parse(raw);
          if (p.error) return reject(new Error(p.error_description || p.error));
          resolve(p);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function _getToken() {
  if (_dfToken && Date.now() < _dfExpiry) return _dfToken;
  const res = await _fetchToken(_makeJwt(DF_CREDS));
  _dfToken  = res.access_token;
  _dfExpiry = Date.now() + (res.expires_in - 300) * 1000;
  return _dfToken;
}

function _httpsPost(hostname, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}` }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function dfDetect(text, sessionId) {
  if (!DF_CREDS || !DF_PROJECT_ID) return null;
  try {
    const token  = await _getToken();
    const urlPath = `/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;
    const result = await _httpsPost('dialogflow.googleapis.com', urlPath,
      { queryInput: { text: { text, languageCode: 'en' } } }, token);
    if (result.error) throw new Error(result.error.message);
    const qr   = result.queryResult;
    const name = qr?.intent?.displayName;
    const conf = qr?.intentDetectionConfidence || 0;
    if (!name || name.startsWith('Default') || conf < 0.30) return null;
    if (!knowledge.find(i => i.tag === name)) return null;
    return { tag: name, confidence: conf, needsClarification: conf < 0.50 };
  } catch (e) {
    console.warn('[Dialogflow] REST error — using local fallback:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  NLP PRE-PROCESSING
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
  const norm     = text.toLowerCase().replace(/[^\w\u00C0-\u024F\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens   = tokenizer.tokenize(norm) || norm.split(/\s+/);
  const stopSet  = lang === 'cy' ? CY_STOP : EN_STOP;
  const filtered = tokens.filter(t => t.length > 1 && !stopSet.has(t));
  const stemmed  = lang === 'en' ? filtered.map(t => natural.PorterStemmer.stem(t)) : filtered;
  return stemmed.join(' ');
}

// ═════════════════════════════════════════════════════════════════════════
//  WELSH LANGUAGE DETECTION
// ═════════════════════════════════════════════════════════════════════════

const WELSH_WORDS = new Set([
  'sut','beth','ble','pryd','pam','pwy','faint','pa',
  'sydd','mae','oes','ydy','yw','wyt','bydd','gallaf','gallwch','gall',
  'hoffwn','hoffech','allaf','allech','allwch','ydych','ydw',
  'gyda','drwy','trwy','dros','rhwng','oherwydd','achos',
  'shwmae','diolch','hwyl','iawn','cymraeg','cymru','pcydds',
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

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-z\u00C0-\u024F\s']/g, ' ').split(/\s+/);
  let count = 0;
  for (const w of words) { if (WELSH_WORDS.has(w)) count++; }
  return count >= 2 ? 'cy' : 'en';
}

// ═════════════════════════════════════════════════════════════════════════
//  TF-IDF + NAIVE BAYES (local fallback)
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
    bayesClassifier.addDocument(preprocess(pattern, detectLanguage(pattern)), intent.tag);
  });
});
bayesClassifier.train();

const THRESHOLD_FALLBACK = 0.05;
const THRESHOLD_CLARIFY  = 0.18;

function findBestIntent(msg, lang) {
  const processed = preprocess(msg, lang);
  let tfidfScore = 0, tfidfIndex = -1;
  tfidf.tfidfs(processed, (i, score) => {
    if (score > tfidfScore) { tfidfScore = score; tfidfIndex = i; }
  });
  if (tfidfIndex === -1 || tfidfScore < THRESHOLD_FALLBACK) return null;
  const tfidfTag = intentMap[tfidfIndex];
  let bayesTag = null;
  try { bayesTag = bayesClassifier.classify(processed); } catch (_) {}
  const boost      = bayesTag && bayesTag === tfidfTag ? 1.35 : 1.0;
  const finalScore = tfidfScore * boost;
  return { tag: tfidfTag, score: finalScore, needsClarification: finalScore < THRESHOLD_CLARIFY };
}

// ═════════════════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═════════════════════════════════════════════════════════════════════════

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

const CLARIFICATION = {
  en: "I want to make sure I help you correctly. Are you asking about admissions, courses, fees, accommodation, IT support, campus locations, wellbeing, the library, or something else?",
  cy: "Rwyf am wneud yn siŵr fy mod yn eich helpu'n gywir. Ydych chi'n gofyn am dderbyniadau, cyrsiau, ffioedd, llety, cymorth TG, lleoliadau campws, lles, y llyfrgell, neu rywbeth arall?"
};

// ═════════════════════════════════════════════════════════════════════════
//  SAFETY OVERRIDE — runs before all NLP
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
    const { message, sessionId } = req.body;
    if (!message || typeof message !== 'string')
      return res.status(400).json({ error: 'message is required' });

    const raw          = message.trim();
    const detectedLang = detectLanguage(raw);
    const altLang      = detectedLang === 'cy' ? 'en' : 'cy';
    const session      = sessionId || crypto.randomUUID();

    // 1. Safety override
    if (isCrisis(raw)) {
      return res.json({
        response:    getResponse('wellbeing_crisis', detectedLang),
        altResponse: getResponse('wellbeing_crisis', altLang),
        tag: 'wellbeing_crisis', lang: detectedLang, confidence: 1.0
      });
    }

    // 2. Dialogflow (primary)
    const dfResult = await dfDetect(raw, session);
    if (dfResult) {
      if (dfResult.needsClarification) {
        return res.json({
          response: CLARIFICATION[detectedLang], altResponse: CLARIFICATION[altLang],
          tag: 'clarification', lang: detectedLang, confidence: dfResult.confidence
        });
      }
      return res.json({
        response:    getResponse(dfResult.tag, detectedLang),
        altResponse: getResponse(dfResult.tag, altLang),
        tag: dfResult.tag, lang: detectedLang, confidence: dfResult.confidence, source: 'dialogflow'
      });
    }

    // 3. Local TF-IDF + Bayes (fallback)
    const result = findBestIntent(raw, detectedLang);
    if (!result) {
      return res.json({
        response: FALLBACK[detectedLang], altResponse: FALLBACK[altLang],
        tag: 'fallback', lang: detectedLang, confidence: 0
      });
    }
    if (result.needsClarification) {
      return res.json({
        response: CLARIFICATION[detectedLang], altResponse: CLARIFICATION[altLang],
        tag: 'clarification', lang: detectedLang, confidence: result.score
      });
    }
    return res.json({
      response:    getResponse(result.tag, detectedLang),
      altResponse: getResponse(result.tag, altLang),
      tag: result.tag, lang: detectedLang, confidence: result.score, source: 'local'
    });

  } catch (err) {
    console.error('[/api/chat] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  MONGODB FEEDBACK
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
//  ADMIN AUTH
// ═════════════════════════════════════════════════════════════════════════

function requireAdminAuth(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.status(503).json({ error: 'Admin access not configured.' });
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

app.get('/api/feedback', requireAdminAuth, async (req, res) => {
  try { res.json(await readFeedback()); }
  catch (err) { res.status(500).json({ error: 'Could not read feedback' }); }
});

app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="U-Pal Admin"');
  res.status(401).json({ message: 'Logged out' });
});

// ── Start ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`U-Pal running at http://localhost:${PORT}`));
}

module.exports = app;
