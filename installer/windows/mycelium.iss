; Inno Setup script for Mycelium-for-Speckle (Windows).
; Compiled by scripts/build-windows.ps1 on a windows-latest CI runner.
; Produces a self-contained, per-user (no-admin) installer that embeds its own
; Node runtime and puts `mycelium-for-speckle` on the user's PATH.
;
; Required defines (passed by iscc /D...):
;   MyAppVersion   e.g. 0.1.0
;   SourceDir      staged payload dir (app files + node.exe + .cmd launchers)
;   OutputDir      where to write the setup .exe
;   OutputBase     base name of the setup .exe (no extension)

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

[Setup]
AppId={{B6E3C9A2-4F1D-4E7A-9C2B-7F0A1D2E3B4C}
AppName=Mycelium for Speckle
AppVersion={#MyAppVersion}
AppPublisher=Mycelium
AppPublisherURL=https://github.com/thomhoffer-arch/Mycelium-for-Speckle
DefaultDirName={autopf}\Mycelium-for-Speckle
DefaultGroupName=Mycelium for Speckle
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
UninstallDisplayName=Mycelium for Speckle

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Uninstall Mycelium for Speckle"; Filename: "{uninstallexe}"

[Registry]
; Add {app} to the user's PATH so `mycelium-for-speckle` works in any terminal.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Check: NeedsAddPath('{app}')

[Run]
Filename: "{cmd}"; Parameters: "/C ""{app}\node.exe"" ""{app}\connector.mjs"" --version"; \
  Flags: runhidden; StatusMsg: "Verifying installation..."

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  // Avoid duplicating the entry on re-install.
  Result := Pos(';' + Uppercase(ExpandConstant(Param)) + ';',
                ';' + Uppercase(OrigPath) + ';') = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath, AppDir, NewPath: string;
  P: Integer;
begin
  if CurUninstallStep <> usUninstall then exit;
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then exit;
  AppDir := ExpandConstant('{app}');
  NewPath := ';' + OrigPath + ';';
  P := Pos(';' + Uppercase(AppDir) + ';', Uppercase(NewPath));
  if P > 0 then
  begin
    Delete(NewPath, P, Length(AppDir) + 1);
    NewPath := Copy(NewPath, 2, Length(NewPath) - 2);
    RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath);
  end;
end;
