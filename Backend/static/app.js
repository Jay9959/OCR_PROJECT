/* ═══════════════════════════════════════════════════
   OCR Dashboard — Frontend Logic
   ═══════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────
let autoScroll = true;
let eventSource = null;
let statusInterval = null;
let currentConfig = {};

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
    document.getElementById("btnAutoScroll").classList.add("active");
    
    // Inject Welcome Art safely
    const welcomeArtContainer = document.getElementById("welcomeArt");
    if (welcomeArtContainer) {
        welcomeArtContainer.textContent = [
            "+------------------------------------------------+",
            "|                                                |",
            "|       OCR ROTATION ENGINE v10.2 PREMIUM        |",
            "|                                                |",
            "|   ==========================================   |",
            "|                                                |",
            "|    PDF  ->  IMAGES  ->  ROTATE  ->  OUTPUT     |",
            "|                                                |",
            "|           Ready to process documents           |",
            "|                                                |",
            "|     Click [PDF -> Images] or [Auto Rotate]     |",
            "|              to begin processing               |",
            "|                                                |",
            "+------------------------------------------------+"
        ].join("\n");
    }
    
    // Advanced Loader Logic
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
                setTimeout(() => {
                    loader.classList.add("hidden");
                }, 500);
            }
            loaderPercent.textContent = p + "%";
            loaderFill.style.width = p + "%";
        }, 40);
    }
});

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
        if (data.error) {
            showToast(data.error, "error");
            return;
        }
        clearTerminal();
        showToast(scriptType === "convert" ? "PDF conversion started" : "Auto-rotation started", "success");
        connectSSE();
        fetchStatus();
    } catch (e) {
        showToast("Failed to start: " + e.message, "error");
    }
}

async function stopProcess() {
    try {
        const res = await fetch("/api/stop", { method: "POST" });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, "error");
        } else {
            showToast("Process stopped", "info");
        }
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
                return;
            }
            appendLogLine(entry);
        } catch (e) { /* ignore parse errors */ }
    };
    eventSource.onerror = () => {
        if (eventSource) { eventSource.close(); eventSource = null; }
    };
}

// ── UI Updates ──────────────────────────────────────
function updateStatusUI(data) {
    const pill = document.getElementById("statusPill");
    const dot = pill.querySelector(".status-text");
    const timer = document.getElementById("navTimer");
    const btnConvert = document.getElementById("btnConvert");
    const btnRotate = document.getElementById("btnRotate");
    const btnStop = document.getElementById("btnStop");
    const progressSection = document.getElementById("progressSection");

    // Status pill
    pill.className = "status-pill";
    const statusMap = {
        idle: "Idle", running: "Running", stopping: "Stopping",
        finished: "Complete", error: "Error"
    };
    dot.textContent = statusMap[data.status] || data.status;
    if (data.status === "running") pill.classList.add("running");
    else if (data.status === "error") pill.classList.add("error");
    else if (data.status === "stopping") pill.classList.add("stopping");

    // Timer
    if (data.elapsed > 0) {
        const m = Math.floor(data.elapsed / 60);
        const s = Math.floor(data.elapsed % 60);
        timer.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    }

    // Buttons
    const isRunning = data.status === "running" || data.status === "stopping";
    btnConvert.disabled = isRunning;
    btnRotate.disabled = isRunning;
    btnStop.disabled = !isRunning;

    // Progress
    if (data.status === "running" || data.status === "finished") {
        progressSection.style.display = "block";
        document.getElementById("progressFill").style.width = data.progress + "%";
        document.getElementById("progressPercent").textContent = data.progress + "%";
        const script = data.current_script === "convert" ? "PDF Conversion" : "Auto Rotation";
        document.getElementById("progressLabel").textContent = script;
        let detail = "";
        if (data.processed_images > 0) detail += `${data.processed_images}`;
        if (data.total_images > 0) detail += ` / ${data.total_images} images`;
        if (data.blank_pages > 0) detail += ` · ${data.blank_pages} blank`;
        if (data.failed_images > 0) detail += ` · ${data.failed_images} failed`;
        document.getElementById("progressDetail").textContent = detail;
    } else {
        progressSection.style.display = "none";
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
    const count = content.querySelectorAll(".log-line").length;
    badge.textContent = count + " lines";

    if (autoScroll) content.scrollTop = content.scrollHeight;
}

function clearTerminal() {
    const content = document.getElementById("terminalContent");
    content.innerHTML = "";
    document.getElementById("lineCountBadge").textContent = "0 lines";
    fetch("/api/clear-logs", { method: "POST" });
}

async function clearLogs() {
    clearTerminal();
    showToast("Logs cleared", "info");
}

function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const btn = document.getElementById("btnAutoScroll");
    btn.classList.toggle("active", autoScroll);
    if (autoScroll) {
        const content = document.getElementById("terminalContent");
        content.scrollTop = content.scrollHeight;
    }
}

function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
}

