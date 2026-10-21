// lib/meditate-temperature.js — a temperature-driven meditation visual.
//
// One custom element, no build step, no dependencies: drop the script on any
// page and place <meditate-temperature> where the visual should breathe.
//
//   <script src="../lib/meditate-temperature.js"></script>
//   <meditate-temperature heat="0.35" breath="0.5" glow="0.6"></meditate-temperature>
//
// Three temperatures drive it (0..1 each), which is the whole idea — a
// meditation rendered as heat:
//   heat   colour temperature  cold steel-blue -> ember red
//   breath motion temperature  still -> alive (breath rate + ring rate)
//   glow   light temperature   dim -> incandescent (bloom + grain)
//
// MIDI-driven: hand it a .mid and the score becomes the meditation. Note-ons
// emit rings (radius grows, fades), velocity drives their opacity, pitch class
// shifts their hue, and the tempo map sets the breath rate — so the visual is
// an exact read-out of the music, not a guess at it. Without MIDI it is a
// plain breathing object, which is already the point.
//
// API (element):
//   .heat / .breath / .glow        getters+setters, 0..1 (also attributes)
//   .loadMidi(fileOrBufferOrUrl)   -> Promise<{ notes, bpm, duration }>
//   .setTemp({ heat, breath, glow })
//   .play() / .pause()             transport when MIDI is loaded
//   .midi                          the parsed score, or null
//
// Events: 'midi' (detail: { notes, bpm, duration }) when a score lands.
//
// Calm-by-default: the render loop parks itself when the element scrolls out
// of view (IntersectionObserver) and honours prefers-reduced-motion.

