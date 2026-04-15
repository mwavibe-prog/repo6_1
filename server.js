// Co-op Climb — authoritative multiplayer platformer server.
//
// Up to 15 players connect via WebSocket. The server runs physics
// at TICK_RATE Hz and broadcasts world state to every client.
// Clients send inputs (left/right/jump) and render whatever the
// server sends back. Physics includes player-on-player collisions
// so players can stand on each other's heads to reach high places.

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const { levels } = require('./levels');

// -------- Constants --------
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 15;
const TICK_RATE = 30;              // server simulation Hz
const TICK_MS = 1000 / TICK_RATE;
const GRAVITY = 0.55;
const MOVE_ACCEL = 1.2;
const MOVE_MAX = 4.8;
const FRICTION = 0.75;
const AIR_FRICTION = 0.92;
const JUMP_VELOCITY = -11.2;
const PLAYER_W = 28;
const PLAYER_H = 40;
const MAX_FALL = 18;
const GOAL_WIN_RATIO = 0.7;        // fraction of alive players at goal to advance
const GOAL_MIN_PLAYERS = 1;
const GOAL_HOLD_TIME = 2.0;        // seconds of goal hold before level advances

const COLORS = [
  '#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#8338ec',
  '#ff006e', '#fb5607', '#ffbe0b', '#3a86ff', '#b5179e',
  '#43aa8b', '#f94144', '#f3722c', '#90be6d', '#577590',
];

// -------- Server setup --------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, players: Object.keys(players).length }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -------- Game state --------
let nextPlayerId = 1;
const players = {};      // id -> player object
const clients = new Map(); // ws -> id
let currentLevelIndex = 0;
let levelState = null;   // mutable copy of current level entities
let goalHoldStart = null;
let frame = 0;

function cloneLevel(def) {
  // Deep copy the entity list so per-level state (plates/doors open)
  // does not leak between runs.
  return {
    name: def.name,
    width: def.width,
    height: def.height,
    spawn: { ...def.spawn },
    entities: def.entities.map((e) => JSON.parse(JSON.stringify(e))),
  };
}

function loadLevel(index) {
  currentLevelIndex = Math.max(0, Math.min(index, levels.length - 1));
  levelState = cloneLevel(levels[currentLevelIndex]);
  goalHoldStart = null;
  // Reset and respawn every connected player.
  for (const pid of Object.keys(players)) {
    respawnPlayer(players[pid], true);
  }
  broadcast({
    type: 'level',
    index: currentLevelIndex,
    level: publicLevel(),
  });
}

function publicLevel() {
  return {
    name: levelState.name,
    width: levelState.width,
    height: levelState.height,
    index: currentLevelIndex,
    total: levels.length,
    entities: levelState.entities,
  };
}

function respawnPlayer(p, resetCheckpoint = false) {
  if (resetCheckpoint) {
    p.checkpoint = { ...levelState.spawn };
  }
  p.x = p.checkpoint.x;
  p.y = p.checkpoint.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = false;
  p.ridingId = null;
  p.deaths = p.deaths || 0;
  p.atGoal = false;
}

// -------- Physics helpers --------
function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectFor(p) {
  return { x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H };
}

// Build the list of solid rects for this frame, factoring in closed doors.
function solids() {
  const out = [];
  for (const e of levelState.entities) {
    if (e.type === 'platform') out.push(e);
    else if (e.type === 'door' && !e.open) out.push(e);
  }
  return out;
}

// Resolve axis-aligned player vs solid-rect collision, axis by axis.
function moveWithCollisions(p, rects, others) {
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
  // Clamp to level bounds horizontally
  if (p.x < 0) { p.x = 0; p.vx = 0; }
  if (p.x + PLAYER_W > levelState.width) { p.x = levelState.width - PLAYER_W; p.vx = 0; }

  // Vertical collision with world solids
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

  // Vertical collision with other players (stand-on-head)
  for (const other of others) {
    if (other.id === p.id || !other.alive) continue;
    const o = { x: other.x, y: other.y, w: PLAYER_W, h: PLAYER_H };
    if (!aabbOverlap(r, o)) continue;
    if (p.vy > 0 && r.y + r.h - p.vy <= o.y + 4) {
      // Landed on top of another player
      p.y = o.y - PLAYER_H;
      p.vy = 0;
      p.onGround = true;
      p.ridingId = other.id;
      r = rectFor(p);
    } else if (p.vy < 0 && r.y - p.vy >= o.y + o.h - 4) {
      // Bumped head from below
      p.y = o.y + o.h;
      p.vy = 0;
      r = rectFor(p);
    } else {
      // Horizontal overlap — gentle push apart so players don't fully merge
      const dx = (r.x + r.w / 2) - (o.x + o.w / 2);
      if (dx >= 0) { p.x = o.x + o.w; }
      else { p.x = o.x - PLAYER_W; }
      if (p.x < 0) p.x = 0;
      if (p.x + PLAYER_W > levelState.width) p.x = levelState.width - PLAYER_W;
      r = rectFor(p);
    }
  }

  // Clamp to floor-of-world (shouldn't happen if hazards cover pits, but safety net)
  if (p.y > levelState.height + 200) {
    respawnPlayer(p);
  }
}

