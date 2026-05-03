"""
================================================================
AUTO IMAGE ROTATION v10.2 — TABLE ROTATION FIX + BLANK PAGE SEPARATION
Works with: Printed + Handwritten | English + Gujarati
Handles: 0 / 90 / 180 / 270 automatically
Recursive: walks all subfolders inside INPUT_FOLDER
FEATURE: Separates blank/black pages into dedicated folder

MODIFICATIONS FROM v10.2:
─────────────────────────────────────────────────────────────────
FEATURE 1 — Blank page detection and separation:
  Black/blank pages (ink_ratio < MIN_INK_RATIO) are now saved to
  a separate BLANK_PAGES_FOLDER instead of the main output.
  
FEATURE 2 — Enhanced page_ink_ratio() tracking:
  detect_rotation() now returns ink_ratio along with angle/margin
  to enable downstream decisions.

FEATURE 3 — New _worker signature:
  _worker now checks ink_ratio and routes pages accordingly.
  Blank pages bypass rotation and go straight to blank folder.

FEATURE 4 — Checkpoint includes blank pages:
  Blank pages are tracked separately in checkpoint to avoid
  reprocessing.

================================================================
"""
import os
import re
import json
import logging
import traceback
from pathlib import Path
from typing import Tuple, Dict, List
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeout, as_completed
import multiprocessing as mp

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFile, ImageOps
from tqdm import tqdm
import pytesseract

ImageFile.LOAD_TRUNCATED_IMAGES = True

# ================================================================
# CONFIG — edit these paths
# ================================================================
# CONFIG — edit these paths
# ================================================================
BASE_DIR = Path(__file__).resolve().parent.parent

# These values are updated by the Dashboard UI or Environment Variables
INPUT_FOLDER = Path(os.getenv("PDF_PAGE_FOLDER", r"Backend/pdf_page"))
TEMP_FIXED_FOLDER = Path(os.getenv("TEMP_FIXED_FOLDER", r"Output/temp_fixed"))
BLANK_PAGES_FOLDER = Path(os.getenv("BLANK_PAGES_FOLDER", r"Output/CO_TEC1234_4567_blank_pages"))
REVIEW_FOLDER = Path(os.getenv("REVIEW_FOLDER", r"Output/CO_TEC1234_4567_review"))
OUTPUT_PDF = Path(os.getenv("OUTPUT_PDF", r"Output/CO_TEC1234_4567_OUTPUT.pdf"))
CHECKPOINT_FILE = Path(os.getenv("CHECKPOINT_FILE", r"Output/CO_TEC1234_4567_checkpoint.json"))

import platform
if platform.system() == "Windows":
    pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
else:
    pytesseract.pytesseract.tesseract_cmd = "/usr/bin/tesseract"

# ================================================================
# SETTINGS
# ================================================================
IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
OCR_LANG = "eng+guj"
ALL_ANGLES = [0, 90, 180, 270]

OSD_CONF_HIGH = 8.0
OSD_CONF_MID = 4.0

MIN_OCR_CONF = 20
OCR_MAX_SIDE = 1200

TITLE_FRAC = 0.20
BOTTOM_FRAC = 0.15

HOUGH_THRESHOLD = 50
HOUGH_MIN_LEN = 40
HOUGH_MAX_GAP = 15

MIN_FINAL_MARGIN = 0.10
MIN_INK_RATIO = 0.012  # Pages with less ink are considered blank
BLACK_PAGE_DARK_RATIO = 0.85
WHITE_PAGE_WHITE_RATIO = 0.970
LOW_CONTRAST_STD = 18.0
REVIEW_MARGIN = 0.20
LOW_TEXT_OCR_MAX = 0.0

OCR_TOP_N_ANGLES = 4
IMAGE_TIMEOUT_SEC = 120
FAST_PATH_SIZE = 800

TABLE_GRID_THRESH = 0.08
LANDSCAPE_RATIO_THRESH = 1.15
TABLE_GRID_LANDSCAPE_THRESH = 0.02

WEIGHTS = {
    "hough":     3.5,
    "proj":      4.0,
    "ocr":       5.5,
    "title":     2.5,
    "tb":        2.2,
    "lr":        1.5,
    "comp":      2.0,
    "grid":      3.2,
    "textline":  3.5,
    "lineaxis":  4.0,
}

NUM_WORKERS = min(max(1, mp.cpu_count() - 1), 32)
BATCH_SIZE = 64
CHECKPOINT_EVERY = 500

# ================================================================
# LOGGING
# ================================================================
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(
        "rotation_errors.log", encoding="utf-8"), logging.StreamHandler()]
)
log = logging.getLogger(__name__)


