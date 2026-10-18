const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

// Proxy chat completions (streaming)
app.post('/api/chat', (req, res) => {
  const payload = JSON.stringify(req.body);

  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const ollamaReq = http.request(options, (ollamaRes) => {
    res.writeHead(ollamaRes.statusCode, ollamaRes.headers);
    ollamaRes.pipe(res);
  });

  ollamaReq.on('error', (err) => {
    console.error('Error proxying to Ollama:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to connect to local Ollama server' });
    }
  });

  ollamaReq.write(payload);
  ollamaReq.end();
});

// Endpoint to list models
app.get('/api/tags', (req, res) => {
  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: '/api/tags',
    method: 'GET'
  };

  const ollamaReq = http.request(options, (ollamaRes) => {
    res.writeHead(ollamaRes.statusCode, ollamaRes.headers);
    ollamaRes.pipe(res);
  });

  ollamaReq.on('error', (err) => {
    res.status(500).json({ error: err.message });
  });

  ollamaReq.end();
});

const PORT = 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Chat application running on http://0.0.0.0:${PORT}`);
});
