#!/usr/bin/env node
'use strict';
// Read the iReal Pro library table's TITLE for every row, fast.
//
// MEASURED 2026-11-02: the old `allRowTitles` walked every row's
// static text in ONE AppleScript call, and it times out — the AX
// bridge gives up on a 1702-row sweep. The fix is to read the cell's
// CHILDREN index (static text 2) rather than by role, and to page the
// read in chunks so no single Apple event runs too long.
//
// The cell layout, confirmed by probe:
//   AXCell > AXStaticText(empty) > AXStaticText(title) > AXStaticText(composer)
//   AXStaticText(style) > AXGroup > AXStaticText(key) > AXStaticText("bpm")
//   AXStaticText(tempo)
// and the AXCell's own `description` is
//   "<tempo> <title>, <composer>, <style>, <bpm> BPM, <key>"

const { execFileSync } = require('node:child_process');

const APP = 'iReal Pro';

function osa(script, timeoutMs = 60000) {
    const file = `/tmp/ireal-${process.pid}-${Math.floor(Math.random() * 1e6)}.scpt`;
    require('node:fs').writeFileSync(file, script);
    try {
        const out = execFileSync('perl', ['-e', `alarm ${Math.ceil(timeoutMs / 1000)}; exec @ARGV`, 'osascript', file],
            { timeout: timeoutMs + 5000, encoding: 'utf8' });
        return (out || '').trim();
    } catch (e) {
        return '';
    } finally {
        try { require('node:fs').unlinkSync(file); } catch { /* gone */ }
    }
}

/**
 * The titles of rows [from, to] (1-based, inclusive).
 * Returns an array of strings.
 */
function titlesRange(from, to) {
    const s = `
tell application "System Events"
tell process "${APP}"
  set lvl to {window 1}
  set depth to 1
  set found to missing value
  repeat while depth is less than 6
    set nextLvl to {}
    repeat with p in lvl
      try
        repeat with e in UI elements of p
          try
            if (role of e) is "AXTable" then
              set found to e
              exit repeat
            end if
            set end of nextLvl to e
          end try
        end repeat
      end try
      if found is not missing value then exit repeat
    end repeat
    if found is not missing value then exit repeat
    set lvl to nextLvl
    set depth to depth + 1
  end repeat
  if found is missing value then return ""
  set out to ""
  set ri to ${from}
  repeat while ri is less than or equal to ${to}
    try
      set c to UI element 1 of row ri of found
      set t to value of static text 2 of c
      set out to out & t & "\\n"
    on error
      set out to out & "\\n"
    end try
    set ri to ri + 1
  end repeat
  return out
end tell
end tell
`;
    return osa(s, 120000).split('\n');
}

/** The composer of one row (static text 3). */
function rowComposer(index) {
    const s = `
tell application "System Events"
tell process "${APP}"
  set lvl to {window 1}
  set depth to 1
  repeat while depth is less than 6
    set nextLvl to {}
    repeat with p in lvl
      try
        repeat with e in UI elements of p
          try
            if (role of e) is "AXTable" then
              try
                return (value of static text 3 of UI element 1 of row ${index} of e) as string
              on error
                return ""
              end try
            end if
            set end of nextLvl to e
          end try
        end repeat
      end try
    end repeat
    set lvl to nextLvl
    set depth to depth + 1
  end repeat
  return ""
end tell
end tell
`;
    return osa(s);
}

/** The full AXCell description for one row. */
function rowDescription(index) {
    const s = `
tell application "System Events"
tell process "${APP}"
  set lvl to {window 1}
  set depth to 1
  repeat while depth is less than 6
    set nextLvl to {}
    repeat with p in lvl
      try
        repeat with e in UI elements of p
          try
            if (role of e) is "AXTable" then
              try
                return (description of UI element 1 of row ${index} of e) as string
              on error
                return ""
              end try
            end if
            set end of nextLvl to e
          end try
        end repeat
      end try
    end repeat
    set lvl to nextLvl
    set depth to depth + 1
  end repeat
  return ""
end tell
end tell
`;
    return osa(s);
}

module.exports = { osa, titlesRange, rowComposer, rowDescription };

if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'titles') {
        const from = Number(process.argv[3] || 1);
        const to = Number(process.argv[4] || 1702);
        titlesRange(from, to).forEach((t, i) => console.log(`${from + i}\t${t}`));
    } else if (cmd === 'desc') {
        console.log(rowDescription(Number(process.argv[3])));
    } else if (cmd === 'composer') {
        console.log(rowComposer(Number(process.argv[3])));
    } else {
        console.log('usage: ireal-index.js titles [from] [to] | desc <row> | composer <row>');
    }
}