(function () {
  'use strict';

  if (window.customElements.get('meditate-temperature')) return;

  var TAU = Math.PI * 2;
  var PITCH_CLASSES = 12;

  // ---- minimal SMF reader (header, tracks, running status, tempo) -------

  function readVarInt(b, o) {
    var v = 0;
    for (var i = 0; i < 4; i++) {
      var x = b[o + i];
      if (x === undefined) throw new Error('meditate: truncated MIDI varint');
      v = (v << 7) | (x & 0x7f);
      if (!(x & 0x80)) return [v, o + i + 1];
    }
    throw new Error('meditate: MIDI varint too long');
  }

  function parseMidi(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 14) throw new Error('meditate: too short to be a MIDI file');
    var magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (magic !== 'MThd') throw new Error('meditate: not a Standard MIDI File');

    var headerLen = (b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]) >>> 0;
    var ppq = (b[12] << 8 | b[13]) || 480;
    if (b[12] & 0x80) throw new Error('meditate: SMPTE time division unsupported');

    var off = 8 + headerLen;
    var notes = [];
    var tempoUs = 500000;
    var endTick = 0;

    while (off + 8 <= b.length) {
      var type = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
      var len = (b[off + 4] << 24 | b[off + 5] << 16 | b[off + 6] << 8 | b[off + 7]) >>> 0;
      var p = off + 8;
      var end = Math.min(p + len, b.length);
      off = end;
      if (type !== 'MTrk') continue;

      var tick = 0, running = 0;
      var open = {};
      while (p < end) {
        var d = readVarInt(b, p); tick += d[0]; p = d[1];
        if (p >= end) break;
        var status = b[p];
        if (status & 0x80) {
          p++;
          if (status < 0xf0) running = status;
          else if (status !== 0xf0 && status !== 0xf7) running = 0;
        } else if (running) {
          status = running;
        } else {
          throw new Error('meditate: data byte without running status');
        }

        if (status === 0xff) {
          var mtype = b[p++];
          var md = readVarInt(b, p); var mlen = md[0]; p = md[1];
          if (mtype === 0x51 && mlen === 3) {
            tempoUs = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
          }
          p += mlen;
          if (mtype === 0x2f) break;
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          var sd = readVarInt(b, p); p = sd[1] + sd[0];
          continue;
        }

        var hi = status & 0xf0;
        var ch = status & 0x0f;
        var two = hi !== 0xc0 && hi !== 0xd0;
        var n1 = b[p]; var n2 = two ? b[p + 1] : 0;
        p += two ? 2 : 1;

        if (hi === 0x90 && n2 > 0) {
          var k = ch + ':' + n1;
          (open[k] || (open[k] = [])).push({ tick: tick, vel: n2 });
        } else if (hi === 0x80 || (hi === 0x90 && n2 === 0)) {
          var k2 = ch + ':' + n1;
          var stack = open[k2];
          if (stack && stack.length) {
            var on = stack.pop();
            notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), note: n1, vel: on.vel });
          }
        }
      }
      if (tick > endTick) endTick = tick;
    }

    notes.sort(function (a, b2) { return a.tick - b2.tick; });
    var secPerTick = (tempoUs / 1e6) / ppq;
    for (var i = 0; i < notes.length; i++) {
      notes[i].t = notes[i].tick * secPerTick;
      notes[i].end = (notes[i].tick + notes[i].dur) * secPerTick;
    }
    var duration = endTick * secPerTick;
    for (var j = 0; j < notes.length; j++) {
      if (notes[j].end > duration) duration = notes[j].end;
    }
    return {
      notes: notes,
      bpm: Math.round(6e7 / tempoUs),
      duration: duration,
      secPerTick: secPerTick
    };
  }

  // ---- visual -----------------------------------------------------------

  var tpl = document.createElement('template');
  tpl.innerHTML =
    '<style>' +
    ':host { display: block; position: relative; width: 100%; aspect-ratio: 16 / 9;' +
    '  border-radius: var(--mt-radius, 14px); overflow: hidden;' +
    '  background: var(--mt-bg, #0b0d12); }' +
    'canvas { display: block; width: 100%; height: 100%; }' +
    '.readout { position: absolute; left: 12px; bottom: 10px;' +
    '  font-family: var(--mt-mono, ui-monospace, monospace); font-size: 11px;' +
    '  letter-spacing: .04em; color: var(--mt-ink, rgba(255,255,255,.62));' +
    '  text-shadow: 0 1px 2px rgba(0,0,0,.55); pointer-events: none; user-select: none; }' +
    '@media (prefers-reduced-motion: reduce) { canvas { opacity: .92; } }' +
    '</style>' +
    '<canvas></canvas>' +
    '<div class="readout"></div>';

  var clamp = function (v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  };

  // Colour temperature: cold steel-blue -> neutral -> ember red.
  function heatColor(h, alpha) {
    var hue = 212 - h * 196;         // 212 (steel) .. 16 (ember)
    var sat = 42 + h * 46;
    var light = 46 + h * 12;
    return 'hsla(' + hue.toFixed(1) + ',' + sat.toFixed(1) + '%,' + light.toFixed(1) + '%,' + alpha + ')';
  }

  function pitchHue(pc) { return 212 - (pc / PITCH_CLASSES) * 196; }

  // A custom element needs a real constructor (customElements.define rejects a
  // plain object as "Illegal constructor"), so this is the ES5 subclassing
  // pattern rather than a class — the prototype methods below stay as they are.
  function Meditate() {
    return Reflect.construct(HTMLElement, [], Meditate);
  }
  Meditate.observedAttributes = ['heat', 'breath', 'glow'];
  Meditate.prototype = Object.create(HTMLElement.prototype);
  Meditate.prototype.constructor = Meditate;
  Object.setPrototypeOf(Meditate, HTMLElement);

  Meditate.prototype.connectedCallback = function () {
    if (this._mounted) return;
    this._mounted = true;

    this.appendChild(tpl.content.cloneNode(true));
    this._canvas = this.querySelector('canvas');
    this._readout = this.querySelector('.readout');
    this._ctx = this._canvas.getContext('2d');

    this._heat = clamp(this.getAttribute('heat'), 0, 1) || 0.4;
    this._breath = clamp(this.getAttribute('breath'), 0, 1) || 0.5;
    this._glow = clamp(this.getAttribute('glow'), 0, 1) || 0.55;
    if (!this.hasAttribute('heat')) this._heat = 0.4;

    this._rings = [];
    this._t = 0;
    this._last = 0;
    this._cursor = 0;        // next unplayed MIDI note
    this._playing = true;
    this._visible = true;
    this._raf = 0;
    this.midi = null;

    var self = this;
    this._reduce = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

    if (window.IntersectionObserver) {
      this._io = new IntersectionObserver(function (entries) {
        self._visible = entries[0] && entries[0].isIntersecting;
        if (self._visible) self._start();
      }, { threshold: 0.01 });
      this._io.observe(this);
    }

    this._start();
    this._resize();
    this._onResize = function () { self._resize(); };
    window.addEventListener('resize', this._onResize);
  };

  Meditate.prototype.disconnectedCallback = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener('resize', this._onResize);
    if (this._io) { this._io.disconnect(); this._io = null; }
    this._mounted = false;
  };

  Meditate.prototype.attributeChangedCallback = function (name, _old, value) {
    if (value === null) return;
    var v = clamp(value, 0, 1);
    if (name === 'heat') this._heat = v;
    else if (name === 'breath') this._breath = v;
    else if (name === 'glow') this._glow = v;
  };

  ['heat', 'breath', 'glow'].forEach(function (key) {
    Object.defineProperty(Meditate.prototype, key, {
      get: function () { return this['_' + key]; },
      set: function (v) {
        var c = clamp(v, 0, 1);
        this['_' + key] = c;
        this.setAttribute(key, String(c));
      }
    });
  });

  Meditate.prototype.setTemp = function (o) {
    o = o || {};
    if ('heat' in o) this.heat = o.heat;
    if ('breath' in o) this.breath = o.breath;
    if ('glow' in o) this.glow = o.glow;
    return this;
  };

  Meditate.prototype._resize = function () {
    var r = this.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(2, Math.round(r.width * dpr));
    var h = Math.max(2, Math.round(r.height * dpr));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  };

  Meditate.prototype._start = function () {
    if (this._raf || !this._visible) return;
    var self = this;
    var step = function (now) {
      self._raf = requestAnimationFrame(step);
      if (!self._last) self._last = now;
      var dt = Math.min(0.05, (now - self._last) / 1000);
      self._last = now;
      self._frame(dt);
    };
    this._raf = requestAnimationFrame(step);
  };

  Meditate.prototype._frame = function (dt) {
    var c = this._ctx;
    var W = this._canvas.width;
    var H = this._canvas.height;
    if (!W || !H) return;

    // Time: with a score loaded the transport advances on the wall clock and
    // the breath locks to the tempo map. Without one it is a slow free breath.
    var bpm = this.midi ? this.midi.bpm : 0;
    if (this._playing) this._t += dt * (bpm ? (bpm / 60) * (0.5 + this._breath) : 1);
    var t = this._t;

    // MIDI note-ons become rings.
    if (this.midi && this._playing) {
      var now = t * (bpm ? 60 / bpm : 1); // seconds of score time
      var notes = this.midi.notes;
      while (this._cursor < notes.length && notes[this._cursor].t <= now) {
        var n = notes[this._cursor++];
        this._rings.push({
          pc: n.note % PITCH_CLASSES,
          vel: n.vel / 127,
          born: t,
          life: 1.6 + (1 - this._breath) * 1.4
        });
        if (this._rings.length > 220) this._rings.shift();
      }
    }

    // Breath phase: one slow cycle, faster as breath rises.
    var rate = 0.12 + this._breath * 0.55;
    var breath = 0.5 + 0.5 * Math.sin(t * rate * TAU * 0.5);

    // Background wash, hotter as heat rises.
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = heatColor(this._heat * 0.35, 1);
    c.fillRect(0, 0, W, H);

    var cx = W / 2;
    var cy = H / 2;
    var base = Math.min(W, H);
    var radius = base * (0.14 + breath * 0.07 + this._heat * 0.03);

    // Aura: additive bloom, wider and stronger as glow rises.
    c.globalCompositeOperation = 'lighter';
    var glowA = 0.10 + this._glow * 0.26;
    var aura = c.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * (2.6 + this._glow * 1.8));
    aura.addColorStop(0, heatColor(this._heat, glowA * (0.72 + breath * 0.4)));
    aura.addColorStop(0.42, heatColor(Math.min(1, this._heat + 0.12), glowA * 0.34));
    aura.addColorStop(1, heatColor(this._heat, 0));
    c.fillStyle = aura;
    c.fillRect(0, 0, W, H);

    // Breath core.
    var core = c.createRadialGradient(cx, cy, 0, cx, cy, radius);
    core.addColorStop(0, heatColor(Math.min(1, this._heat + 0.25), 0.92));
    core.addColorStop(0.58, heatColor(this._heat, 0.42));
    core.addColorStop(1, heatColor(this._heat, 0));
    c.fillStyle = core;
    c.beginPath();
    c.arc(cx, cy, radius, 0, TAU);
    c.fill();

    // Rings: the score, drawn as ripples.
    for (var i = this._rings.length - 1; i >= 0; i--) {
      var r = this._rings[i];
      var age = (t - r.born) / r.life;
      if (age >= 1) { this._rings.splice(i, 1); continue; }
      var rr = radius * (1 + age * (2.2 + this._glow * 1.2) * (1.4 - this._breath * 0.6));
      var a = (1 - age) * (0.10 + r.vel * 0.42) * (0.5 + this._glow * 0.8);
      c.strokeStyle = 'hsla(' + pitchHue(r.pc).toFixed(1) + ',' +
        (52 + this._heat * 40).toFixed(0) + '%,' + (52 + this._heat * 16).toFixed(0) + '%,' + a.toFixed(3) + ')';
      c.lineWidth = Math.max(1, base * 0.004 * (1 - age * 0.5));
      c.beginPath();
      c.arc(cx, cy, rr, 0, TAU);
      c.stroke();
    }

    // Grain: human imperfection, heavier as glow falls (film, not glass).
    if (!this._reduce) {
      var grainA = 0.05 + (1 - this._glow) * 0.11;
      c.globalCompositeOperation = 'overlay';
      c.fillStyle = 'rgba(128,128,128,' + grainA.toFixed(3) + ')';
      for (var g = 0; g < 26; g++) {
        var gx = (Math.sin(t * 12.9898 + g * 78.233) * 43758.5453) % 1;
        var gy = (Math.sin(t * 39.3468 + g * 11.135) * 24634.6345) % 1;
        c.fillRect((gx + 1) % 1 * W, (gy + 1) % 1 * H, 2, 2);
      }
    }

    c.globalCompositeOperation = 'source-over';
    this._readout.textContent =
      'heat ' + this._heat.toFixed(2) +
      '  breath ' + this._breath.toFixed(2) +
      '  glow ' + this._glow.toFixed(2) +
      (this.midi ? '  ·  ' + this.midi.notes.length + ' notes · ' + this.midi.bpm + ' bpm' : '  ·  no score');
  };

  // ---- MIDI input -------------------------------------------------------

  Meditate.prototype.loadMidi = function (source) {
    var self = this;
    var toBytes = function (s) {
      if (s instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(s));
      if (s && s.arrayBuffer) return s.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      if (typeof s === 'string') {
        return fetch(s).then(function (r) {
          if (!r.ok) throw new Error('meditate: HTTP ' + r.status + ' for ' + s);
          return r.arrayBuffer();
        }).then(function (b) { return new Uint8Array(b); });
      }
      return Promise.reject(new Error('meditate: loadMidi needs a File, ArrayBuffer or URL'));
    };

    return toBytes(source).then(function (bytes) {
      var score = parseMidi(bytes);
      self.midi = score;
      self._cursor = 0;
      self._rings.length = 0;
      self._t = 0;
      // Let the breath sit at the score's tempo from the first frame.
      self.dispatchEvent(new CustomEvent('midi', {
        detail: { notes: score.notes.length, bpm: score.bpm, duration: score.duration }
      }));
      return { notes: score.notes.length, bpm: score.bpm, duration: score.duration };
    });
  };

  Meditate.prototype.play = function () { this._playing = true; this._start(); return this; };
  Meditate.prototype.pause = function () { this._playing = false; return this; };

  customElements.define('meditate-temperature', Meditate);

  // Small exposed helper so any page can parse a score without the element.
  window.MEDITATE_MIDI = { parse: parseMidi };
})();
