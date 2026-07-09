# Film Archive — create a Windows shortcut ("Film Archive.lnk") that launches
# the app through the safe updater and shows the app icon.
#
# Run automatically by setup.cmd. Nothing here is hardcoded: every path is
# derived from this script's own location, so it works from any folder on any
# machine. The generated .lnk contains machine-specific absolute paths, so it
# is git-ignored and never published.
$ErrorActionPreference = 'Stop'

$root    = $PSScriptRoot
$pythonw = Join-Path $root '.venv\Scripts\pythonw.exe'
$icon    = Join-Path $root 'img\Icon.ico'
$link    = Join-Path $root 'Film Archive.lnk'

if (-not (Test-Path $pythonw)) {
    Write-Host "  (shortcut skipped: .venv not found - run setup.cmd first)"
    exit 0
}

try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    # Target an .exe (pythonw) so Windows will let you pin it to the taskbar;
    # it runs the updater quietly, which then opens the app window.
    $sc.TargetPath       = $pythonw
    $sc.Arguments        = 'update_and_launch.py'
    $sc.WorkingDirectory = $root
    if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
    $sc.Description      = 'Film Archive'
    $sc.Save()
    Write-Host "  created 'Film Archive.lnk' - drag it onto your taskbar to pin it."
} catch {
    Write-Host "  (could not create the shortcut: $($_.Exception.Message))"
}
exit 0
