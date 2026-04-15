// Co-op Climb — multi-room game server.
//
// Each "room" has its own physics simulation, players, and level state.
// The host displays a TV view with a QR code pointing to
//     ${BASE_URL}/?room=<code>
// Players scan the QR on their phones and join that room.
//
// Rooms are identified by a 4-digit numeric code (easy to read aloud
// and easy for seniors to type).

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const { levels } = require('./levels');

// -------- Constants --------
const PORT = process.env.PORT || 3000;
// BASE_URL is where QR codes point. Defaults to the deployed URL, but
// if you set BASE_URL (e.g. BASE_URL=http://192.168.1.5:3000) QR codes
// will use that instead — useful for LAN testing.
const BASE_URL = process.env.BASE_URL || 'https://repo61-production.up.railway.app';

const MAX_PLAYERS_PER_ROOM = 15;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;

// Physics tuned for easy, senior-friendly play:
// slower horizontal speed, gentler gravity, generous jumps,
// bigger characters, generous collision margins.
const GRAVITY = 0.42;
const MOVE_ACCEL = 0.9;
const MOVE_MAX = 3.6;
const FRICTION = 0.72;
const AIR_FRICTION = 0.90;
const JUMP_VELOCITY = -10.5;
const PLAYER_W = 40;
const PLAYER_H = 56;
const MAX_FALL = 14;

// Goal: just 1 player needs to reach the goal and hold for 1.5s.
// Co-op still matters because other mechanics (plates, stacking) need
// teammates — but we never hold the group up because some players can't
// make it to the flag.
const GOAL_WIN_RATIO = 0.4;
const GOAL_MIN_PLAYERS = 1;
const GOAL_HOLD_TIME = 1.5;

const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // close idle/empty rooms after 10 min

const COLORS = [
  '#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#8338ec',
  '#ff006e', '#fb5607', '#ffbe0b', '#3a86ff', '#b5179e',
  '#43aa8b', '#f94144', '#f3722c', '#90be6d', '#577590',
];

