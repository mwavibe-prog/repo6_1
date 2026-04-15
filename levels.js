// Co-op Climb — senior-friendly level set.
//
// Design goals for elderly players (60+):
//   - Short levels, wide platforms, gentle gaps
//   - NO spikes or surprise hazards; pits clearly marked and small
//   - Plenty of landing room — you rarely need precise jumps
//   - Each level teaches one simple idea; no time pressure
//   - Bright, calm colors; clear goals
//
// Teamwork is the reason to play together — without teammates you
// can still traverse the platforming, but doors won't open without
// friends standing on the pressure plates.

const LEVEL_WIDTH = 2600;
const LEVEL_HEIGHT = 900;
const GROUND_Y = 780;

// ----- Builders -----
const ground = (x, w) => ({
  type: 'platform', x, y: GROUND_Y, w, h: LEVEL_HEIGHT - GROUND_Y, color: '#3a7d44',
});
const block = (x, y, w, h, color = '#8d6e63') => ({ type: 'platform', x, y, w, h, color });
const softBlock = (x, y, w, h) => block(x, y, w, h, '#a5a58d');
const pit = (x, y, w, h) => ({ type: 'hazard', x, y, w, h, color: '#6d4c41', kind: 'pit' });
const plate = (id, x, y, w, required = 1, triggers = []) => ({
  type: 'plate', id, x, y: y - 10, w, h: 10, required, triggers, active: false, color: '#fbc02d',
});
const door = (id, x, y, w, h, plates) => ({
  type: 'door', id, x, y, w, h, plates, open: false, color: '#6a4c93',
});
const checkpoint = (x, y) => ({ type: 'checkpoint', x, y: y - 70, w: 24, h: 70, color: '#81c784' });
const goal = (x, y) => ({ type: 'goal', x, y: y - 110, w: 90, h: 110, color: '#ffd166' });
const sign = (x, y, text) => ({ type: 'sign', x, y, text });

const levels = [
  // ------------------------------------------------------------
  // LEVEL 1 — A GENTLE WALK
  // One very small gap. Teaches "walk right, press jump once".
  // ------------------------------------------------------------
  {
    name: 'Level 1: A Gentle Walk',
    hint: 'Press the big buttons on your phone. Walk to the yellow flag!',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 60 },
    entities: [
      ground(0, 1000),
      ground(1180, 1600),
      pit(1000, GROUND_Y, 180, LEVEL_HEIGHT - GROUND_Y),
      // A bridge block that makes the gap trivially small
      block(1030, GROUND_Y - 20, 120, 20, '#c8b68b'),
      sign(160, 720, 'Walk to the yellow flag. Take your time.'),
      sign(1050, 720, 'One small hop across the bridge!'),
      checkpoint(1300, GROUND_Y),
      goal(2400, GROUND_Y),
    ],
  },

  // ------------------------------------------------------------
  // LEVEL 2 — HELP EACH OTHER
  // A plate opens a door. One friend stands on the plate; the rest
  // walk through. The plate-holder uses a gentle slope up to catch up.
  // ------------------------------------------------------------
  {
    name: 'Level 2: Help Each Other',
    hint: 'One friend stands on the yellow pad. The purple door opens!',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 60 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(140, 720, 'One friend stands on the yellow pad — door opens.'),
      sign(140, 750, 'Others walk through. Plate friend hops up the steps to catch up.'),

      // The plate — nice and wide so it's easy to stand on
      plate('p1', 520, GROUND_Y, 180, 1, ['d1']),
      door('d1', 850, GROUND_Y - 160, 40, 160, ['p1']),

      // A friendly staircase over the door so the plate-holder can follow
      block(710, GROUND_Y - 70, 140, 20, '#c8b68b'),
      block(820, GROUND_Y - 140, 140, 20, '#c8b68b'),
      block(930, GROUND_Y - 210, 140, 20, '#c8b68b'),
      block(1050, GROUND_Y - 140, 140, 20, '#c8b68b'),

      sign(780, GROUND_Y - 230, 'Plate friend: hop up these steps!'),

      checkpoint(1400, GROUND_Y),
      goal(2400, GROUND_Y),
    ],
  },

  // ------------------------------------------------------------
  // LEVEL 3 — STAND ON SHOULDERS
  // A wall you cannot jump over alone. Friends stack to reach the
  // high plate. The plate opens the gate to the flag.
  // ------------------------------------------------------------
  {
    name: 'Level 3: Stand on Shoulders',
    hint: 'Jump on a friend\'s head to reach the high pad!',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 60 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(140, 720, 'This wall is too tall for one person.'),
      sign(140, 750, 'Jump on a friend\'s head! Two makes a tower.'),

      // The tall wall
      block(620, GROUND_Y - 190, 60, 190, '#5d4037'),
      block(680, GROUND_Y - 20, 320, 20, '#5d4037'),
      block(680, GROUND_Y - 190, 320, 20, '#8d6e63'),

      // High plate on top of the wall
      plate('p2', 740, GROUND_Y - 190, 200, 1, ['d2']),
      door('d2', 1060, GROUND_Y - 200, 40, 200, ['p2']),

      sign(700, GROUND_Y - 220, 'Stand on the pad up here!'),
      checkpoint(1300, GROUND_Y),
      goal(2400, GROUND_Y),
    ],
  },

  // ------------------------------------------------------------
  // LEVEL 4 — TWO PADS TOGETHER
  // Door needs two plates at once. Two friends stay; others cross.
  // Has a catch-up "reverse" plate past the door so the two
  // plate-holders can follow.
  // ------------------------------------------------------------
  {
    name: 'Level 4: Two Pads Together',
    hint: 'Both yellow pads must be pressed at once! Two friends, one on each.',
    width: LEVEL_WIDTH,
    height: LEVEL_HEIGHT,
    spawn: { x: 100, y: GROUND_Y - 60 },
    entities: [
      ground(0, LEVEL_WIDTH),
      sign(140, 720, 'BOTH yellow pads must be pressed at the same time.'),
      sign(140, 750, 'Two stay. Others walk through the door.'),

      plate('p3a', 380, GROUND_Y, 160, 1, ['d3']),
      plate('p3b', 640, GROUND_Y, 160, 1, ['d3']),
      door('d3', 870, GROUND_Y - 200, 40, 200, ['p3a', 'p3b']),

      // Catch-up bridge: one friend past the door holds a plate,
      // opening a small gate so the two plate-holders can follow.
      block(400, GROUND_Y - 220, 500, 20, '#c8b68b'),
      plate('p3c', 1050, GROUND_Y, 140, 1, ['d3b']),
      door('d3b', 910, GROUND_Y - 240, 40, 40, ['p3c']),
      sign(430, GROUND_Y - 240, 'Friends past the door: stand on the next yellow pad to let them up.'),

      checkpoint(1500, GROUND_Y),
      goal(2400, GROUND_Y),
    ],
  },
];

module.exports = { levels, LEVEL_WIDTH, LEVEL_HEIGHT, GROUND_Y };
