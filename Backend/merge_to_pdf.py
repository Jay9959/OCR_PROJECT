"""
================================================================
IMAGE TO PDF MERGER v1.0
Combines all processed images into a single PDF file.
================================================================
"""
import os
import sys
from pathlib import Path
from PIL import Image
from tqdm import tqdm

def main():
    if getattr(sys, "frozen", False):
        BASE_DIR = Path(sys.executable).resolve().parent
    else:
        BASE_DIR = Path(__file__).resolve().parent

    # Use the same output folders as finalcode.py
    TEMP_FIXED_FOLDER = BASE_DIR / "Output" / "temp_fixed"
    OUTPUT_PDF = BASE_DIR / "Output" / "Final_Output.pdf"

    if not TEMP_FIXED_FOLDER.exists():
        print(f"[ERROR] Folder not found: {TEMP_FIXED_FOLDER}")
        return

    # Get all images from temp_fixed folder
    img_exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
    
    # We want to maintain order, so we sort by name
    image_files = sorted([
        f for f in TEMP_FIXED_FOLDER.rglob("*") 
        if f.suffix.lower() in img_exts
    ])

    if not image_files:
        print("[WARNING] No images found in Output/temp_fixed to merge.")
        return

    print(f"[START] Merging {len(image_files)} images into {OUTPUT_PDF}...")
    
    images = []
    first_image = None
    
    # tqdm will be caught by app.py to show progress
    for i, img_path in enumerate(tqdm(image_files, desc="Merging PDF")):
        try:
            # Open image and convert to RGB (required for PDF)
            img = Image.open(img_path).convert("RGB")
            if i == 0:
                first_image = img
            else:
                images.append(img)
        except Exception as e:
            print(f"[ERROR] Failed to load {img_path}: {e}")

    if first_image:
        try:
            first_image.save(OUTPUT_PDF, save_all=True, append_images=images)
            print(f"[OK] [DONE] PDF created successfully at {OUTPUT_PDF}")
        except Exception as e:
            print(f"[ERROR] Failed to save PDF: {e}")
    else:
        print("[ERROR] No images could be loaded for PDF creation.")

if __name__ == "__main__":
    main()
