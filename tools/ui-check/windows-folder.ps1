param(
    [Parameter(Mandatory)][ValidateSet('choose','observe')][string]$Mode,
    [Parameter(Mandatory)][string]$Folder,
    [int]$OwnerPid,
    [string]$Sentinel
)
$ErrorActionPreference = 'Stop'
$until = [DateTime]::UtcNow.AddSeconds(30)
if ($Mode -eq 'choose') {
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FolderDialogControls {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, string text);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    $element = [System.Windows.Automation.AutomationElement]
    $children = [System.Windows.Automation.TreeScope]::Children
    $process = [System.Windows.Automation.PropertyCondition]::new($element::ProcessIdProperty,$OwnerPid)
    $class = [System.Windows.Automation.PropertyCondition]::new($element::ClassNameProperty,'#32770')
    $filter = [System.Windows.Automation.AndCondition]::new($process,$class)
    $editId = [System.Windows.Automation.PropertyCondition]::new($element::AutomationIdProperty,'1152')
    $okId = [System.Windows.Automation.PropertyCondition]::new($element::AutomationIdProperty,'1')
    $descendants = [System.Windows.Automation.TreeScope]::Descendants
    while ([DateTime]::UtcNow -lt $until) {
        $dialog = $element::RootElement.FindFirst($children,$filter)
        if ($null -ne $dialog -and $dialog.Current.Name -eq 'Choose a folder') {
            $edit = [IntPtr]::new([int]$dialog.FindFirst($descendants,$editId).Current.NativeWindowHandle)
            $ok = [IntPtr]::new([int]$dialog.FindFirst($descendants,$okId).Current.NativeWindowHandle)
            if ($edit -ne [IntPtr]::Zero -and $ok -ne [IntPtr]::Zero) {
                if ([FolderDialogControls]::SendMessage($edit,0x000C,[IntPtr]::Zero,$Folder) -eq [IntPtr]::Zero) { throw 'Folder field rejected WM_SETTEXT' }
                if (![FolderDialogControls]::PostMessage($ok,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'Folder confirmation failed' }
                return
            }
        }
        Start-Sleep -Milliseconds 120
    }
    throw "Could not locate the path and confirmation controls in the test application's folder picker"
}

# Windows can reuse an existing Explorer window. Only close a window the test opened.
$shell = New-Object -ComObject Shell.Application
$prior = @{}
foreach ($view in $shell.Windows()) { $prior[[long]$view.HWND] = $true }
[Console]::WriteLine('READY')
while ([DateTime]::UtcNow -lt $until) {
    foreach ($view in $shell.Windows()) {
        try {
            if ([IO.Path]::GetFileName([string]$view.FullName) -ine 'explorer.exe') { continue }
            $directory = $view.Document.Folder
            if ($directory.Self.Path -ine $Folder -or $null -eq $directory.ParseName($Sentinel)) { continue }
            if (!$prior.ContainsKey([long]$view.HWND)) {
                $view.Quit()
                [Console]::WriteLine('CLOSED')
            } else { [Console]::WriteLine('REUSED') }
            return
        } catch [System.Runtime.InteropServices.COMException] {
            # A view may still be navigating or have been closed between polls.
        }
    }
    Start-Sleep -Milliseconds 120
}
throw 'Explorer did not display the selected test directory and its marker file'