# ================================================================
# UTILITIES
# ================================================================
def natural_sort_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.stem)]


def rotate_pil(img: Image.Image, angle: int) -> Image.Image:
    return img.rotate(-angle, expand=True) if angle != 0 else img


def resize_keep_ratio(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    m = max(w, h)
    if m <= max_side:
        return img
    s = max_side / m
    return img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)


def preprocess_for_ocr(img: Image.Image) -> Image.Image:
    g = img.convert("L")
    g = ImageEnhance.Contrast(g).enhance(1.8)
    g = ImageEnhance.Sharpness(g).enhance(1.4)
    return g


def binarize(img: Image.Image, max_side: int = 1000) -> np.ndarray:
    img = resize_keep_ratio(img, max_side)
    gray = np.array(img.convert("L"))
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    _, th = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return th


def ink_density(binary: np.ndarray) -> float:
    return float(binary.sum()) / (255.0 * binary.size + 1e-9)


def normalize(scores: Dict[int, float]) -> Dict[int, float]:
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return {k: 1.0 for k in scores}
    return {k: (v - lo) / (hi - lo) for k, v in scores.items()}


# ================================================================
# BLANK PAGE CHECK
# ================================================================
# ================================================================
# BLANK PAGE CHECK  — REVISED THRESHOLDS
# ================================================================

def crop_center_area(img: Image.Image) -> Image.Image:
    """
    Ignore border/top-bottom scanner marks.
    Blank decision mostly center content પરથી થશે.
    """
    w, h = img.size

    left = int(w * 0.08)
    right = int(w * 0.92)
    top = int(h * 0.08)
    bottom = int(h * 0.92)

    return img.crop((left, top, right, bottom))


def page_ink_ratio(img: Image.Image) -> float:
    center = crop_center_area(img)
    return ink_density(binarize(center, 900))


def is_blank_page(img: Image.Image) -> bool:
    """
    Real white/black blank pages only.
    Text/document pages will stay in temp_fixed.
    """
    gray = np.array(img.convert("L"))

    # remove scanner border area
    h, w = gray.shape
    crop = gray[int(h * 0.10):int(h * 0.90), int(w * 0.10):int(w * 0.90)]

    total = crop.size

    white_ratio = np.sum(crop > 245) / total
    dark_ratio = np.sum(crop < 35) / total
    std_dev = float(np.std(crop))

    # light ink detection
    _, th = cv2.threshold(
        crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )
    ink_ratio = np.sum(th > 0) / total

    # connected components: real text/table has many useful components
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(th, 8)

    useful_components = 0
    for i in range(1, num_labels):
        x, y, cw, ch, area = stats[i]

        # ignore dust/small dots
        if area < 20:
            continue

        # ignore very long scanner border lines
        if cw > crop.shape[1] * 0.75 or ch > crop.shape[0] * 0.75:
            continue

        useful_components += 1

    # Black/dark blank page
    if dark_ratio > 0.70 and std_dev < 50:
        return True

    # White blank page with scanner marks only
    if white_ratio > 0.88 and ink_ratio < 0.045 and useful_components < 35:
        return True

    # Almost empty page
    if ink_ratio < 0.020 and useful_components < 20:
        return True

    return False

# ================================================================
# OSD
# ================================================================


def get_osd_fast(img: Image.Image) -> Tuple[int, float]:
    base = resize_keep_ratio(img, 1400)
    attempts = [base, preprocess_for_ocr(base)]
    best_angle, best_conf = 0, 0.0
    for attempt in attempts:
        try:
            osd = pytesseract.image_to_osd(
                attempt, output_type=pytesseract.Output.DICT, config="--psm 0"
            )
            angle = int(osd.get("rotate", 0))
            conf = float(osd.get("orientation_conf", 0.0))
            if angle in ALL_ANGLES and conf > best_conf:
                best_angle, best_conf = angle, conf
        except Exception:
            pass
    return best_angle, best_conf


# ================================================================
# SIGNALS
# ================================================================
def hough_horizontal_score(binary: np.ndarray) -> float:
    edges = cv2.Canny(binary, 50, 150)
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180,
        threshold=HOUGH_THRESHOLD,
        minLineLength=HOUGH_MIN_LEN,
        maxLineGap=HOUGH_MAX_GAP
    )
    if lines is None or len(lines) == 0:
        return 0.0

    pts = lines[:, 0, :]
    dx = (pts[:, 2] - pts[:, 0]).astype(float)
    dy = (pts[:, 3] - pts[:, 1]).astype(float)
    lengths = np.hypot(dx, dy)
    mask = lengths >= 10
    if not mask.any():
        return 0.0

    angles = np.abs(np.degrees(np.arctan2(dy[mask], dx[mask])))
    angles = np.minimum(angles, 180 - angles)
    return float((angles <= 18).sum()) / mask.sum()


