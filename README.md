# Co-op Climb

A real-time multiplayer **co-op platformer for up to 15 players**. You cannot beat the levels alone — progress requires pressing plates for your teammates, stacking on each other's heads to reach high ledges, and coordinating across multi-plate gates.

![coop platformer](https://img.shields.io/badge/players-up%20to%2015-brightgreen) ![stack](https://img.shields.io/badge/stack-node%20%2B%20websocket-blue)

## Features

- **Server-authoritative physics** — one physics loop, 30 Hz tick, shared by all clients
- **Up to 15 simultaneous players** over WebSockets
- **Stack on each other's heads** — players act as moving platforms for each other
- **Pressure plates** that require 1, 2, or 3 players standing on them to open doors
- **Checkpoints, hazards (pits + spikes), and respawn**
- **Interpolated rendering** for smooth motion between server updates
- **5 hand-designed co-op levels**, each teaching a new teamwork mechanic

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in as many browser tabs / devices as you want (up to 15). Each one joins the same shared game instance.

To play with friends on your LAN, share your machine's IP (`http://<your-ip>:3000`). To play over the internet, put the server behind a tunnel like `ngrok http 3000` or deploy to any Node host.

## Controls

| Key | Action |
|---|---|
| `A` / `←` | Move left |
| `D` / `→` | Move right |
| `Space` / `W` / `↑` | Jump |
| `R` | Respawn at last checkpoint (if stuck) |
| `Shift+R` | Restart the level for everyone |

## How co-op works

- **Pressure plates** (yellow pads) open purple doors while players stand on them. The plate shows `count / required`.
- Some doors need **two or three plates held simultaneously** — split up and coordinate.
- **Tall walls**: jump on a teammate's head to reach high ledges and plates.
- **Goal flag**: when ~70% of alive players stand on the goal for 2 seconds, the level advances.
- **No player left behind**: later levels include a "catch-up" plate on the far side so a teammate can let the plate-holders through after the rest of the group is past.

## Level overview

1. **Getting Started** — solo controls & jumping
2. **The First Plate** — one player holds a plate so the rest can pass
3. **Stack Up** — stack to reach a plate nobody can reach alone
4. **Two of a Kind** — a door needs **two** plates held at once
5. **The Summit** — stacking + dual plates + triple-plate final gate

When the final level is cleared the game announces a win and restarts from level 1.

## Architecture

```
server.js        Node + ws, physics loop, authoritative state
levels.js        Level definitions (platforms, plates, doors, hazards)
public/
  index.html     Join screen + in-game HUD
  game.js        Canvas renderer, input, WebSocket client
  style.css      Styling
```

### Wire protocol (JSON over WebSocket)

Client → server:
```
{type: "join",  name: "Alice"}
{type: "input", keys: {left, right, jump}}
{type: "suicide"}        // R — respawn self
{type: "restart"}        // Shift+R — reload current level
```

Server → client:
```
{type: "welcome",  id, maxPlayers, tickRate, level, playerW, playerH}
{type: "level",    index, level}                    // new level loaded
{type: "state",    frame, players, entities, goal}  // ~30 Hz
{type: "playerJoin" | "playerLeave", ...}
{type: "win"}
{type: "full",     max}
```

### Adding your own level

Edit `levels.js` and add an object to the `levels` array. Use the helper builders (`ground`, `block`, `plate`, `door`, `checkpoint`, `goal`, `spikes`, `pit`, `sign`) to compose a level. Plates reference the door IDs they trigger; doors list all plates that must be active for the door to open.

## Configuration

Environment / constants in `server.js`:

- `PORT` — HTTP port (default 3000)
- `MAX_PLAYERS` — hard cap (default 15)
- `TICK_RATE` — physics/broadcast rate (default 30 Hz)
- `GOAL_WIN_RATIO` — fraction of alive players needed at goal (default 0.7)
- `GOAL_HOLD_TIME` — seconds to hold the goal before advancing (default 2.0)

## License

MIT
