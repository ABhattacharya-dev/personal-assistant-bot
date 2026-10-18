# Personal Assistant Bot (EC2 + Open-Weight LLM)

A production-grade, channel-agnostic personal assistant built with Node.js, SQLite, and open-weight models (running on AWS EC2 via Ollama or any OpenAI-compatible API). 

It understands natural everyday messages (English, Hinglish, Bengali, Hindi), persists data in a single SQLite database, and executes real stored data workflows across three core capabilities:
1. **Expense Tracking & Discovery** (amounts, categories, date aggregations, undo/corrections)
2. **Reminders & Automations** (one-off, interval, recurring, cancellations, offline catchup via SSE)
3. **Memory Vault** (structured payment records, notes, search with multi-match disambiguation)
4. **Interactive Database Explorer** (slide-out tabular view of all stored SQLite tables and records)

---

## 1. Architecture & Channel-Agnostic Core

The core assistant engine (`src/core/assistant.js`) is decoupled from any specific transport channel (Web, Telegram, WhatsApp, Discord, Slack):

```
                       ┌───────────────────────┐
                       │  Web Browser Chat UI  │
                       │  (HTTP POST / SSE)    │
                       └───────────┬───────────┘
                                   │
                                   ▼
┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐
│ Telegram Adapter  │───▶│ Assistant Core    │◀───│ Future Adapters   │
│ (polling/webhook) │    │ (Channel-Agnostic)│    │ (WhatsApp/Slack)  │
└───────────────────┘    └─────────┬─────────┘    └───────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
 ┌──────────────┐          ┌──────────────┐          ┌────────────────┐
 │ Tier 1 Engine│          │ Tier 2 Model │          │ Background     │
 │ (Fast-Path)  │          │ (Ollama LLM) │          │ Scheduler      │
 │  < 5ms, DB   │          │ Structured   │          │ (Due Reminders,│
 │  Calculations│          │ JSON Output  │          │ Backups)       │
 └──────────────┘          └──────────────┘          └────────────────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   ▼
                       ┌───────────────────────┐
                       │   SQLite Database     │
                       │  (assistant.db file)  │
                       └───────────────────────┘
```

### The Channel Adapter Interface Contract

All adapters interact with the core through a normalized protocol:

#### Inbound Request: `processMessage`
```javascript
const reply = await assistant.processMessage({
  userId: string,          // Unique identifier (e.g. "user_123" or Telegram chat ID)
  channel: string,         // e.g. "web", "telegram", "cli"
  text: string,            // Raw message string
  attachment?: {           // Optional attachment
    type: 'image' | 'file',
    mimeType?: string,
    data?: string          // Base64 or URL
  },
  timestamp: number        // Epoch ms
});
```

#### Outbound Response: `NormalizedReply`
```javascript
{
  text: string,            // Formatted assistant response
  choices?: string[],      // Disambiguation choice chips
  action?: string,         // Action identifier (e.g., 'expense_saved', 'reminder_created')
  attachment?: any,        // Optional media or file
  metadata?: object
}
```

#### Outbound Push Notifications: `notifyUser`
```javascript
assistant.registerChannel('telegram', async (userId, reply) => {
  // Push real-time asynchronous reminders directly to the user
  await bot.sendMessage(userId, reply.text);
});
```

---

## 2. Step-by-Step: Adding a New Channel (e.g. Telegram)

To add Telegram support, **no changes to `src/core/` are needed**:

1. **Install Telegraf**:
   ```bash
   npm install telegraf
   ```

2. **Create `src/adapters/telegramAdapter.js`**:
   ```javascript
   const { Telegraf } = require('telegraf');

   function setupTelegramAdapter(assistant, botToken) {
     const bot = new Telegraf(botToken);

     // Register Telegram outbound push notification dispatcher
     assistant.registerChannel('telegram', async (userId, reply) => {
       await bot.telegram.sendMessage(userId, reply.text);
     });

     // Forward inbound Telegram messages to core
     bot.on('text', async (ctx) => {
       const reply = await assistant.processMessage({
         userId: String(ctx.from.id),
         channel: 'telegram',
         text: ctx.message.text,
         timestamp: ctx.message.date * 1000
       });
       await ctx.reply(reply.text);
     });

     bot.launch();
     console.log('[Telegram] Bot active');
   }

   module.exports = { setupTelegramAdapter };
   ```

3. **Mount in `src/index.js`**:
   ```javascript
   if (process.env.TELEGRAM_BOT_TOKEN) {
     const { setupTelegramAdapter } = require('./adapters/telegramAdapter');
     setupTelegramAdapter(assistant, process.env.TELEGRAM_BOT_TOKEN);
   }
   ```

