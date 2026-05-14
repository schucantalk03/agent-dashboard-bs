const https = require('https');
const crypto = require('crypto');

// ── JWT helpers (no external deps) ──────────────────────────
function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = base64url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const sigInput = `${header}.${claim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${sigInput}.${signature}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Find next empty row ──────────────────────────────────────
async function getNextRow(accessToken, sheetId, sheetName) {
  const range = encodeURIComponent(`${sheetName}!A:A`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });
  const data = await res.json();
  const rows = data.values || [];
  return rows.length + 1; // next empty row
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { tradeData } = JSON.parse(event.body);

    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey  = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const sheetId     = process.env.GOOGLE_SHEET_ID;
    const sheetName   = 'All Trades';

    if (!clientEmail || !privateKey || !sheetId) {
      throw new Error('Missing Google credentials in environment variables.');
    }

    // Get access token
    const accessToken = await getGoogleToken(clientEmail, privateKey);

    // Find next empty row
    const nextRow = await getNextRow(accessToken, sheetId, sheetName);

    // Build the row — only filling A,B,C,D,E,H,I,J,K
    // Columns: A=Symbol, B=Date, C=Direction, D=Entry, E=Close,
    //          F=Points(formula), G=Ticks(formula), H=W/L, I=Size, J=Fee, K=Profit
    const { symbol, date, direction, entryPrice, closePrice, winLoss, size, fee, profit } = tradeData;

    // We write A-E then skip F,G with empty strings, then H-K
    const rowValues = [
      symbol,      // A - Symbol
      date,        // B - Date
      direction,   // C - Direction
      entryPrice,  // D - Entry Price
      closePrice,  // E - Close Price
      '',          // F - Points (formula, leave blank)
      '',          // G - Ticks (formula, leave blank)
      winLoss,     // H - W/L
      size,        // I - Size
      fee,         // J - Fee
      profit,      // K - Profit
    ];

    const range = encodeURIComponent(`${sheetName}!A${nextRow}:K${nextRow}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`;

    const writeRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [rowValues] }),
    });

    const writeData = await writeRes.json();

    if (!writeRes.ok) {
      throw new Error('Sheets write failed: ' + JSON.stringify(writeData));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, row: nextRow }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
