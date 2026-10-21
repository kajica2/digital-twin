-- chart-notes.applescript — chart export Apple Notes ping (Apple Notes)
-- Args:
--   argv 1: folder name (created if missing)
--   argv 2: ISO-ish timestamp
--   argv 3: songBase (the .musicxml basename without extension)
--   argv 4: wall time in seconds (one decimal)
--   argv 5: attempt count (1 or 2)
--
-- Strategy: create a fresh note per export in the "twin OS" folder.
-- Notes scroll up for history. The first line of the body acts as
-- the in-app title display.
--
-- Notes scripting rules (mirrors notes.applescript from sprint 0.1):
--   * notes must live under account → folder, NOT at app level
--   * `body` is HTML — literal `&` and stray `<>` confuse the parser
--   * safer to create the note with empty body, then set body separately
--   * avoid `&` and `:`-as-key in the body — replace with `and` and `  `

on run argv
    set folderName to item 1 of argv
    set stamp to item 2 of argv
    set songBase to item 3 of argv
    set secText to item 4 of argv
    set attemptCount to item 5 of argv

    tell application "Notes"
        activate

        if (count of accounts) is 1 then
            set theAccount to account 1
        else
            set theAccount to default account
        end if

        try
            set theFolder to folder folderName of theAccount
        on error
            set theFolder to make new folder at theAccount ¬
                with properties {name:folderName}
        end try

        set bodyText to "chart export

when   " & stamp & "
song   " & songBase & "
time   " & secText & "s
try    " & attemptCount & "

demo    chart-inbox/" & songBase & "_Demo.mp3
full    chart-inbox/" & songBase & "_Full_Score.pdf
parts   chart-inbox/" & songBase & "_PDF/parts/

(Notes keeps one note per chart export — scroll up for history.)"

        set newNote to make new note at theFolder with properties ¬
            {name:"chart export " & songBase, body:"…"}
        set body of newNote to bodyText
        return "created note id=" & (id of newNote as text)
    end tell
end run