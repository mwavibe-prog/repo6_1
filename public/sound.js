// Co-op Climb — Web Audio sound effects.
//
// All sounds are synthesized at runtime with oscillators + envelopes,
// so there are no audio files to ship. Browsers require a user gesture
// before an AudioContext can actually make sound — call SoundFX.unlock()
// from any click/tap handler. The first call resumes a suspended context.
//
// Usage:
//   SoundFX.unlock();                // after a user gesture
//   SoundFX.play('jump');            // fire-and-forget
//   SoundFX.setMuted(true);          // mute everything
//
// Sound map (keep these names stable — game.js hooks them):
//   jump, land, plateOn, plateOff, doorOpen,
//   playerJoin, levelComplete, win, respawn, click

(() => {
  'use strict';

  class SoundFX {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.unlocked = false;
      this._muted = false;
      this._masterVolume = 0.45;
      // Debounce so rapid-fire identical sounds don't stack up
      this._lastPlayed = Object.create(null);
    }

    init() {
      if (this.ctx) return true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this._masterVolume;
        this.master.connect(this.ctx.destination);
        this.unlocked = this.ctx.state === 'running';
      } catch (_) {
        return false;
      }
      return true;
    }

    /** Must be called from a user-gesture handler (click, touchstart, keydown). */
    async unlock() {
      if (!this.init()) return false;
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (_) {}
      }
      this.unlocked = this.ctx.state === 'running';
      return this.unlocked;
    }

    setMuted(m) { this._muted = !!m; }
    isMuted() { return this._muted; }
    isUnlocked() { return !!this.unlocked; }

    play(name, opts = {}) {
      if (this._muted) return;
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        // Try a non-blocking resume; if the browser refuses, skip.
        try { this.ctx.resume(); } catch (_) {}
        if (this.ctx.state !== 'running') return;
      }
      const now = this.ctx.currentTime;
      // Debounce identical sounds within 40 ms
      const last = this._lastPlayed[name] || 0;
      if (now - last < 0.04) return;
      this._lastPlayed[name] = now;

      const fn = SOUNDS[name];
      if (!fn) return;
      try { fn(this.ctx, this.master, opts); } catch (_) {}
    }
  }

  // ---------- Helpers ----------
  function tone(ctx, dest, { type = 'sine', freq = 440, freq2, t0, attack = 0.01, peak = 0.2, release = 0.2, detune = 0, filter = null }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2 !== undefined) {
      // exponentialRamp requires positive target
      const target = Math.max(0.0001, freq2);
      osc.frequency.exponentialRampToValueAtTime(target, t0 + attack + release);
    }
    if (detune) osc.detune.value = detune;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + attack + release);
    osc.connect(gain);
    if (filter) {
      gain.connect(filter);
      filter.connect(dest);
    } else {
      gain.connect(dest);
    }
    osc.start(t0);
    osc.stop(t0 + attack + release + 0.05);
  }

  function noiseBurst(ctx, dest, { t0, duration = 0.1, peak = 0.15, cutoff = 800 }) {
    // Short noise burst through a lowpass — used for thuds.
    const bufferSize = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    src.connect(filter); filter.connect(gain); gain.connect(dest);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  // ---------- Sound definitions ----------
  const SOUNDS = {
    // Jump — cheerful rising blip
    jump: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'triangle', freq: 320, freq2: 720, t0: t, attack: 0.008, peak: 0.32, release: 0.14 });
    },

    // Land — soft thud with a pitched component
    land: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'sine', freq: 180, freq2: 70, t0: t, attack: 0.004, peak: 0.22, release: 0.12 });
      noiseBurst(ctx, dest, { t0: t, duration: 0.08, peak: 0.12, cutoff: 600 });
    },

    // Plate pressed — pleasant two-note ding
    plateOn: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'sine', freq: 880,  t0: t,        attack: 0.005, peak: 0.16, release: 0.25 });
      tone(ctx, dest, { type: 'sine', freq: 1320, t0: t + 0.03, attack: 0.005, peak: 0.12, release: 0.3  });
    },

    // Plate released — gentle descending tone
    plateOff: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'sine', freq: 520, freq2: 220, t0: t, attack: 0.005, peak: 0.16, release: 0.18 });
    },

    // Door opens — bright ascending arpeggio (C-E-G-C)
    doorOpen: (ctx, dest) => {
      const t = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        tone(ctx, dest, { type: 'sine', freq: f, t0: t + i * 0.08, attack: 0.01, peak: 0.18, release: 0.28 });
      });
    },

    // Player joined — brief welcoming chirp
    playerJoin: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'sine', freq: 600, freq2: 1200, t0: t, attack: 0.008, peak: 0.18, release: 0.18 });
    },

    // Level completed — short fanfare
    levelComplete: (ctx, dest) => {
      const t = ctx.currentTime;
      const seq = [
        [523.25, 0.00],
        [659.25, 0.12],
        [783.99, 0.24],
        [1046.5, 0.36],
        [1318.5, 0.60],
      ];
      seq.forEach(([f, d]) => {
        tone(ctx, dest, { type: 'triangle', freq: f, t0: t + d, attack: 0.012, peak: 0.26, release: 0.36 });
      });
    },

    // Final win — grander fanfare
    win: (ctx, dest) => {
      const t = ctx.currentTime;
      const seq = [
        [523.25, 0.00], [659.25, 0.13], [783.99, 0.26], [1046.5, 0.39],
        [1318.5, 0.52], [1567.98, 0.65], [2093.0, 0.78],
        [1567.98, 1.00], [2093.0, 1.00], [2637.02, 1.00],
      ];
      seq.forEach(([f, d]) => {
        tone(ctx, dest, { type: 'triangle', freq: f, t0: t + d, attack: 0.015, peak: 0.28, release: 0.5 });
      });
    },

    // Respawn — subtle rising whoosh (rarely used but handy)
    respawn: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'sine', freq: 200, freq2: 800, t0: t, attack: 0.05, peak: 0.15, release: 0.25 });
    },

    // UI click (button tap)
    click: (ctx, dest) => {
      const t = ctx.currentTime;
      tone(ctx, dest, { type: 'square', freq: 1200, t0: t, attack: 0.002, peak: 0.1, release: 0.05 });
    },
  };

  window.SoundFX = new SoundFX();
})();