// -------- Simulation --------
function tick(dt) {
  const rects = solids();
  const alivePlayers = Object.values(players).filter((p) => p.alive);

  // Apply inputs and gravity
  for (const p of alivePlayers) {
    const input = p.input;
    const wantLeft = !!input.left;
    const wantRight = !!input.right;
    const wantJump = !!input.jump;

    if (wantLeft && !wantRight) p.vx -= MOVE_ACCEL;
    else if (wantRight && !wantLeft) p.vx += MOVE_ACCEL;
    else p.vx *= p.onGround ? FRICTION : AIR_FRICTION;

    if (p.vx > MOVE_MAX) p.vx = MOVE_MAX;
    if (p.vx < -MOVE_MAX) p.vx = -MOVE_MAX;
    if (Math.abs(p.vx) < 0.05) p.vx = 0;

    if (wantJump && p.onGround) {
      p.vy = JUMP_VELOCITY;
      p.onGround = false;
      p.ridingId = null;
    }

    p.vy += GRAVITY;
    if (p.vy > MAX_FALL) p.vy = MAX_FALL;
  }

  // Sort players by Y descending so lower (higher-Y, on-ground) players resolve first.
  // This helps stacking stability — the base of the stack moves first,
  // then players on top follow.
  const ordered = [...alivePlayers].sort((a, b) => b.y - a.y);
  for (const p of ordered) {
    moveWithCollisions(p, rects, alivePlayers);
  }

  // Hazards (pits, spikes)
  for (const p of alivePlayers) {
    const r = rectFor(p);
    for (const e of levelState.entities) {
      if (e.type !== 'hazard') continue;
      if (aabbOverlap(r, e)) {
        p.deaths++;
        respawnPlayer(p);
        break;
      }
    }
  }

  // Checkpoints
  for (const p of alivePlayers) {
    const r = rectFor(p);
    for (const e of levelState.entities) {
      if (e.type !== 'checkpoint') continue;
      if (aabbOverlap(r, e)) {
        if (p.checkpoint.x !== e.x + e.w / 2) {
          p.checkpoint = { x: e.x + e.w / 2 - PLAYER_W / 2, y: e.y + e.h - PLAYER_H };
        }
      }
    }
  }

  // Pressure plates
  for (const e of levelState.entities) {
    if (e.type !== 'plate') continue;
    let count = 0;
    const plateRect = { x: e.x, y: e.y - 4, w: e.w, h: e.h + 8 };
    for (const p of alivePlayers) {
      const footRect = { x: p.x + 2, y: p.y + PLAYER_H - 4, w: PLAYER_W - 4, h: 8 };
      if (aabbOverlap(footRect, plateRect)) count++;
    }
    e.active = count >= (e.required || 1);
    e.count = count;
  }

  // Doors: open when all triggering plates are active
  for (const e of levelState.entities) {
    if (e.type !== 'door') continue;
    const plateIds = e.plates || [];
    const allActive = plateIds.every((pid) => {
      const plate = levelState.entities.find((x) => x.type === 'plate' && x.id === pid);
      return plate && plate.active;
    });
    e.open = allActive;
  }

  // Goal detection — advance level when enough alive players are at goal
  const goalEnt = levelState.entities.find((e) => e.type === 'goal');
  let atGoalCount = 0;
  for (const p of alivePlayers) {
    const inGoal = goalEnt && aabbOverlap(rectFor(p), goalEnt);
    p.atGoal = inGoal;
    if (inGoal) atGoalCount++;
  }
  const aliveCount = alivePlayers.length;
  const needed = Math.max(GOAL_MIN_PLAYERS, Math.ceil(aliveCount * GOAL_WIN_RATIO));
  if (aliveCount > 0 && atGoalCount >= needed) {
    if (goalHoldStart == null) goalHoldStart = Date.now();
    const held = (Date.now() - goalHoldStart) / 1000;
    if (held >= GOAL_HOLD_TIME) {
      advanceLevel();
      return;
    }
  } else {
    goalHoldStart = null;
  }

  frame++;
}