// ── Config Panels (Separate) ────────────────────────
function togglePanel(panelId) {
    const body = document.getElementById(panelId);
    body.classList.toggle("open");
    // Rotate the toggle button arrow
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
    ["CONVERT_INPUT", "CONVERT_OUTPUT"].forEach(k => {
        const el = document.getElementById("cfg_" + k);
        if (el) data[k] = el.value;
    });
    try {
        const res = await fetch("/api/update-convert-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.error) showToast("Error: " + result.error, "error");
        else showToast("PDF config saved!", "success");
        fetchConfig();
    } catch (e) {
        showToast("Failed to save config", "error");
    }
}

async function saveRotateConfig() {
    const data = {};
    ["INPUT_FOLDER","TEMP_FIXED_FOLDER","BLANK_PAGES_FOLDER","OUTPUT_PDF","CHECKPOINT_FILE"].forEach(k => {
        const el = document.getElementById("cfg_" + k);
        if (el) data[k] = el.value;
    });
    try {
        const res = await fetch("/api/update-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.error) showToast("Error: " + result.error, "error");
        else showToast("Rotate config saved!", "success");
        fetchConfig();
    } catch (e) {
        showToast("Failed to save config", "error");
    }
}

// ── Quick Action Buttons ────────────────────────────
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
        const res = await fetch("/api/open-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder })
        });
        const data = await res.json();
        if (data.error) showToast(data.error, "error");
    } catch (e) {
        showToast("Failed to open folder", "error");
    }
}

// ── Toasts ──────────────────────────────────────────
let _lastToast = { msg: "", time: 0 };

function showToast(msg, type = "info") {
    // Prevent duplicate toasts within 2 seconds
    const now = Date.now();
    if (_lastToast.msg === msg && (now - _lastToast.time) < 2000) return;
    _lastToast = { msg, time: now };

    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast " + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        toast.style.transition = "all .3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ── Background Particles ────────────────────────────
function initParticles() {
    const canvas = document.getElementById("particles");
    if (!canvas) return;
    for (let i = 0; i < 25; i++) {
        const dot = document.createElement("div");
        dot.style.cssText = `
            position:absolute;
            width:${2 + Math.random() * 3}px;
            height:${2 + Math.random() * 3}px;
            border-radius:50%;
            background:rgba(108,140,255,${0.05 + Math.random() * 0.1});
            left:${Math.random() * 100}%;
            top:${Math.random() * 100}%;
            animation:float ${8 + Math.random() * 12}s ease-in-out infinite alternate;
            animation-delay:${-Math.random() * 10}s;
        `;
        canvas.appendChild(dot);
    }
    if (!document.getElementById("particleStyle")) {
        const style = document.createElement("style");
        style.id = "particleStyle";
        style.textContent = `@keyframes float{0%{transform:translate(0,0)}100%{transform:translate(${-20+Math.random()*40}px,${-30+Math.random()*60}px)}}`;
        document.head.appendChild(style);
    }
}

// ── 3D Tilt & Glow Effect ───────────────────────────
function init3DTilt() {
    const cards = document.querySelectorAll('.stat-card, .card:not(.terminal-card)');
    cards.forEach(card => {
        card.addEventListener('mousemove', e => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            card.style.setProperty('--mouse-x', `${x}px`);
            card.style.setProperty('--mouse-y', `${y}px`);
            
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            const rotateX = ((y - centerY) / centerY) * -4;
            const rotateY = ((x - centerX) / centerX) * 4;
            
            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
            card.style.setProperty('--mouse-x', `-1000px`);
            card.style.setProperty('--mouse-y', `-1000px`);
        });
    });
}

// ── Custom Cursor ───────────────────────────────────
function initCustomCursor() {
    const cursor = document.getElementById("cursor");
    if (!cursor) return;
    
    // Add class to hide default cursor safely
    document.body.classList.add("custom-cursor-enabled");
    
    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let cursorX = mouseX;
    let cursorY = mouseY;
    
    function render() {
        cursorX += (mouseX - cursorX) * 0.15;
        cursorY += (mouseY - cursorY) * 0.15;
        cursor.style.transform = `translate(${cursorX}px, ${cursorY}px) translate(-50%, -50%)`;
        requestAnimationFrame(render);
    }
    render();
    
    document.addEventListener("mousemove", (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    const attachHoverEvents = () => {
        const interactiveElements = document.querySelectorAll("button, a, .card, .stat-card, input, select, .action-btn, .btn-icon, .terminal-content");
        interactiveElements.forEach(el => {
            el.addEventListener("mouseenter", () => {
                document.body.classList.add("cursor-hover");
                
                // Determine specific cursor style
                if (el.id === "btnConvert" || el.id === "btnRotate" || el.classList.contains("btn-save-config")) {
                    document.body.dataset.cursorStyle = "pulsing-green";
                } else if (el.classList.contains("btn-danger") || el.textContent.includes("Stop")) {
                    document.body.dataset.cursorStyle = "target-red";
                } else if (el.classList.contains("stat-card") || el.classList.contains("config-card")) {
                    document.body.dataset.cursorStyle = "dashed-spin";
                } else if (el.classList.contains("terminal-content") || el.tagName.toLowerCase() === 'input') {
                    document.body.dataset.cursorStyle = "brackets";
                } else {
                    document.body.dataset.cursorStyle = "default-hover";
                }
            });
            el.addEventListener("mouseleave", () => {
                document.body.classList.remove("cursor-hover");
                delete document.body.dataset.cursorStyle;
            });
        });
    };
    
    attachHoverEvents();
    
    // Re-attach hover events when DOM changes (like config generation)
    const observer = new MutationObserver(attachHoverEvents);
    observer.observe(document.body, { childList: true, subtree: true });
}