def dominant_line_axis_score(binary: np.ndarray) -> float:
    h, w = binary.shape

    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, w // 20), 1))
    horiz = cv2.morphologyEx(binary, cv2.MORPH_OPEN, hk, iterations=1)
    h_ink = float(horiz.sum()) / (255.0 * binary.size + 1e-9)

    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(30, h // 20)))
    vert = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vk, iterations=1)
    v_ink = float(vert.sum()) / (255.0 * binary.size + 1e-9)

    return h_ink / (v_ink + 1e-9)


def table_grid_score(binary: np.ndarray) -> float:
    h, w = binary.shape
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 30), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 30)))
    horiz = cv2.morphologyEx(binary, cv2.MORPH_OPEN, hk, iterations=1)
    vert = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vk, iterations=1)
    hs = float(horiz.sum()) / (255.0 * binary.size + 1e-9)
    vs = float(vert.sum()) / (255.0 * binary.size + 1e-9)
    return hs / (vs + 1e-9)


def raw_grid_density(binary: np.ndarray) -> float:
    h, w = binary.shape
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w // 30), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h // 30)))
    horiz = cv2.morphologyEx(binary, cv2.MORPH_OPEN, hk, iterations=1)
    vert = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vk, iterations=1)
    combined = cv2.bitwise_or(horiz, vert)
    return float(combined.sum()) / (255.0 * binary.size + 1e-9)


def projection_score(binary: np.ndarray) -> float:
    return float(np.var(binary.sum(axis=1))) / (float(np.var(binary.sum(axis=0))) + 1e-9)


def top_bottom_score(binary: np.ndarray) -> float:
    h = binary.shape[0]
    top_h = max(1, int(h * TITLE_FRAC))
    bot_h = max(1, int(h * BOTTOM_FRAC))
    return ink_density(binary[:top_h]) - ink_density(binary[h - bot_h:])


def left_right_score(binary: np.ndarray) -> float:
    w = binary.shape[1]
    return ink_density(binary[:, :max(1, int(w * 0.35))]) - ink_density(binary[:, int(w * 0.65):])


def component_score(binary: np.ndarray) -> float:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    merged = cv2.dilate(binary, kernel, iterations=1)
    contours, _ = cv2.findContours(
        merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_h, img_w = binary.shape
    ratios = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if h == 0 or w * h < 40:
            continue
        if w > img_w * 0.95 or h > img_h * 0.95:
            continue
        ratios.append(w / h)
    return float(np.median(ratios)) if ratios else 0.0


def textline_score(binary: np.ndarray) -> float:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3))
    merged = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    row_profile = merged.sum(axis=1).astype(np.float64) / 255.0
    if row_profile.size < 5:
        return 0.0
    row_profile = cv2.GaussianBlur(
        row_profile.reshape(-1, 1), (1, 9), 0).reshape(-1)
    mean_v = float(np.mean(row_profile)) + 1e-9
    std_v = float(np.std(row_profile))
    thr = mean_v + 0.6 * std_v
    peaks = int(np.sum(
        (row_profile[1:-1] > row_profile[:-2]) &
        (row_profile[1:-1] > row_profile[2:]) &
        (row_profile[1:-1] > thr)
    ))
    return (std_v / mean_v) + peaks * 0.08


# ================================================================
# OCR SCORING
# ================================================================
def ocr_word_score(img: Image.Image, angle: int, psm_modes: List[int] = None) -> float:
    if psm_modes is None:
        psm_modes = [6]

    rotated = rotate_pil(resize_keep_ratio(img, OCR_MAX_SIDE), angle)
    attempts = [rotated, preprocess_for_ocr(rotated)]
    best = 0.0

    for attempt in attempts:
        for psm in psm_modes:
            try:
                data = pytesseract.image_to_data(
                    attempt,
                    lang=OCR_LANG,
                    output_type=pytesseract.Output.DICT,
                    config=f"--psm {psm}"
                )
                score = 0.0
                for i, txt in enumerate(data["text"]):
                    txt = txt.strip()
                    try:
                        conf = float(data["conf"][i])
                    except Exception:
                        continue
                    if conf < MIN_OCR_CONF or len(txt) < 2:
                        continue
                    score += 1.0
                    if conf >= 85:
                        score += 4.0
                    elif conf >= 70:
                        score += 3.0
                    elif conf >= 55:
                        score += 2.0
                    elif conf >= 35:
                        score += 1.0
                    if re.search(r"[A-Za-zઅ-હ]", txt):
                        score += 0.5
                best = max(best, score)
            except Exception:
                pass

    if best < 8.0 and psm_modes == [6]:
        return ocr_word_score(img, angle, psm_modes=[3])

    return best


