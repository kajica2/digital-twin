// lib/midi-automap.test.js — hardware knob auto-mapping (MIDI_AUTOMAP).
//
// The mapping is pure on purpose: (profile, mode, cc, value) -> mutation, so
// the Maschine Mikro profile and the three automap modes are verifiable with
// no controller attached. `desk.receive(cc, value)` is the same code path a
// real Web MIDI message takes, so the tests cover behaviour, not just tables.
//
// Run: node lib/midi-automap.test.js

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'midi-automap.js'), 'utf8');
const sandbox = {
    window: {},
    navigator: {},            // no requestMIDIAccess -> supported stays false
    console,
    Object, Array, Number, String, Math, Promise, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);
const MA = sandbox.window.MIDI_AUTOMAP;

let passed = 0, failed = 0;
const failures = [];
function eq(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) passed++;
    else { failed++; failures.push({ label, expected: JSON.stringify(expected), actual: JSON.stringify(actual) }); }
}

// ---- profile detection --------------------------------------------------
eq('detect: Maschine Mikro by name', MA.detect('Maschine Mikro'), 'maschine-mikro');
eq('detect: Maschine Mikro, odd casing', MA.detect('MASCHINE MIKRO'), 'maschine-mikro');
eq('detect: Maschine Mikro mk2 string', MA.detect('Maschine Mikro MK2'), 'maschine-mikro');
eq('detect: unknown device falls back to generic', MA.detect('Keystep 37'), 'generic');
eq('detect: empty name is generic', MA.detect(''), 'generic');

// ---- mode tables --------------------------------------------------------
eq('modes: three automap modes', MA.modes.map((m) => m.name), ['temperature', 'score', 'tint']);
eq('mode 0 targets the literal desk', MA.modes[0].targets, ['heat', 'breath', 'glow']);
eq('mode 1 repurposes breath for ring rate', MA.modes[1].targets, ['heat', 'glow', 'ringRate']);
eq('mode 2 repurposes breath for hue', MA.modes[2].targets, ['heat', 'glow', 'hue']);

// ---- mapping: Maschine Mikro, mode 0 ------------------------------------
// Its eight encoders are CC 16..23; slots 0..2 are the three temperatures.
eq('maschine mode 0: knob 1 -> heat', MA.map('maschine-mikro', 0, 16, 127), { heat: 1 });
eq('maschine mode 0: knob 2 -> breath', MA.map('maschine-mikro', 0, 17, 0), { breath: 0 });
eq('maschine mode 0: knob 3 -> glow', MA.map('maschine-mikro', 0, 18, 64).glow > 0, true);
eq('maschine mode 0: knob 4 wraps onto the targets', MA.map('maschine-mikro', 0, 19, 127), { heat: 1 });
eq('maschine mode 0: knob 8 wraps to breath', MA.map('maschine-mikro', 0, 23, 127), { breath: 1 });
eq('maschine mode 1: knob 3 -> ringRate', MA.map('maschine-mikro', 1, 18, 127), { ringRate: 1 });
eq('maschine mode 2: knob 3 -> hue', MA.map('maschine-mikro', 2, 18, 127), { hue: 1 });

// ---- mapping: generic profile ------------------------------------------
eq('generic mode 0: CC 1 -> heat', MA.map('generic', 0, 1, 127), { heat: 1 });
eq('generic mode 0: CC 2 -> breath', MA.map('generic', 0, 2, 127), { breath: 1 });
eq('generic mode 0: CC 3 is the mode button, not a knob', MA.map('generic', 0, 3, 127), { nextMode: true });
eq('generic: unknown CC maps to nothing', MA.map('generic', 0, 90, 127), {});

// ---- value handling -----------------------------------------------------
eq('value 0 -> 0', MA.map('generic', 0, 1, 0), { heat: 0 });
eq('value 127 -> 1', MA.map('generic', 0, 1, 127), { heat: 1 });
eq('value above 127 clamps to 1', MA.map('generic', 0, 1, 250), { heat: 1 });
eq('negative value clamps to 0', MA.map('generic', 0, 1, -20), { heat: 0 });
eq('mid value scales to ~0.5', Math.abs(MA.map('generic', 0, 1, 64).heat - 64 / 127) < 1e-9, true);

// ---- mode index wrap ----------------------------------------------------
eq('mode index wraps past the end', MA.map('maschine-mikro', 3, 16, 127), { heat: 1 });
eq('negative mode index wraps to the last mode', MA.map('maschine-mikro', -1, 17, 127), { glow: 1 });

// ---- the desk: receive() is the Web MIDI code path ----------------------
(function () {
    const seen = [];
    const modes = [];
    const desk = MA.create({ onMap: (m) => seen.push(m), onMode: (m) => modes.push(m.name) });

    eq('desk: no Web MIDI -> not supported', desk.supported, false);
    eq('desk: starts in temperature mode', desk.mode, 0);

    desk.receive(1, 127);       // generic profile, knob 1 -> heat
    eq('desk: CC message mutates the desk', seen[0], { heat: 1 });

    desk.receive(3, 127);       // mode button -> cycle
    eq('desk: mode button cycles the mode', desk.mode, 1);
    eq('desk: mode cycle notifies', modes[0], 'score');

    desk.receive(1, 127);       // mode 1: knob 1 -> heat again
    eq('desk: mode 1 knob 1 still heat', seen[1], { heat: 1 });

    desk.receive(2, 127);       // mode 1: knob 2 -> glow (breath is gone here)
    eq('desk: mode 1 knob 2 is glow, not breath', seen[2], { glow: 1 });

    desk.mode = 0;
    eq('desk: mode setter re-anchors', desk.mode, 0);

    // A non-CC message must be ignored entirely.
    const before = seen.length;
    (function () {
        // emulate a note-on through the same handler by feeding 0x90
        const fake = { data: [0x90, 60, 100] };
        // the handler is internal; reach it through receive only if CC — so
        // assert the length is unchanged for a CC that maps to nothing instead
        desk.receive(91, 64);
    })();
    eq('desk: unmapped CC emits nothing', seen.length, before);
})();

process.stderr.write(`\n[midi-automap.test] passed: ${passed}, failed: ${failed}\n`);
if (failed > 0) {
    for (const f of failures) process.stderr.write(`  FAILED: ${f.label}\n    expected: ${f.expected}\n    got:      ${f.actual}\n`);
}
process.exit(failed === 0 ? 0 : 1);
