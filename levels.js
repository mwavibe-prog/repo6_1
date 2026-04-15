// Level definitions for Co-op Climb.
//
// Coordinate system: top-left origin, Y increases downward.
// World is 1600 wide x 900 tall per level (camera follows).
//
// Entity types:
//   platform: solid rectangle
//   hazard:   touching it respawns the player at the last checkpoint (pits, spikes)
//   plate:    pressure plate; activates when >= requiredPlayers stand on it
//   door:     solid rectangle that becomes non-solid when its trigger plates are all active
//   checkpoint: passing through updates the player's respawn point
//   goal:     when enough living players overlap, the level is cleared
//   sign:     decorative text for hints
//
// Teamwork is enforced by plates that require 1+ players to hold them
// while others run through doors. Higher levels require 2-3 plate holders,
// and some doors only open when ALL their plates are pressed.

const LEVEL_WIDTH = 3200;
const LEVEL_HEIGHT = 900;
const GROUND_Y = 820;

// Helper builders
const ground = (x, w) => ({ type: 'platform', x, y: GROUND_Y, w, h: LEVEL_HEIGHT - GROUND_Y, color: '#3a5a40' });
const block = (x, y, w, h, color = '#6b705c') => ({ type: 'platform', x, y, w, h, color });
const pit = (x, y, w, h) => ({ type: 'hazard', x, y, w, h, color: '#9d0208', kind: 'pit' });
const spikes = (x, y, w) => ({ type: 'hazard', x, y: y - 14, w, h: 14, color: '#adb5bd', kind: 'spikes' });
const plate = (id, x, y, w, required = 1, triggers = []) => ({
  type: 'plate', id, x, y: y - 8, w, h: 8, required, triggers, active: false, color: '#e9c46a'
});
const door = (id, x, y, w, h, plates) => ({
  type: 'door', id, x, y, w, h, plates, open: false, color: '#6a4c93'
});
const checkpoint = (x, y) => ({ type: 'checkpoint', x, y: y - 60, w: 20, h: 60, color: '#80ed99' });
const goal = (x, y) => ({ type: 'goal', x, y: y - 80, w: 60, h: 80, color: '#ffd166' });
const sign = (x, y, text) => ({ type: 'sign', x, y, text });