def title_ocr_score(img: Image.Image, angle: int) -> float:
    rotated = rotate_pil(resize_keep_ratio(img, OCR_MAX_SIDE), angle)
    w, h = rotated.size
    top = rotated.crop((0, 0, w, max(1, int(h * TITLE_FRAC))))
    return ocr_word_score(top, 0, psm_modes=[6])


# ================================================================
# PAGE TYPE CLASSIFIER
# ================================================================
def classify_page_type(
    raw_scores: Dict[str, Dict[int, float]],
    raw_grid_densities: Dict[int, float],
    img_aspect: float
) -> str:
    max_ocr = max(raw_scores["ocr"].values())
    max_grid = max(raw_scores["grid"].values())
    max_textline = max(raw_scores["textline"].values())
    max_raw_grid = max(raw_grid_densities.values())

    if max_raw_grid >= TABLE_GRID_THRESH:
        return "table"
    if max_ocr >= 12:
        return "document"
    if max_grid >= 1.25 or max_textline >= 1.6:
        return "table"
    return "low_text"


# ================================================================
# LANDSCAPE TABLE FAST PATH
# ================================================================
def _is_landscape_table(img: Image.Image, binary_0: np.ndarray) -> Tuple[bool, int]:
    w, h = img.size
    if w <= h * LANDSCAPE_RATIO_THRESH:
        return False, 0

    gd = raw_grid_density(binary_0)
    if gd < TABLE_GRID_LANDSCAPE_THRESH:
        return False, 0

    s90 = ocr_word_score(img, 90, psm_modes=[6])
    s270 = ocr_word_score(img, 270, psm_modes=[6])

    if abs(s90 - s270) < 3.0:
        t90 = title_ocr_score(img, 90)
        t270 = title_ocr_score(img, 270)
        return True, (90 if t90 >= t270 else 270)

    return True, (90 if s90 >= s270 else 270)


# ================================================================
# PAIR DECISION HELPERS
# ================================================================
def choose_between_0_180(raw_scores):
    a0, a180 = 0.0, 0.0
    rules = {"ocr": 4.0, "title": 3.5, "tb": 2.5,
             "textline": 2.0, "proj": 1.5, "comp": 1.2}
    for k, w in rules.items():
        if raw_scores[k][0] > raw_scores[k][180]:
            a0 += w
        elif raw_scores[k][180] > raw_scores[k][0]:
            a180 += w
    return (0, a0 - a180) if a0 >= a180 else (180, a180 - a0)


def choose_between_90_270(raw_scores):
    a90, a270 = 0.0, 0.0
    rules = {"ocr": 3.8, "title": 2.8, "lr": 2.4, "grid": 2.8,
             "textline": 2.4, "proj": 1.5, "comp": 1.2}
    for k, w in rules.items():
        if raw_scores[k][90] > raw_scores[k][270]:
            a90 += w
        elif raw_scores[k][270] > raw_scores[k][90]:
            a270 += w
    return (90, a90 - a270) if a90 >= a270 else (270, a270 - a90)