function advanceLevel() {
  const next = currentLevelIndex + 1;
  if (next >= levels.length) {
    // Beat the game — replay from level 1 after a brief "you win" broadcast.
    broadcast({ type: 'win' });
    setTimeout(() => loadLevel(0), 5000);
  } else {
    loadLevel(next);
  }
}

// -------- Networking --------
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function publicPlayers() {
  return Object.values(players).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    x: Math.round(p.x),
    y: Math.round(p.y),
    vx: Math.round(p.vx * 10) / 10,
    vy: Math.round(p.vy * 10) / 10,
    facing: p.facing,
    alive: p.alive,
    deaths: p.deaths,
    atGoal: p.atGoal,
    onGround: p.onGround,
  }));
}

function publicLevelState() {
  // Only send the volatile bits each tick to save bandwidth
  return levelState.entities
    .filter((e) => e.type === 'plate' || e.type === 'door')
    .map((e) => ({ id: e.id, type: e.type, active: !!e.active, open: !!e.open, count: e.count || 0 }));
}

function goalStatus() {
  const goalEnt = levelState.entities.find((e) => e.type === 'goal');
  const aliveCount = Object.values(players).filter((p) => p.alive).length;
  const atGoalCount = Object.values(players).filter((p) => p.alive && p.atGoal).length;
  const needed = Math.max(GOAL_MIN_PLAYERS, Math.ceil(aliveCount * GOAL_WIN_RATIO));
  return {
    atGoal: atGoalCount,
    needed,
    hold: goalHoldStart ? Math.min(1, (Date.now() - goalHoldStart) / 1000 / GOAL_HOLD_TIME) : 0,
  };
}

function pickColor() {
  const used = new Set(Object.values(players).map((p) => p.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw.replace(/[^\w\s\-\.]/g, '').trim().slice(0, 16);
  return cleaned || 'Player';
}

wss.on('connection', (ws) => {
  if (Object.keys(players).length >= MAX_PLAYERS) {
    send(ws, { type: 'full', max: MAX_PLAYERS });
    ws.close();
    return;
  }

  const id = nextPlayerId++;
  clients.set(ws, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (players[id]) return;
      const player = {
        id,
        name: sanitizeName(msg.name) || `Player${id}`,
        color: pickColor(),
        x: levelState.spawn.x,
        y: levelState.spawn.y,
        vx: 0,
        vy: 0,
        facing: 1,
        alive: true,
        onGround: false,
        ridingId: null,
        checkpoint: { ...levelState.spawn },
        input: { left: false, right: false, jump: false },
        deaths: 0,
        atGoal: false,
      };
      players[id] = player;
      send(ws, {
        type: 'welcome',
        id,
        maxPlayers: MAX_PLAYERS,
        tickRate: TICK_RATE,
        level: publicLevel(),
        playerW: PLAYER_W,
        playerH: PLAYER_H,
      });
      broadcast({ type: 'playerJoin', player: { id, name: player.name, color: player.color } });
    } else if (msg.type === 'input') {
      const p = players[id];
      if (!p) return;
      const k = msg.keys || {};
      p.input.left = !!k.left;
      p.input.right = !!k.right;
      p.input.jump = !!k.jump;
      if (p.input.left) p.facing = -1;
      else if (p.input.right) p.facing = 1;
    } else if (msg.type === 'suicide') {
      // Manual respawn (player got stuck)
      const p = players[id];
      if (p) { p.deaths++; respawnPlayer(p); }
    } else if (msg.type === 'restart') {
      // Any player can request a level restart (useful when stuck)
      loadLevel(currentLevelIndex);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (players[id]) {
      const name = players[id].name;
      delete players[id];
      broadcast({ type: 'playerLeave', id, name });
    }
  });

  ws.on('error', () => {});
});

// -------- Main loop --------
loadLevel(0);
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  tick(dt);
  broadcast({
    type: 'state',
    frame,
    players: publicPlayers(),
    entities: publicLevelState(),
    goal: goalStatus(),
  });
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`Co-op Climb listening on http://localhost:${PORT}`);
  console.log(`Max players: ${MAX_PLAYERS}   Levels: ${levels.length}`);
});
