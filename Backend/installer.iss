[Setup]
AppName=OCR Application
AppVersion=1.0
DefaultDirName={pf}\OCR Application
DefaultGroupName=OCR Application
OutputDir=C:\Users\DESKTOP\Music\OCR_PROJECT\Backend\installer
OutputBaseFilename=OCR_APP_Setup
Compression=lzma
SolidCompression=yes

[Dirs]
Name: "{app}\input"
Name: "{app}\pdf_page"
Name: "{app}\Output"
Name: "{app}\Output\temp_fixed"
Name: "{app}\Output\blank_pages"
Name: "{app}\Output\review"

[Files]
Source: "C:\Users\DESKTOP\Music\OCR_PROJECT\Backend\dist\OCR_APP.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\OCR Application"; Filename: "{app}\OCR_APP.exe"
Name: "{commondesktop}\OCR Application"; Filename: "{app}\OCR_APP.exe"

[Run]
Filename: "{app}\OCR_APP.exe"; Description: "Launch OCR Application"; Flags: nowait postinstall skipifsilent