# ================================================================
# MAIN DETECTION ENGINE
# ================================================================
def detect_rotation(img: Image.Image) -> Tuple[int, float, float]:
    """
    Returns: (angle, margin, ink_ratio)
    """
    ink_ratio = page_ink_ratio(img)

    if ink_ratio < MIN_INK_RATIO:
        return 0, 1.0, ink_ratio

    osd_angle, osd_conf = get_osd_fast(img)
    if osd_conf >= OSD_CONF_HIGH:
        return osd_angle, 1.0, ink_ratio

    binary_0 = binarize(img, 900)

    binaries: Dict[int, np.ndarray] = {0: binary_0}
    for angle in (90, 180, 270):
        binaries[angle] = binarize(rotate_pil(img, angle), 900)

    raw_grid_densities: Dict[int, float] = {
        a: raw_grid_density(binaries[a]) for a in ALL_ANGLES}

    raw_scores: Dict[str, Dict[int, float]] = {k: {} for k in WEIGHTS}
    for angle in ALL_ANGLES:
        b = binaries[angle]
        raw_scores["hough"][angle] = hough_horizontal_score(b)
        raw_scores["proj"][angle] = projection_score(b)
        raw_scores["tb"][angle] = top_bottom_score(b)
        raw_scores["lr"][angle] = left_right_score(b)
        raw_scores["comp"][angle] = component_score(b)
        raw_scores["grid"][angle] = table_grid_score(b)
        raw_scores["textline"][angle] = textline_score(b)
        raw_scores["lineaxis"][angle] = dominant_line_axis_score(b)

    cheap_rank = sorted(
        ALL_ANGLES,
        key=lambda a: (
            raw_scores["hough"][a] * 2 +
            raw_scores["textline"][a] * 2 +
            raw_scores["proj"][a]
        ),
        reverse=True
    )
    ocr_angles = set(cheap_rank[:OCR_TOP_N_ANGLES])
    if osd_conf >= OSD_CONF_MID:
        ocr_angles.add(osd_angle)

    for angle in ALL_ANGLES:
        if angle in ocr_angles:
            raw_scores["ocr"][angle] = ocr_word_score(img, angle)
            raw_scores["title"][angle] = title_ocr_score(img, angle)
        else:
            raw_scores["ocr"][angle] = raw_scores["textline"][angle] * 2.5
            raw_scores["title"][angle] = raw_scores["tb"][angle] * 1.5

    portrait_bonus: Dict[int, float] = {}
    for angle in ALL_ANGLES:
        w, h = rotate_pil(img, angle).size
        portrait_bonus[angle] = 0.35 if h >= w else 0.0

    img_w, img_h = img.size
    img_aspect = img_w / max(img_h, 1)

    page_type = classify_page_type(raw_scores, raw_grid_densities, img_aspect)
    norm = {k: normalize(v) for k, v in raw_scores.items()}

    lineaxis_is_inverted = (
        img_aspect > LANDSCAPE_RATIO_THRESH and page_type == "table")

    combined: Dict[int, float] = {}
    for angle in ALL_ANGLES:
        score = 0.0
        for sig, w in WEIGHTS.items():
            if sig == "lineaxis" and lineaxis_is_inverted:
                score += (1.0 - norm["lineaxis"][angle]) * w
            else:
                score += norm[sig][angle] * w

        score += portrait_bonus[angle]

        if osd_conf >= 2.0 and angle == osd_angle:
            score += min(osd_conf / 8.0, 1.0)

        if page_type == "document":
            score += norm["ocr"][angle] * 1.5 + norm["title"][angle] * 1.0

        elif page_type == "table":
            score += norm["grid"][angle] * 2.0
            score += norm["textline"][angle] * 1.5
            score += portrait_bonus[angle]

        else:
            if max(raw_grid_densities.values()) < TABLE_GRID_LANDSCAPE_THRESH:
                if angle in (90, 270):
                    score -= 0.8
                if angle == 180:
                    score -= 0.4

        combined[angle] = score

    ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)
    best_angle = ranked[0][0]
    best_score = ranked[0][1]
    second_score = ranked[1][1]
    margin = best_score - second_score

    if margin < MIN_FINAL_MARGIN and osd_conf >= OSD_CONF_MID:
        return osd_angle, margin, ink_ratio

    upright_best, upright_margin = choose_between_0_180(raw_scores)
    side_best, side_margin = choose_between_90_270(raw_scores)

    upright_strength = (
        max(raw_scores["ocr"][0], raw_scores["ocr"][180]) * 0.03 +
        max(raw_scores["title"][0], raw_scores["title"][180]) * 0.03 +
        max(raw_scores["textline"][0], raw_scores["textline"][180]) +
        max(raw_scores["proj"][0], raw_scores["proj"][180]) +
        portrait_bonus[0] + portrait_bonus[180]
    )
    sideways_strength = (
        max(raw_scores["ocr"][90], raw_scores["ocr"][270]) * 0.03 +
        max(raw_scores["grid"][90], raw_scores["grid"][270]) +
        max(raw_scores["textline"][90], raw_scores["textline"][270]) +
        max(raw_scores["proj"][90], raw_scores["proj"][270]) +
        portrait_bonus[90] + portrait_bonus[270]
    )

    if page_type == "document":
        pair_best = upright_best if upright_strength >= sideways_strength else side_best
        pair_margin = upright_margin if upright_strength >= sideways_strength else side_margin
    elif page_type == "table":
        use_side = max(raw_scores["grid"][90], raw_scores["grid"][270]) > max(
            raw_scores["grid"][0], raw_scores["grid"][180])
        pair_best = side_best if use_side else upright_best
        pair_margin = side_margin if use_side else upright_margin
    else:
        pair_best, pair_margin = best_angle, margin

    if page_type == "low_text" and max(raw_grid_densities.values()) < TABLE_GRID_LANDSCAPE_THRESH:
        if pair_best in (90, 270) and pair_margin < 2.5 and osd_conf < OSD_CONF_MID:
            return 0, margin, ink_ratio
        if pair_best == 180 and raw_scores["title"][180] <= raw_scores["title"][0]:
            return 0, margin, ink_ratio

    if pair_best == 180:
        strong_180 = (
            raw_scores["title"][180] > raw_scores["title"][0] or
            raw_scores["tb"][180] > raw_scores["tb"][0] or
            raw_scores["ocr"][180] > raw_scores["ocr"][0] + 3
        )
        if strong_180:
            return 180, max(margin, 0.12), ink_ratio

    if page_type == "table" and pair_best in (90, 270):
        if raw_scores["grid"][pair_best] > max(raw_scores["grid"][0], raw_scores["grid"][180]):
            return pair_best, max(margin, 0.12), ink_ratio

    if page_type == "table" and pair_best in (90, 270):
        if raw_scores["grid"][pair_best] > max(raw_scores["grid"][0], raw_scores["grid"][180]):
            return pair_best, max(margin, 0.12), ink_ratio

   # Strong table/form pages: OCR-readable direction wins
    if page_type == "table":
        table_candidates = {}

        for a in ALL_ANGLES:
            table_candidates[a] = (
                raw_scores["ocr"][a] * 4.0 +
                raw_scores["title"][a] * 2.0 +
                raw_scores["textline"][a] * 2.5 +
                raw_scores["grid"][a] * 1.5 +
                raw_scores["proj"][a] * 1.0
            )

        ranked_table = sorted(table_candidates.items(),
                              key=lambda x: x[1], reverse=True)
        table_best, table_score = ranked_table[0]
        table_second = ranked_table[1][1]

        if table_score - table_second >= 1.5:
            return table_best, max(margin, 0.25), ink_ratio

    if margin >= MIN_FINAL_MARGIN:
        return best_angle, margin, ink_ratio

    return pair_best, max(margin, pair_margin * 0.05), ink_ratio


