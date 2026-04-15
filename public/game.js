// Co-op Climb — client. Handles input, rendering, and WebSocket
// communication with the authoritative server.
//
// The server sends ~30 state updates per second; we interpolate
// player positions between the last two updates for smoother motion.

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const joinOverlay = document.getElementById('join-overlay');
  const gameRoot = document.getElementById('game-root');
  const nameInput = document.getElementById('name-input');
  const joinBtn = document.getElementById('join-btn');
  const joinStatus = document.getElementById('join-status');
  const levelNameEl = document.getElementById('level-name');
  const levelProgressEl = document.getElementById('level-progress');
  const playerCountEl = document.getElementById('player-count');
  const goalMeterEl = document.getElementById('goal-meter');
  const playerListEl = document.getElementById('player-list');
  const toastEl = document.getElementById('toast');
  const holdWrap = document.getElementById('hold-bar-wrap');
  const holdFill = document.getElementById('hold-fill');

  // Remember last name
  try {
    const saved = localStorage.getItem('coopclimb.name');
    if (saved) nameInput.value = saved;
  } catch (_) {}

  // ---- State ----
  let ws = null;
  let myId = null;
  let maxPlayers = 15;
  let level = null;              // { name, width, height, entities, index, total }
  let playerW = 28;
  let playerH = 40;

  // Interpolation buffers
  let prevSnapshot = null;       // { t, players }
  let nextSnapshot = null;
  let entities = [];             // volatile entity state (plates/doors)
  let goalStatus = { atGoal: 0, needed: 0, hold: 0 };
  let playerMeta = {};           // id -> { name, color }
  let winActive = false;

  // Camera
  const camera = { x: 0, y: 0, scale: 1 };

  // Input
  const input = { left: false, right: false, jump: false };
  let lastSentInput = null;

  // ---- Networking ----
  function connect(name) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;
    joinStatus.textContent = 'Connecting...';
    joinBtn.disabled = true;

    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', name }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      if (myId == null) {
        joinStatus.textContent = 'Connection closed. Refresh to try again.';
        joinBtn.disabled = false;
      } else {
        showToast('Disconnected', 4000);
      }
    });

    ws.addEventListener('error', () => {
      joinStatus.textContent = 'Could not reach server.';
      joinBtn.disabled = false;
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'full':
        joinStatus.textContent = `Server is full (max ${msg.max} players).`;
        joinBtn.disabled = false;
        break;
      case 'welcome':
        myId = msg.id;
        maxPlayers = msg.maxPlayers;
        level = msg.level;
        playerW = msg.playerW;
        playerH = msg.playerH;
        joinOverlay.classList.add('hidden');
        gameRoot.classList.remove('hidden');
        updateLevelUi();
        requestAnimationFrame(loop);
        break;
      case 'level':
        level = msg.level;
        prevSnapshot = null;
        nextSnapshot = null;
        updateLevelUi();
        showToast(level.name, 2200);
        break;
      case 'state': {
        const stamp = performance.now();
        prevSnapshot = nextSnapshot;
        nextSnapshot = { t: stamp, players: msg.players };
        entities = msg.entities || [];
        goalStatus = msg.goal || { atGoal: 0, needed: 0, hold: 0 };
        for (const p of msg.players) {
          playerMeta[p.id] = { name: p.name, color: p.color };
        }
        break;
      }
      case 'playerJoin':
        playerMeta[msg.player.id] = { name: msg.player.name, color: msg.player.color };
        showToast(`${msg.player.name} joined`, 1500);
        break;
      case 'playerLeave':
        delete playerMeta[msg.id];
        if (msg.name) showToast(`${msg.name} left`, 1500);
        break;
      case 'win':
        winActive = true;
        showToast('🏆 You beat the game! Restarting...', 4500);
        setTimeout(() => { winActive = false; }, 5000);
        break;
    }
  }

  function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const snap = { left: input.left, right: input.right, jump: input.jump };
    const prev = lastSentInput;
    if (prev && prev.left === snap.left && prev.right === snap.right && prev.jump === snap.jump) return;
    lastSentInput = snap;
    ws.send(JSON.stringify({ type: 'input', keys: snap }));
  }

  function sendRestart() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'restart' }));
  }
  function sendSuicide() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'suicide' }));
  }

  // ---- Input ----
  window.addEventListener('keydown', (e) => {
    if (joinOverlay.classList.contains('hidden') === false) return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': input.left = true; sendInput(); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': input.right = true; sendInput(); e.preventDefault(); break;
      case 'Space': case 'ArrowUp': case 'KeyW':
        input.jump = true; sendInput(); e.preventDefault(); break;
      case 'KeyR':
        if (e.shiftKey) sendRestart();
        else sendSuicide();
        e.preventDefault();
        break;
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

  // Release inputs when tab loses focus so the player doesn't run into walls
  window.addEventListener('blur', () => {
    input.left = input.right = input.jump = false;
    sendInput();
  });

  // Join UI
  joinBtn.addEventListener('click', () => {
    const name = (nameInput.value || '').trim().slice(0, 16) || `Player`;
    try { localStorage.setItem('coopclimb.name', name); } catch (_) {}
    connect(name);
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });

  // ---- Rendering ----
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function interpolatedPlayers() {
    if (!nextSnapshot) return [];
    if (!prevSnapshot) return nextSnapshot.players;
    // Render with a fixed delay so we always have a "next" frame to interp to
    const renderDelay = 100; // ms
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
      return {
        ...p,
        x: a.x + (p.x - a.x) * alpha,
        y: a.y + (p.y - a.y) * alpha,
      };
    });
  }

  function updateCamera(me) {
    if (!level) return;
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    const scaleX = viewW / 1280;
    const scaleY = viewH / 720;
    camera.scale = Math.min(scaleX, scaleY);
    if (camera.scale < 0.5) camera.scale = 0.5;

    const visW = viewW / camera.scale;
    const visH = viewH / camera.scale;
    const focusX = me ? me.x + playerW / 2 : level.width / 2;
    const focusY = me ? me.y + playerH / 2 : level.height / 2;
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

  function drawBackground() {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    // Sky is set by canvas CSS gradient. Draw some parallax stars / hills.
    ctx.save();
    // Distant mountains
    ctx.fillStyle = 'rgba(40,60,100,0.55)';
    for (let i = 0; i < 6; i++) {
      const baseX = (-camera.x * 0.2 + i * 340) % (viewW + 400) - 200;
      ctx.beginPath();
      ctx.moveTo(baseX, viewH * 0.75);
      ctx.lineTo(baseX + 170, viewH * 0.45);
      ctx.lineTo(baseX + 340, viewH * 0.75);
      ctx.closePath();
      ctx.fill();
    }
    // Closer hills
    ctx.fillStyle = 'rgba(30,80,60,0.5)';
    for (let i = 0; i < 8; i++) {
      const baseX = (-camera.x * 0.5 + i * 220) % (viewW + 300) - 150;
      ctx.beginPath();
      ctx.moveTo(baseX, viewH * 0.9);
      ctx.quadraticCurveTo(baseX + 110, viewH * 0.6, baseX + 220, viewH * 0.9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEntity(e) {
    const [sx, sy] = worldToScreen(e.x, e.y);
    const w = e.w * camera.scale;
    const h = e.h * camera.scale;
    switch (e.type) {
      case 'platform': {
        ctx.fillStyle = e.color || '#6b705c';
        ctx.fillRect(sx, sy, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(sx, sy, w, 3 * camera.scale);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1);
        break;
      }
      case 'hazard': {
        if (e.kind === 'spikes') {
          ctx.fillStyle = e.color || '#adb5bd';
          const spikeW = 12 * camera.scale;
          for (let x = sx; x < sx + w; x += spikeW) {
            ctx.beginPath();
            ctx.moveTo(x, sy + h);
            ctx.lineTo(x + spikeW / 2, sy);
            ctx.lineTo(x + spikeW, sy + h);
            ctx.closePath();
            ctx.fill();
          }
        } else {
          // pit — draw as ominous dark hole
          const grad = ctx.createLinearGradient(sx, sy, sx, sy + h);
          grad.addColorStop(0, 'rgba(80,0,20,0.85)');
          grad.addColorStop(1, 'rgba(0,0,0,1)');
          ctx.fillStyle = grad;
          ctx.fillRect(sx, sy, w, h);
        }
        break;
      }
      case 'plate': {
        const volatile = entities.find((x) => x.type === 'plate' && x.id === e.id);
        const active = volatile && volatile.active;
        const count = volatile ? volatile.count || 0 : 0;
        ctx.fillStyle = active ? '#06d6a0' : (e.color || '#e9c46a');
        ctx.fillRect(sx, sy + (active ? 2 * camera.scale : 0), w, h - (active ? 2 * camera.scale : 0));
        // base
        ctx.fillStyle = '#3a506b';
        ctx.fillRect(sx - 2 * camera.scale, sy + h, w + 4 * camera.scale, 3 * camera.scale);
        // label
        ctx.fillStyle = '#000';
        ctx.font = `${12 * camera.scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${count}/${e.required}`, sx + w / 2, sy - 4 * camera.scale);
        break;
      }
      case 'door': {
        const volatile = entities.find((x) => x.type === 'door' && x.id === e.id);
        const open = volatile && volatile.open;
        if (open) {
          // show as faded frame
          ctx.strokeStyle = 'rgba(106,76,147,0.35)';
          ctx.lineWidth = 2;
          ctx.strokeRect(sx, sy, w, h);
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(sx, sy, w, h);
          ctx.setLineDash([]);
        } else {
          const grad = ctx.createLinearGradient(sx, sy, sx + w, sy);
          grad.addColorStop(0, '#6a4c93');
          grad.addColorStop(1, '#4a2c73');
          ctx.fillStyle = grad;
          ctx.fillRect(sx, sy, w, h);
          ctx.fillStyle = 'rgba(255,255,255,0.2)';
          ctx.fillRect(sx + w * 0.3, sy + 4 * camera.scale, w * 0.1, h - 8 * camera.scale);
        }
        break;
      }
      case 'checkpoint': {
        ctx.fillStyle = '#3a506b';
        ctx.fillRect(sx + w / 2 - 1, sy, 2 * camera.scale, h);
        ctx.fillStyle = '#80ed99';
        ctx.beginPath();
        ctx.moveTo(sx + w / 2, sy + 5 * camera.scale);
        ctx.lineTo(sx + w / 2 + 24 * camera.scale, sy + 12 * camera.scale);
        ctx.lineTo(sx + w / 2, sy + 19 * camera.scale);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'goal': {
        // Flag / finish
        const grad = ctx.createLinearGradient(sx, sy, sx, sy + h);
        grad.addColorStop(0, '#ffd166');
        grad.addColorStop(1, '#f4a261');
        ctx.fillStyle = grad;
        ctx.fillRect(sx, sy, w, h);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, w, h);
        ctx.fillStyle = '#000';
        ctx.font = `bold ${18 * camera.scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('GOAL', sx + w / 2, sy + h / 2 + 6 * camera.scale);
        break;
      }
      case 'sign': {
        ctx.fillStyle = 'rgba(11,19,43,0.85)';
        ctx.strokeStyle = '#5bc0be';
        ctx.lineWidth = 1;
        const text = e.text || '';
        ctx.font = `${14 * camera.scale}px sans-serif`;
        const textW = ctx.measureText(text).width + 16 * camera.scale;
        const textH = 22 * camera.scale;
        ctx.fillRect(sx - textW / 2, sy - textH, textW, textH);
        ctx.strokeRect(sx - textW / 2, sy - textH, textW, textH);
        ctx.fillStyle = '#f5f5f5';
        ctx.textAlign = 'center';
        ctx.fillText(text, sx, sy - 6 * camera.scale);
        break;
      }
    }
  }

  function drawPlayer(p) {
    const [sx, sy] = worldToScreen(p.x, p.y);
    const w = playerW * camera.scale;
    const h = playerH * camera.scale;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(sx + w / 2, sy + h + 3 * camera.scale, w * 0.5, 3 * camera.scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = p.color || '#5bc0be';
    ctx.fillRect(sx, sy, w, h);

    // Outline — thicker for "me"
    if (p.id === myId) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
    }
    ctx.strokeRect(sx + 0.5, sy + 0.5, w - 1, h - 1);

    // Face (eyes that look in facing direction)
    const eyeY = sy + h * 0.3;
    const eyeOffset = (p.facing >= 0 ? 1 : -1) * 2 * camera.scale;
    ctx.fillStyle = '#fff';
    ctx.fillRect(sx + w * 0.25 - 2 * camera.scale, eyeY, 5 * camera.scale, 5 * camera.scale);
    ctx.fillRect(sx + w * 0.65 - 2 * camera.scale, eyeY, 5 * camera.scale, 5 * camera.scale);
    ctx.fillStyle = '#000';
    ctx.fillRect(sx + w * 0.25 - 1 * camera.scale + eyeOffset, eyeY + 1, 2 * camera.scale, 3 * camera.scale);
    ctx.fillRect(sx + w * 0.65 - 1 * camera.scale + eyeOffset, eyeY + 1, 2 * camera.scale, 3 * camera.scale);

    // At-goal halo
    if (p.atGoal) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx + w / 2, sy + h / 2, Math.max(w, h) * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Name tag
    const name = p.name || (playerMeta[p.id] && playerMeta[p.id].name) || '';
    ctx.font = `${12 * camera.scale}px sans-serif`;
    ctx.textAlign = 'center';
    const tagW = ctx.measureText(name).width + 10 * camera.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(sx + w / 2 - tagW / 2, sy - 18 * camera.scale, tagW, 16 * camera.scale);
    ctx.fillStyle = p.id === myId ? '#5bc0be' : '#fff';
    ctx.fillText(name, sx + w / 2, sy - 6 * camera.scale);
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    if (!level) return;
    drawBackground();

    const playersNow = interpolatedPlayers();
    const me = playersNow.find((p) => p.id === myId);
    updateCamera(me);

    // Draw level entities: platforms first, then decorations/interactives, goals last
    const order = ['platform', 'hazard', 'checkpoint', 'plate', 'door', 'goal', 'sign'];
    const byType = {};
    for (const e of level.entities) {
      (byType[e.type] || (byType[e.type] = [])).push(e);
    }
    for (const t of order) {
      if (!byType[t]) continue;
      for (const e of byType[t]) drawEntity(e);
    }

    // Draw players
    for (const p of playersNow) drawPlayer(p);

    // HUD updates
    playerCountEl.textContent = `Players: ${playersNow.length} / ${maxPlayers}`;
    goalMeterEl.textContent = `At goal: ${goalStatus.atGoal} / ${goalStatus.needed}`;
    if (goalStatus.hold > 0) {
      holdWrap.classList.remove('hidden');
      holdFill.style.width = `${Math.min(100, goalStatus.hold * 100)}%`;
    } else {
      holdWrap.classList.add('hidden');
    }

    // Player list
    renderPlayerList(playersNow);
  }

  function renderPlayerList(playersNow) {
    playerListEl.innerHTML = '';
    const sorted = [...playersNow].sort((a, b) => (a.id === myId ? -1 : (b.id === myId ? 1 : 0)));
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const swatch = document.createElement('span');
      swatch.className = 'player-swatch';
      swatch.style.background = p.color;
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === myId ? ' (you)' : '');
      if (p.id === myId) name.classList.add('me');
      const meta = document.createElement('span');
      meta.style.marginLeft = 'auto';
      meta.style.color = '#9aa0a6';
      meta.style.fontSize = '11px';
      meta.textContent = p.atGoal ? '🏁' : (p.deaths ? `☠️${p.deaths}` : '');
      row.appendChild(swatch);
      row.appendChild(name);
      row.appendChild(meta);
      playerListEl.appendChild(row);
    }
  }

  function updateLevelUi() {
    if (!level) return;
    levelNameEl.textContent = level.name || `Level ${level.index + 1}`;
    levelProgressEl.textContent = `Level ${level.index + 1} of ${level.total}`;
  }

  let toastTimer = null;
  function showToast(text, ms = 2000) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function loop() {
    render();
    requestAnimationFrame(loop);
  }
})();
