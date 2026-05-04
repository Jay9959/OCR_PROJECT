@echo off
cd /d C:\Users\DESKTOP\Music\OCR_PROJECT\Backend
    
echo ===============================
echo Building OCR_APP.exe...
echo ===============================

pyinstaller --clean --onefile --name OCR_APP --add-data "templates;templates" --add-data "static;static" app.py

echo ===============================
echo Creating OCR_APP_Setup.exe...
echo ===============================

"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "C:\Users\DESKTOP\Music\OCR_PROJECT\Backend\installer.iss"

echo ===============================
echo DONE
echo Setup created here:
echo C:\Users\DESKTOP\Music\OCR_PROJECT\Backend\installer\OCR_APP_Setup.exe
echo ===============================

pause