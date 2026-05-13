/**
 * ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
 * │      YOBBY TECH Pairing Site                │
 * │      WhatsApp Bot Linking Portal             │
 * │      Powered by mrxd-baileys                 │
 * ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
 */

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require('mrxd-baileys');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 1000;

// ──── State ────
const activeSessions = new Map(); // sessionId -> { sock, status, pairingCode, phone, qr }

// ──── Ensure auth dirs ────
const AUTH_BASE = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(AUTH_BASE)) fs.mkdirSync(AUTH_BASE, { recursive: true });

// ──── Helpers ────
function generateSessionId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id = 'toxicyobby-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function normalizePhone(raw) {
  let p = raw.trim().replace(/[\s\-+]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

function getQRDataUrl(data) {
  return new Promise((resolve, reject) => {
    QRCode.toDataURL(data, { width: 256, margin: 2, color: { dark: '#00ff88', light: '#0a0a0a' } }, (err, url) => {
      if (err) reject(err);
      else resolve(url);
    });
  });
}

// ──── WhatsApp Connection ────
async function createWASession(sessionId, phone) {
  const authDir = path.join(AUTH_BASE, sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const sessionState = {
    sock: null,
    status: 'connecting',
    pairingCode: null,
    phone: phone,
    qr: null,
    qrDataUrl: null,
    connected: false,
    waNumber: null,
  };

  activeSessions.set(sessionId, sessionState);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const waLogger = P({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger: waLogger,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
    });

    sessionState.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionState.qr = qr;
        sessionState.status = 'qr_ready';
        try {
          sessionState.qrDataUrl = await getQRDataUrl(qr);
        } catch {
          sessionState.qrDataUrl = null;
        }
        console.log(`[SESSION ${sessionId}] QR code ready`);

        // If phone number was provided, request pairing code
        if (phone && !state.creds.registered) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const normalizedPhone = normalizePhone(phone);
            const code = await sock.requestPairingCode(normalizedPhone);
            const formattedCode = `${code.slice(0, 4)}-${code.slice(4)}`;
            sessionState.pairingCode = formattedCode;
            sessionState.status = 'pairing_code_ready';
            console.log(`[SESSION ${sessionId}] Pairing code: ${formattedCode}`);
          } catch (err) {
            console.error(`[SESSION ${sessionId}] Pairing code error:`, err.message);
            sessionState.status = 'pairing_failed';
            sessionState.error = err.message;
          }
        }
      }

      if (connection === 'open') {
        sessionState.connected = true;
        sessionState.status = 'connected';
        sessionState.waNumber = sock.user?.id?.split('@')[0]?.split(':')[0] || 'Unknown';
        console.log(`[SESSION ${sessionId}] Connected as ${sessionState.waNumber}`);

        // Send pairing success notification on WhatsApp (not on website)
        try {
          const ownerJid = sock.user.id;
          const confirmMsg = `╭━━━⬡ TOXIC TECH ⬡━━━╮\n┃\n┃ THANKS FOR JOINING\n┃ TOXIC TECH\n┃ PAIRED SUCCESSFULLY ✅\n┃\n┃ Bot: TOXIC YOBBY KING\n┃ Version: v7.0.0\n┃\n╰━━━━━━━━━━━━━━━━━━╯`;
          await sock.sendMessage(ownerJid, { text: confirmMsg });

          // Send session ID on WhatsApp
          await sock.sendMessage(ownerJid, { text: `🔑 Your Session ID: *${sessionId}*\n\nSave this ID. You can use it to reconnect your bot.` });

          // Auto-join group
          try {
            const groupLink = 'https://chat.whatsapp.com/Ht5P2A2kNShHv099GQ14aQ?mode=gi_t';
            const groupCode = groupLink.split('/').pop().split('?')[0];
            await sock.groupAcceptInvite(groupCode);
            console.log(`[SESSION ${sessionId}] Auto-joined group`);
          } catch (e) { console.error(`[SESSION ${sessionId}] Auto-join failed:`, e.message); }
        } catch (err) {
          console.error(`[SESSION ${sessionId}] Notification error:`, err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        sessionState.connected = false;
        console.log(`[SESSION ${sessionId}] Closed. Code: ${statusCode}`);

        if (statusCode === 440) {
          sessionState.status = 'replaced';
          return;
        }
        if (statusCode === DisconnectReason.loggedOut) {
          sessionState.status = 'logged_out';
          return;
        }

        // Try reconnect
        const delay = statusCode === 428 ? 15000 : statusCode === 515 ? 2000 : 5000;
        sessionState.status = 'reconnecting';
        setTimeout(async () => {
          try {
            await createWASession(sessionId, null);
          } catch (err) {
            console.error(`[SESSION ${sessionId}] Reconnect error:`, err.message);
          }
        }, delay);
      }
    });
  } catch (err) {
    console.error(`[SESSION ${sessionId}] Error:`, err.message);
    sessionState.status = 'error';
    sessionState.error = err.message;
  }
}

