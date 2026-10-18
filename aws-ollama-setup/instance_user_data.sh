#!/usr/bin/env bash

# instance_user_data.sh – cloud‑init user‑data for the EC2 instance
# This script runs as root on first boot.

set -euo pipefail

# 1. Update system and install prerequisites
apt-get update -y
apt-get install -y curl gnupg lsb-release ca-certificates unzip tar

# 2. Install Ollama (CPU‑only)
curl -fsSL https://ollama.com/install.sh | sh

# 3. Add swap if RAM < 8 GiB (needed for 8 B model)
TOTAL_MEM=$(awk '/MemTotal/ {print $2}' /proc/meminfo) # in KiB
if (( TOTAL_MEM < 8000000 )); then
    echo "Adding 4 GiB swap..."
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 4. Pull candidate models (4‑bit quantized)
# Adjust model names if different on Ollama hub.
OLLAMA_MODEL_4B="qwen3:4b-q4"
OLLAMA_MODEL_8B="qwen3:8b-q4"

# Pull both; later benchmark will decide which to keep.
ollama pull $OLLAMA_MODEL_4B || true
ollama pull $OLLAMA_MODEL_8B || true

# 5. Create systemd service for Ollama (bind to localhost only)
cat > /etc/systemd/system/ollama.service <<'EOF'
[Unit]
Description=Ollama LLM Server
After=network.target

[Service]
ExecStart=/usr/local/bin/ollama serve --host 127.0.0.1 --port 11434
Restart=always
User=ubuntu
Environment=OLLAMA_MODELS_DIR=/home/ubuntu/.ollama

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ollama.service
systemctl start ollama.service

# 6. Install Node.js (LTS) and the chat app
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

# Create app directory
APP_DIR=/home/ubuntu/chat-app
mkdir -p $APP_DIR
cat > $APP_DIR/package.json <<'EOF'
{
  "name": "ollama-chat",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^3.3.2",
    "body-parser": "^1.20.2",
    "cors": "^2.8.5"
  }
}
EOF

cat > $APP_DIR/server.js <<'EOF'
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Proxy chat completions to Ollama (local)
app.post('/api/chat', async (req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    // Stream response back to client
    res.setHeader('Content-Type', 'application/json');
    response.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.toString()});
  }
});

// Serve static UI (simple HTML)
app.use(express.static('public'));

const PORT = 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Chat app listening on port ${PORT}`));
EOF

# Minimal UI – index.html
mkdir -p $APP_DIR/public
cat > $APP_DIR/public/index.html <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Ollama Chat</title>
<style>
body {font-family: Arial, sans-serif; margin: 20px;}
#chat {border: 1px solid #ccc; padding: 10px; height: 400px; overflow-y: auto;}
.message {margin: 5px 0;}
.user {font-weight: bold; color: #0066cc;}
.bot {font-weight: normal; color: #333;}
</style>
</head>
<body>
<h2>Ollama Chat</h2>
<div id="chat"></div>
<input id="input" type="text" placeholder="Type a message..." style="width:80%" />
<button id="send">Send</button>
<script>
const chatDiv = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
function addMessage(text, cls) {
  const el = document.createElement('div');
  el.className = 'message ' + cls;
  el.textContent = text;
  chatDiv.appendChild(el);
  chatDiv.scrollTop = chatDiv.scrollHeight;
}
async function sendMessage() {
  const msg = input.value.trim();
  if (!msg) return;
  addMessage('You: ' + msg, 'user');
  input.value = '';
  const body = {model: 'qwen3:4b-q4', messages: [{role: 'user', content: msg}]};
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || '[no reply]';
    addMessage('Bot: ' + reply, 'bot');
  } catch (e) {
    addMessage('Error: ' + e, 'bot');
  }
}
sendBtn.onclick = sendMessage;
input.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(); });
</script>
</body>
</html>
EOF

# Install npm dependencies and set up service
cd $APP_DIR
npm install
cat > /etc/systemd/system/chat-app.service <<'EOF'
[Unit]
Description=Simple Ollama chat proxy
After=network.target ollama.service

[Service]
WorkingDirectory=/home/ubuntu/chat-app
ExecStart=/usr/bin/node server.js
Restart=always
User=ubuntu
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chat-app.service
systemctl start chat-app.service

# 7. Print useful information to /var/log/cloud-init-output.log (visible after SSH)
echo "Setup complete."
echo "Public chat URL: http://$(curl -s http://169.254.169.254/latest/meta-data/public-hostname):8080"
echo "To access Ollama API locally, run:"
echo "ssh -i /home/ubuntu/.ssh/ollama-chat-key.pem -L 11434:127.0.0.1:11434 ubuntu@$(curl -s http://169.254.169.254/latest/meta-data/public-hostname)"
EOF
