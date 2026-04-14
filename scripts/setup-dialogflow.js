/**
 * setup-dialogflow.js
 * One-time script that creates the U-Pal Dialogflow agent and uploads
 * all intents from knowledge.json as training phrases.
 *
 * Usage:
 *   node scripts/setup-dialogflow.js
 *
 * Requires GOOGLE_CREDENTIALS and DIALOGFLOW_PROJECT_ID in .env
 */

require('dotenv').config();
const dialogflow = require('@google-cloud/dialogflow');
const fs         = require('fs');
const path       = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ID  = process.env.DIALOGFLOW_PROJECT_ID;
const CREDENTIALS = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : null;

if (!PROJECT_ID || !CREDENTIALS) {
  console.error('ERROR: Set DIALOGFLOW_PROJECT_ID and GOOGLE_CREDENTIALS in .env');
  process.exit(1);
}

const clientOpts = { credentials: CREDENTIALS };

// ── Load knowledge base ──────────────────────────────────────────────────────
const knowledge = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'knowledge.json'), 'utf8')
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a plain string into a Dialogflow training phrase object */
function makePhrase(text) {
  return {
    type:  'EXAMPLE',
    parts: [{ text }]
  };
}

/** Build the full parent resource path */
function parent() {
  return `projects/${PROJECT_ID}/agent`;
}

// ── Step 1: Set / update the agent ──────────────────────────────────────────
async function setupAgent() {
  const agentsClient = new dialogflow.AgentsClient(clientOpts);
  console.log('Setting up Dialogflow agent...');

  await agentsClient.setAgent({
    agent: {
      parent:               `projects/${PROJECT_ID}`,
      displayName:          'U-Pal',
      defaultLanguageCode:  'en',
      supportedLanguageCodes: ['cy'],
      timeZone:             'Europe/London',
      description:          'Bilingual UWTSD student assistant chatbot',
      matchMode:            'MATCH_MODE_ML_ONLY',
      classificationThreshold: 0.3,
    }
  });

  console.log('Agent configured.');
  await agentsClient.close();
}

// ── Step 2: Delete all existing custom intents (clean slate) ─────────────────
async function deleteExistingIntents() {
  const intentsClient = new dialogflow.IntentsClient(clientOpts);
  console.log('Fetching existing intents...');

  const [intents] = await intentsClient.listIntents({ parent: parent() });
  let deleted = 0;

  for (const intent of intents) {
    // Skip built-in Default intents
    if (intent.displayName.startsWith('Default')) continue;
    await intentsClient.deleteIntent({ name: intent.name });
    deleted++;
  }

  console.log(`Deleted ${deleted} existing intents.`);
  await intentsClient.close();
}

// ── Step 3: Create intents from knowledge.json ───────────────────────────────
async function createIntents() {
  const intentsClient = new dialogflow.IntentsClient(clientOpts);
  let created = 0;
  let failed  = 0;

  for (const item of knowledge) {
    try {
      // Split patterns into English and Welsh by checking for Welsh characters
      // All patterns go into the English intent; Welsh patterns also added
      const englishPhrases = item.patterns.map(makePhrase);

      // Dialogflow responses (text) — we'll handle responses in server.js
      // but we add them here for Dialogflow console visibility
      const textMessages = [
        ...(item.responses.en || []).map(text => ({
          text: { text: [text] }
        }))
      ];

      const intent = {
        displayName:      item.tag,
        trainingPhrases:  englishPhrases,
        messages:         textMessages,
        mlEnabled:        true,
      };

      await intentsClient.createIntent({
        parent: parent(),
        intent
      });

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 150));
      created++;
      process.stdout.write(`  Created: ${item.tag}\n`);

    } catch (err) {
      failed++;
      console.error(`  FAILED: ${item.tag} — ${err.message}`);
    }
  }

  console.log(`\nIntents created: ${created}, failed: ${failed}`);
  await intentsClient.close();
}

// ── Step 4: Train the agent ──────────────────────────────────────────────────
async function trainAgent() {
  const agentsClient = new dialogflow.AgentsClient(clientOpts);
  console.log('Training agent (this takes ~30 seconds)...');

  const [operation] = await agentsClient.trainAgent({
    parent: `projects/${PROJECT_ID}`
  });

  await operation.promise();
  console.log('Agent trained successfully.');
  await agentsClient.close();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Note: setupAgent() requires Dialogflow API Admin role.
    // If you get PERMISSION_DENIED here, skip to createIntents() — the agent
    // was already created via the Dialogflow console.
    try {
      await setupAgent();
    } catch (e) {
      console.warn('Could not configure agent (needs Admin role) — continuing with intent creation...');
    }
    await deleteExistingIntents();
    await createIntents();
    await trainAgent();
    console.log('\nDialogflow setup complete. U-Pal is ready.');
  } catch (err) {
    console.error('Setup failed:', err.message);
    if (err.details) console.error('Details:', err.details);
    process.exit(1);
  }
})();
