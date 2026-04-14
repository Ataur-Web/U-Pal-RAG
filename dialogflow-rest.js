/**
 * dialogflow-rest.js
 * Lightweight Dialogflow ES client using the REST API + Node built-ins only.
 * No @google-cloud/dialogflow SDK — avoids the 37MB gRPC bundle on Vercel.
 *
 * Auth flow: Service-account JSON → RS256 JWT → OAuth2 access token → REST call
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');

// ── Token cache — reuse until 5 min before expiry ────────────────────────────
let _cachedToken   = null;
let _tokenExpiry   = 0;

/**
 * Build a base64url-encoded string (no padding).
 */
function b64url(data) {
  const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create a signed JWT for the Google service account.
 * Scope: https://www.googleapis.com/auth/dialogflow
 */
function makeJwt(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   credentials.client_email,
    sub:   credentials.client_email,
    aud:  'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/dialogflow',
    iat:   now,
    exp:   now + 3600,
  }));

  const unsigned = `${header}.${payload}`;
  const sign     = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = b64url(sign.sign(credentials.private_key));

  return `${unsigned}.${signature}`;
}

/**
 * Exchange a JWT for a short-lived Google OAuth2 access token.
 */
function fetchAccessToken(jwt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const opts = {
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }
    };

    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error_description || parsed.error));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get a valid access token, refreshing only when within 5 min of expiry.
 */
async function getAccessToken(credentials) {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const jwt    = makeJwt(credentials);
  const result = await fetchAccessToken(jwt);

  _cachedToken  = result.access_token;
  _tokenExpiry  = now + (result.expires_in - 300) * 1000; // refresh 5 min early
  return _cachedToken;
}

/**
 * Simple HTTPS POST helper.
 */
function httpsPost(hostname, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname,
      path,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization':  `Bearer ${token}`,
      }
    };

    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * detectIntent — calls the Dialogflow ES REST detectIntent endpoint.
 *
 * @param {object} credentials  - Parsed service account JSON
 * @param {string} projectId    - GCP project ID
 * @param {string} sessionId    - Conversation session UUID
 * @param {string} text         - User message
 * @param {string} languageCode - 'en' or 'cy'
 * @returns {{ intentName, confidence, fulfillmentText } | null}
 */
async function detectIntent(credentials, projectId, sessionId, text, languageCode) {
  const token = await getAccessToken(credentials);

  const path = `/v2/projects/${projectId}/agent/sessions/${sessionId}:detectIntent`;
  const body = {
    queryInput: {
      text: { text, languageCode }
    },
    queryParams: { timeZone: 'Europe/London' }
  };

  const result = await httpsPost('dialogflow.googleapis.com', path, body, token);

  if (result.error) {
    throw new Error(`Dialogflow REST error: ${result.error.message}`);
  }

  const qr = result.queryResult;
  return {
    intentName:      qr?.intent?.displayName || null,
    confidence:      qr?.intentDetectionConfidence || 0,
    fulfillmentText: qr?.fulfillmentText || '',
    allRequiredParamsPresent: qr?.allRequiredParamsPresent,
  };
}

module.exports = { detectIntent };
