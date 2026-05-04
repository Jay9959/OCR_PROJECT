/* ═══════════════════════════════════════════════════
   OCR Dashboard — Frontend Logic v3.0
   Pipeline: Upload → PDF→Images → Auto Rotate → Download
   ═══════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────
let autoScroll = true;
let eventSource = null;
let statusInterval = null;
let currentConfig = {};
let pipelineStep = 0; // 0=upload, 1=converting, 2=rotating, 3=download
let selectedFiles = [];
let pipelineAutoChain = false; // auto-start step 2 after step 1

// ── Init ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    fetchStatus();
    fetchOutputStats();
    fetchConfig();
    statusInterval = setInterval(() => {
        fetchStatus();
        fetchOutputStats();
    }, 4000);
    initParticles();
    init3DTilt();
    initCustomCursor();
    initUploadZone();
    document.getElementById("btnAutoScroll").classList.add("active");
    
    const welcomeArtContainer = document.getElementById("welcomeArt");
    if (welcomeArtContainer) {
        welcomeArtContainer.textContent = [
            "+------------------------------------------------+",
            "|                                                |",
            "|       OCR ROTATION ENGINE v10.2 PREMIUM        |",
            "|                                                |",
            "|   ==========================================   |",
            "|                                                |",
            "|    UPLOAD  →  CONVERT  →  ROTATE  →  DOWNLOAD  |",
            "|                                                |",
            "|         Drop PDF files to get started          |",
            "|                                                |",
            "+------------------------------------------------+"
        ].join("\n");
    }
    
    // Loader
    const loader = document.getElementById("loader");
    const loaderPercent = document.getElementById("loader-percentage");
    const loaderFill = document.getElementById("loaderFill");
    if(loader && loaderPercent && loaderFill) {
        let p = 0;
        const interval = setInterval(() => {
            p += Math.floor(Math.random() * 8) + 2;
            if(p >= 100) {
                p = 100;
                clearInterval(interval);
                setTimeout(() => { loader.classList.add("hidden"); }, 500);
            }
            loaderPercent.textContent = p + "%";
            loaderFill.style.width = p + "%";
        }, 40);
    }
});

// ── Upload Zone ─────────────────────────────────────
function initUploadZone() {
    const zone = document.getElementById("uploadZone");
    const fileInput = document.getElementById("fileInput");
    const folderInput = document.getElementById("folderInput");
    if (!zone || !fileInput) return;

    zone.addEventListener("click", () => fileInput.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    
    const handleFiles = (filesList) => {
        const files = Array.from(filesList).filter(f => f.name.toLowerCase().endsWith(".pdf"));
        if (files.length) { 
            // Append rather than replace, to allow mix of files and folders
            selectedFiles = [...selectedFiles, ...files]; 
            renderFileList(); 
        } else {
            showToast("No valid PDF files found in selection", "error");
        }
    };

    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        handleFiles(e.dataTransfer.files);
    });
    
    fileInput.addEventListener("change", () => {
        handleFiles(fileInput.files);
        fileInput.value = ""; // Reset to allow re-selecting same file if removed
    });
    
    if (folderInput) {
        folderInput.addEventListener("change", () => {
            handleFiles(folderInput.files);
            folderInput.value = "";
        });
    }
}

function renderFileList() {
    const list = document.getElementById("uploadFileList");
    const btn = document.getElementById("btnUpload");
    if (!selectedFiles.length) { list.innerHTML = ""; btn.disabled = true; return; }
    btn.disabled = false;
    list.innerHTML = selectedFiles.map((f, i) => `
        <div class="upload-file-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="upload-file-name">${escapeHtml(f.name)}</span>
            <span class="upload-file-size">${(f.size / (1024*1024)).toFixed(1)} MB</span>
            <button class="upload-file-remove" onclick="removeFile(${i})">✕</button>
        </div>
    `).join("");
}

function removeFile(idx) {
    selectedFiles.splice(idx, 1);
    renderFileList();
}

async function uploadFiles() {
    if (!selectedFiles.length) return;
    const btn = document.getElementById("btnUpload");
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-spinner"></div><span>Uploading...</span>`;

    const formData = new FormData();
    selectedFiles.forEach(f => formData.append("files", f));

    try {
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (data.error) { showToast(data.error, "error"); btn.disabled = false; btn.innerHTML = `<span>Upload & Start Processing</span>`; return; }
        showToast(`Uploaded ${data.count} file(s) successfully`, "success");
        pipelineAutoChain = true;
        startPipelineStep(1);
    } catch (e) {
        showToast("Upload failed: " + e.message, "error");
        btn.disabled = false;
        btn.innerHTML = `<span>Upload & Start Processing</span>`;
    }
}

// ── Pipeline Steps ──────────────────────────────────
function setPipelineStep(step) {
    pipelineStep = step;
    for (let i = 0; i <= 3; i++) {
        const el = document.getElementById("pipelineStep" + i);
        const dot = document.getElementById("stepDot" + i);
        if (el) el.classList.toggle("active", i === step);
        if (dot) {
            dot.classList.remove("active", "completed");
            if (i < step) dot.classList.add("completed");
            else if (i === step) dot.classList.add("active");
        }
        if (i > 0) {
            const line = document.getElementById("stepLine" + i);
            if (line) line.classList.toggle("completed", i <= step);
        }
    }
}

function startPipelineStep(step) {
    setPipelineStep(step);
    clearTerminal();
    if (step === 1) startProcess("convert");
    else if (step === 2) startProcess("rotate");
}

function resetPipeline() {
    pipelineAutoChain = false;
    selectedFiles = [];
    renderFileList();
    setPipelineStep(0);
    const btn = document.getElementById("btnUpload");
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload & Start Processing</span>`;
    showToast("Pipeline reset — ready for new files", "info");
}

// ── API Calls ───────────────────────────────────────
async function fetchStatus() {
    try {
        const res = await fetch("/api/status");
        const data = await res.json();
        updateStatusUI(data);
    } catch (e) { /* silent */ }
}

