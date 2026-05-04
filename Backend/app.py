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
import shutil
import zipfile
import tempfile
from pathlib import Path
from datetime import datetime
from flask import Flask, render_template, request, jsonify, Response, send_from_directory, send_file


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

# ── Paths ─────────────────────────────────────────────────────
if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).resolve().parent
    SCRIPT_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent
    SCRIPT_DIR = BASE_DIR
INPUT_FOLDER = BASE_DIR / "input"
PDF_PAGE_FOLDER = BASE_DIR / "pdf_page"
OUTPUT_FOLDER = BASE_DIR / "Output"

FINALCODE_SCRIPT = SCRIPT_DIR / "finalcode.py"
CONVERT_SCRIPT = SCRIPT_DIR / "convert_to_image.py"

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
            process_state["total_images"] = max(process_state["total_images"], total)
            process_state["progress"] = min(100, int((current / total) * 100))
    
    # Match total images scan: "Total: 1,234  |  Pending: 500"
    total_match = re.search(r'Total:\s*([\d,]+)', line)
    if total_match:
        process_state["total_images"] = int(total_match.group(1).replace(',', ''))

    pending_match = re.search(r'Pending:\s*([\d,]+)', line)
    if pending_match:
        pending = int(pending_match.group(1).replace(',', ''))
        if pending == 0 and process_state["total_images"] > 0:
            process_state["progress"] = 100
    
    # Match blank page count
    blank_match = re.search(r'Blank.*?:\s*([\d,]+)', line, re.IGNORECASE)
    if blank_match:
        process_state["blank_pages"] = int(blank_match.group(1).replace(',', ''))
    
    # Match failed count
    fail_match = re.search(r'Failed.*?:\s*([\d,]+)', line, re.IGNORECASE)
    if fail_match:
        process_state["failed_images"] = int(fail_match.group(1).replace(',', ''))

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


@app.route("/api/config")
def api_config():
    """Return the current config from finalcode.py."""
    config = {}
    try:
        config = _parse_script_config(FINALCODE_SCRIPT, [
            "INPUT_FOLDER", "TEMP_FIXED_FOLDER", "BLANK_PAGES_FOLDER",
            "OUTPUT_PDF", "CHECKPOINT_FILE",
        ])

        # Extra non-path values
        with open(FINALCODE_SCRIPT, "r", encoding="utf-8") as f:
            content = f.read()
        for key, pattern in {
            "NUM_WORKERS": r'NUM_WORKERS\s*=.*?(\d+)',
            "BATCH_SIZE": r'BATCH_SIZE\s*=\s*(\d+)',
            "OCR_LANG": r'OCR_LANG\s*=\s*"([^"]+)"',
        }.items():
            m = re.search(pattern, content)
            if m:
                config[key] = m.group(1)

        # Also parse convert_to_image.py config
        conv_cfg = _parse_script_config(CONVERT_SCRIPT, ["INPUT_FOLDER", "OUTPUT_FOLDER"])
        config["CONVERT_INPUT"] = conv_cfg.get("INPUT_FOLDER", "")
        config["CONVERT_OUTPUT"] = conv_cfg.get("OUTPUT_FOLDER", "")

    except Exception as e:
        config["error"] = str(e)

    return jsonify(config)