---

## 3. Web UI Features & Aesthetic

The web interface is designed with a sleek, modern slate aesthetic:
- **Typography**: Editorial serif [Cormorant Garamond](https://fonts.google.com/specimen/Cormorant+Garamond) for dynamic greetings and assistant responses, paired with [DM Sans](https://fonts.google.com/specimen/DM+Sans) for user queries, inputs, and controls.
- **Dark & Light Mode**: Default slate-black theme (`#121316` / `#191b20`) and warm slate-white theme (`#f8fafc` / `#ffffff`) with persistent `localStorage` preference.
- **Chat History Modal**: Center-blurred modal displaying prior interactions with timestamps, "+ New Chat", and "Clear History".
- **Floating Input Bar**: Pill-shaped bottom bar with attachment preview chip (`file.png` + remove `✕`), input field, and send button.
- **Database Explorer Drawer**: Slide-out panel accessible from the side menu displaying all SQLite tables (`expenses`, `reminders`, `memory_vault`, `categories`, `users`, `notifications`) in a responsive tabular view with live search and "My Data" / "All Records" scope toggles.
- **Real-Time Push Notifications**: Native Server-Sent Events (SSE) feed (`/api/stream`) for instant reminder delivery and offline catch-up.

---

## 4. Setup & Quickstart Guide

### Prerequisites
- Node.js (v18+)
- SQLite3
- An Ollama instance (local or remote) OR any OpenAI-compatible API key (Groq, Together, DeepInfra, OpenAI)

### Local Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ABhattacharya-dev/personal-assistant-bot.git
   cd personal-assistant-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` as needed:
   ```ini
   PORT=8080
   DB_PATH=./data/assistant.db
   BACKUP_DIR=./data/backups

   # Model Endpoint (EC2 Ollama, Local Ollama, Groq, or OpenAI)
   MODEL_BASE_URL=http://127.0.0.1:11434/v1
   MODEL_NAME=qwen2.5:3b
   MODEL_API_KEY=ollama

   DEFAULT_TIMEZONE=Asia/Kolkata
   REMINDER_CHECK_INTERVAL_MS=3000
   ```

4. **Start the assistant**:
   ```bash
   npm start
   ```
   Open your browser to `http://localhost:8080`.

---

## 5. Operations: EC2 Deployment & Maintenance

### A. Deployment via Script
From your local Windows workstation:
```powershell
powershell -ExecutionPolicy Bypass -File "scripts/deploy_to_ec2.ps1"
```

### B. Remote Update on EC2
To update on the EC2 host directly:
```bash
ssh -i aws-ollama-setup/ollama-chat-key.pem ubuntu@<INSTANCE_PUBLIC_IP>
cd /home/ubuntu/personal-assistant
bash scripts/update_service.sh
```

### C. Systemd Service Lifecycle
Managed via `assistant.service`:
```bash
sudo systemctl status assistant.service   # View service status
sudo systemctl restart assistant.service  # Restart service
sudo journalctl -u assistant.service -f   # Follow live logs
```

---

## 6. Performance & Dual-Tier Design

The assistant optimizes CPU latency using a **Dual-Tier Processing Pipeline**:

- **Tier 1 (Fast-Path Rules & SQL Aggregations, < 5ms)**:
  - Exact total calculations (`SUM(amount)`, `COUNT(*)` in SQLite).
  - Common spending queries ("how much did I spend today", "yesterday", "this month").
  - Category summaries ("how much on transport?").
  - Deletion confirmations and undo commands ("change that to food", "delete the last one").
  - Memory disambiguation selections ("1", "2").
  - Privacy commands ("export all my data", "delete all my data").
- **Tier 2 (Structured Model Extraction, ~5-6s on CPU)**:
  - Handles messy multilingual phrasing, Hinglish/Bengali voice style, and new expense discoveries.
  - Returns strictly validated JSON schemas with automatic single-retry fallback.

---

## 7. Automated Test Suite

Run the 42-case test suite locally or on the instance:
```bash
npm test
```

### Test Metrics
- **Total Test Cases**: 42
- **Fast-Path Latency**: ~3 ms
- **Model Inference Latency**: ~5.8 s (CPU)
- **Calculations Accuracy**: 100% (computed strictly from SQLite tables)

---

## 8. License & Privacy
- Zero telemetry beyond local SQLite storage.
- All numbers and totals are computed with direct database queries, never model guesswork.
- Full privacy compliance with instant Export-All and Delete-All commands.