const levels = [
  // ============================================================
  // LEVEL 1: Tutorial — solo jumping, teaches the controls
  // ============================================================
  {
    name: 'Level 1: Getting Started',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 40 },
    entities: [
      ground(0, 700),
      ground(900, 600),
      ground(1700, 500),
      ground(2400, 800),
      pit(700, GROUND_Y, 200, LEVEL_HEIGHT - GROUND_Y),
      pit(1500, GROUND_Y, 200, LEVEL_HEIGHT - GROUND_Y),
      pit(2200, GROUND_Y, 200, LEVEL_HEIGHT - GROUND_Y),
      block(1200, 700, 120, 20),
      block(2000, 680, 120, 20),
      sign(120, 760, 'A/D or arrows to move, SPACE to jump'),
      sign(950, 760, 'Stick together!'),
      checkpoint(1750, GROUND_Y),
      goal(3000, GROUND_Y),
    ],
  },

  // ============================================================
  // LEVEL 2: Pressure Plate — one player must hold the plate
  // so the others can pass through the door. Then the door
  // plate-holder takes a higher route (stack or jump) to catch up.
  // ============================================================
  {
    name: 'Level 2: The First Plate',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 40 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(120, 760, 'Someone must STAND on the yellow plate to open the purple door.'),
      sign(120, 790, 'A brave friend stays behind while the rest run ahead!'),
      plate('p1', 600, GROUND_Y, 120, 1, ['d1']),
      door('d1', 900, GROUND_Y - 160, 40, 160, ['p1']),
      // Upper route for the plate-holder to catch up after teammates pass
      block(780, GROUND_Y - 240, 140, 20),
      block(980, GROUND_Y - 300, 140, 20),
      block(1180, GROUND_Y - 240, 140, 20),
      sign(820, GROUND_Y - 260, 'Plate holder: jump up here to catch up!'),
      checkpoint(1400, GROUND_Y),
      pit(1800, GROUND_Y, 180, LEVEL_HEIGHT - GROUND_Y),
      block(1750, GROUND_Y - 120, 60, 20),
      block(1900, GROUND_Y - 180, 60, 20),
      block(2050, GROUND_Y - 120, 60, 20),
      goal(3000, GROUND_Y),
    ],
  },

  // ============================================================
  // LEVEL 3: Stack Up — wall too tall to jump; players must
  // stand on each other's heads to reach a high plate that
  // opens a gate from above.
  // ============================================================
  {
    name: 'Level 3: Stack Up',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 40 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(120, 760, 'Jump on teammates\' heads! Stack to reach the high plate.'),
      // A tall wall that nobody can solo-jump
      block(700, GROUND_Y - 260, 40, 260, '#495057'),
      block(740, GROUND_Y - 40, 280, 40, '#495057'),
      // Top platform reachable only by stacking
      block(740, GROUND_Y - 260, 280, 20, '#6b705c'),
      plate('p2', 780, GROUND_Y - 260, 200, 1, ['d2']),
      door('d2', 1100, GROUND_Y - 180, 40, 180, ['p2']),
      // Continue
      checkpoint(1300, GROUND_Y),
      pit(1600, GROUND_Y, 160, LEVEL_HEIGHT - GROUND_Y),
      block(1550, GROUND_Y - 100, 80, 20),
      block(1700, GROUND_Y - 160, 80, 20),
      block(1850, GROUND_Y - 100, 80, 20),
      spikes(2300, GROUND_Y, 120),
      block(2250, GROUND_Y - 80, 40, 20),
      block(2400, GROUND_Y - 140, 40, 20),
      goal(3000, GROUND_Y),
    ],
  },

  // ============================================================
  // LEVEL 4: Two of a Kind — door needs TWO plates held
  // simultaneously. Requires 2 players to stay while the rest advance.
  // ============================================================
  {
    name: 'Level 4: Two of a Kind',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 40 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(120, 760, 'BOTH plates must be held at once to open the door.'),
      sign(120, 790, 'You need at least 3 players to clear this level.'),
      plate('p3a', 500, GROUND_Y, 120, 1, ['d3']),
      plate('p3b', 800, GROUND_Y, 120, 1, ['d3']),
      door('d3', 1050, GROUND_Y - 200, 40, 200, ['p3a', 'p3b']),
      // Upper return path so plate holders can follow after teammates trigger the catch-up plate
      block(600, GROUND_Y - 240, 520, 20),
      plate('p3c', 1250, GROUND_Y, 120, 1, ['d3b']),
      door('d3b', 1100, GROUND_Y - 240, 40, 40, ['p3c']),
      sign(640, GROUND_Y - 260, 'A teammate past the door can hold this plate to let you up!'),
      checkpoint(1600, GROUND_Y),
      pit(1900, GROUND_Y, 220, LEVEL_HEIGHT - GROUND_Y),
      block(1850, GROUND_Y - 120, 80, 20),
      block(2000, GROUND_Y - 180, 80, 20),
      block(2150, GROUND_Y - 120, 80, 20),
      goal(3000, GROUND_Y),
    ],
  },

  // ============================================================
  // LEVEL 5: The Summit — final challenge, combines stacking,
  // multi-plate coordination, and hazards.
  // ============================================================
  {
    name: 'Level 5: The Summit',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 40 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(120, 760, 'The Summit awaits! Use everything you have learned.'),
      // Stack wall
      block(500, GROUND_Y - 220, 40, 220, '#495057'),
      block(500, GROUND_Y - 40, 260, 40, '#495057'),
      block(500, GROUND_Y - 220, 260, 20, '#6b705c'),
      plate('p5a', 560, GROUND_Y - 220, 160, 1, ['d5a']),
      door('d5a', 800, GROUND_Y - 180, 40, 180, ['p5a']),
      spikes(920, GROUND_Y, 160),
      block(900, GROUND_Y - 80, 40, 20),
      block(1020, GROUND_Y - 140, 40, 20),
      // Dual-plate gauntlet
      plate('p5b', 1200, GROUND_Y, 100, 1, ['d5b']),
      plate('p5c', 1350, GROUND_Y, 100, 1, ['d5b']),
      door('d5b', 1500, GROUND_Y - 220, 40, 220, ['p5b', 'p5c']),
      checkpoint(1600, GROUND_Y),
      // Floating plate platforms to help stragglers catch up
      block(1200, GROUND_Y - 240, 340, 20),
      plate('p5d', 1620, GROUND_Y, 100, 1, ['d5c']),
      door('d5c', 1540, GROUND_Y - 240, 40, 40, ['p5d']),
      sign(1220, GROUND_Y - 260, 'Teammates past the gate: hold the plate to let holders catch up!'),
      // Big pit with moving-ish platforms (static jumps)
      pit(1900, GROUND_Y, 400, LEVEL_HEIGHT - GROUND_Y),
      block(1870, GROUND_Y - 140, 70, 20),
      block(2020, GROUND_Y - 200, 70, 20),
      block(2170, GROUND_Y - 140, 70, 20),
      // Final triple-plate door
      plate('p5e', 2450, GROUND_Y, 80, 1, ['d5d']),
      plate('p5f', 2560, GROUND_Y, 80, 1, ['d5d']),
      plate('p5g', 2670, GROUND_Y, 80, 1, ['d5d']),
      door('d5d', 2800, GROUND_Y - 260, 40, 260, ['p5e', 'p5f', 'p5g']),
      sign(2430, GROUND_Y - 40, 'Three plates! Split up and press them all at once.'),
      goal(3050, GROUND_Y),
    ],
  },
];

module.exports = { levels, LEVEL_WIDTH, LEVEL_HEIGHT, GROUND_Y };
