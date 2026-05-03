"""
═══════════════════════════════════════════════════════════════
OCR Dashboard — Flask Backend
Wraps finalcode.py & convert_to_image.py with a web UI
═══════════════════════════════════════════════════════════════
"""
import os
import sys
import json
import time
import signal
import threading
import subprocess
import re
import logging
from pathlib import Path
from datetime import datetime
import shutil
import tempfile
from flask import Flask, render_template, request, jsonify, Response, send_from_directory
from flask_cors import CORS


# ── Suppress noisy polling logs ───────────────────────
class QuietPollFilter(logging.Filter):
    """Filter out repetitive polling endpoint logs from terminal."""
    QUIET_ENDPOINTS = {"/api/status", "/api/output-stats"}

    def filter(self, record):
        msg = record.getMessage()
        for ep in self.QUIET_ENDPOINTS:
            if ep in msg:
                return False
        return True


logging.getLogger("werkzeug").addFilter(QuietPollFilter())

app = Flask(__name__,
            static_folder="static",
            template_folder="templates")

CORS(app, origins=["https://your-vercel-app.vercel.app"])

# ── Paths ─────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = BASE_DIR / "Backend"

# Use /tmp/uploads on Render (Linux), otherwise use local paths
if os.name == 'posix':
    TMP_ROOT = Path("/tmp/ocr_engine")
    INPUT_FOLDER = TMP_ROOT / "input"
    PDF_PAGE_FOLDER = TMP_ROOT / "pdf_page"
    OUTPUT_FOLDER = TMP_ROOT / "Output"
else:
    INPUT_FOLDER = BASE_DIR / "Backend" / "input"
    PDF_PAGE_FOLDER = BASE_DIR / "Backend" / "pdf_page"
    OUTPUT_FOLDER = BASE_DIR / "Output"

# Ensure directories exist
for p in [INPUT_FOLDER, PDF_PAGE_FOLDER, OUTPUT_FOLDER]:
    p.mkdir(parents=True, exist_ok=True)

FINALCODE_SCRIPT = BACKEND_DIR / "finalcode.py"
CONVERT_SCRIPT = BACKEND_DIR / "convert_to_image.py"

# ── Process State ─────────────────────────────────────────────
process_state = {
    "status": "idle",           # idle | running | stopping | finished | error
    "current_script": None,     # "convert" | "rotate"
    "process": None,
    "start_time": None,
    "end_time": None,
    "log_lines": [],
    "progress": 0,
    "total_images": 0,
    "processed_images": 0,
    "blank_pages": 0,
    "failed_images": 0,
    "review_pages": 0,
    "rotation_stats": {"0": 0, "90": 0, "180": 0, "270": 0},
    "error_message": None,
}

log_lock = threading.Lock()
MAX_LOG_LINES = 5000


def reset_state():
    process_state.update({
        "status": "idle",
        "current_script": None,
        "process": None,
        "start_time": None,
        "end_time": None,
        "log_lines": [],
        "progress": 0,
        "total_images": 0,
        "processed_images": 0,
        "blank_pages": 0,
        "failed_images": 0,
        "review_pages": 0,
        "rotation_stats": {"0": 0, "90": 0, "180": 0, "270": 0},
        "error_message": None,
    })


# ── Log parsing ───────────────────────────────────────────────
def parse_progress_line(line):
    """Parse tqdm and summary output lines to extract progress."""
    # Match tqdm progress: "  Batch 1:  45%|████      | 9/20 [00:30<00:37,  3.37s/img]"
    tqdm_match = re.search(r'(\d+)/(\d+)\s*\[', line)
    if tqdm_match:
        current = int(tqdm_match.group(1))
        total = int(tqdm_match.group(2))
        process_state["processed_images"] = current
        if total > 0:
            process_state["total_images"] = max(
                process_state["total_images"], total)
            process_state["progress"] = min(100, int((current / total) * 100))

    # Match total images scan: "Total: 1,234  |  Pending: 500"
    total_match = re.search(r'Total:\s*([\d,]+)', line)
    if total_match:
        process_state["total_images"] = int(
            total_match.group(1).replace(',', ''))

    pending_match = re.search(r'Pending:\s*([\d,]+)', line)
    if pending_match:
        pending = int(pending_match.group(1).replace(',', ''))
        if pending == 0 and process_state["total_images"] > 0:
            process_state["progress"] = 100

    # Match blank page count
    blank_match = re.search(r'Blank.*?:\s*([\d,]+)', line, re.IGNORECASE)
    if blank_match:
        process_state["blank_pages"] = int(
            blank_match.group(1).replace(',', ''))

    # Match failed count
    fail_match = re.search(r'Failed.*?:\s*([\d,]+)', line, re.IGNORECASE)
    if fail_match:
        process_state["failed_images"] = int(
            fail_match.group(1).replace(',', ''))

    # Match rotation stats
    for angle in ["0", "90", "180", "270"]:
        rot_match = re.search(rf'{angle}.*?:\s*([\d,]+)', line)
        if rot_match and "Rotation" not in line:
            pass

    # Match PDF conversion progress
    pdf_match = re.search(r'Converting.*?(\d+)%', line)
    if pdf_match:
        process_state["progress"] = int(pdf_match.group(1))

    # Match "Total pages: X"
    pages_match = re.search(r'Total pages:\s*(\d+)', line)
    if pages_match:
        process_state["total_images"] = int(pages_match.group(1))