async function fetchOutputStats() {
    try {
        const res = await fetch("/api/output-stats");
        const data = await res.json();
        updateStatsUI(data);
    } catch (e) { /* silent */ }
}

async function fetchConfig() {
    try {
        const res = await fetch("/api/config");
        currentConfig = await res.json();
        renderConvertConfig(currentConfig);
        renderRotateConfig(currentConfig);
        renderActionButtons(currentConfig);
    } catch (e) { /* silent */ }
}

// ── Process Control ─────────────────────────────────
async function startProcess(scriptType) {
    try {
        const res = await fetch("/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ script: scriptType })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, "error"); return; }
        showToast(scriptType === "convert" ? "PDF conversion started" : "Auto-rotation started", "success");
        connectSSE();
        fetchStatus();
    } catch (e) {
        showToast("Failed to start: " + e.message, "error");
    }
}

async function stopProcess() {
    try {
        pipelineAutoChain = false;
        const res = await fetch("/api/stop", { method: "POST" });
        const data = await res.json();
        if (data.error) showToast(data.error, "error");
        else showToast("Process stopped", "info");
        fetchStatus();
    } catch (e) {
        showToast("Failed to stop: " + e.message, "error");
    }
}

// ── SSE Stream ──────────────────────────────────────
function connectSSE() {
    if (eventSource) { eventSource.close(); }
    eventSource = new EventSource("/api/stream");
    eventSource.onmessage = (event) => {
        try {
            const entry = JSON.parse(event.data);
            if (entry.type === "end") {
                eventSource.close();
                eventSource = null;
                fetchStatus();
                fetchOutputStats();
                handleStepComplete(entry.status);
                return;
            }
            appendLogLine(entry);
        } catch (e) { /* ignore */ }
    };
    eventSource.onerror = () => {
        if (eventSource) { eventSource.close(); eventSource = null; }
    };
}

function handleStepComplete(status) {
    if (status === "finished") {
        if (pipelineStep === 1 && pipelineAutoChain) {
            // Card 1 done → auto start Card 2
            showToast("PDF conversion complete! Starting Auto Rotate...", "success");
            setTimeout(() => startPipelineStep(2), 1500);
        } else if (pipelineStep === 2) {
            // Card 2 done → show download
            showToast("All processing complete! Results ready for download.", "success");
            setPipelineStep(3);
        }
    } else if (status === "error") {
        showToast("Process encountered an error. Check terminal for details.", "error");
    }
}

// ── UI Updates ──────────────────────────────────────
function updateStatusUI(data) {
    const pill = document.getElementById("statusPill");
    const dot = pill.querySelector(".status-text");
    const timer = document.getElementById("navTimer");
    const btnStop = document.getElementById("btnStop");

    pill.className = "status-pill";
    const statusMap = { idle: "Idle", running: "Running", stopping: "Stopping", finished: "Complete", error: "Error" };
    dot.textContent = statusMap[data.status] || data.status;
    if (data.status === "running") pill.classList.add("running");
    else if (data.status === "error") pill.classList.add("error");
    else if (data.status === "stopping") pill.classList.add("stopping");

    if (data.elapsed > 0) {
        const m = Math.floor(data.elapsed / 60);
        const s = Math.floor(data.elapsed % 60);
        timer.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    }

    const isRunning = data.status === "running" || data.status === "stopping";
    btnStop.disabled = !isRunning;

    // Update active step progress
    if (data.status === "running" || data.status === "finished") {
        const stepNum = pipelineStep;
        const fillId = stepNum === 1 ? "step1Fill" : "step2Fill";
        const percentId = stepNum === 1 ? "step1Percent" : "step2Percent";
        const detailId = stepNum === 1 ? "step1Detail" : "step2Detail";
        const labelId = stepNum === 1 ? "step1Label" : "step2Label";
        const statusId = stepNum === 1 ? "step1Status" : "step2Status";

        const fill = document.getElementById(fillId);
        const pct = document.getElementById(percentId);
        const detail = document.getElementById(detailId);
        const label = document.getElementById(labelId);
        const statusEl = document.getElementById(statusId);

        if (fill) fill.style.width = data.progress + "%";
        if (pct) pct.textContent = data.progress + "%";
        if (label) label.textContent = data.current_script === "convert" ? "Converting PDF pages..." : "Rotating images...";
        if (statusEl) statusEl.textContent = data.status === "finished" ? "✅ Completed!" : (data.current_script === "convert" ? "Running convert_to_image.py..." : "Running finalcode.py...");

        if (detail) {
            let d = "";
            if (data.processed_images > 0) d += `${data.processed_images}`;
            if (data.total_images > 0) d += ` / ${data.total_images} images`;
            if (data.blank_pages > 0) d += ` · ${data.blank_pages} blank`;
            if (data.failed_images > 0) d += ` · ${data.failed_images} failed`;
            detail.textContent = d;
        }
    }
}

function updateStatsUI(data) {
    setText("inputPdfCount", data.input_pdfs || 0);
    setText("convertedPageCount", data.converted_pages || 0);
    setText("outputImageCount", data.output_images || 0);
    setText("blankPageCount", data.blank_pages || 0);
    setText("outputPdfCount", data.output_pdfs || 0);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = typeof val === "number" ? val.toLocaleString() : val;
}

// ── Terminal ────────────────────────────────────────
function appendLogLine(entry) {
    const content = document.getElementById("terminalContent");
    const welcome = content.querySelector(".terminal-welcome");
    if (welcome) welcome.remove();
    const line = document.createElement("div");
    line.className = "log-line " + (entry.type || "default");
    line.innerHTML = `<span class="log-time">${entry.time || ""}</span><span class="log-text">${escapeHtml(entry.text || "")}</span>`;
    content.appendChild(line);
    const badge = document.getElementById("lineCountBadge");
    badge.textContent = content.querySelectorAll(".log-line").length + " lines";
    if (autoScroll) content.scrollTop = content.scrollHeight;
}

function clearTerminal() {
    const content = document.getElementById("terminalContent");
    content.innerHTML = "";
    document.getElementById("lineCountBadge").textContent = "0 lines";
    fetch("/api/clear-logs", { method: "POST" });
}

async function clearLogs() { clearTerminal(); showToast("Logs cleared", "info"); }

function toggleAutoScroll() {
    autoScroll = !autoScroll;
    document.getElementById("btnAutoScroll").classList.toggle("active", autoScroll);
    if (autoScroll) document.getElementById("terminalContent").scrollTop = document.getElementById("terminalContent").scrollHeight;
}

function escapeHtml(text) { const d = document.createElement("div"); d.textContent = text; return d.innerHTML; }

// ── Config Panels ───────────────────────────────────
function togglePanel(panelId) {
    const body = document.getElementById(panelId);
    body.classList.toggle("open");
    const btn = body.parentElement.querySelector(".btn-icon");
    if (btn) btn.style.transform = body.classList.contains("open") ? "rotate(180deg)" : "";
}

function renderConvertConfig(cfg) {
    const grid = document.getElementById("convertConfigGrid");
    const fields = [
        { key: "CONVERT_INPUT", label: "PDF Input Folder" },
        { key: "CONVERT_OUTPUT", label: "Images Output Folder" },
    ];
    grid.innerHTML = fields.map(f => `
        <div class="config-item">
            <label>${f.label}</label>
            <input type="text" id="cfg_${f.key}" value="${escapeHtml(cfg[f.key] || "")}" />
        </div>
    `).join("");
}

function renderRotateConfig(cfg) {
    const grid = document.getElementById("rotateConfigGrid");
    const fields = [
        { key: "INPUT_FOLDER", label: "Input Images Folder" },
        { key: "TEMP_FIXED_FOLDER", label: "Output Folder" },
        { key: "BLANK_PAGES_FOLDER", label: "Blank Pages Folder" },
        { key: "OUTPUT_PDF", label: "Output PDF Path" },
        { key: "CHECKPOINT_FILE", label: "Checkpoint File" },
    ];
    grid.innerHTML = fields.map(f => `
        <div class="config-item">
            <label>${f.label}</label>
            <input type="text" id="cfg_${f.key}" value="${escapeHtml(cfg[f.key] || "")}" />
        </div>
    `).join("");
}

async function saveConvertConfig() {
    const data = {};
    ["CONVERT_INPUT", "CONVERT_OUTPUT"].forEach(k => { const el = document.getElementById("cfg_" + k); if (el) data[k] = el.value; });
    try {
        const res = await fetch("/api/update-convert-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        const result = await res.json();
        if (result.error) showToast("Error: " + result.error, "error");
        else showToast("PDF config saved!", "success");
        fetchConfig();
    } catch (e) { showToast("Failed to save config", "error"); }
}

async function saveRotateConfig() {
    const data = {};
    ["INPUT_FOLDER","TEMP_FIXED_FOLDER","BLANK_PAGES_FOLDER","OUTPUT_PDF","CHECKPOINT_FILE"].forEach(k => { const el = document.getElementById("cfg_" + k); if (el) data[k] = el.value; });
    try {
        const res = await fetch("/api/update-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        const result = await res.json();
        if (result.error) showToast("Error: " + result.error, "error");
        else showToast("Rotate config saved!", "success");
        fetchConfig();
    } catch (e) { showToast("Failed to save config", "error"); }
}

// ── Quick Actions ───────────────────────────────────
function renderActionButtons(cfg) {
    const container = document.getElementById("actionButtons");
    const folderIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const actions = [
        { label: "Open PDF Input", folder: cfg.CONVERT_INPUT },
        { label: "Open Converted Pages", folder: cfg.CONVERT_OUTPUT },
        { label: "Open Rotated Output", folder: cfg.TEMP_FIXED_FOLDER },
        { label: "Open Blank Pages", folder: cfg.BLANK_PAGES_FOLDER },
    ];
    container.innerHTML = actions.map(a => `
        <button class="action-btn" onclick="openFolder('${escapeHtml(a.folder || "")}')">${folderIcon} ${a.label}</button>
    `).join("");
}

async function openFolder(folder) {
    if (!folder) { showToast("Path not configured", "error"); return; }
    try {
        const res = await fetch("/api/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) });
        const data = await res.json();
        if (data.error) showToast(data.error, "error");
    } catch (e) { showToast("Failed to open folder", "error"); }
}

// ── Toasts ──────────────────────────────────────────
let _lastToast = { msg: "", time: 0 };
function showToast(msg, type = "info") {
    const now = Date.now();
    if (_lastToast.msg === msg && (now - _lastToast.time) < 2000) return;
    _lastToast = { msg, time: now };
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast " + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateX(100%)"; toast.style.transition = "all .3s ease"; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ── Particles ───────────────────────────────────────
function initParticles() {
    const canvas = document.getElementById("particles");
    if (!canvas) return;
    for (let i = 0; i < 25; i++) {
        const dot = document.createElement("div");
        dot.style.cssText = `position:absolute;width:${2+Math.random()*3}px;height:${2+Math.random()*3}px;border-radius:50%;background:rgba(108,140,255,${0.05+Math.random()*0.1});left:${Math.random()*100}%;top:${Math.random()*100}%;animation:float ${8+Math.random()*12}s ease-in-out infinite alternate;animation-delay:${-Math.random()*10}s;`;
        canvas.appendChild(dot);
    }
}

// ── 3D Tilt ─────────────────────────────────────────
function init3DTilt() {
    const cards = document.querySelectorAll('.stat-card, .card:not(.terminal-card)');
    cards.forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            card.style.setProperty('--mouse-x', `${x}px`);
            card.style.setProperty('--mouse-y', `${y}px`);
            const rotateX = ((y - rect.height/2) / (rect.height/2)) * -4;
            const rotateY = ((x - rect.width/2) / (rect.width/2)) * 4;
            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02,1.02,1.02)`;
        });
        card.addEventListener('mouseleave', () => {
            card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)`;
            card.style.setProperty('--mouse-x', `-1000px`);
            card.style.setProperty('--mouse-y', `-1000px`);
        });
    });
}