def _parse_script_config(script_path, keys):
    """
    Parse path config values from a Python script.
    Handles both formats:
      - r"C:\\some\\path"            (raw string)
      - BASE_DIR / "sub" / "folder"  (Path expression)
    Returns resolved absolute path strings.
    """
    result = {}
    with open(script_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Resolve BASE_DIR the same way the scripts do
    script_base_dir = Path(script_path).resolve().parent

    for key in keys:
        # Try format 1: raw/quoted string  e.g. INPUT_FOLDER = r"C:\..."
        m = re.search(rf'{key}\s*=\s*r?"([^"]+)"', content)
        if m:
            result[key] = m.group(1)
            continue

        # Try format 2: Path expression  e.g. INPUT_FOLDER = BASE_DIR / "sub" / "name"
        m = re.search(rf'{key}\s*=\s*(.+)', content)
        if m:
            expr = m.group(1).strip().rstrip("#").strip()
            # Remove trailing comments like  # NEW
            expr = re.sub(r'\s*#.*$', '', expr)
            try:
                resolved = _resolve_path_expr(expr, script_base_dir)
                if resolved:
                    result[key] = str(resolved)
                    continue
            except Exception:
                pass

    return result


def _resolve_path_expr(expr, base_dir):
    """
    Resolve a Path expression like: BASE_DIR / "Output" / "folder"
    Returns a resolved Path or None.
    """
    if "BASE_DIR" not in expr:
        return None

    # Split by /  and extract quoted parts
    parts = re.findall(r'"([^"]+)"', expr)
    result = base_dir
    for part in parts:
        result = result / part
    return result


@app.route("/api/update-config", methods=["POST"])
def api_update_config():
    """Update config values in finalcode.py."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    try:
        with open(FINALCODE_SCRIPT, "r", encoding="utf-8") as f:
            lines = f.readlines()

        script_base_dir = Path(FINALCODE_SCRIPT).resolve().parent

        config_keys = {
            "INPUT_FOLDER", "TEMP_FIXED_FOLDER", "BLANK_PAGES_FOLDER",
            "OUTPUT_PDF", "CHECKPOINT_FILE",
        }

        new_lines = []
        for line in lines:
            replaced = False
            for key in config_keys:
                value = data.get(key)
                if not value:
                    continue
                # Check if this line defines this key
                if re.match(rf'^{key}\s*=', line):
                    # Preserve trailing comment
                    comment = ""
                    cm = re.search(r'(\s*#.*)$', line.rstrip('\r\n'))
                    if cm:
                        comment = cm.group(1)

                    # Try to write as BASE_DIR / ... if it's under base_dir
                    new_path = Path(value)
                    try:
                        rel = new_path.relative_to(script_base_dir)
                        parts = rel.parts
                        expr = "BASE_DIR"
                        for p in parts:
                            expr += f' / "{p}"'
                        new_line = f'{key} = {expr}{comment}\n'
                    except ValueError:
                        # Not relative to BASE_DIR, use raw string
                        escaped = str(value).replace('\\', '\\\\')
                        new_line = f'{key} = r"{value}"{comment}\n'

                    new_lines.append(new_line)
                    replaced = True
                    break

            if not replaced:
                new_lines.append(line)

        with open(FINALCODE_SCRIPT, "w", encoding="utf-8") as f:
            f.writelines(new_lines)

        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/update-convert-config", methods=["POST"])
def api_update_convert_config():
    """Update config values in convert_to_image.py."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    try:
        with open(CONVERT_SCRIPT, "r", encoding="utf-8") as f:
            lines = f.readlines()

        script_base_dir = Path(CONVERT_SCRIPT).resolve().parent

        key_map = {
            "CONVERT_INPUT": "INPUT_FOLDER",
            "CONVERT_OUTPUT": "OUTPUT_FOLDER",
        }

        new_lines = []
        for line in lines:
            replaced = False
            for data_key, file_key in key_map.items():
                value = data.get(data_key)
                if not value:
                    continue
                if re.match(rf'^{file_key}\s*=', line):
                    comment = ""
                    cm = re.search(r'(\s*#.*)$', line.rstrip('\r\n'))
                    if cm:
                        comment = cm.group(1)

                    new_path = Path(value)
                    try:
                        rel = new_path.relative_to(script_base_dir)
                        parts = rel.parts
                        expr = "BASE_DIR"
                        for p in parts:
                            expr += f' / "{p}"'
                        new_line = f'{file_key} = {expr}{comment}\n'
                    except ValueError:
                        new_line = f'{file_key} = r"{value}"{comment}\n'

                    new_lines.append(new_line)
                    replaced = True
                    break

            if not replaced:
                new_lines.append(line)

        with open(CONVERT_SCRIPT, "w", encoding="utf-8") as f:
            f.writelines(new_lines)

        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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
        # Force UTF-8 in child process to handle emoji in print() statements
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"

        proc = subprocess.Popen(
            [python_exe, "--worker", script_type] if getattr(sys, "frozen", False) else [python_exe, str(script)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(BASE_DIR),
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
        process_state["process"] = proc

        thread = threading.Thread(target=stream_output, args=(proc, script_type), daemon=True)
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
                page_count = sum(1 for f in folder.rglob("*") if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"})
                stats["converted_pages"] += page_count
                stats["converted_folders"].append({
                    "name": folder.name,
                    "pages": page_count
                })

        # Count output images
        if OUTPUT_FOLDER.exists():
            for item in OUTPUT_FOLDER.iterdir():
                if item.is_dir() and not item.name.endswith("_blank_pages"):
                    stats["output_images"] += sum(1 for f in item.rglob("*") if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
                elif item.is_dir() and item.name.endswith("_blank_pages"):
                    stats["blank_pages"] += sum(1 for f in item.rglob("*") if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
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


@app.route("/api/open-folder", methods=["POST"])
def api_open_folder():
    """Open a folder in Windows Explorer."""
    data = request.json or {}
    folder = data.get("folder", "")
    if not folder or not Path(folder).exists():
        return jsonify({"error": "Folder not found"}), 404
    try:
        os.startfile(str(folder))
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── File Upload ───────────────────────────────────────────────
@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Receive PDF files and save them to the input folder."""
    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files selected"}), 400

    INPUT_FOLDER.mkdir(parents=True, exist_ok=True)

    saved = 0
    for f in files:
        if f.filename and f.filename.lower().endswith(".pdf"):
            safe_name = Path(f.filename).name
            f.save(str(INPUT_FOLDER / safe_name))
            saved += 1

    if saved == 0:
        return jsonify({"error": "No valid PDF files found"}), 400

    return jsonify({"success": True, "count": saved})


# ── Download Results ──────────────────────────────────────────
@app.route("/api/download-results")
def api_download_results():
    """Zip and serve the Output folder."""
    if not OUTPUT_FOLDER.exists():
        return jsonify({"error": "Output folder not found"}), 404

    # Check if there are any files
    output_files = list(OUTPUT_FOLDER.rglob("*"))
    if not any(f.is_file() for f in output_files):
        return jsonify({"error": "No output files to download"}), 404

    # Create zip in a temp location inside the project
    zip_dir = BASE_DIR / "_temp_downloads"
    zip_dir.mkdir(parents=True, exist_ok=True)
    zip_path = zip_dir / "OCR_Results.zip"

    # Remove old zip if exists
    if zip_path.exists():
        zip_path.unlink()

    try:
        with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in output_files:
                if file_path.is_file():
                    arcname = file_path.relative_to(OUTPUT_FOLDER)
                    zf.write(str(file_path), str(arcname))

        return send_file(
            str(zip_path),
            mimetype='application/zip',
            as_attachment=True,
            download_name='OCR_Results.zip'
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Static files ──────────────────────────────────────────────
@app.route("/style.css")
def serve_css():
    return send_from_directory("static", "style.css")


@app.route("/app.js")
def serve_js():
    return send_from_directory("static", "app.js")


# ── Run ───────────────────────────────────────────────────────
if __name__ == "__main__":
    import runpy
    if "--worker" in sys.argv:
        worker_type = sys.argv[sys.argv.index("--worker") + 1]
        worker_script = CONVERT_SCRIPT if worker_type == "convert" else FINALCODE_SCRIPT
        runpy.run_path(str(worker_script), run_name="__main__")
        sys.exit(0)
    print("\n  [*] OCR Dashboard running at http://localhost:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)