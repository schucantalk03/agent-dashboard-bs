import { getStore } from "@netlify/blobs";

// ── Config ───────────────────────────────────────────────────
const OANDA_BASE    = 'https://api-fxpractice.oanda.com/v3/accounts';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const NOTION_URL    = 'https://api.notion.com/v1/pages';
const SHEETS_URL    = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Schedule: every 5 minutes ───────────────────────────────
// Every 5 min, Monday-Friday, 7am-12pm Eastern (12:00-17:00 UTC)
export const config = { schedule: "*/5 12-16 * * 1-5" };

// ── Main ─────────────────────────────────────────────────────
export default async function handler() {
  const oandaToken    = process.env.OANDA_TOKEN;
  const oandaAccount  = process.env.OANDA_ACCOUNT_ID;
  const anthropicKey  = process.env.ANTHROPIC_KEY;
  const notionToken   = process.env.NOTION_TOKEN;
  const notionTradeDb = process.env.NOTION_TRADE_DB;
  const googleEmail   = process.env.GOOGLE_CLIENT_EMAIL;
  const googleKey     = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const sheetId       = process.env.GOOGLE_SHEET_ID;

  if (!oandaToken || !oandaAccount || !anthropicKey) {
    console.log('Missing required env vars — skipping poll');
    return;
  }

  // Load known trades from Netlify Blobs
  const store = getStore('trade-monitor');
  let knownTrades = {};
  try {
    const raw = await store.get('known-trades');
    if (raw) knownTrades = JSON.parse(raw);
  } catch(e) {
    console.log('No existing trade state, starting fresh');
  }

  // Fetch open trades from OANDA
  let openTrades = [];
  try {
    const res = await fetch(`${OANDA_BASE}/${oandaAccount}/openTrades`, {
      headers: {
        'Authorization': `Bearer ${oandaToken}`,
        'Accept-Datetime-Format': 'RFC3339',
      },
    });
    const data = await res.json();
    openTrades = data.trades || [];
  } catch(e) {
    console.log('OANDA fetch failed:', e.message);
    return;
  }

  const openIds = new Set(openTrades.map(t => t.id));

  // ── Detect NEW open trades ───────────────────────────────
  for (const trade of openTrades) {
    if (!knownTrades[trade.id]) {
      console.log('New trade detected:', trade.id);
      knownTrades[trade.id] = { ...trade, status: 'open' };

      try {
        const analysis = await runPreTradeAnalysis(trade, anthropicKey);
        if (notionToken && notionTradeDb) {
          await pushToNotion(notionToken, notionTradeDb, 
            `${trade.instrument} ${trade.currentUnits > 0 ? 'Long' : 'Short'} @ ${parseFloat(trade.price).toFixed(5)}`,
            analysis);
        }
        console.log('Pre-trade analysis complete for trade', trade.id);
      } catch(e) {
        console.log('Pre-trade analysis failed:', e.message);
      }
    }
  }

  // ── Detect CLOSED trades ─────────────────────────────────
  for (const [id, trade] of Object.entries(knownTrades)) {
    if (trade.status === 'open' && !openIds.has(id)) {
      console.log('Trade closed:', id);
      knownTrades[id].status = 'closed';

      try {
        const breakdown = await runPostTradeBreakdown(trade, anthropicKey);

        // Push to Notion
        if (notionToken && notionTradeDb) {
          await pushToNotion(notionToken, notionTradeDb,
            `CLOSED: ${trade.instrument} ${trade.currentUnits > 0 ? 'Long' : 'Short'} — Post-Trade`,
            breakdown);
        }

        // Push to Google Sheets
        if (googleEmail && googleKey && sheetId) {
          await pushToSheets(trade, googleEmail, googleKey, sheetId);
        }

        console.log('Post-trade breakdown complete for trade', id);
      } catch(e) {
        console.log('Post-trade breakdown failed:', e.message);
      }
    }
  }

  // Save updated state back to Netlify Blobs
  await store.set('known-trades', JSON.stringify(knownTrades));
  console.log('Trade monitor poll complete. Known trades:', Object.keys(knownTrades).length);
}

// ── Claude API ───────────────────────────────────────────────
async function callClaude(anthropicKey, system, userMsg) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

// ── Pre-Trade Analysis ───────────────────────────────────────
async function runPreTradeAnalysis(trade, anthropicKey) {
  const dir = parseInt(trade.currentUnits) > 0 ? 'Long' : 'Short';
  const system = `You are an expert FOREX trading coach analyzing a paper trade for a beginner-intermediate EUR/USD trader. Be specific, educational, and constructive. Format your response as:

## Pre-Trade Analysis
**Instrument:** | **Direction:** | **Entry:** | **Units:**

## Setup Quality Checklist
- [ ] Trend alignment
- [ ] Key level proximity
- [ ] Risk assessment
- [ ] Session timing

## What To Watch
Key levels to monitor while this trade is open.

## Suggested Stop Loss & Take Profit
Based on typical EUR/USD price action.

## Coaching Note
One key lesson this trade setup teaches.`;

  return callClaude(anthropicKey, system,
    `Analyze this new paper trade:
Instrument: ${trade.instrument}
Direction: ${dir}
Entry Price: ${trade.price}
Units: ${Math.abs(trade.currentUnits)}
Time: ${new Date().toLocaleString()}`);
}

