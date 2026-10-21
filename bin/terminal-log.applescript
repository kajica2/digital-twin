-- terminal-log.applescript — open a Terminal window that tails the
-- twin OS server log. Used by boot.sh so the user has a visible
-- indicator that the server is running.

on run argv
    set logPath to item 1 of argv
    tell application "Terminal"
        activate
        do script "clear; echo '── twin OS server log ──'; tail -F " & quoted form of logPath & " 2>/dev/null; echo '(log ended)'"
        set custom title of front window to "twin OS — server log"
    end tell
end run