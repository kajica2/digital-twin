-- stickies.applescript — twin OS status sticky
-- Reads a JSON blob from the environment-friendly input pipe and
-- creates or updates a Stickies note titled "twin OS".

on run argv
    set statusLine to item 1 of argv
    set portLine to item 2 of argv
    set msg to "twin OS online
" & statusLine & " · http://localhost:" & portLine & "/pages/twin-os/"

    tell application "Stickies"
        activate
        try
            repeat with s in stickies
                if name of s contains "twin OS" then
                    set body of s to msg
                    return "updated"
                end if
            end repeat
        end try
        try
            set newSticky to make new sticky at end of stickies
            set body of newSticky to msg
            return "created"
        on error errMsg
            return "error: " & errMsg
        end try
    end tell
end run