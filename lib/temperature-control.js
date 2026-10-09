// lib/temperature-control.js — shared MIDI/keyboard → temperature control + SWR bridge.
//
// A unified control layer for hardware knobs and keyboard shortcuts that drives
// temperature parameters (heat, breath, glow). Can operate standalone or bridge
// to the SWR engine's _fxOverride for audio-visual synchronization.
//
// Usage (standalone):
//   <script src="/lib/temperature-control.js"></script>
//   var ctrl = TEMPERATURE_CONTROL.create({
//     onChange: function(temps) { console.log(temps); },
//     source: function(name) { ... }  // optional: report input source
//   });
//   ctrl.connect();    // MIDI + keyboard
//   ctrl.setTemp('heat', 0.5);
//
// Usage (SWR bridge):
//   <script src="/lib/temperature-control.js"></script>
//   var ctrl = TEMPERATURE_CONTROL.create({
//     swr: window.SWR,        // SWR instance
//     swrTarget: 'automix'    // 'automix' (uses _fxOverride) or 'direct' (sets fx.*)
//   });
//   ctrl.connect();  // heat→warmth, breath→intensity, glow→bloom
//
// Keyboard shortcuts (no MIDI):
//   1-9, 0       → heat (0.1 → 1.0)
//   Shift+1-9, 0 → breath (0.1 → 1.0)
//   Ctrl+1-9, 0  → glow (0.1 → 1.0)
//   M             → cycle mode

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TEMPERATURE_CONTROL = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- MIDI_AUTOMAP embedded (lightweight, no dependencies) ----
  var MODES = [
    { id: 0, name: 'temperature', targets: ['heat', 'breath', 'glow'] },
    { id: 1, name: 'score', targets: ['heat', 'glow', 'ringRate'] },
    { id: 2, name: 'tint', targets: ['heat', 'glow', 'hue'] }
  ];

  var PROFILES = {
    'maschine-mikro': {
      name: 'Native Instruments Maschine Mikro',
      match: /maschine\s*mikro/i,
      knobs: [16, 17, 18, 19, 20, 21, 22, 23],
      modeCC: 3
    },
    generic: {
      name: 'Generic MIDI controller',
      match: /.*/,
      knobs: [1, 2, 3, 4, 5, 6, 7, 8],
      modeCC: 3
    }
  };

  function detect(deviceName) {
    var n = String(deviceName || '');
    for (var id in PROFILES) {
      if (id === 'generic') continue;
      if (PROFILES[id].match.test(n)) return id;
    }
    return 'generic';
  }

  function map(profileId, modeIndex, cc, value) {
    var profile = PROFILES[profileId] || PROFILES.generic;
    var mode = MODES[((modeIndex % MODES.length) + MODES.length) % MODES.length];
    cc = Number(cc);
    value = Math.max(0, Math.min(1, Number(value) / 127));
    var out = {};

    if (cc === profile.modeCC) {
      out.nextMode = true;
      return out;
    }

    var slot = profile.knobs.indexOf(cc);
    if (slot === -1) return out;
    var target = mode.targets[slot % mode.targets.length];
    if (target) out[target] = value;
    return out;
  }

  // ---- SWR Bridge ----
  // Maps temperature keys to SWR _fxOverride fields
  var SWR_MAPPING = {
    heat: 'warmth',      // heat → warmth
    breath: 'intensity', // breath → intensity  
    glow: 'bloom'        // glow → bloom
  };

  // Default SWR _fxOverride structure (14 fields)
  var DEFAULT_FX_OVERRIDE = {
    warmth: 0.5,
    intensity: 0.5,
    bloom: 0.3,
    vignette: 0,
    chroma: 0,
    grain: 0,
    sepia: 0,
    grayscale: 0,
    blur: 0,
    liquid: 0,
    pearl: 0,
    glitch: 0,
    contrast: 0,
    saturation: 0
  };

  function applyToSWR(swr, temps, target) {
    if (!swr || !swr._fxOverride) return;
    var override = swr._fxOverride;
    var mapping = SWR_MAPPING;
    
    Object.keys(temps).forEach(function (key) {
      var swrKey = mapping[key];
      if (swrKey && override.hasOwnProperty(swrKey)) {
        override[swrKey] = temps[key];
      }
    });

    // If direct mode, also set swr.fx.* for immediate effect
    if (target === 'direct' && swr.fx) {
      Object.keys(temps).forEach(function (key) {
        var swrKey = mapping[key];
        if (swrKey && swr.fx.hasOwnProperty(swrKey)) {
          swr.fx[swrKey] = temps[key];
        }
      });
    }
  }

  // ---- Main Controller ----
  function create(opts) {
    opts = opts || {};
    var onChange = opts.onChange || function () {};
    var onSource = opts.onSource || function () {};
    var swr = opts.swr || null;
    var swrTarget = opts.swrTarget || 'automix'; // 'automix' or 'direct'
    var mode = 0;
    var temps = { heat: 0.5, breath: 0.5, glow: 0.5 };
    var midiDesk = null;
    var keyboardActive = false;

    function emit(newTemps) {
      Object.keys(newTemps).forEach(function (k) { temps[k] = newTemps[k]; });
      onChange(temps);
      if (swr) applyToSWR(swr, temps, swrTarget);
    }

    function setTemp(key, value) {
      var t = {}; t[key] = value;
      emit(t);
    }

    // MIDI setup
    function setupMIDI() {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess().then(function (access) {
          var inputs = access.inputs ? Array.from(access.inputs.values()) : [];
          if (inputs.length) {
            onSource('MIDI');
            inputs[0].onmidimessage = function (e) {
              var data = e.data;
              if (!data || data.length < 3) return;
              var cc = data[1];
              var val = data[2];
              var mut = map(detect(inputs[0].name), mode, cc, val);
              if (mut.nextMode) {
                mode = (mode + 1) % MODES.length;
              }
              if (mut.heat !== undefined) emit({ heat: mut.heat });
              if (mut.breath !== undefined) emit({ breath: mut.breath });
              if (mut.glow !== undefined) emit({ glow: mut.glow });
            };
          }
        }).catch(function () {});
      }
    }

    // Keyboard setup
    function setupKeyboard() {
      if (typeof document !== 'undefined') {
        document.addEventListener('keydown', function (e) {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          var key = e.key;
          var set = null;

          // Heat: 1-9 → 0.1-0.9, 0 → 1.0
          if (key >= '1' && key <= '9') {
            set = { temp: 'heat', value: (key.charCodeAt(0) - 48) / 9 };
          } else if (key === '0') {
            set = { temp: 'heat', value: 1.0 };
          }
          // Breath: Shift+1-9 → 0.1-0.9, Shift+0 → 1.0
          else if (e.shiftKey && key >= '1' && key <= '9') {
            set = { temp: 'breath', value: (key.charCodeAt(0) - 48) / 9 };
          } else if (e.shiftKey && key === '0') {
            set = { temp: 'breath', value: 1.0 };
          }
          // Glow: Ctrl+1-9 → 0.1-0.9, Ctrl+0 → 1.0
          else if ((e.ctrlKey || e.metaKey) && key >= '1' && key <= '9') {
            set = { temp: 'glow', value: (key.charCodeAt(0) - 48) / 9 };
          } else if ((e.ctrlKey || e.metaKey) && key === '0') {
            set = { temp: 'glow', value: 1.0 };
          }
          // Mode cycle: M
          else if (key === 'm' || key === 'M') {
            mode = (mode + 1) % MODES.length;
            return;
          }

          if (set) {
            e.preventDefault();
            onSource('keyboard');
            setTemp(set.temp, set.value);
          }
        });
      }
    }

    return {
      // Connect MIDI + keyboard
      connect: function () {
        setupMIDI();
        setupKeyboard();
        return this;
      },
      // Set temperature directly
      setTemp: setTemp,
      // Set all temperatures at once
      setTemps: function (t) { emit(t); },
      // Get current temperatures
      getTemps: function () { return Object.assign({}, temps); },
      // Get current mode
      getMode: function () { return MODES[mode]; },
      // Cycle mode
      nextMode: function () { mode = (mode + 1) % MODES.length; return MODES[mode]; },
      // Connect to SWR after creation
      connectSWR: function (swrInstance, target) {
        swr = swrInstance;
        swrTarget = target || 'automix';
        return this;
      },
      // Disconnect MIDI
      disconnect: function () {
        if (midiDesk && midiDesk.disconnect) midiDesk.disconnect();
        midiDesk = null;
        return this;
      },
      // Expose MIDI_AUTOMAP for advanced use
      MIDI_AUTOMAP: {
        create: function (midiOpts) {
          midiDesk = midiOpts;
          return midiDesk;
        },
        map: map,
        detect: detect,
        modes: MODES,
        profiles: PROFILES
      }
    };
  }

  return {
    create: create,
    // Re-export for direct use
    map: map,
    detect: detect,
    modes: MODES,
    profiles: PROFILES,
    // SWR mapping constants
    SWR_MAPPING: SWR_MAPPING,
    DEFAULT_FX_OVERRIDE: DEFAULT_FX_OVERRIDE
  };
}));
