@echo off
cd /d C:\Users\DESKTOP\Music\OCR_PROJECT\Backend
    
echo ===============================
echo Building OCR_APP.exe...
echo ===============================

pyinstaller --clean --onefile --name OCR_APP ^
--add-data "templates;templates" ^
--add-data "static;static" ^
--add-data "finalcode.py;." ^
--add-data "convert_to_image.py;." ^
--hidden-import fitz ^
--hidden-import pymupdf ^
--hidden-import tqdm ^
--hidden-import PIL.Image ^
--hidden-import PIL.ImageEnhance ^
--hidden-import PIL.ImageFile ^
--hidden-import PIL.ImageOps ^
--hidden-import cv2 ^
--hidden-import numpy ^
--hidden-import pytesseract ^
--hidden-import pdf2image ^
--hidden-import multiprocessing ^
app.py

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