def stream_output(proc, script_type):
    """Read process output line-by-line and update state."""
    try:
        for raw_line in iter(proc.stdout.readline, ''):
            if not raw_line:
                break
            line = raw_line.rstrip('\r\n')
            if not line.strip():
                continue

            with log_lock:
                process_state["log_lines"].append({
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "text": line,
                    "type": classify_line(line)
                })
                if len(process_state["log_lines"]) > MAX_LOG_LINES:
                    process_state["log_lines"] = process_state["log_lines"][-MAX_LOG_LINES:]

            parse_progress_line(line)

        proc.wait()

        if proc.returncode == 0:
            process_state["status"] = "finished"
            process_state["progress"] = 100
        elif process_state["status"] == "stopping":
            process_state["status"] = "idle"
        else:
            process_state["status"] = "error"
            process_state["error_message"] = f"Process exited with code {proc.returncode}"
    except Exception as e:
        process_state["status"] = "error"
        process_state["error_message"] = str(e)
    finally:
        process_state["end_time"] = time.time()
        process_state["process"] = None


def classify_line(line):
    """Classify log line for styling."""
    lower = line.lower()
    if any(w in lower for w in ['error', 'fail', '❌']):
        return 'error'
    if any(w in lower for w in ['warn', '⚠']):
        return 'warning'
    if any(w in lower for w in ['✅', 'done', 'complete', 'saved', 'success']):
        return 'success'
    if any(w in lower for w in ['scan', 'processing', '📄', '📁', '📊']):
        return 'info'
    if '%|' in line or 'batch' in lower:
        return 'progress'
    return 'default'


# ── Routes ────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    elapsed = 0
    if process_state["start_time"]:
        end = process_state["end_time"] or time.time()
        elapsed = end - process_state["start_time"]

    return jsonify({
        "status": process_state["status"],
        "current_script": process_state["current_script"],
        "progress": process_state["progress"],
        "total_images": process_state["total_images"],
        "processed_images": process_state["processed_images"],
        "blank_pages": process_state["blank_pages"],
        "failed_images": process_state["failed_images"],
        "review_pages": process_state["review_pages"],
        "rotation_stats": process_state["rotation_stats"],
        "elapsed": round(elapsed, 1),
        "error_message": process_state["error_message"],
    })





