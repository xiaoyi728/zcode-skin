' ZCode launcher: start beautify backend (hidden) then ZCode with debug port
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set ws = CreateObject("Wscript.Shell")
ws.CurrentDirectory = baseDir

' If ZCode is already running (e.g. after auto-update restart), the debug port
' argument would be ignored (single-instance lock). Ask user to exit first.
Set ps = ws.Exec("powershell -NoProfile -Command ""if (Get-Process ZCode -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }""")
Do While ps.Status = 0
  WScript.Sleep 100
Loop
If ps.ExitCode = 1 Then
  MsgBox "ZCode is already running without the beautify port." & vbCrLf & _
         "Please exit ZCode first (tray icon right-click -> Exit), then start again.", vbExclamation, "ZCode Skin"
  WScript.Quit
End If

ws.Run "cmd /c node bin\zcode-skin serve", 0, False
WScript.Sleep 2000

' Locate ZCode.exe in common install paths
Dim exe
For Each p In Array("D:\Zcode\ZCode.exe", "D:\ZCode\ZCode.exe", "C:\Program Files\ZCode\ZCode.exe", "C:\Program Files (x86)\ZCode\ZCode.exe")
  If fso.FileExists(p) Then exe = p : Exit For
Next
If exe = "" Then exe = "D:\Zcode\ZCode.exe"
ws.Run """" & exe & """ --remote-debugging-port=9335", 1, False
