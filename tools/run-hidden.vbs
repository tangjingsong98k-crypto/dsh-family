' dsh-family-kit: run a command line with no console window.
' Usage: wscript.exe run-hidden.vbs "C:\...\agent.cmd"
Dim shell, command
If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If
command = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd.exe /c """ & command & """", 0, False
