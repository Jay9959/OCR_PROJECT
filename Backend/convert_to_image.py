import os
from pathlib import Path
import fitz  # PyMuPDF
from PIL import Image
import numpy as np
from tqdm import tqdm

# =========================
# CONFIG
# =========================
BASE_DIR = Path(__file__).resolve().parent.parent
INPUT_FOLDER = BASE_DIR / "Backend" / "input"
OUTPUT_FOLDER = BASE_DIR / "Backend" / "pdf_page"

# image quality settings
ZOOM_X = 2.0   # 2.0 = good quality
ZOOM_Y = 2.0
IMAGE_FORMAT = "jpg"   # "png" or "jpg"
JPG_QUALITY = 95

# =========================
# PDF -> PAGE IMAGES
# =========================
def pdf_to_images(pdf_path, output_base_folder):
    pdf_path = Path(pdf_path)
    pdf_name = pdf_path.stem

    pdf_output_folder = Path(output_base_folder) / pdf_name
    pdf_output_folder.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(pdf_path))
    total_pages = len(doc)

    print(f"\n📄 Processing PDF: {pdf_path.name}")
    print(f"Total pages: {total_pages}")

    matrix = fitz.Matrix(ZOOM_X, ZOOM_Y)

    for page_num in tqdm(range(total_pages), desc=f"Converting {pdf_path.name}"):
        page = doc[page_num]
        pix = page.get_pixmap(matrix=matrix, alpha=False)

        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)

        if pix.n == 4:
            image = Image.fromarray(img, "RGBA").convert("RGB")
        elif pix.n == 3:
            image = Image.fromarray(img, "RGB")
        else:
            image = Image.fromarray(img)

        page_no = page_num + 1

        if IMAGE_FORMAT.lower() == "png":
            out_path = pdf_output_folder / f"page_{page_no:04d}.png"
            image.save(out_path)
        else:
            out_path = pdf_output_folder / f"page_{page_no:04d}.jpg"
            image.save(out_path, quality=JPG_QUALITY)

    doc.close()
    print(f"✅ Saved all page images in: {pdf_output_folder}")

# =========================
# PROCESS ALL PDFS
# =========================
def process_all_pdfs():
    input_folder = Path(INPUT_FOLDER)
    output_folder = Path(OUTPUT_FOLDER)

    # Auto-create input folder if it doesn't exist
    input_folder.mkdir(parents=True, exist_ok=True)

    pdf_files = sorted(input_folder.glob("*.pdf"))

    if len(pdf_files) == 0:
        print("❌ No PDF files found in:", input_folder)
        return

    output_folder.mkdir(parents=True, exist_ok=True)

    print(f"✅ Found {len(pdf_files)} PDF(s)")

    for pdf_file in pdf_files:
        try:
            pdf_to_images(pdf_file, output_folder)
        except Exception as e:
            print(f"❌ Failed on {pdf_file.name}: {e}")

# =========================
# START
# =========================
if __name__ == "__main__":
    process_all_pdfs()