// -------- Express / HTTP --------
const app = express();
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create a new room. Returns {code, url}.
app.post('/api/rooms', async (_req, res) => {
  try {
    const room = await createRoom();
    res.json({ code: room.code, url: roomUrl(room.code) });
  } catch (err) {
    console.error('Failed to create room', err);
    res.status(500).json({ error: 'could not create room' });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json({
    code: room.code,
    players: Object.keys(room.players).length,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    level: room.levelIndex,
    levelName: room.levelState.name,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + Object.keys(r.players).length, 0),
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -------- Rooms --------
const rooms = new Map();

function roomUrl(code) {
  return `${BASE_URL}/?room=${code}`;
}

function genRoomCode() {
  // 4-digit numeric code, avoiding collisions with existing rooms.
  // Elderly-friendly: short and spoken as "one-two-three-four".
  for (let i = 0; i < 50; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  // Fallback: sequential
  let n = 1000;
  while (rooms.has(String(n))) n++;
  return String(n);
}

async function createRoom() {
  const code = genRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    nextPlayerId: 1,
    players: {},
    clients: new Map(), // ws -> {id, role}
    levelIndex: 0,
    levelState: null,
    goalHoldStart: null,
    frame: 0,
    qrDataUrl: null,
  };
  loadLevel(room, 0);
  try {
    room.qrDataUrl = await QRCode.toDataURL(roomUrl(code), {
      width: 512,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a2d6e', light: '#ffffff' },
    });
  } catch (err) {
    console.error('QR generation failed', err);
    room.qrDataUrl = '';
  }
  rooms.set(code, room);
  console.log(`Room ${code} created (total: ${rooms.size})`);
  return room;
}

function destroyRoom(room) {
  rooms.delete(room.code);
  for (const [ws] of room.clients) {
    try { ws.close(); } catch (_) {}
  }
  console.log(`Room ${room.code} closed`);
}

// Periodic cleanup of empty / stale rooms
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const empty = room.clients.size === 0;
    const idleFor = now - room.lastActivity;
    if (empty && idleFor > 30_000) destroyRoom(room);
    else if (idleFor > ROOM_IDLE_TIMEOUT_MS) destroyRoom(room);
  }
}, 10_000);

// -------- Level & physics helpers (per-room) --------
function cloneLevel(def) {
  return {
    name: def.name,
    width: def.width,
    height: def.height,
    spawn: { ...def.spawn },
    entities: def.entities.map((e) => JSON.parse(JSON.stringify(e))),
  };
}

function loadLevel(room, index) {
  room.levelIndex = Math.max(0, Math.min(index, levels.length - 1));
  room.levelState = cloneLevel(levels[room.levelIndex]);
  room.goalHoldStart = null;
  for (const pid of Object.keys(room.players)) {
    respawnPlayer(room, room.players[pid], true);
  }
  broadcastRoom(room, {
    type: 'level',
    index: room.levelIndex,
    level: publicLevel(room),
  });
}

function publicLevel(room) {
  return {
    name: room.levelState.name,
    width: room.levelState.width,
    height: room.levelState.height,
    index: room.levelIndex,
    total: levels.length,
    entities: room.levelState.entities,
    hint: room.levelState.hint || '',
  };
}

function respawnPlayer(room, p, resetCheckpoint = false) {
  if (resetCheckpoint) p.checkpoint = { ...room.levelState.spawn };
  // Spread players a little so they don't all stack on spawn
  const spread = ((p.id - 1) % 5) * 48;
  p.x = p.checkpoint.x + spread;
  p.y = p.checkpoint.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = false;
  p.ridingId = null;
  p.deaths = p.deaths || 0;
  p.atGoal = false;
}

function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function rectFor(p) { return { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H }; }

function solids(room) {
  const out = [];
  for (const e of room.levelState.entities) {
    if (e.type === 'platform') out.push(e);
    else if (e.type === 'door' && !e.open) out.push(e);
  }
  return out;
}

function moveWithCollisions(room, p, rects, others) {
  // Horizontal
  p.x += p.vx;
  let r = rectFor(p);
  for (const s of rects) {
    if (aabbOverlap(r, s)) {
      if (p.vx > 0) p.x = s.x - PLAYER_W;
      else if (p.vx < 0) p.x = s.x + s.w;
      p.vx = 0;
      r = rectFor(p);
    }
  }
  if (p.x < 0) { p.x = 0; p.vx = 0; }
  if (p.x + PLAYER_W > room.levelState.width) {
    p.x = room.levelState.width - PLAYER_W; p.vx = 0;
  }

  // Vertical against solids
  p.y += p.vy;
  r = rectFor(p);
  p.onGround = false;
  for (const s of rects) {
    if (aabbOverlap(r, s)) {
      if (p.vy > 0) { p.y = s.y - PLAYER_H; p.onGround = true; p.ridingId = null; }
      else if (p.vy < 0) { p.y = s.y + s.h; }
      p.vy = 0;
      r = rectFor(p);
    }
  }

  // Vertical against other players (stand-on-head)
  for (const other of others) {
    if (other.id === p.id || !other.alive) continue;
    const o = { x: other.x, y: other.y, w: PLAYER_W, h: PLAYER_H };
    if (!aabbOverlap(r, o)) continue;
    if (p.vy > 0 && r.y + r.h - p.vy <= o.y + 6) {
      p.y = o.y - PLAYER_H; p.vy = 0; p.onGround = true; p.ridingId = other.id;
      r = rectFor(p);
    } else if (p.vy < 0 && r.y - p.vy >= o.y + o.h - 6) {
      p.y = o.y + o.h; p.vy = 0;
      r = rectFor(p);
    } else {
      const dx = (r.x + r.w / 2) - (o.x + o.w / 2);
      if (dx >= 0) p.x = o.x + o.w;
      else p.x = o.x - PLAYER_W;
      if (p.x < 0) p.x = 0;
      if (p.x + PLAYER_W > room.levelState.width) p.x = room.levelState.width - PLAYER_W;
      r = rectFor(p);
    }
  }

  // Safety net
  if (p.y > room.levelState.height + 200) respawnPlayer(room, p);
}

function tickRoom(room) {
  const rects = solids(room);
  const alivePlayers = Object.values(room.players).filter((p) => p.alive);

  for (const p of alivePlayers) {
    const k = p.input;
    if (k.left && !k.right) p.vx -= MOVE_ACCEL;
    else if (k.right && !k.left) p.vx += MOVE_ACCEL;
    else p.vx *= p.onGround ? FRICTION : AIR_FRICTION;
    if (p.vx > MOVE_MAX) p.vx = MOVE_MAX;
    if (p.vx < -MOVE_MAX) p.vx = -MOVE_MAX;
    if (Math.abs(p.vx) < 0.05) p.vx = 0;

    if (k.jump && p.onGround) {
      p.vy = JUMP_VELOCITY;
      p.onGround = false;
      p.ridingId = null;
    }
    p.vy += GRAVITY;
    if (p.vy > MAX_FALL) p.vy = MAX_FALL;
  }

  const ordered = [...alivePlayers].sort((a, b) => b.y - a.y);
  for (const p of ordered) moveWithCollisions(room, p, rects, alivePlayers);

  // Hazards
  for (const p of alivePlayers) {
    const r = rectFor(p);
    for (const e of room.levelState.entities) {
      if (e.type !== 'hazard') continue;
      if (aabbOverlap(r, e)) {
        p.deaths++;
        respawnPlayer(room, p);
        break;
      }
    }
  }

  // Checkpoints
  for (const p of alivePlayers) {
    const r = rectFor(p);
    for (const e of room.levelState.entities) {
      if (e.type !== 'checkpoint') continue;
      if (aabbOverlap(r, e)) {
        p.checkpoint = { x: e.x + e.w / 2 - PLAYER_W / 2, y: e.y + e.h - PLAYER_H };
      }
    }
  }

  // Plates
  for (const e of room.levelState.entities) {
    if (e.type !== 'plate') continue;
    let count = 0;
    const pr = { x: e.x, y: e.y - 4, w: e.w, h: e.h + 10 };
    for (const p of alivePlayers) {
      const foot = { x: p.x + 2, y: p.y + PLAYER_H - 6, w: PLAYER_W - 4, h: 10 };
      if (aabbOverlap(foot, pr)) count++;
    }
    e.active = count >= (e.required || 1);
    e.count = count;
  }

  // Doors
  for (const e of room.levelState.entities) {
    if (e.type !== 'door') continue;
    const pids = e.plates || [];
    e.open = pids.every((pid) => {
      const plate = room.levelState.entities.find((x) => x.type === 'plate' && x.id === pid);
      return plate && plate.active;
    });
  }

  // Goal
  const goalEnt = room.levelState.entities.find((e) => e.type === 'goal');
  let atGoal = 0;
  for (const p of alivePlayers) {
    const ok = goalEnt && aabbOverlap(rectFor(p), goalEnt);
    p.atGoal = ok;
    if (ok) atGoal++;
  }
  const aliveCount = alivePlayers.length;
  const needed = Math.max(GOAL_MIN_PLAYERS, Math.ceil(aliveCount * GOAL_WIN_RATIO));
  if (aliveCount > 0 && atGoal >= needed) {
    if (room.goalHoldStart == null) room.goalHoldStart = Date.now();
    if ((Date.now() - room.goalHoldStart) / 1000 >= GOAL_HOLD_TIME) {
      advanceLevel(room);
      return;
    }
  } else {
    room.goalHoldStart = null;
  }

  room.frame++;
}

function advanceLevel(room) {
  const next = room.levelIndex + 1;
  if (next >= levels.length) {
    broadcastRoom(room, { type: 'win' });
    setTimeout(() => loadLevel(room, 0), 5000);
  } else {
    loadLevel(room, next);
  }
}

// -------- Wire protocol --------
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    x: Math.round(p.x),
    y: Math.round(p.y),
    facing: p.facing,
    alive: p.alive,
    deaths: p.deaths,
    atGoal: p.atGoal,
  }));
}

