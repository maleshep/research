Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ForEach-Object {
    [PSCustomObject]@{
        Id = $_.ProcessId
        Path = $_.ExecutablePath
        CmdLine = $_.CommandLine
    }
} | Select-Object Id, Path, @{N='CmdShort';E={$_.CmdLine.Substring(0, [Math]::Min(200, $_.CmdLine.Length))}} | Format-Table -AutoSize -Wrap
