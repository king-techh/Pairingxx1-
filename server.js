const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 1000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Session storage
const sessions = new Map();
const pairingRequests = new Map();

// ──── API Routes ────

// Request pairing code
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const cleaned = phone.replace(/[\s\-+]/g, '');
    let normalized = cleaned;
    if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
    if (normalized.startsWith('7') || normalized.startsWith('1')) normalized = '254' + normalized;

    const sessionId = 'toxicyobby-' + Math.random().toString().slice(2, 8);
    sessions.set(sessionId, { phone: normalized, status: 'pending', createdAt: Date.now() });
    pairingRequests.set(normalized, { sessionId, status: 'pending' });

    res.json({ success: true, sessionId, phone: normalized, message: 'Pairing request created. Use the session ID or wait for the bot to connect.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check session status
app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Connect with session ID
app.post('/api/connect', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Invalid session ID' });

    session.status = 'connected';
    session.connectedAt = Date.now();

    // Notify via socket
    io.emit('session:connected', { sessionId, phone: session.phone });

    res.json({ success: true, status: 'connected', phone: session.phone, message: 'Bot is now connected to your WhatsApp!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  const all = [];
  for (const [id, data] of sessions) {
    all.push({ id, ...data });
  }
  res.json(all);
});

// ──── Socket.io ────
io.on('connection', (socket) => {
  console.log('[SOCKET] Client connected:', socket.id);

  socket.on('pair:request', (data) => {
    const { phone } = data;
    const sessionId = 'toxicyobby-' + Math.random().toString().slice(2, 8);
    sessions.set(sessionId, { phone, status: 'pending', createdAt: Date.now() });
    socket.emit('pair:response', { sessionId, phone, status: 'pending' });
  });

  socket.on('session:check', (data) => {
    const session = sessions.get(data.sessionId);
    if (session) {
      socket.emit('session:status', { ...session, sessionId: data.sessionId });
    } else {
      socket.emit('session:status', { status: 'not_found' });
    }
  });

  socket.on('disconnect', () => {
    console.log('[SOCKET] Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`[YOBBY PAIR] Server running on port ${PORT}`);
});
