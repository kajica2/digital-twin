-- notes.applescript — twin OS status note (Apple Notes)
-- Args:
--   argv 1: folder name (created if missing)
--   argv 2: ISO-ish timestamp
--   argv 3: HTTP port
--
-- Notes scripting rules learned the hard way:
--   * notes must live under account → folder, NOT at app level
--   * `body` is HTML — literal `&` and stray `<>` confuse the parser
--   * safer to create the note with empty body, then set body separately
--
-- Strategy: create a fresh note per boot in a "twin OS" folder. Notes
-- scroll up for history. The first line of the body acts as the
-- in-app title display.

on run argv
    set folderName to item 1 of argv
    set stamp to item 2 of argv
    set portNum to item 3 of argv

    tell application "Notes"
        activate

        -- Resolve the default account (handles 1-account or N-account setups).
        if (count of accounts) is 1 then
            set theAccount to account 1
        else
            set theAccount to default account
        end if

        -- Find or create the folder under that account.
        try
            set theFolder to folder folderName of theAccount
        on error
            set theFolder to make new folder at theAccount ¬
                with properties {name:folderName}
        end try

        -- Build the body as a clean, single string. No special chars.
        -- We deliberately avoid `&` and `:`-as-key in the body because
        -- they confuse AppleScript's body parser.
        set bodyText to "twin OS boot

when   " & stamp & "
url    http://localhost:" & portNum & "/pages/twin-os/
status online

log    ~/digital-twin/logs/boot-*.log
launchd  gui/" & (do shell script "id -u") & "/com.kaidjuric.digital-twin.boot

(Notes keeps one note per boot — scroll up for history.)"

        -- Create the note with a placeholder body, then set body
        -- separately. This avoids the `properties` parser eating our
        -- content.
        set newNote to make new note at theFolder with properties ¬
            {name:"twin OS boot", body:"…"}
        set body of newNote to bodyText
        return "created note id=" & (id of newNote as text)
    end tell
end run