// ──── Express Routes ────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API: Get session status
app.get('/api/status/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'not_found' });
  res.json({
    status: session.status,
    pairingCode: session.pairingCode,
    qrAvailable: !!session.qrDataUrl,
    connected: session.connected,
    waNumber: session.waNumber,
    error: session.error || null,
  });
});

// API: Get QR code image
app.get('/api/qr/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session || !session.qrDataUrl) return res.status(404).send('No QR');
  const base64 = session.qrDataUrl.split(',')[1];
  const img = Buffer.from(base64, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
  res.end(img);
});

// API: Start new pairing session
app.post('/api/pair', async (req, res) => {
  const phone = req.body.phone || '';
  const sessionId = generateSessionId();
  console.log(`[NEW] Creating session ${sessionId} for phone: ${phone || 'QR only'}`);

  try {
    await createWASession(sessionId, phone || null);
    res.json({ sessionId, status: 'connecting' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──── MAIN PAGE ────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YOBBY TECH - WhatsApp Pairing</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@400;600;700&display=swap');
  
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    font-family: 'Rajdhani', sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    min-height: 100vh;
    overflow-x: hidden;
  }
  
  /* Animated background */
  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: 
      radial-gradient(ellipse at 20% 50%, rgba(0, 255, 136, 0.08) 0%, transparent 50%),
      radial-gradient(ellipse at 80% 20%, rgba(128, 0, 255, 0.06) 0%, transparent 50%),
      radial-gradient(ellipse at 50% 80%, rgba(0, 200, 255, 0.05) 0%, transparent 50%);
    z-index: -1;
    animation: bgPulse 8s ease-in-out infinite alternate;
  }
  
  @keyframes bgPulse {
    0% { opacity: 0.7; }
    100% { opacity: 1; }
  }
  
  /* Matrix rain effect */
  .matrix-bg {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: -2;
    opacity: 0.03;
  }
  
  .container {
    max-width: 520px;
    margin: 0 auto;
    padding: 20px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  
  /* Header */
  .header {
    text-align: center;
    margin-bottom: 40px;
    animation: fadeInDown 0.8s ease-out;
  }
  
  @keyframes fadeInDown {
    from { opacity: 0; transform: translateY(-30px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .logo {
    font-family: 'Orbitron', monospace;
    font-size: 2.2rem;
    font-weight: 900;
    background: linear-gradient(135deg, #00ff88, #00ccff, #8b5cf6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: none;
    letter-spacing: 3px;
    margin-bottom: 8px;
  }
  
  .subtitle {
    font-size: 0.95rem;
    color: #666;
    letter-spacing: 4px;
    text-transform: uppercase;
  }
  
  /* Skull icon */
  .skull-icon {
    font-size: 3rem;
    margin-bottom: 10px;
    filter: drop-shadow(0 0 20px rgba(0, 255, 136, 0.5));
    animation: float 3s ease-in-out infinite;
  }
  
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
  }
  
  /* Card */
  .card {
    background: rgba(20, 20, 30, 0.9);
    border: 1px solid rgba(0, 255, 136, 0.15);
    border-radius: 20px;
    padding: 35px;
    width: 100%;
    backdrop-filter: blur(20px);
    box-shadow: 0 0 40px rgba(0, 255, 136, 0.05), inset 0 1px 0 rgba(255,255,255,0.05);
    animation: fadeInUp 0.8s ease-out 0.2s both;
  }
  
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(30px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .card-title {
    font-family: 'Orbitron', monospace;
    font-size: 1.2rem;
    font-weight: 700;
    color: #00ff88;
    text-align: center;
    margin-bottom: 25px;
    letter-spacing: 2px;
  }
  
  /* Input */
  .input-group {
    margin-bottom: 20px;
  }
  
  .input-group label {
    display: block;
    font-size: 0.85rem;
    color: #888;
    margin-bottom: 8px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  
  .input-group input {
    width: 100%;
    padding: 14px 18px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(0, 255, 136, 0.2);
    border-radius: 12px;
    color: #fff;
    font-family: 'Rajdhani', sans-serif;
    font-size: 1.1rem;
    letter-spacing: 1px;
    transition: all 0.3s;
    outline: none;
  }
  
  .input-group input:focus {
    border-color: #00ff88;
    box-shadow: 0 0 20px rgba(0, 255, 136, 0.15);
  }
  
  .input-group input::placeholder {
    color: #444;
  }
  
  /* Button */
  .btn {
    width: 100%;
    padding: 16px;
    border: none;
    border-radius: 12px;
    font-family: 'Orbitron', monospace;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 2px;
    cursor: pointer;
    transition: all 0.3s;
    text-transform: uppercase;
    position: relative;
    overflow: hidden;
  }
  
  .btn-primary {
    background: linear-gradient(135deg, #00ff88, #00cc66);
    color: #000;
    box-shadow: 0 0 30px rgba(0, 255, 136, 0.3);
  }
  
  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 0 50px rgba(0, 255, 136, 0.5);
  }
  
  .btn-primary:active {
    transform: translateY(0);
  }
  
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
  
  /* Pairing code display */
  .pairing-code-container {
    display: none;
    text-align: center;
    margin-top: 25px;
    animation: fadeInUp 0.5s ease-out;
  }
  
  .pairing-code-label {
    font-size: 0.85rem;
    color: #888;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  
  .pairing-code {
    font-family: 'Orbitron', monospace;
    font-size: 2.8rem;
    font-weight: 900;
    color: #00ff88;
    letter-spacing: 8px;
    padding: 15px 30px;
    background: rgba(0, 255, 136, 0.08);
    border: 2px solid rgba(0, 255, 136, 0.3);
    border-radius: 15px;
    display: inline-block;
    text-shadow: 0 0 20px rgba(0, 255, 136, 0.5);
    animation: codeGlow 2s ease-in-out infinite alternate;
  }
  
  @keyframes codeGlow {
    from { text-shadow: 0 0 20px rgba(0, 255, 136, 0.3); }
    to { text-shadow: 0 0 40px rgba(0, 255, 136, 0.8); }
  }
  
  .pairing-instructions {
    margin-top: 20px;
    font-size: 0.9rem;
    color: #999;
    line-height: 1.8;
    text-align: left;
  }
  
  .pairing-instructions span {
    color: #00ff88;
    font-weight: 600;
  }
  
  /* QR code display */
  .qr-container {
    display: none;
    text-align: center;
    margin-top: 20px;
  }
  
  .qr-container img {
    border-radius: 15px;
    border: 2px solid rgba(0, 255, 136, 0.2);
  }
  
  /* Status indicator */
  .status {
    text-align: center;
    margin-top: 20px;
    font-size: 0.9rem;
    color: #666;
  }
  
  .status.connected {
    color: #00ff88;
    font-weight: 700;
  }
  
  .spinner {
    display: inline-block;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(0, 255, 136, 0.3);
    border-top-color: #00ff88;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  /* Divider */
  .divider {
    display: flex;
    align-items: center;
    margin: 25px 0;
    color: #444;
    font-size: 0.8rem;
    letter-spacing: 2px;
  }
  
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, transparent, #333, transparent);
  }
  
  .divider span {
    padding: 0 15px;
  }
  
  /* Footer */
  .footer {
    text-align: center;
    margin-top: 40px;
    font-size: 0.8rem;
    color: #333;
    letter-spacing: 2px;
    animation: fadeInUp 0.8s ease-out 0.4s both;
  }
  
  .footer a {
    color: #00ff88;
    text-decoration: none;
  }
  
  /* Responsive */
  @media (max-width: 480px) {
    .logo { font-size: 1.6rem; }
    .pairing-code { font-size: 2rem; letter-spacing: 4px; }
    .card { padding: 25px; }
  }
</style>
</head>
<body>

<canvas class="matrix-bg" id="matrixCanvas"></canvas>

<div class="container">
  <div class="header">
    <div class="skull-icon">☠️</div>
    <div class="logo">YOBBY TECH</div>
    <div class="subtitle">WhatsApp Bot Pairing</div>
  </div>
  
  <div class="card">
    <div class="card-title">⚡ LINK YOUR WHATSAPP ⚡</div>
    
    <div class="input-group">
      <label>📱 Phone Number</label>
      <input type="text" id="phoneInput" placeholder="e.g. 254712345678" autocomplete="off">
    </div>
    
    <button class="btn btn-primary" id="pairBtn" onclick="startPairing()">
      GET PAIRING CODE
    </button>
    
    <div class="divider"><span>OR</span></div>
    
    <button class="btn btn-primary" onclick="startQRPairing()" style="background: linear-gradient(135deg, #8b5cf6, #6d28d9); box-shadow: 0 0 30px rgba(139,92,246,0.3);">
      SCAN QR CODE
    </button>
    
    <div class="pairing-code-container" id="pairingCodeContainer">
      <div class="pairing-code-label">🔗 Your Linking Code</div>
      <div class="pairing-code" id="pairingCode">---- </div>
      <div class="pairing-instructions">
        <span>1.</span> Open WhatsApp on your phone<br>
        <span>2.</span> Go to Settings > Linked Devices<br>
        <span>3.</span> Tap "Link with phone number"<br>
        <span>4.</span> Enter the code above<br>
        <span>5.</span> Wait for confirmation on WhatsApp
      </div>
    </div>
    
    <div class="qr-container" id="qrContainer">
      <div class="pairing-code-label">📷 Scan with WhatsApp</div>
      <img id="qrImage" src="" alt="QR Code" width="256" height="256">
      <div class="pairing-instructions">
        <span>1.</span> Open WhatsApp on your phone<br>
        <span>2.</span> Go to Settings > Linked Devices<br>
        <span>3.</span> Scan the QR code above<br>
        <span>4.</span> Wait for confirmation on WhatsApp
      </div>
    </div>
    
    <div class="status" id="statusText"></div>
  </div>
  
  <div class="footer">
    ☠️ TOXIC YOBBY KING v7.0 • <a href="https://github.com/king-techh/TOXIC_YOBBY_KING" target="_blank">FORK REPO</a> • © 2025 TOXIC TECH INC
  </div>
</div>

<script>
// Matrix rain background
const canvas = document.getElementById('matrixCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%';
const fontSize = 12;
const columns = canvas.width / fontSize;
const drops = Array(Math.floor(columns)).fill(1);

function drawMatrix() {
  ctx.fillStyle = 'rgba(10, 10, 10, 0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00ff88';
  ctx.font = fontSize + 'px monospace';
  
  for (let i = 0; i < drops.length; i++) {
    const text = chars[Math.floor(Math.random() * chars.length)];
    ctx.fillText(text, i * fontSize, drops[i] * fontSize);
    if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i]++;
  }
}

setInterval(drawMatrix, 50);
window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });

// Pairing logic
let currentSessionId = null;
let pollInterval = null;

function setStatus(text, isConnected) {
  const el = document.getElementById('statusText');
  el.innerHTML = text;
  el.className = isConnected ? 'status connected' : 'status';
}

async function startPairing() {
  const phone = document.getElementById('phoneInput').value.trim();
  if (!phone) {
    setStatus('⚠️ Please enter your phone number');
    return;
  }
  
  const btn = document.getElementById('pairBtn');
  btn.disabled = true;
  btn.textContent = 'CONNECTING...';
  setStatus('<span class="spinner"></span>Requesting pairing code...');
  
  document.getElementById('pairingCodeContainer').style.display = 'none';
  document.getElementById('qrContainer').style.display = 'none';
  
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    
    if (data.error) {
      setStatus('❌ Error: ' + data.error);
      btn.disabled = false;
      btn.textContent = 'GET PAIRING CODE';
      return;
    }
    
    currentSessionId = data.sessionId;
    pollStatus();
  } catch (err) {
    setStatus('❌ Connection error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'GET PAIRING CODE';
  }
}

async function startQRPairing() {
  setStatus('<span class="spinner"></span>Generating QR code...');
  
  document.getElementById('pairingCodeContainer').style.display = 'none';
  document.getElementById('qrContainer').style.display = 'none';
  
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '' })
    });
    const data = await res.json();
    
    if (data.error) {
      setStatus('❌ Error: ' + data.error);
      return;
    }
    
    currentSessionId = data.sessionId;
    pollStatus(true);
  } catch (err) {
    setStatus('❌ Connection error: ' + err.message);
  }
}

function pollStatus(isQR = false) {
  if (pollInterval) clearInterval(pollInterval);
  
  pollInterval = setInterval(async () => {
    if (!currentSessionId) return;
    
    try {
      const res = await fetch('/api/status/' + currentSessionId);
      const data = await res.json();
      
      if (data.status === 'pairing_code_ready' && data.pairingCode) {
        document.getElementById('pairingCode').textContent = data.pairingCode;
        document.getElementById('pairingCodeContainer').style.display = 'block';
        document.getElementById('qrContainer').style.display = 'none';
        setStatus('<span class="spinner"></span>Waiting for you to enter the code...');
        
        const btn = document.getElementById('pairBtn');
        btn.disabled = false;
        btn.textContent = 'GET PAIRING CODE';
      }
      
      if (data.qrAvailable && isQR) {
        document.getElementById('qrImage').src = '/api/qr/' + currentSessionId + '?t=' + Date.now();
        document.getElementById('qrContainer').style.display = 'block';
        document.getElementById('pairingCodeContainer').style.display = 'none';
        setStatus('<span class="spinner"></span>Scan the QR code with WhatsApp...');
      }
      
      if (data.connected) {
        clearInterval(pollInterval);
        setStatus('✅ CONNECTED SUCCESSFULLY! Check your WhatsApp for the session ID.', true);
        
        const btn = document.getElementById('pairBtn');
        btn.disabled = false;
        btn.textContent = 'GET PAIRING CODE';
        
        // Hide code/QR after connected
        document.getElementById('pairingCodeContainer').style.display = 'none';
        document.getElementById('qrContainer').style.display = 'none';
      }
      
      if (data.status === 'pairing_failed') {
        clearInterval(pollInterval);
        setStatus('❌ Pairing failed: ' + (data.error || 'Unknown error'));
        const btn = document.getElementById('pairBtn');
        btn.disabled = false;
        btn.textContent = 'GET PAIRING CODE';
      }
      
      if (data.status === 'logged_out') {
        clearInterval(pollInterval);
        setStatus('❌ Session logged out. Try again.');
        const btn = document.getElementById('pairBtn');
        btn.disabled = false;
        btn.textContent = 'GET PAIRING CODE';
      }
      
    } catch (err) {
      // Silently retry
    }
  }, 2000);
}
</script>

</body>
</html>`);
});

// ──── Start Server ────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] YOBBY TECH Pairing Site running on port ${PORT}`);
  console.log(`[SERVER] Open http://localhost:${PORT} to pair your WhatsApp`);
  console.log(`[TUNNEL] Run: cloudflared tunnel --no-autoupdate run --token <YOUR_TOKEN>`);
  console.log(`[TUNNEL] Or: npm run tunnel`);
});
