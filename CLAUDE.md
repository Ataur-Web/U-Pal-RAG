# U-Pal RAG — Claude Code Instructions

## What this project is
U-Pal is a **bilingual (Welsh / English) student assistant chatbot** for UWTSD (University of Wales Trinity Saint David). It uses a **TF-IDF + Naive Bayes RAG pipeline** — no LLM, no external AI API. All responses come from a hardcoded `knowledge.json` knowledge base.

The project is based on the Dialogflow chatbot architecture described in:
> *"Simplifying Student Queries: A Dialogflow-Based Conversational Chatbot for University Websites"*

---

## Tech stack
| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| NLP | `natural` npm library (TfIdf, BayesClassifier, PorterStemmer, WordTokenizer) |
| Knowledge base | `knowledge.json` — 42 intents, bilingual responses |
| Language detection | Custom `WELSH_WORDS` set in `server.js` |
| Feedback storage | MongoDB Atlas (env: `MONGODB_URI`) |
| Frontend | Vanilla HTML + Alpine.js 3.x |
| Fonts | Nunito + DM Mono (Google Fonts) |
| Deployment | Vercel (Node serverless) |
| GitHub | https://github.com/Ataur-Web/U-Pal-RAG |

---

## NLP Pipeline (matches Fig. 2 — Chatbot Flowchart)

```
User message
    │
    ▼
detectLanguage()          ← Welsh word-set matching, auto-detect always
    │
    ▼
preprocess(text, lang)    ← Step 1: NLP Pre-processing
  1. Normalisation        (lowercase, strip punctuation, preserve Welsh diacritics)
  2. Tokenization         (natural.WordTokenizer)
  3. Stop-word removal    (EN_STOP or CY_STOP depending on detected language)
  4. Stemming             (PorterStemmer for English only — NOT applied to Welsh)
    │
    ▼
findBestIntent()          ← Step 2+3: Vectorization + Classification
  - TF-IDF scoring        (natural.TfIdf trained on preprocessed patterns)
  - Naive Bayes           (natural.BayesClassifier — boosts score when it agrees)
    │
    ├── score < 0.05      → FALLBACK response  (intent not recognised)
    ├── score < 0.18      → CLARIFICATION      (ask clarification, low confidence)
    └── score ≥ 0.18      → getResponse()      (return matched bilingual response)
    │
    ▼
/api/chat response
  { response, altResponse, tag, lang, confidence }
```

---

## Key files

| File | Purpose |
|---|---|
| `server.js` | All backend logic: NLP pipeline, chat endpoint, feedback API, admin auth |
| `knowledge.json` | 42 intents with `tag`, `patterns` (EN+CY mixed), `responses.en[]`, `responses.cy[]` |
| `public/index.html` | Full chatbot UI — Alpine.js, Nunito font, bilingual, no emoji |
| `public/admin.html` | Admin feedback dashboard — stats, paginated table, CSV export |
| `vercel.json` | Vercel build config — includes `knowledge.json` in bundle |
| `.env.example` | Template: `PORT=3000`, `ADMIN_PASSWORD=` |

---

## Environment variables
| Variable | Where set | Purpose |
|---|---|---|
| `MONGODB_URI` | Vercel + local `.env` | MongoDB Atlas connection string |
| `ADMIN_PASSWORD` | Vercel + local `.env` | Protects `/admin` and `GET /api/feedback` |

**Never commit a `.env` file. The `.gitignore` already excludes it.**
No `ANTHROPIC_API_KEY` is used — this project has no LLM.

---

## Language detection rules
- Auto-detect on **every** message — no manual toggle
- A single recognised Welsh word in the input flips the response to Welsh
- The `WELSH_WORDS` set in `server.js` is the detection vocabulary
- `altResponse` (opposite language) is always returned alongside `response` for the translate button

---

## Admin dashboard
- URL: `/admin`
- Protected by HTTP Basic Auth — password is `ADMIN_PASSWORD` env var
- Username field: anything (only password is checked)
- Logout: `GET /api/logout` — returns 401 to clear browser Basic Auth cache

---

## Adding / editing intents
Edit `knowledge.json`. Each intent must have:
```json
{
  "tag": "unique_snake_case_id",
  "patterns": ["English question", "Welsh question", "Another phrase"],
  "responses": {
    "en": ["English answer 1", "English answer 2"],
    "cy": ["Welsh answer 1", "Welsh answer 2"]
  }
}
```
- Add at least 10–14 patterns per intent (mix of English and Welsh)
- After editing, redeploy — the TF-IDF and Bayes classifier retrain on startup

---

## Deployment
- **GitHub**: `Ataur-Web/U-Pal-RAG` (single clean `initial commit`)
- **Vercel**: project `u-pal-rag`, team `shamimrahman224-9945s-projects`
- Vercel auto-deploys on push to `main`
- After recreating the GitHub repo, go to Vercel → Settings → Git → reconnect

---

## Design system (index.html)
- Font: **Nunito** (400/500/600/700) + **DM Mono** (400/500)
- CSS variables: `--green #1D9E75`, `--green-light #E6F7F1`, `--green-mid #A8DEC9`, `--green-dark #0A4D36`
- **No emoji anywhere**, no gradients, no box-shadow, sentence case only
- Alpine.js 3.x — all state in `upal()` function + `Alpine.store('fb')` for feedback modal
- Feedback submit is on `$store.fb.submit()` — NOT on the `upal()` component (modal is outside that scope)

---

## What NOT to do
- Do not add an LLM or call any AI API (`ANTHROPIC_API_KEY` is intentionally unused)
- Do not add a manual language toggle — language is always auto-detected from message content
- Do not add emoji to the UI
- Do not commit `.env` or credentials
- Do not change the MongoDB collection name (`upal-rag` / `feedback`) without updating `server.js`