# ================================================================
# FAST PATH
# ================================================================
def _fast_path(
    img: Image.Image,
    binary_0: np.ndarray,
    osd_angle: int,
    osd_conf: float
) -> Tuple[int, float]:
    binaries = {0: binary_0}
    for angle in (90, 180, 270):
        binaries[angle] = binarize(rotate_pil(img, angle), FAST_PATH_SIZE)

    scores = {}
    for angle in ALL_ANGLES:
        b = binaries[angle]
        score = (
            projection_score(b) * 2.0 +
            hough_horizontal_score(b) * 2.5 +
            textline_score(b) * 2.0
        )
        w, h = rotate_pil(img, angle).size
        if h >= w:
            score += 0.3
        if osd_conf >= 2.0 and angle == osd_angle:
            score += min(osd_conf / 4.0, 1.0)
        scores[angle] = score

    best_angle = max(scores, key=scores.get)
    if best_angle == 180:
        return 0, 0.05
    return best_angle, 0.1


# ================================================================
# SAVE HELPER
# ================================================================
def save_image_safely(img: Image.Image, save_path: Path) -> bool:
    try:
        save_path.parent.mkdir(parents=True, exist_ok=True)
        ext = save_path.suffix.lower()

        if ext in {".jpg", ".jpeg"}:
            img.save(str(save_path), quality=95, optimize=True)
        elif ext == ".png":
            img.save(str(save_path), optimize=True)
        else:
            img.save(str(save_path))

        if not save_path.exists():
            log.error(f"Save verification failed for {save_path}")
            return False

        if save_path.stat().st_size == 0:
            log.error(f"Saved file is empty: {save_path}")
            return False

        return True
    except Exception as e:
        log.error(f"Failed to save {save_path}: {e}")
        return False


