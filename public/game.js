// Co-op Climb — client. Runs in three modes based on URL:
//
//   /                  -> landing page: "Start" creates a room, "Join" asks for a code
//   /?room=XXXX&host=1 -> host/TV view: shows QR + big room code + game
//   /?room=XXXX        -> player view: mobile-friendly, big touch controls
//
// The client always renders whatever the server sends; physics is
// authoritative on the server. Player movement uses interpolation for
// smoothness.

(() => {
  'use strict';

  // ---------- Mode detection ----------
  const params = new URLSearchParams(location.search);
  const urlRoomCode = (params.get('room') || '').trim();
  const isHost = params.get('host') === '1';

  const el = (id) => document.getElementById(id);
  const landing = el('landing');
  const hostScreen = el('host-screen');
  const playerScreen = el('player-screen');

  function showScreen(name) {
    landing.classList.toggle('hidden', name !== 'landing');
    hostScreen.classList.toggle('hidden', name !== 'host');
    playerScreen.classList.toggle('hidden', name !== 'player');
  }

  // ---------- Landing ----------
  const btnStart = el('btn-start');
  const btnJoin = el('btn-join');
  const codeInput = el('code-input');
  const landingError = el('landing-error');

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    landingError.textContent = '';
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error('server error');
      const data = await res.json();
      // Redirect to host/TV view for this room
      location.href = `${location.pathname}?room=${encodeURIComponent(data.code)}&host=1`;
    } catch (err) {
      landingError.textContent = "Couldn't start a new game. Please try again.";
      btnStart.disabled = false;
    }
  });

  btnJoin.addEventListener('click', () => {
    const code = (codeInput.value || '').replace(/[^0-9]/g, '').slice(0, 4);
    if (code.length !== 4) {
      landingError.textContent = 'Please type the 4-digit room number.';
      codeInput.focus();
      return;
    }
    location.href = `${location.pathname}?room=${encodeURIComponent(code)}`;
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/[^0-9]/g, '').slice(0, 4);
  });

  // If no room in URL, show landing and stop here.
  if (!urlRoomCode) {
    showScreen('landing');
    return;
  }

  // =============================================================
  //  SHARED GAME STATE (used by both host and player views)
  // =============================================================
  let ws = null;
  let role = isHost ? 'host' : 'player';
  let myId = null;
  let maxPlayers = 15;
  let level = null;
  let playerW = 40;
  let playerH = 56;

  let prevSnapshot = null;
  let nextSnapshot = null;
  let entities = [];
  let goalStatus = { atGoal: 0, needed: 0, hold: 0 };
  let playerMeta = {};

  const camera = { x: 0, y: 0, scale: 1 };

  // =============================================================
  //  NETWORKING
  // =============================================================
  function connect(joinPayload) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', ...joinPayload })));
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      onError('Connection lost. Refresh the page to try again.');
    });
    ws.addEventListener('error', () => {
      onError('Could not reach the game server.');
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'error':
        onError(msg.message || 'Something went wrong.');
        break;
      case 'roomFull':
        onError(`This room is full (max ${msg.max} players).`);
        break;
      case 'welcome':
        myId = msg.id;
        maxPlayers = msg.maxPlayers || 15;
        playerW = msg.playerW;
        playerH = msg.playerH;
        level = msg.level;
        if (role === 'host') initHostView(msg);
        else initPlayerGame();
        updateLevelUi();
        break;
      case 'level':
        level = msg.level;
        prevSnapshot = null;
        nextSnapshot = null;
        updateLevelUi();
        showToast(level.name, 2500);
        break;
      case 'state': {
        const t = performance.now();
        prevSnapshot = nextSnapshot;
        nextSnapshot = { t, players: msg.players };
        entities = msg.entities || [];
        goalStatus = msg.goal || { atGoal: 0, needed: 0, hold: 0 };
        for (const p of msg.players) playerMeta[p.id] = { name: p.name, color: p.color };
        break;
      }
      case 'playerJoin':
        playerMeta[msg.player.id] = { name: msg.player.name, color: msg.player.color };
        showToast(`${msg.player.name} joined!`, 1800);
        break;
      case 'playerLeave':
        delete playerMeta[msg.id];
        if (msg.name) showToast(`${msg.name} left`, 1500);
        break;
      case 'win':
        showToast('🎉 You beat the game! Well done!', 4500);
        break;
    }
  }

  function onError(message) {
    if (role === 'host') {
      // show a toast on host
      showToast(message, 4000);
    } else {
      // show in player name-step error if visible, else toast
      const err = el('player-name-error');
      const toast = el('player-toast');
      if (err && !el('player-name-step').classList.contains('hidden')) {
        err.textContent = message;
      } else if (toast) {
        showToast(message, 4000);
      }
    }
  }

  // =============================================================
  //  HOST / TV VIEW
  // =============================================================
  const hostCanvas = el('game-canvas');
  const hostCtx = hostCanvas.getContext('2d');
  const hostToast = el('host-toast');
  const playerToast = el('player-toast');
  const qrImg = el('qr-image');
  const roomCodeEl = el('room-code');
  const roomUrlEl = el('room-url');
  const hostLevelName = el('host-level-name');
  const hostPlayerCount = el('host-player-count');
  const hostGoalMeter = el('host-goal-meter');
  const hostHint = el('host-hint');
  const hostPlayerListBody = el('host-player-list-body');

  function initHostView(welcome) {
    showScreen('host');
    roomCodeEl.textContent = welcome.roomCode;
    roomUrlEl.textContent = welcome.roomUrl;
    if (welcome.qrDataUrl) qrImg.src = welcome.qrDataUrl;
    resizeHostCanvas();
    window.addEventListener('resize', resizeHostCanvas);
    requestAnimationFrame(hostLoop);
  }

  function resizeHostCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = hostCanvas.getBoundingClientRect();
    hostCanvas.width = Math.floor(rect.width * dpr);
    hostCanvas.height = Math.floor(rect.height * dpr);
    hostCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function hostLoop() {
    renderScene(hostCtx, hostCanvas, /*focusId*/ null, /*bigUi*/ true);
    updateHostHud();
    requestAnimationFrame(hostLoop);
  }

  function updateHostHud() {
    if (!level) return;
    const ps = nextSnapshot ? nextSnapshot.players : [];
    hostLevelName.textContent = level.name;
    hostPlayerCount.textContent = `${ps.length} / ${maxPlayers}`;
    hostGoalMeter.textContent = `${goalStatus.atGoal} of ${goalStatus.needed}`;
    hostHint.textContent = level.hint || '';

    // Player list
    hostPlayerListBody.innerHTML = '';
    for (const p of ps) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const dot = document.createElement('span');
      dot.className = 'list-dot';
      dot.style.background = p.color;
      const name = document.createElement('span');
      name.textContent = p.name;
      const status = document.createElement('span');
      status.className = 'list-status';
      status.textContent = p.atGoal ? '🏁' : '';
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(status);
      hostPlayerListBody.appendChild(row);
    }
  }

  // =============================================================
  //  PLAYER VIEW
  // =============================================================
  const playerCanvas = el('player-canvas');
  const playerCtx = playerCanvas ? playerCanvas.getContext('2d') : null;
  const playerNameStep = el('player-name-step');
  const playerGame = el('player-game');
  const playerNameInput = el('player-name-input');
  const playerNameGo = el('player-name-go');
  const playerNameError = el('player-name-error');
  const playerRoomCode = el('player-room-code');
  const playerHudName = el('player-hud-name');
  const playerHudLevel = el('player-hud-level');
  const playerHint = el('player-hint');

  const input = { left: false, right: false, jump: false };
  let lastSentInput = null;

  function initPlayerGame() {
    playerNameStep.classList.add('hidden');
    playerGame.classList.remove('hidden');
    resizePlayerCanvas();
    window.addEventListener('resize', resizePlayerCanvas);
    requestAnimationFrame(playerLoop);
    setupTouchControls();
    setupKeyboardBackup();
  }

  function resizePlayerCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = playerCanvas.getBoundingClientRect();
    playerCanvas.width = Math.floor(rect.width * dpr);
    playerCanvas.height = Math.floor(rect.height * dpr);
    playerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function playerLoop() {
    renderScene(playerCtx, playerCanvas, myId, /*bigUi*/ false);
    updatePlayerHud();
    requestAnimationFrame(playerLoop);
  }

  function updatePlayerHud() {
    if (!level) return;
    playerHudLevel.textContent = level.name;
    const me = playerMeta[myId];
    if (me) {
      playerHudName.innerHTML = '';
      const dot = document.createElement('span');
      dot.style.display = 'inline-block';
      dot.style.width = '14px';
      dot.style.height = '14px';
      dot.style.borderRadius = '3px';
      dot.style.background = me.color;
      dot.style.marginRight = '6px';
      dot.style.verticalAlign = 'middle';
      playerHudName.appendChild(dot);
      playerHudName.appendChild(document.createTextNode(me.name));
    }
    playerHint.textContent = level.hint || '';
  }

  function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const snap = { left: input.left, right: input.right, jump: input.jump };
    if (lastSentInput &&
        lastSentInput.left === snap.left &&
        lastSentInput.right === snap.right &&
        lastSentInput.jump === snap.jump) return;
    lastSentInput = snap;
    ws.send(JSON.stringify({ type: 'input', keys: snap }));
  }

  function setupTouchControls() {
    // For each touch button, bind pointer events that press/release the input.
    const buttons = document.querySelectorAll('#touch-controls .touch-btn');
    const pressed = {};
    buttons.forEach((btn) => {
      const key = btn.dataset.key;
      const press = (ev) => {
        ev.preventDefault();
        if (pressed[key]) return;
        pressed[key] = true;
        input[key] = true;
        btn.classList.add('active');
        sendInput();
      };
      const release = (ev) => {
        ev.preventDefault();
        pressed[key] = false;
        input[key] = false;
        btn.classList.remove('active');
        sendInput();
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', (ev) => {
        if (pressed[key]) release(ev);
      });
      // Also handle touchstart in case pointer events don't fire on some browsers
      btn.addEventListener('touchstart', press, { passive: false });
      btn.addEventListener('touchend', release);
      btn.addEventListener('touchcancel', release);
      // Prevent context menu on long press
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // Release everything when tab loses focus
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        input.left = input.right = input.jump = false;
        document.querySelectorAll('.touch-btn.active').forEach((b) => b.classList.remove('active'));
        sendInput();
      }
    });
  }

  function setupKeyboardBackup() {
    // Support keyboard too — useful if playing from a laptop.
    window.addEventListener('keydown', (e) => {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': input.left = true; sendInput(); e.preventDefault(); break;
        case 'ArrowRight': case 'KeyD': input.right = true; sendInput(); e.preventDefault(); break;
        case 'Space': case 'ArrowUp': case 'KeyW':
          input.jump = true; sendInput(); e.preventDefault(); break;
      }
    });
    window.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': input.left = false; sendInput(); break;
        case 'ArrowRight': case 'KeyD': input.right = false; sendInput(); break;
        case 'Space': case 'ArrowUp': case 'KeyW':
          input.jump = false; sendInput(); break;
      }
    });
    window.addEventListener('blur', () => {
      input.left = input.right = input.jump = false;
      sendInput();
    });
  }

  // =============================================================
  //  RENDERING
  // =============================================================
  function interpolatedPlayers() {
    if (!nextSnapshot) return [];
    if (!prevSnapshot) return nextSnapshot.players;
    const renderDelay = 100;
    const t = performance.now() - renderDelay;
    const span = nextSnapshot.t - prevSnapshot.t;
    if (span <= 0) return nextSnapshot.players;
    let alpha = (t - prevSnapshot.t) / span;
    if (alpha < 0) alpha = 0;
    if (alpha > 1) alpha = 1;
    const prevMap = new Map(prevSnapshot.players.map((p) => [p.id, p]));
    return nextSnapshot.players.map((p) => {
      const a = prevMap.get(p.id);
      if (!a) return p;
      return { ...p, x: a.x + (p.x - a.x) * alpha, y: a.y + (p.y - a.y) * alpha };
    });
  }

  function updateCamera(canvas, focusPlayer) {
    if (!level) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    // Fit level height into the view; adjust width by aspect
    const desiredVisH = 600; // show this much vertical world
    camera.scale = viewH / desiredVisH;
    if (camera.scale < 0.25) camera.scale = 0.25;

    const visW = viewW / camera.scale;
    const visH = viewH / camera.scale;
    let focusX, focusY;
    if (focusPlayer) {
      focusX = focusPlayer.x + playerW / 2;
      focusY = focusPlayer.y + playerH / 2;
    } else {
      // Host view: follow the centroid of all players
      const ps = nextSnapshot ? nextSnapshot.players : [];
      if (ps.length === 0) {
        focusX = level.width / 2;
        focusY = level.height / 2;
      } else {
        let sx = 0, sy = 0;
        for (const p of ps) { sx += p.x; sy += p.y; }
        focusX = sx / ps.length + playerW / 2;
        focusY = sy / ps.length + playerH / 2;
      }
    }
    camera.x = focusX - visW / 2;
    camera.y = focusY - visH / 2;
    if (camera.x < 0) camera.x = 0;
    if (camera.y < 0) camera.y = 0;
    if (camera.x + visW > level.width) camera.x = level.width - visW;
    if (camera.y + visH > level.height) camera.y = level.height - visH;
  }

  function worldToScreen(x, y) {
    return [(x - camera.x) * camera.scale, (y - camera.y) * camera.scale];
  }

  function renderScene(ctx, canvas, focusId, bigUi) {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    if (!level) return;
    const ps = interpolatedPlayers();
    const me = focusId ? ps.find((p) => p.id === focusId) : null;
    updateCamera(canvas, me);

    drawBackground(ctx, canvas);

    const order = ['platform', 'hazard', 'checkpoint', 'plate', 'door', 'goal', 'sign'];
    const byType = {};
    for (const e of level.entities) (byType[e.type] || (byType[e.type] = [])).push(e);
    for (const t of order) {
      if (!byType[t]) continue;
      for (const e of byType[t]) drawEntity(ctx, e, bigUi);
    }
    for (const p of ps) drawPlayer(ctx, p, focusId, bigUi);

    // Goal hold bar (centered)
    if (goalStatus.hold > 0) {
      const dprW = canvas.width / dpr;
      const dprH = canvas.height / dpr;
      const w = Math.min(420, dprW * 0.6);
      const x = (dprW - w) / 2;
      const y = dprH * 0.12;
      ctx.fillStyle = 'rgba(10,45,110,0.78)';
      ctx.fillRect(x - 10, y - 32, w + 20, 52);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Hold at the flag...', x + w / 2, y - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x, y, w, 14);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(x, y, w * goalStatus.hold, 14);
    }
  }

  function drawBackground(ctx, canvas) {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    // Clouds
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 260) - camera.x * 0.15) % (viewW + 300);
      const cy = 60 + (i % 3) * 40;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, 0, Math.PI * 2);
      ctx.arc(cx + 22, cy + 4, 22, 0, Math.PI * 2);
      ctx.arc(cx + 46, cy, 26, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
    // Far hills
    ctx.fillStyle = 'rgba(120,180,120,0.45)';
    for (let i = 0; i < 8; i++) {
      const bx = ((i * 220) - camera.x * 0.4) % (viewW + 300);
      ctx.beginPath();
      ctx.moveTo(bx, viewH * 0.85);
      ctx.quadraticCurveTo(bx + 110, viewH * 0.55, bx + 220, viewH * 0.85);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawEntity(ctx, e, bigUi) {
    const [sx, sy] = worldToScreen(e.x, e.y);
    const w = (e.w || 0) * camera.scale;
    const h = (e.h || 0) * camera.scale;
    switch (e.type) {
      case 'platform': {
        ctx.fillStyle = e.color || '#8d6e63';
        ctx.fillRect(sx, sy, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(sx, sy, w, Math.max(3, 4 * camera.scale));
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1);
        break;
      }
      case 'hazard': {
        const grad = ctx.createLinearGradient(sx, sy, sx, sy + h);
        grad.addColorStop(0, 'rgba(70,45,30,0.95)');
        grad.addColorStop(1, 'rgba(30,20,10,1)');
        ctx.fillStyle = grad;
        ctx.fillRect(sx, sy, w, h);
        break;
      }
      case 'plate': {
        const volatile = entities.find((x) => x.type === 'plate' && x.id === e.id);
        const active = volatile && volatile.active;
        const count = volatile ? (volatile.count || 0) : 0;
        // Base
        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(sx - 4, sy + h, w + 8, 4 * camera.scale);
        // Plate top
        const topOffset = active ? 3 * camera.scale : 0;
        ctx.fillStyle = active ? '#7bcf3a' : (e.color || '#fbc02d');
        ctx.fillRect(sx, sy + topOffset, w, h - topOffset);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5 + topOffset, w - 1, h - 1 - topOffset);
        // Label
        ctx.fillStyle = '#0a2d6e';
        const fs = bigUi ? 18 : 14;
        ctx.font = `bold ${Math.max(12, fs * camera.scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${count} / ${e.required}`, sx + w / 2, sy - 6 * camera.scale);
        break;
      }
      case 'door': {
        const volatile = entities.find((x) => x.type === 'door' && x.id === e.id);
        const open = volatile && volatile.open;
        if (open) {
          ctx.strokeStyle = 'rgba(106,46,126,0.35)';
          ctx.setLineDash([5, 5]);
          ctx.lineWidth = 2;
          ctx.strokeRect(sx, sy, w, h);
          ctx.setLineDash([]);
        } else {
          const grad = ctx.createLinearGradient(sx, sy, sx + w, sy);
          grad.addColorStop(0, '#6a2e7e');
          grad.addColorStop(1, '#4a1e5e');
          ctx.fillStyle = grad;
          ctx.fillRect(sx, sy, w, h);
          ctx.fillStyle = 'rgba(255,255,255,0.2)';
          ctx.fillRect(sx + w * 0.25, sy + 4 * camera.scale, w * 0.1, h - 8 * camera.scale);
        }
        break;
      }
      case 'checkpoint': {
        ctx.fillStyle = '#795548';
        ctx.fillRect(sx + w / 2 - 2, sy, 4 * camera.scale, h);
        ctx.fillStyle = '#81c784';
        ctx.beginPath();
        ctx.moveTo(sx + w / 2, sy + 6 * camera.scale);
        ctx.lineTo(sx + w / 2 + 26 * camera.scale, sy + 14 * camera.scale);
        ctx.lineTo(sx + w / 2, sy + 22 * camera.scale);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'goal': {
        // Gold flag / finish
        const grad = ctx.createLinearGradient(sx, sy, sx, sy + h);
        grad.addColorStop(0, '#ffe066');
        grad.addColorStop(1, '#f6a93a');
        ctx.fillStyle = grad;
        ctx.fillRect(sx, sy, w, h);
        // Stripes
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        for (let y = sy; y < sy + h; y += 16) ctx.fillRect(sx, y, w, 4);
        ctx.strokeStyle = '#0a2d6e';
        ctx.lineWidth = 3;
        ctx.strokeRect(sx, sy, w, h);
        ctx.fillStyle = '#0a2d6e';
        ctx.font = `bold ${Math.max(18, 22 * camera.scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('FLAG', sx + w / 2, sy + h / 2 + 8 * camera.scale);
        break;
      }
      case 'sign': {
        const text = e.text || '';
        const fsPx = Math.max(12, 16 * camera.scale);
        ctx.font = `bold ${fsPx}px sans-serif`;
        const tw = ctx.measureText(text).width + 20;
        const th = fsPx + 12;
        ctx.fillStyle = 'rgba(10,45,110,0.82)';
        ctx.fillRect(sx - tw / 2, sy - th, tw, th);
        ctx.fillStyle = '#ffd166';
        ctx.textAlign = 'center';
        ctx.fillText(text, sx, sy - 8);
        break;
      }
    }
  }

  function drawPlayer(ctx, p, focusId, bigUi) {
    const [sx, sy] = worldToScreen(p.x, p.y);
    const w = playerW * camera.scale;
    const h = playerH * camera.scale;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(sx + w / 2, sy + h + 4 * camera.scale, w * 0.48, 4 * camera.scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body (rounded rect)
    const radius = Math.max(4, 8 * camera.scale);
    drawRoundRect(ctx, sx, sy, w, h, radius, p.color || '#4fb8dc');

    // Outline
    if (p.id === focusId) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1.5;
    }
    strokeRoundRect(ctx, sx, sy, w, h, radius);

    // Face
    const eyeY = sy + h * 0.32;
    const face = (p.facing >= 0 ? 1 : -1);
    const eyeOffset = face * 2 * camera.scale;
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx + w * 0.22, eyeY, 6 * camera.scale, 6 * camera.scale);
    ctx.fillRect(sx + w * 0.62, eyeY, 6 * camera.scale, 6 * camera.scale);
    ctx.fillStyle = '#0a2d6e';
    ctx.fillRect(sx + w * 0.22 + 1 + eyeOffset, eyeY + 1, 3 * camera.scale, 4 * camera.scale);
    ctx.fillRect(sx + w * 0.62 + 1 + eyeOffset, eyeY + 1, 3 * camera.scale, 4 * camera.scale);
    // Smile
    ctx.strokeStyle = '#0a2d6e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx + w / 2, sy + h * 0.62, w * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // Goal halo
    if (p.atGoal) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(sx + w / 2, sy + h / 2, Math.max(w, h) * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Name tag
    const name = p.name || (playerMeta[p.id] && playerMeta[p.id].name) || '';
    if (name) {
      const fs = bigUi ? 16 : 14;
      const fsPx = Math.max(12, fs * camera.scale);
      ctx.font = `bold ${fsPx}px sans-serif`;
      const tw = ctx.measureText(name).width + 14;
      ctx.fillStyle = 'rgba(10,45,110,0.86)';
      ctx.fillRect(sx + w / 2 - tw / 2, sy - fsPx - 8, tw, fsPx + 6);
      ctx.textAlign = 'center';
      ctx.fillStyle = p.id === focusId ? '#ffd166' : '#ffffff';
      ctx.fillText(name, sx + w / 2, sy - 10);
    }
  }

  function drawRoundRect(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }
  function strokeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.stroke();
  }

  function updateLevelUi() {
    // both views read this elsewhere; nothing central to do here
  }

  // =============================================================
  //  TOASTS
  // =============================================================
  let toastTimer = null;
  function showToast(text, ms = 2000) {
    const toast = role === 'host' ? hostToast : playerToast;
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  // =============================================================
  //  BOOT
  // =============================================================
  if (isHost) {
    // Host: connect immediately; our "player slot" isn't used but we
    // still want state updates.
    connect({ role: 'host', roomCode: urlRoomCode });
    showScreen('host');
  } else {
    // Player: show the name step first
    showScreen('player');
    playerRoomCode.textContent = urlRoomCode;

    // Pre-fill name from localStorage
    try {
      const saved = localStorage.getItem('coopclimb.name');
      if (saved) playerNameInput.value = saved;
    } catch (_) {}

    playerNameGo.addEventListener('click', () => {
      const name = (playerNameInput.value || '').trim().slice(0, 14);
      if (!name) {
        playerNameError.textContent = 'Please enter your name.';
        playerNameInput.focus();
        return;
      }
      try { localStorage.setItem('coopclimb.name', name); } catch (_) {}
      playerNameGo.disabled = true;
      playerNameError.textContent = '';
      connect({ role: 'player', roomCode: urlRoomCode, name });
    });
    playerNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') playerNameGo.click();
    });
  }
})();
