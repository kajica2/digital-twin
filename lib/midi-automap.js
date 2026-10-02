// lib/midi-automap.js — hardware knob auto-mapping for the Temple of Control.
//
// A MIDI controller (Native Instruments Maschine Mikro and friends) becomes
// the temperature desk: three encoders drive heat / breath / glow, and a mode
// button cycles which "automap mode" those encoders are currently assigned to.
// The mapping is table-driven so a new controller is one profile object, and
// the mapping function is pure (profile, mode, cc, value -> mutation) so it is
// unit-testable without hardware.
//
//   <script src="../lib/midi-automap.js"></script>
//   var desk = window.MIDI_AUTOMAP.create({
//     onMap: function (m) { visual.setTemp(m); },
//     onDevice: function (name) { console.log('auto-mapped', name); },
//     onMode: function (mode) { ... }
//   });
//   desk.request();           // asks for Web MIDI access, picks a device
//   desk.mode = 1;            // switch automap mode programmatically
//
// With no Web MIDI (Safari, or permission denied) the module stays inert and
// `supported` is false — the page keeps working as a plain three-slider desk.
//
// Automap modes (the "modi"):
//   0 temperature  knobs = heat, breath, glow        (the literal desk)
//   1 score        knobs = heat, glow, ring rate     (breath repurposed)
//   2 tint         knobs = heat, glow, hue shift     (breath repurposed)
// The mode button (default CC 3) advances the mode; a long list of controllers
// is unnecessary because unknown devices fall back to the generic profile.

(function () {
  'use strict';

  if (window.MIDI_AUTOMAP) return;

  var MODES = [
    { id: 0, name: 'temperature', targets: ['heat', 'breath', 'glow'] },
    { id: 1, name: 'score', targets: ['heat', 'glow', 'ringRate'] },
    { id: 2, name: 'tint', targets: ['heat', 'glow', 'hue'] }
  ];

  // Profiles: CC number -> param. `modeCC` cycles the mode, `modeValue`
  // optionally jumps straight to a mode (pad-style controllers).
  var PROFILES = {
    'maschine-mikro': {
      name: 'Native Instruments Maschine Mikro',
      match: /maschine\s*mikro/i,
      knobs: [16, 17, 18, 19, 20, 21, 22, 23], // the 8 encoders
      modeCC: 3,
      modeValues: null
    },
    generic: {
      name: 'Generic MIDI controller',
      match: /.*/,
      knobs: [1, 2, 3, 4, 5, 6, 7, 8],
      modeCC: 3,
      modeValues: null
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

  // Pure mapping: (profileId, modeIndex, cc, value) -> mutation object.
  // Returns {} when the CC belongs to nothing.
  function map(profileId, modeIndex, cc, value) {
    var profile = PROFILES[profileId] || PROFILES.generic;
    var mode = MODES[((modeIndex % MODES.length) + MODES.length) % MODES.length];
    cc = Number(cc);
    value = Math.max(0, Math.min(1, Number(value) / 127));
    var out = {};

    if (cc === profile.modeCC) {
      if (profile.modeValues && profile.modeValues.indexOf(cc) !== -1) {
        out.mode = mode.id;
      } else {
        out.nextMode = true;
      }
      return out;
    }

    var slot = profile.knobs.indexOf(cc);
    if (slot === -1) return out;
    var target = mode.targets[slot % mode.targets.length];
    if (target) out[target] = value;
    return out;
  }

  function create(opts) {
    opts = opts || {};
    var state = { mode: 0, device: null, supported: false, access: null };

    function emit(m) {
      if (opts.onMap && m && Object.keys(m).length) opts.onMap(m);
    }

    function onMessage(ev) {
      var data = ev.data || [];
      var status = data[0] & 0xf0;
      if (status !== 0xb0) return; // control change only
      var cc = data[1];
      var value = data[2];
      var mutation = map(state.device ? state.device.automap : 'generic', state.mode, cc, value);
      if (mutation.nextMode) {
        state.mode = (state.mode + 1) % MODES.length;
        if (opts.onMode) opts.onMode(MODES[state.mode]);
        return;
      }
      if (typeof mutation.mode === 'number') {
        state.mode = mutation.mode;
        if (opts.onMode) opts.onMode(MODES[state.mode]);
        return;
      }
      emit(mutation);
    }

    function attach(input) {
      state.device = {
        id: input.id,
        name: input.name || 'MIDI input',
        automap: detect(input.name)
      };
      input.onmidimessage = onMessage;
      if (opts.onDevice) opts.onDevice(state.device);
    }

    return {
      get supported() { return state.supported; },
      get mode() { return state.mode; },
      set mode(v) {
        state.mode = ((Number(v) % MODES.length) + MODES.length) % MODES.length;
        if (opts.onMode) opts.onMode(MODES[state.mode]);
      },
      get modes() { return MODES.slice(); },
      get device() { return state.device; },
      request: function () {
        if (!navigator.requestMIDIAccess) return Promise.resolve(false);
        var self = this;
        return navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
          state.access = access;
          state.supported = true;
          var inputs = access.inputs ? Array.from(access.inputs.values()) : [];
          if (inputs.length) attach(inputs[0]);
          access.onstatechange = function (e) {
            if (e.port && e.port.type === 'input' && e.port.state === 'connected' && !state.device) {
              attach(e.port);
            }
          };
          return true;
        }).catch(function () { return false; });
      },
      // Test seam: feed a CC message without hardware.
      receive: function (cc, value) { onMessage({ data: [0xb0, cc, value] }); },
      disconnect: function () {
        if (state.access && state.access.inputs) {
          state.access.inputs.forEach(function (i) { i.onmidimessage = null; });
        }
        state.device = null;
      }
    };
  }

  window.MIDI_AUTOMAP = {
    create: create,
    map: map,
    detect: detect,
    modes: MODES,
    profiles: PROFILES
  };
})();
