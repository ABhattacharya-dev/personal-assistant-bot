const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { initSchema } = require('./database/db');
const { AssistantCore } = require('./core/assistant');
const { Scheduler } = require('./core/scheduler');
const { createWebAdapter } = require('./adapters/webAdapter');

async function main() {
  console.log('--- Initializing Personal Assistant Server ---');
  
  // 1. Initialize SQLite Database Schema
  await initSchema();
  console.log('[Database] SQLite schema verified and ready at', config.DB_PATH);

  // 2. Initialize Core Assistant
  const assistant = new AssistantCore({ timezone: config.DEFAULT_TIMEZONE });

  // 3. Initialize & Start Scheduler (for reminders and backups)
  const scheduler = new Scheduler(assistant);
  scheduler.start();

  // 4. Setup Express App
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Mount Web Adapter
  app.use('/api', createWebAdapter(assistant));

  // Serve static chat UI
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      model: config.MODEL_NAME,
      endpoint: config.MODEL_BASE_URL,
      uptime: process.uptime()
    });
  });

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[Server] Assistant active on http://0.0.0.0:${config.PORT}`);
    console.log(`[Model] Configured endpoint: ${config.MODEL_BASE_URL} (Model: ${config.MODEL_NAME})`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully...');
    scheduler.stop();
    server.close(() => {
      console.log('[Server] Closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[Fatal] Server failed to start:', err);
  process.exit(1);
});