# ================================================================
# WORKER — MODIFIED FOR BLANK PAGE SEPARATION
# ================================================================
def _worker(args):
    img_path_str, save_path_str, blank_path_str, review_root_str, input_root_str = args
    img_path = Path(img_path_str)
    save_path = Path(save_path_str)
    blank_path = Path(blank_path_str)
    review_root = Path(review_root_str)
    input_root = Path(input_root_str)

    try:
        with Image.open(img_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode != "RGB":
                img = img.convert("RGB")

            # Check for blank BEFORE rotation detection
            if is_blank_page(img):
                save_ok = save_image_safely(img, blank_path)
                if save_ok:
                    return img_path_str, True, 0, 1.0, True
                return img_path_str, False, 0, 1.0, True

            # Process rotation for non-blank pages
            angle, margin, ink_ratio = detect_rotation(img)

            fixed_img = img if angle == 0 else img.rotate(-angle, expand=True)
            save_ok = save_image_safely(fixed_img, save_path)

            if not save_ok:
                return img_path_str, False, angle, margin, False

            # Check if needs review
            if margin < REVIEW_MARGIN:
                rel = img_path.relative_to(input_root)
                review_path = review_root / rel
                save_image_safely(fixed_img, review_path)

            return img_path_str, True, angle, margin, False

    except Exception as e:
        log.error(f"FAIL {img_path.name}: {e}\n{traceback.format_exc()}")
        return img_path_str, False, 0, 0.0, False


# ================================================================
# CHECKPOINT
# ================================================================
def load_checkpoint(path: str) -> Tuple[set, set]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return set(data.get("done", [])), set(data.get("blank", []))
    except Exception:
        return set(), set()


def save_checkpoint(path, done: set, blank: set) -> None:
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "done": sorted(done),
            "blank": sorted(blank)
        }, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def get_expected_output_path(img_path: Path, input_root: Path, output_root: Path) -> Path:
    return output_root / img_path.relative_to(input_root)


def collect_existing_output_images(output_root: Path) -> List[Path]:
    if not output_root.exists():
        return []
    files = []
    for root, _, filenames in os.walk(output_root):
        for f in filenames:
            p = Path(root) / f
            if p.suffix.lower() in IMG_EXTS and p.exists() and p.is_file():
                try:
                    if p.stat().st_size > 0:
                        files.append(p)
                except Exception:
                    pass
    return sorted(files, key=natural_sort_key)


def validate_checkpoint_entries(image_files: List[Path], input_root: Path, output_root: Path, done_set: set) -> set:
    valid_done = set()
    for img_path in image_files:
        if str(img_path) not in done_set:
            continue
        out_path = get_expected_output_path(img_path, input_root, output_root)
        if out_path.exists() and out_path.is_file():
            try:
                if out_path.stat().st_size > 0:
                    valid_done.add(str(img_path))
            except Exception:
                pass
    return valid_done


def validate_blank_checkpoint_entries(image_files: List[Path], input_root: Path, blank_root: Path, blank_set: set) -> set:
    valid_blank = set()
    for img_path in image_files:
        if str(img_path) not in blank_set:
            continue
        blank_path = get_expected_output_path(img_path, input_root, blank_root)
        if blank_path.exists() and blank_path.is_file():
            try:
                if blank_path.stat().st_size > 0:
                    valid_blank.add(str(img_path))
            except Exception:
                pass
    return valid_blank


# ================================================================
# MAIN
# ================================================================


