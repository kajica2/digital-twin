-- bin/ireal-export.applescript
--
-- Export ONE song from iReal Pro's Library as a WAV.
--
--   osascript bin/ireal-export.applescript <rowIndex> <destinationPath>
--
-- WHAT THE EXPORT ACTUALLY DOES (measured 2026-11-02)
--
-- File > Export Audio does NOT open a save panel. It renders the song
-- and writes it, on its own, to:
--
--   ~/Library/Containers/com.massimobiolcati.irealbookmac/Data/tmp/song.wav
--
-- together with `song.mid` and `realDrums.pcm` in the same folder. The
-- file is a real WAV: PCM s16le, 44.1 kHz, stereo, ~1.4 Mbps, and its
-- length is the song's length (152.9 s for the song tested).
--
-- So the export is a RENDER, not a copy — the panel this script
-- originally looked for never appears, which is why the first version
-- of this script reported "no save panel after File > Export Audio"
-- while the export was in fact working perfectly.
--
-- The job here is therefore: select the song, invoke the menu item, WAIT
-- for the render to finish, and move the file to where the caller asked.
--
-- How the menu item is invoked: `click menu item "Export Audio" of menu
-- "File" of menu bar 1` is swallowed by this app (the menu opens, the
-- click does nothing). `perform action "AXPress"` on the item works.
--
-- How the item is located: BY NAME. The File menu's contents change
-- with context — a selected song adds "Save", a selected playlist adds
-- "Sort Playlist" — so a hardcoded index is wrong.
--
-- The AX tree is large and its snapshot is flaky under automation:
-- `window 1 of process "iReal Pro"` intermittently raises "Invalid
-- index" while the app is alive and has exactly one window (verified:
-- `count of windows` = 1, `version` = 2026.9). Every access is retried.
--
-- The Library's split group holds TWO scroll areas, and the indices
-- flip: measured on one run, `scroll area 1` was the 9-row playlist
-- sidebar and `scroll area 2` the 1702-row song list; on another, the
-- other way round. The song table is therefore found by ROW COUNT, not
-- by index.
--
-- Exit: 0 exported · 2 bad input · 3 the menu item was not found
--       4 the render did not produce a file · 5 the file was not copied

on run argv
	if (count of argv) < 2 then
		return "usage: osascript bin/ireal-export.applescript <rowIndex> <destination.wav>"
	end if
	set rowIndex to (item 1 of argv) as integer
	set destPath to item 2 of argv

	-- The container folder iReal Pro renders into.
	set srcPath to (POSIX path of (path to home folder)) & "Library/Containers/com.massimobiolcati.irealbookmac/Data/tmp/song.wav"

	tell application "System Events"
		tell process "iReal Pro"
			set frontmost to true
			delay 0.6
		end tell
	end tell

	-- 1. the song table
	set tbl to my songTable()
	set songName to my songTitle(tbl, rowIndex)
	if songName is "" then return "row " & rowIndex & " has no title"

	-- 2. select it
	tell application "System Events"
		tell process "iReal Pro"
			try
				click row rowIndex of tbl
			on error
				delay 1
				click row rowIndex of tbl
			end try
			delay 2
		end tell
	end tell

	-- 3. File > Export Audio, located by name
	set menuIdx to my invokeFileMenu("Export Audio")
	if menuIdx is 0 then return "menu item not found"

	-- 4. wait for the RENDER. It is asynchronous: the file appears once
	--    the song has been rendered, and a partial file is possible
	--    while it is still being written — so the wait is on the file's
	--    size STABILISING, not merely on its existence.
	set rendered to my waitForRender(srcPath)
	if rendered is false then
		return "no render at " & srcPath & " after File > Export Audio"
	end if
	set byteCount to my fileSize(srcPath)

	-- 5. move it where the caller asked
	set destDir to my dirOf(destPath)
	do shell script "mkdir -p " & quoted form of destDir
	do shell script "cp " & quoted form of srcPath & " " & quoted form of destPath

	-- 6. VERIFY — the file on disk at the destination, not the copy
	set finalSize to my fileSize(destPath)
	if finalSize is 0 then
		return "MISSING\t" & rowIndex & "\t" & songName & "\t" & destPath
	end if
	return "OK\t" & rowIndex & "\t" & songName & "\t" & destPath & "\t" & finalSize