function publicLevelState(room) {
  return room.levelState.entities
    .filter((e) => e.type === 'plate' || e.type === 'door')
    .map((e) => ({ id: e.id, type: e.type, active: !!e.active, open: !!e.open, count: e.count || 0 }));
}

function goalStatus(room) {
  const aliveCount = Object.values(room.players).filter((p) => p.alive).length;
  const atGoalCount = Object.values(room.players).filter((p) => p.alive && p.atGoal).length;
  const needed = Math.max(GOAL_MIN_PLAYERS, Math.ceil(aliveCount * GOAL_WIN_RATIO));
  return {
    atGoal: atGoalCount,
    needed,
    hold: room.goalHoldStart ? Math.min(1, (Date.now() - room.goalHoldStart) / 1000 / GOAL_HOLD_TIME) : 0,
  };
}

function pickColor(room) {
  const used = new Set(Object.values(room.players).map((p) => p.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw.replace(/[^\w\s\-\.]/g, '').trim().slice(0, 14);
  return cleaned || 'Player';
}

wss.on('connection', (ws) => {
  let joinedRoom = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const role = msg.role === 'host' ? 'host' : 'player';
      let room;
      if (msg.roomCode && rooms.has(String(msg.roomCode))) {
        room = rooms.get(String(msg.roomCode));
      } else if (msg.create || role === 'host') {
        room = await createRoom();
      } else {
        send(ws, { type: 'error', code: 'no_room', message: 'Room not found.' });
        return;
      }
      room.lastActivity = Date.now();

      // Hosts don't occupy a player slot but get state updates.
      if (role === 'player' && Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { type: 'roomFull', max: MAX_PLAYERS_PER_ROOM });
        return;
      }

      const id = room.nextPlayerId++;
      room.clients.set(ws, { id, role });
      joinedRoom = room;

      if (role === 'player') {
        const player = {
          id,
          name: sanitizeName(msg.name) || `Player${id}`,
          color: pickColor(room),
          x: room.levelState.spawn.x + ((id - 1) % 5) * 48,
          y: room.levelState.spawn.y,
          vx: 0,
          vy: 0,
          facing: 1,
          alive: true,
          onGround: false,
          ridingId: null,
          checkpoint: { ...room.levelState.spawn },
          input: { left: false, right: false, jump: false },
          deaths: 0,
          atGoal: false,
        };
        room.players[id] = player;
        broadcastRoom(room, { type: 'playerJoin', player: { id, name: player.name, color: player.color } });
      }

      send(ws, {
        type: 'welcome',
        id,
        role,
        roomCode: room.code,
        roomUrl: roomUrl(room.code),
        qrDataUrl: room.qrDataUrl,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        tickRate: TICK_RATE,
        playerW: PLAYER_W,
        playerH: PLAYER_H,
        level: publicLevel(room),
      });
    } else if (msg.type === 'input' && joinedRoom) {
      const info = joinedRoom.clients.get(ws);
      if (!info) return;
      const p = joinedRoom.players[info.id];
      if (!p) return;
      const k = msg.keys || {};
      p.input.left = !!k.left;
      p.input.right = !!k.right;
      p.input.jump = !!k.jump;
      if (p.input.left) p.facing = -1;
      else if (p.input.right) p.facing = 1;
      joinedRoom.lastActivity = Date.now();
    } else if (msg.type === 'respawn' && joinedRoom) {
      const info = joinedRoom.clients.get(ws);
      const p = info && joinedRoom.players[info.id];
      if (p) { p.deaths++; respawnPlayer(joinedRoom, p); }
    } else if (msg.type === 'restart' && joinedRoom) {
      loadLevel(joinedRoom, joinedRoom.levelIndex);
    } else if (msg.type === 'skip' && joinedRoom) {
      // Host can skip to next level if everyone's stuck
      const info = joinedRoom.clients.get(ws);
      if (info && info.role === 'host') advanceLevel(joinedRoom);
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    const info = joinedRoom.clients.get(ws);
    joinedRoom.clients.delete(ws);
    if (info && info.role === 'player') {
      const p = joinedRoom.players[info.id];
      if (p) {
        delete joinedRoom.players[info.id];
        broadcastRoom(joinedRoom, { type: 'playerLeave', id: info.id, name: p.name });
      }
    }
  });

  ws.on('error', () => {});
});

// -------- Main loop --------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const room of rooms.values()) {
    tickRoom(room);
    broadcastRoom(room, {
      type: 'state',
      frame: room.frame,
      players: publicPlayers(room),
      entities: publicLevelState(room),
      goal: goalStatus(room),
    });
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Co-op Climb (multi-room) listening on http://localhost:${PORT}`);
  console.log(`QR codes will point to: ${BASE_URL}/?room=<code>`);
  console.log(`Max players per room: ${MAX_PLAYERS_PER_ROOM}   Levels: ${levels.length}`);
});