def main():
    input_dir = Path(INPUT_FOLDER)
    fixed_dir = Path(TEMP_FIXED_FOLDER)
    blank_dir = Path(BLANK_PAGES_FOLDER)  # NEW
    review_dir = Path(REVIEW_FOLDER)
    pdf_dir = Path(OUTPUT_PDF).parent

    # Create all output directories
    fixed_dir.mkdir(parents=True, exist_ok=True)
    blank_dir.mkdir(parents=True, exist_ok=True)  # NEW
    review_dir.mkdir(parents=True, exist_ok=True)
    pdf_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.exists():
        print(f"[ERROR] Input folder not found: {input_dir}")
        return

    print("[SCAN] Scanning for images...")
    image_files: List[Path] = sorted(
        (
            Path(root) / f
            for root, _, files in os.walk(input_dir)
            for f in files
            if Path(f).suffix.lower() in IMG_EXTS
        ),
        key=natural_sort_key
    )

    if not image_files:
        print("[ERROR] No images found")
        return

    raw_done_set, raw_blank_set = load_checkpoint(CHECKPOINT_FILE)
    done_set = validate_checkpoint_entries(
        image_files, input_dir, fixed_dir, raw_done_set)
    blank_set = validate_blank_checkpoint_entries(
        image_files, input_dir, blank_dir, raw_blank_set)

    stale_count = len(raw_done_set) - len(done_set)
    stale_blank = len(raw_blank_set) - len(blank_set)
    if stale_count > 0 or stale_blank > 0:
        print(
            f"[WARN] Found {stale_count} stale checkpoint entries (output) and {stale_blank} blank entries.")
        save_checkpoint(CHECKPOINT_FILE, done_set, blank_set)

    pending = []
    for p in image_files:
        if str(p) in done_set or str(p) in blank_set:
            continue
        pending.append(p)

    existing_output_files = collect_existing_output_images(fixed_dir)
    existing_blank_files = collect_existing_output_images(blank_dir)

    print("\n" + "═" * 80)
    print("AUTO IMAGE ROTATION v10.2+ — WITH ENHANCED BLANK PAGE DETECTION")
    print("═" * 80)
    print(f"\n📁 PATHS:")
    print(f"  1️⃣  INPUT      : {INPUT_FOLDER}")
    print(f"  2️⃣  OUTPUT     : {TEMP_FIXED_FOLDER}")
    print(f"  3️⃣  BLANK      : {BLANK_PAGES_FOLDER}")
    print(f"  4️⃣  REVIEW     : {REVIEW_FOLDER}")
    print(f"  5️⃣  PDF        : {OUTPUT_PDF}")
    print(f"  6️⃣  CHECKPOINT : {CHECKPOINT_FILE}")
    print(f"\n📊 STATISTICS:")
    print(
        f"  Total: {len(image_files):,}  |  Pending: {len(pending):,}  |  Valid: {len(existing_output_files):,}  |  Blank: {len(existing_blank_files):,}")
    print(f"  Workers: {NUM_WORKERS}  |  Batch Size: {BATCH_SIZE}")
    print("═" * 80 + "\n")

    try:
        print(f"[OK] Tesseract: {pytesseract.get_tesseract_version()}\n")
    except Exception as e:
        print(f"[ERROR] Tesseract error: {e}")
        return

    def make_args(p: Path):
        return (
            str(p),
            str(get_expected_output_path(p, input_dir, fixed_dir)),
            str(get_expected_output_path(p, input_dir, blank_dir)),  # NEW
            str(review_dir),
            str(input_dir)
        )

    success = len(existing_output_files)
    blank_count = len(existing_blank_files)
    fail = 0
    review_count = 0
    stats = {0: 0, 90: 0, 180: 0, 270: 0}
    processed_since_ckpt = 0

    if pending:
        with ProcessPoolExecutor(max_workers=NUM_WORKERS) as executor:
            for batch_start in range(0, len(pending), BATCH_SIZE):
                batch = pending[batch_start: batch_start + BATCH_SIZE]
                futures = {executor.submit(
                    _worker, make_args(p)): p for p in batch}

                with tqdm(as_completed(futures), total=len(batch),
                          desc=f"  Batch {batch_start // BATCH_SIZE + 1}", unit="img") as pbar:
                    for future in pbar:
                        img_path_str = str(futures[future])
                        try:
                            _, ok, angle, margin, is_blank = future.result(
                                timeout=IMAGE_TIMEOUT_SEC)
                        except FuturesTimeout:
                            log.error(f"TIMEOUT: {img_path_str}")
                            ok, angle, margin, is_blank = False, 0, 0.0, False
                        except Exception as e:
                            log.error(f"EXCEPTION: {img_path_str}: {e}")
                            ok, angle, margin, is_blank = False, 0, 0.0, False

                        if ok:
                            if is_blank:
                                blank_count += 1
                                blank_set.add(img_path_str)
                            else:
                                success += 1
                                stats[angle] += 1
                                if margin < REVIEW_MARGIN:
                                    review_count += 1
                                done_set.add(img_path_str)
                        else:
                            fail += 1

                        processed_since_ckpt += 1
                        if processed_since_ckpt >= CHECKPOINT_EVERY:
                            save_checkpoint(CHECKPOINT_FILE,
                                            done_set, blank_set)
                            processed_since_ckpt = 0

    save_checkpoint(CHECKPOINT_FILE, done_set, blank_set)

    print("\n" + "═" * 80)
    print("📋 SUMMARY")
    print("═" * 80)
    print(f"Total images : {len(image_files):,}")
    print(f"✅ Processed    : {success:,}    → {TEMP_FIXED_FOLDER}")
    print(f"⬛ Blank pages  : {blank_count:,}    → {BLANK_PAGES_FOLDER}")
    print(f"❌ Failed       : {fail:,}")
    print(f"🔍 Review pages : {review_count:,}   → {REVIEW_FOLDER}")
    print(f"\n📐 Rotation Stats:")
    print(f"   0°   : {stats[0]:,}")
    print(f"   90°  : {stats[90]:,}")
    print(f"   180° : {stats[180]:,}")
    print(f"   270° : {stats[270]:,}")
    print("═" * 80)

    # Show folder locations
    print(f"\n📂 OUTPUT FOLDERS CREATED:")
    print(f"   ✓ Fixed Images  : {TEMP_FIXED_FOLDER}")
    print(f"   ✓ Blank Pages   : {BLANK_PAGES_FOLDER}")
    print(f"   ✓ Review Folder : {REVIEW_FOLDER}")
    print(f"   ✓ Checkpoint    : {CHECKPOINT_FILE}")

    print("\n✅ [DONE] Image processing complete!")
    print("📄 PDF creation skipped.")


if __name__ == "__main__": main()