end run

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

-- The song table (1702 rows), found by ROW COUNT rather than by index.
on songTable()
	tell application "System Events"
		tell process "iReal Pro"
			repeat with a from 1 to 6
				try
					set w to window 1
					set sg to UI element 1 of w
					repeat with si from 1 to 2
						try
							set t to UI element 1 of scroll area si of sg
							if (count of rows of t) > 100 then return t
						end try
					end repeat
				end try
				delay 0.8
			end repeat
			-- pass 2: walk the split group's children
			try
				set w to window 1
				set sg to UI element 1 of w
				repeat with i from 1 to (count of UI elements of sg)
					set e to UI element i of sg
					try
						if (role of e) is "AXScrollArea" then
							repeat with j from 1 to (count of UI elements of e)
								set e2 to UI element j of e
								try
									if (role of e2) is "AXTable" then
										set t to e2
										if (count of rows of t) > 100 then return t
									end if
								end try
							end repeat
						end if
					end try
				end repeat
			end try
			error "song table not found"
		end tell
	end tell
end songTable

-- A song's title. The row's cell holds 8 static texts; #2 is the title.
on songTitle(tbl, ri)
	tell application "System Events"
		try
			return value of static text 2 of UI element 1 of row ri of tbl
		end try
		try
			return value of static text 1 of UI element 1 of row ri of tbl
		end try
		return ""
	end tell
end songTitle

-- The File menu's item index for a name, or 0.
on fileMenuIndex(itemName)
	tell application "System Events"
		tell process "iReal Pro"
			repeat with a from 1 to 6
				try
					set fm to menu "File" of menu bar 1
					repeat with i from 1 to (count of menu items of fm)
						try
							if (name of menu item i of fm) is itemName then return i
						end try
					end repeat
				end try
				delay 0.7
			end repeat
			return 0
		end tell
	end tell
end fileMenuIndex

-- Invoke a File-menu item BY NAME.
--
-- The item is AXPressed while the menu is OPEN. Pressing a closed
-- menu's item is what silently did nothing (measured 2026-11-02).
on invokeFileMenu(itemName)
	tell application "System Events"
		tell process "iReal Pro"
			set frontmost to true
			delay 0.4
			set idx to my fileMenuIndex(itemName)
			if idx is 0 then return 0
			try
				click menu "File" of menu bar 1
			on error
				delay 1
				click menu "File" of menu bar 1
			end try
			delay 1.2
			try
				perform action "AXPress" of menu item itemName of menu "File" of menu bar 1
			on error
				return 0
			end try
			delay 2
			return idx
		end tell
	end tell
end invokeFileMenu

-- A file's size in bytes, or 0.
on fileSize(p)
	try
		return (do shell script "stat -f%z " & quoted form of p) as integer
	on error
		return 0
	end try
end fileSize

-- The folder part of a path.
on dirOf(p)
	set i to 0
	repeat with k from 1 to (length of p)
		if (character k of p) is "/" then set i to k
	end repeat
	if i is 0 then return "/"
	return text 1 thru i of p
end dirOf

-- Wait until the render has produced a file whose size has STOPPED
-- growing. The render is asynchronous, so a file that exists is not
-- necessarily a finished file.
on waitForRender(p)
	set lastSize to 0
	set stableRounds to 0
	repeat with a from 1 to 120
		set sz to my fileSize(p)
		if sz > 0 and sz = lastSize then
			set stableRounds to stableRounds + 1
			if stableRounds >= 3 then return true
		else
			set stableRounds to 0
		end if
		set lastSize to sz
		delay 1
	end repeat
	return false
end waitForRender
