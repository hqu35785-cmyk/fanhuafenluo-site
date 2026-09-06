Option Explicit

Dim shell
Dim fileSystem
Dim scriptDirectory
Dim launcherPath
Dim nodePath
Dim command
Dim index
Dim exitCode
Dim logPath

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fileSystem.BuildPath(scriptDirectory, "launcher.mjs")

If Not fileSystem.FileExists(launcherPath) Then
  WScript.Quit 2
End If

nodePath = ResolveNode(shell, fileSystem)
command = QuoteArgument(nodePath) & " " & QuoteArgument(launcherPath)

For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArgument(CStr(WScript.Arguments(index)))
Next

On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  On Error GoTo 0
  logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\FanHuaSitePublisher\launcher.log")
  MsgBox FromCodePoints(Array(&H65B0, &H7AD9, &H5FEB, &H6377, &H53D1, &H5E03, &H5361, &H7247, &H672A, &H80FD, &H542F, &H52A8, &H3002)) & vbCrLf & _
    FromCodePoints(Array(&H8BCA, &H65AD, &H65E5, &H5FD7, &HFF1A)) & logPath, _
    vbOKOnly + vbExclamation, _
    FromCodePoints(Array(&H65B0, &H7AD9, &H5FEB, &H6377, &H53D1, &H5E03, &H5361, &H7247))
  WScript.Quit 3
End If
On Error GoTo 0

If exitCode <> 0 Then
  logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\FanHuaSitePublisher\launcher.log")
  MsgBox FromCodePoints(Array(&H65B0, &H7AD9, &H5FEB, &H6377, &H53D1, &H5E03, &H5361, &H7247, &H672A, &H80FD, &H542F, &H52A8, &H3002)) & vbCrLf & _
    FromCodePoints(Array(&H8BCA, &H65AD, &H65E5, &H5FD7, &HFF1A)) & logPath, _
    vbOKOnly + vbExclamation, _
    FromCodePoints(Array(&H65B0, &H7AD9, &H5FEB, &H6377, &H53D1, &H5E03, &H5361, &H7247))
  WScript.Quit exitCode
End If

Function ResolveNode(ByRef currentShell, ByRef currentFileSystem)
  Dim pathValue
  Dim pathParts
  Dim entry
  Dim candidate
  Dim commonCandidates
  Dim item
  Dim position

  pathValue = currentShell.ExpandEnvironmentStrings("%PATH%")
  pathParts = Split(pathValue, ";")

  For position = 0 To UBound(pathParts)
    entry = Trim(pathParts(position))
    If Len(entry) >= 2 Then
      If Left(entry, 1) = """" And Right(entry, 1) = """" Then
        entry = Mid(entry, 2, Len(entry) - 2)
      End If
    End If
    entry = currentShell.ExpandEnvironmentStrings(entry)
    If Len(entry) > 0 Then
      candidate = currentFileSystem.BuildPath(entry, "node.exe")
      If currentFileSystem.FileExists(candidate) Then
        ResolveNode = candidate
        Exit Function
      End If
    End If
  Next

  commonCandidates = Array( _
    currentShell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    currentShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe") _
  )
  For Each item In commonCandidates
    If currentFileSystem.FileExists(CStr(item)) Then
      ResolveNode = CStr(item)
      Exit Function
    End If
  Next

  ResolveNode = "node.exe"
End Function

Function QuoteArgument(ByVal value)
  Dim quoted
  Dim character
  Dim slashCount
  Dim position

  value = CStr(value)
  quoted = """"
  slashCount = 0

  For position = 1 To Len(value)
    character = Mid(value, position, 1)
    If character = "\" Then
      slashCount = slashCount + 1
    ElseIf character = """" Then
      quoted = quoted & String(slashCount * 2 + 1, "\") & """"
      slashCount = 0
    Else
      If slashCount > 0 Then
        quoted = quoted & String(slashCount, "\")
        slashCount = 0
      End If
      quoted = quoted & character
    End If
  Next

  If slashCount > 0 Then
    quoted = quoted & String(slashCount * 2, "\")
  End If
  QuoteArgument = quoted & """"
End Function

Function FromCodePoints(ByVal values)
  Dim value
  Dim result

  result = ""
  For Each value In values
    result = result & ChrW(CLng(value))
  Next
  FromCodePoints = result
End Function
