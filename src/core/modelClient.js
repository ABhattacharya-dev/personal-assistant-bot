const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config');

// System prompt instructing the model to output strict JSON
function buildSystemPrompt(existingCategories = [], timezone = 'Asia/Kolkata', profile = {}) {
  const catList = existingCategories.length > 0 
    ? existingCategories.join(', ')
    : 'transport, food, groceries, bills, shopping, medical, entertainment, general';

  const tone = profile.tone || 'friendly';
  const customPrompt = profile.system_prompt || profile.customPrompt || '';
  const userName = profile.name || '';

  const toneInstructions = {
    motivated: 'You are high-energy, empowering, positive, motivating, and action-oriented. Inspire the user and celebrate progress!',
    formal: 'You are polished, professional, concise, direct, and business-like. Maintain an executive polite tone.',
    casual: 'You are relaxed, informal, modern, like texting a smart peer. Keep it cool and friendly.',
    friendly: 'You are warm, supportive, polite, and welcoming.'
  };

  const selectedToneDesc = toneInstructions[tone] || toneInstructions.friendly;

  return `You are a fast, precise personal assistant engine.
Analyze the user's message (which may be in English, Hinglish, Bengali, Hindi, or voice style) and return ONLY a valid JSON object.
Never output markdown code blocks (no \`\`\`json or \`\`\`), no conversational intro or outro.

User Timezone: ${timezone}.
${userName ? `User Name: ${userName}.` : ''}
Persona / Tone Style: ${selectedToneDesc}
${customPrompt ? `User Custom System Prompt: ${customPrompt}` : ''}
Current User Categories: [${catList}]. Re-use these categories whenever applicable before creating new ones.

JSON Schema:
{
  "intent": "log_expense" | "query_expense" | "set_reminder" | "cancel_reminder" | "save_memory" | "query_memory" | "ambiguous" | "general_chat",
  "expense": {
    "amount": number,
    "item": string,
    "category": string,
    "currency": "INR" | "BDT" | string
  },
  "expense_query": {
    "period": "today" | "yesterday" | "this_month" | "all",
    "category": string | null
  },
  "reminder": {
    "text": string,
    "in_seconds": number | null,
    "every_seconds": number | null,
    "at_time": string | null,
    "is_recurring": boolean
  },
  "reminder_cancel": {
    "target": string
  },
  "memory": {
    "entity": string | null,
    "amount": number | null,
    "details": string
  },
  "memory_query": {
    "entity": string | null,
    "query": string
  },
  "clarification": string | null,
  "reply": string | null
}

Rules:
1. "rickshaw 10", "chai 20", "auto 40 diye diyechi", "bajaar theke mach 250 taka", "petrol 500" -> intent: "log_expense".
2. "how much did I spend today?", "transport kharach koto?", "yesterday spend" -> intent: "query_expense".
3. "remind me in 2 minutes to stretch", "remind me every 15 minutes to drink water", "kal subah 9 baje yaad dilana" -> intent: "set_reminder". Calculate in_seconds or every_seconds accurately (e.g. 2 min = 120s, 15 min = 900s).
4. "stop the water reminder", "cancel reminder" -> intent: "cancel_reminder".
5. "I paid Ramesh 500 for the electrician today", "Remember my locker code is 4491" -> intent: "save_memory".
6. "what did I pay Ramesh?", "what is my locker code?" -> intent: "query_memory".
7. If a message is genuinely ambiguous (e.g. user just types "50" or "payment" with no context), set intent: "ambiguous" and ask EXACTLY one short clarifying question in "clarification".
8. Never guess blindly.
Output raw JSON only.`;
}

// Low-level HTTP/HTTPS post to OpenAI-compatible endpoint
function callOpenAIEndpoint(messages, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(config.MODEL_BASE_URL + '/chat/completions');
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const payload = JSON.stringify({
      model: config.MODEL_NAME,
      messages,
      temperature,
      stream: false
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };

    if (config.MODEL_API_KEY && config.MODEL_API_KEY !== 'ollama') {
      headers['Authorization'] = `Bearer ${config.MODEL_API_KEY}`;
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers,
      timeout: 45000
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(body);
            const content = data.choices?.[0]?.message?.content || '';
            resolve(content);
          } catch (e) {
            reject(new Error(`Failed to parse response JSON: ${e.message}`));
          }
        } else {
          reject(new Error(`API responded with HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Model API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// Clean and extract JSON from model output
function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip markdown code fences if model hallucinated them
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find first { and last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      } catch (err) {}
    }
  }
  return null;
}

// Schema validation
function validateSchema(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const validIntents = [
    'log_expense',
    'query_expense',
    'set_reminder',
    'cancel_reminder',
    'save_memory',
    'query_memory',
    'ambiguous',
    'general_chat'
  ];
  if (!validIntents.includes(obj.intent)) return false;

  if (obj.intent === 'log_expense') {
    if (!obj.expense || typeof obj.expense.amount !== 'number' || isNaN(obj.expense.amount)) return false;
    if (!obj.expense.item || typeof obj.expense.item !== 'string') return false;
  }

  return true;
}

// Main Model Parser with 1 retry on failure
async function parseMessageWithModel(userMessage, existingCategories = [], timezone = 'Asia/Kolkata', profile = {}) {
  const systemPrompt = buildSystemPrompt(existingCategories, timezone, profile);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  let rawOutput = '';
  try {
    rawOutput = await callOpenAIEndpoint(messages);
  } catch (err) {
    console.error('Model API call failed:', err.message);
    return {
      intent: 'ambiguous',
      clarification: `I couldn't reach the model right now. Could you please rephrase or try again?`
    };
  }

  let parsed = extractJson(rawOutput);
  if (parsed && validateSchema(parsed)) {
    return parsed;
  }

  // RETRY ONCE
  console.warn('Initial model output failed validation, retrying once. Output was:', rawOutput);
  const retryMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
    { role: 'assistant', content: rawOutput },
    { role: 'user', content: 'Your previous response was not valid raw JSON adhering to the schema. Output ONLY valid raw JSON for the schema without any markdown formatting.' }
  ];

  try {
    const retryOutput = await callOpenAIEndpoint(retryMessages);
    parsed = extractJson(retryOutput);
    if (parsed && validateSchema(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.error('Model retry call failed:', err.message);
  }

  // Fallback: Ask one short clarifying question
  return {
    intent: 'ambiguous',
    clarification: `I didn't quite catch that. Did you mean an expense, a reminder, or a note to save?`
  };
}

module.exports = {
  buildSystemPrompt,
  callOpenAIEndpoint,
  extractJson,
  validateSchema,
  parseMessageWithModel
};
