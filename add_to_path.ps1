# Adds the Film Archive folder to the *user* PATH (never the system PATH),
# so `film_archive` can be run from any new terminal.
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { $current = '' }

$parts = $current -split ';' | Where-Object { $_ -ne '' }
if ($parts -contains $appDir) {
    Write-Host "  already on PATH."
    exit 0
}

$new = if ($current.Trim() -eq '') { $appDir } else { $current.TrimEnd(';') + ';' + $appDir }
[Environment]::SetEnvironmentVariable('Path', $new, 'User')
Write-Host "  added to user PATH: $appDir"
exit 0