// ── Post-Trade Breakdown ─────────────────────────────────────
async function runPostTradeBreakdown(trade, anthropicKey) {
  const dir = parseInt(trade.currentUnits) > 0 ? 'Long' : 'Short';
  const pl  = parseFloat(trade.unrealizedPL || 0);
  const system = `You are an expert FOREX trading coach delivering a post-trade breakdown for a beginner-intermediate EUR/USD paper trader. Be honest, specific, and educational. Format your response as:

## Post-Trade Breakdown
**Instrument:** | **Direction:** | **Entry:** | **Result:**

## What Went Right
Specific positives about this trade.

## What To Improve
Honest critique and specific improvements for next time.

## Key Lesson
The single most important thing to take away from this trade.

## Trade Score
Grade this trade A/B/C/D based on execution quality (not outcome). Explain the grade.`;

  return callClaude(anthropicKey, system,
    `Analyze this closed paper trade:
Instrument: ${trade.instrument}
Direction: ${dir}
Entry Price: ${trade.price}
P&L: ${pl}
Opened: ${new Date(trade.openTime).toLocaleString()}
Closed: ${new Date().toLocaleString()}`);
}

// ── Notion Push ──────────────────────────────────────────────
async function pushToNotion(token, dbId, title, content) {
  const lines  = content.split('\n');
  const blocks = [];
  for (const line of lines) {
    if      (line.startsWith('## '))  blocks.push({ object:'block', type:'heading_2',         heading_2:         { rich_text:[{type:'text',text:{content:line.slice(3)}}]}});
    else if (line.startsWith('### ')) blocks.push({ object:'block', type:'heading_3',         heading_3:         { rich_text:[{type:'text',text:{content:line.slice(4)}}]}});
    else if (line.startsWith('> '))   blocks.push({ object:'block', type:'quote',             quote:             { rich_text:[{type:'text',text:{content:line.slice(2)}}]}});
    else if (line.startsWith('- '))   blocks.push({ object:'block', type:'bulleted_list_item',bulleted_list_item:{ rich_text:[{type:'text',text:{content:line.slice(2)}}]}});
    else if (line.trim() === '---')   blocks.push({ object:'block', type:'divider',           divider:{}});
    else if (line.trim())             blocks.push({ object:'block', type:'paragraph',         paragraph:         { rich_text:[{type:'text',text:{content:line}}]}});
    if (blocks.length >= 95) break;
  }

  await fetch(NOTION_URL, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent:     { database_id: dbId },
      properties: { Name: { title: [{ text: { content: title } }] } },
      children:   blocks,
    }),
  });
}

// ── Google Sheets Push ───────────────────────────────────────
async function pushToSheets(trade, clientEmail, privateKey, sheetId) {
  const { createSign } = await import('node:crypto');

  function b64url(s) {
    return Buffer.from(s).toString('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  const now    = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss:   clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   GOOGLE_TOKEN_URL,
    exp:   now + 3600,
    iat:   now,
  }));

  const sigInput = `${header}.${claim}`;
  const sign     = createSign('RSA-SHA256');
  sign.update(sigInput);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt = `${sigInput}.${sig}`;

  const tokenRes  = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // Find next empty row
  const rangeRes  = await fetch(`${SHEETS_URL}/${sheetId}/values/${encodeURIComponent('All Trades!A:A')}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const rangeData = await rangeRes.json();
  const nextRow   = (rangeData.values || []).length + 1;

  const dir     = parseInt(trade.currentUnits) > 0 ? 'Long' : 'Short';
  const pl      = parseFloat(trade.unrealizedPL || 0);
  const winLoss = pl >= 0 ? 'Win' : 'Loss';
  const date    = new Date().toLocaleDateString('en-US');

  const rowValues = [
    trade.instrument,
    date,
    dir,
    parseFloat(trade.price).toFixed(5),
    '',   // Close Price — left for formula
    '',   // Points — formula
    '',   // Ticks — formula
    winLoss,
    Math.abs(parseInt(trade.currentUnits)),
    0,    // Fee
    pl.toFixed(2),
  ];

  await fetch(`${SHEETS_URL}/${sheetId}/values/${encodeURIComponent(`All Trades!A${nextRow}:K${nextRow}`)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ values: [rowValues] }),
  });

  console.log(`Trade written to Google Sheets row ${nextRow}`);
}
