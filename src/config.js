const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '../data/assistant.db'),
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(__dirname, '../data/backups'),
  
  // Model Access via OpenAI-compatible endpoint
  MODEL_BASE_URL: (process.env.MODEL_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, ''),
  MODEL_NAME: process.env.MODEL_NAME || 'qwen2.5:3b',
  MODEL_API_KEY: process.env.MODEL_API_KEY || 'ollama',
  
  // Features
  VISION_MODEL_ENABLED: process.env.VISION_MODEL_ENABLED === 'true',
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
  REMINDER_CHECK_INTERVAL_MS: parseInt(process.env.REMINDER_CHECK_INTERVAL_MS || '3000', 10),

  // AWS Cognito Authentication
  COGNITO_REGION: process.env.COGNITO_REGION || 'ap-south-1',
  COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID || 'ap-south-1_OJ4bi0EIU',
  COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID || '6go9rqfft62c1l6rlg4anljgis'
};
