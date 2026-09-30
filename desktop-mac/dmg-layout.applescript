on run argv
    set mountPath to item 1 of argv
    set diskFolder to (POSIX file mountPath) as alias
    set backgroundFile to (POSIX file (mountPath & "/.background/install.png")) as alias
    tell application "Finder"
        open diskFolder
        set diskWindow to container window of diskFolder
        set current view of diskWindow to icon view
        set toolbar visible of diskWindow to false
        set statusbar visible of diskWindow to false
        set bounds of diskWindow to {100, 100, 860, 580}
        set viewOptions to icon view options of diskWindow
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 104
        set text size of viewOptions to 13
        set background picture of viewOptions to backgroundFile
        set position of item "Agent Bridge.app" of diskFolder to {190, 235}
        set position of item "Applications" of diskFolder to {570, 235}
        close diskWindow
    end tell
    delay 2
end run