// ── Custom Cursor ───────────────────────────────────
function initCustomCursor() {
    const cursor = document.getElementById("cursor");
    if (!cursor) return;
    document.body.classList.add("custom-cursor-enabled");
    let mouseX = window.innerWidth/2, mouseY = window.innerHeight/2, cursorX = mouseX, cursorY = mouseY;
    function render() {
        cursorX += (mouseX - cursorX) * 0.15;
        cursorY += (mouseY - cursorY) * 0.15;
        cursor.style.transform = `translate(${cursorX}px, ${cursorY}px) translate(-50%, -50%)`;
        requestAnimationFrame(render);
    }
    render();
    document.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; });
    const attachHoverEvents = () => {
        document.querySelectorAll("button, a, .card, .stat-card, input, select, .action-btn, .btn-icon, .terminal-content, .upload-zone").forEach(el => {
            el.addEventListener("mouseenter", () => {
                document.body.classList.add("cursor-hover");
                if (el.classList.contains("btn-upload-action") || el.classList.contains("btn-download") || el.classList.contains("btn-save-config")) document.body.dataset.cursorStyle = "pulsing-green";
                else if (el.classList.contains("btn-danger") || el.classList.contains("btn-stop-inline")) document.body.dataset.cursorStyle = "target-red";
                else if (el.classList.contains("upload-zone")) document.body.dataset.cursorStyle = "pulsing-green";
                else document.body.dataset.cursorStyle = "default-hover";
            });
            el.addEventListener("mouseleave", () => { document.body.classList.remove("cursor-hover"); delete document.body.dataset.cursorStyle; });
        });
    };
    attachHoverEvents();
    new MutationObserver(attachHoverEvents).observe(document.body, { childList: true, subtree: true });
}