@app.route("/api/start", methods=["POST"])
def api_start():
    """Start a processing script."""
    if process_state["status"] == "running":
        return jsonify({"error": "A process is already running"}), 409

    data = request.json or {}
    script_type = data.get("script", "rotate")  # "convert" or "rotate"

    reset_state()
    process_state["status"] = "running"
    process_state["current_script"] = script_type
    process_state["start_time"] = time.time()

    script = CONVERT_SCRIPT if script_type == "convert" else FINALCODE_SCRIPT

    # Find Python executable
    python_exe = sys.executable

    try:
        # Force UTF-8 and pass dynamic paths
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        
        # Inject paths for the scripts to use
        env["INPUT_FOLDER"] = str(INPUT_FOLDER)
        env["PDF_PAGE_FOLDER"] = str(PDF_PAGE_FOLDER)
        env["OUTPUT_FOLDER"] = str(OUTPUT_FOLDER)
        env["TEMP_FIXED_FOLDER"] = str(OUTPUT_FOLDER / "temp_fixed")
        env["BLANK_PAGES_FOLDER"] = str(OUTPUT_FOLDER / "blank_pages")
        env["REVIEW_FOLDER"] = str(OUTPUT_FOLDER / "review")
        env["OUTPUT_PDF"] = str(OUTPUT_FOLDER / "Final_Result.pdf")
        env["CHECKPOINT_FILE"] = str(OUTPUT_FOLDER / "checkpoint.json")

        proc = subprocess.Popen(
            [python_exe, str(script)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(BACKEND_DIR),
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        process_state["process"] = proc

        thread = threading.Thread(
            target=stream_output, args=(proc, script_type), daemon=True)
        thread.start()

        return jsonify({"success": True, "pid": proc.pid})
    except Exception as e:
        process_state["status"] = "error"
        process_state["error_message"] = str(e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/stop", methods=["POST"])
def api_stop():
    """Stop the running process."""
    proc = process_state.get("process")
    if not proc:
        return jsonify({"error": "No process running"}), 400

    process_state["status"] = "stopping"
    try:
        if os.name == 'nt':
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            proc.terminate()

        # Give it a few seconds to cleanup
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

        process_state["status"] = "idle"
        process_state["end_time"] = time.time()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stream")
def api_stream():
    """Server-Sent Events stream for real-time log updates."""
    def generate():
        last_idx = 0
        while True:
            with log_lock:
                current_len = len(process_state["log_lines"])
                if current_len > last_idx:
                    new_lines = process_state["log_lines"][last_idx:current_len]
                    last_idx = current_len
                    for entry in new_lines:
                        data = json.dumps(entry, ensure_ascii=False)
                        yield f"data: {data}\n\n"

            status = process_state["status"]
            if status in ("finished", "error", "idle") and last_idx >= len(process_state["log_lines"]):
                yield f"data: {json.dumps({'type': 'end', 'status': status})}\n\n"
                break

            time.sleep(0.3)

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/output-stats")
def api_output_stats():
    """Return statistics about existing output files."""
    stats = {
        "input_pdfs": 0,
        "input_pdf_list": [],
        "converted_pages": 0,
        "converted_folders": [],
        "output_images": 0,
        "blank_pages": 0,
        "output_pdfs": 0,
        "output_pdf_list": [],
    }

    try:
        # Count input PDFs
        if INPUT_FOLDER.exists():
            pdfs = list(INPUT_FOLDER.glob("*.pdf"))
            stats["input_pdfs"] = len(pdfs)
            stats["input_pdf_list"] = [p.name for p in pdfs]

        # Count converted pages
        if PDF_PAGE_FOLDER.exists():
            folders = [d for d in PDF_PAGE_FOLDER.iterdir() if d.is_dir()]
            for folder in folders:
                page_count = sum(1 for f in folder.rglob(
                    "*") if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"})
                stats["converted_pages"] += page_count
                stats["converted_folders"].append({
                    "name": folder.name,
                    "pages": page_count
                })

        # Count output images
        if OUTPUT_FOLDER.exists():
            for item in OUTPUT_FOLDER.iterdir():
                if item.is_dir() and not item.name.endswith("_blank_pages"):
                    stats["output_images"] += sum(1 for f in item.rglob(
                        "*") if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
                elif item.is_dir() and item.name.endswith("_blank_pages"):
                    stats["blank_pages"] += sum(1 for f in item.rglob(
                        "*") if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
                elif item.suffix.lower() == ".pdf":
                    stats["output_pdfs"] += 1
                    stats["output_pdf_list"].append({
                        "name": item.name,
                        "size_mb": round(item.stat().st_size / (1024 * 1024), 2)
                    })
    except Exception as e:
        stats["error"] = str(e)

    return jsonify(stats)


@app.route("/api/logs")
def api_logs():
    """Return all current log lines."""
    with log_lock:
        return jsonify(process_state["log_lines"])


@app.route("/api/clear-logs", methods=["POST"])
def api_clear_logs():
    """Clear log buffer."""
    with log_lock:
        process_state["log_lines"] = []
    return jsonify({"success": True})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Handle file uploads (PDFs or Images)."""
    if "files" not in request.files:
        return jsonify({"error": "No files part"}), 400

    files = request.files.getlist("files")
    if not files or files[0].filename == "":
        return jsonify({"error": "No selected files"}), 400

    # Clear input folder before new upload to avoid mixing sessions
    if INPUT_FOLDER.exists():
        shutil.rmtree(INPUT_FOLDER)
    INPUT_FOLDER.mkdir(parents=True, exist_ok=True)

    uploaded_count = 0
    for file in files:
        if file:
            filename = file.filename
            # Handle directory structure if sent via webkitdirectory
            # filename might be "folder/file.jpg"
            target_path = INPUT_FOLDER / filename
            target_path.parent.mkdir(parents=True, exist_ok=True)
            file.save(str(target_path))
            uploaded_count += 1

    return jsonify({"success": True, "count": uploaded_count})


@app.route("/api/download-result")
def api_download_result():
    """Zip the output folder and serve it for download."""
    if not OUTPUT_FOLDER.exists():
        return jsonify({"error": "Output folder does not exist"}), 404

    # Create a temporary zip file
    temp_dir = Path(tempfile.gettempdir())
    zip_path = temp_dir / "OCR_Result"
    
    # Remove existing zip if any
    zip_file = zip_path.with_suffix(".zip")
    if zip_file.exists():
        zip_file.unlink()

    # Zip the output folder
    shutil.make_archive(str(zip_path), 'zip', str(OUTPUT_FOLDER))

    return send_from_directory(temp_dir, "OCR_Result.zip", as_attachment=True)


# ── Static files ──────────────────────────────────────────────
@app.route("/style.css")
def serve_css():
    return send_from_directory("static", "style.css")


@app.route("/app.js")
def serve_js():
    return send_from_directory("static", "app.js")


# ── Run ───────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)