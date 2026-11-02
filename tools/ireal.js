#!/usr/bin/env node
'use strict';
// tools/ireal.js — drive iReal Pro over the Accessibility API.
//
// WHY A SCRIPT AND NOT A CLICK-BY-CLICK
//
// iReal Pro's AX tree is pathological: a full `entire contents` walk
// times out, and the File menu's items time out when read all at once.
// But the tree is navigable if you walk it by DEPTH with an explicit
// limit and use `UI element N` rather than the reserved-word class
// names (`scroll area` is not a term — `AXScrollArea` is not either,
// and `table 1 of scroll area 1 of ...` is a syntax error).
//
// WHAT IS HERE
//
//   songTable()    the library's song table (1702 rows)
//   rowTitle(i)    one row's title
//   selectSong(i)  open a song in the editor
//   exportAudio(path)  File > Export Audio, with the destination chosen
//
// The export goes through the app's OWN renderer, so the WAV is
// iReal's sound, not a re-implementation.

const { execFileSync } = require('node:child_process');

const APP = 'iReal Pro';

/** Run an AppleScript and return its stdout (or '' on failure). */
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

/** The library's song table: its row count. */
function songTableCount() {
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
            if (role of e) is "AXTable" then return (count of rows of e) as text
            set end of nextLvl to e
          end try
        end repeat
      end try
    end repeat
    set lvl to nextLvl
    set depth to depth + 1
  end repeat
  return "0"
end tell
end tell
`;
    return Number(osa(s)) || 0;
}

/** One row's title text. */
function rowTitle(index) {
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
              repeat with r in rows of e
                try
                  if (value of attribute "AXIndex" of r) is ${index} then
                    return (value of static text 1 of r as string)
                  end if
                end try
              end repeat
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

/** Every row's title, as an array. */
function allRowTitles() {
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
              set out to ""
              repeat with r in rows of e
                try
                  set out to out & (value of static text 1 of r as string) & "\\n"
                end try
              end repeat
              return out
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
    return osa(s, 180000).split('\n').map((x) => x.trim()).filter(Boolean);
}

/** Click a row (1-based, as AX sees it). */
function clickRow(index) {
    const s = `
tell application "System Events"
tell process "${APP}"
  set frontmost to true
  set lvl to {window 1}
  set depth to 1
  repeat while depth is less than 6
    set nextLvl to {}
    repeat with p in lvl
      try
        repeat with e in UI elements of p
          try
            if (role of e) is "AXTable" then
              click row ${index} of e
              return "ok"
            end if
            set end of nextLvl to e
          end try
        end repeat
      end try
    end repeat
    set lvl to nextLvl
    set depth to depth + 1
  end repeat
  return "not found"
end tell
end tell
`;
    return osa(s) === 'ok';
}

/** The window title (the song editor shows the song's name). */
function windowTitle() {
    return osa(`
tell application "System Events"
tell process "${APP}"
  try
    return name of window 1
  on error
    return ""
  end try
end tell
end tell
`);
}

/** The File menu's items, one at a time (reading them all at once times out). */
function fileMenuItems() {
    const s = `
tell application "System Events"
tell process "${APP}"
  set fm to menu "File" of menu bar 1
  set n to count of menu items of fm
  set out to ""
  set idx to 1
  repeat while idx <= n
    try
      set out to out & idx & "=" & (name of menu item idx of fm) & "\\n"
    on error
      set out to out & idx & "=<none>\\n"
    end try
    set idx to idx + 1
  end repeat
  return out
end tell
end tell
`;
    return osa(s).split('\n').map((x) => x.trim()).filter(Boolean);
}

/** Click a File menu item by name. */
function clickFileMenu(name) {
    return osa(`
tell application "System Events"
tell process "${APP}"
  click menu item "${name}" of menu "File" of menu bar 1
  return "ok"
end tell
end tell
`) === 'ok';
}

module.exports = {
    osa,
    songTableCount,
    rowTitle,
    allRowTitles,
    clickRow,
    windowTitle,
    fileMenuItems,
    clickFileMenu,
};

if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'count') console.log(songTableCount());
    else if (cmd === 'titles') console.log(allRowTitles().join('\n'));
    else if (cmd === 'menu') console.log(fileMenuItems().join('\n'));
    else if (cmd === 'title') console.log(windowTitle());
    else console.log('usage: ireal.js count|titles|menu|title');
}
