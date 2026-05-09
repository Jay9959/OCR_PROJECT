/* ═══════════════════════════════════════════════════
   OCR Dashboard — Frontend Logic v3.0
   Pipeline: Upload → PDF→Images → Auto Rotate → Download
   ═══════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────
let autoScroll = true;
let eventSource = null;
let statusInterval = null;
let currentConfig = {};
let pipelineStep = 0; // 0=upload, 1=pdf, 2=images, 3=rotate, 4=download
let selectedFiles = [];
let pipelineAutoChain = false; // auto-start step 2 after step 1
let currentTheme = localStorage.getItem('ocr-theme') || 'dark';

// Batch Processing State
let batchQueue = [];
let batchState = {
    isRunning: false,
    isPaused: false,
    currentIndex: 0,
    totalProcessed: 0,
    totalFailed: 0,
    startTime: null,
    currentProcess: null
};

// ── Init ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    // Enhanced Loading Screen Animation
    const loaderContainer = document.getElementById("loader");
    const loaderPercent = document.getElementById("loader-percentage");
    const loaderFill = document.getElementById("loaderFill");
    const loaderStatus = document.getElementById("loaderStatus");
    
    if (loaderContainer && loaderPercent && loaderFill && loaderStatus) {
        let p = 0;
        const statusMessages = [
            "Initializing...",
            "Loading OCR modules...",
            "Preparing engine components...",
            "Setting up processing environment...",
            "Calibrating rotation algorithms...",
            "Finalizing initialization...",
            "Almost ready..."
        ];
        
        const interval = setInterval(() => {
            p += Math.floor(Math.random() * 2) + 1;
            if (p >= 100) {
                p = 100;
                clearInterval(interval);
                loaderStatus.textContent = "Complete! Ready to process documents.";
                setTimeout(() => { 
                    loaderContainer.classList.add("hidden"); 
                }, 1000);
            }
            
            loaderPercent.textContent = p + "%";
            loaderFill.style.width = p + "%";

            // Update status message based on progress
            const statusIndex = Math.min(Math.floor(p / 15), statusMessages.length - 1);
            loaderStatus.textContent = statusMessages[statusIndex];
        }, 100);
    }

    // Initialize application after a short delay to let loader show
    setTimeout(() => {
        fetchStatus();
        fetchOutputStats();
        fetchConfig();
        statusInterval = setInterval(() => {
            fetchStatus();
            fetchOutputStats();
        }, 4000);
        initParticles();
        init2DHover();
        initUploadZone();
        initThemeSystem();
        
        const btnUpload = document.getElementById("btnUpload");
        if (btnUpload) {
            btnUpload.addEventListener("click", uploadFiles);
        }
        document.getElementById("btnAutoScroll").classList.add("active");

        const welcomeArtContainer = document.getElementById("welcomeArt");
        if (welcomeArtContainer) {
            welcomeArtContainer.textContent = [
                "══════════════════════════════════════════════════════════════",
                "                                                              ",
                "          OCR ROTATION ENGINE v10.2 PREMIUM                   ",
                "                                                              ",
                "  ═════════════════════════════════════════════════════════   ",
                "                                                              ",
                "     UPLOAD  +  CONVERT  +  ROTATE  +  DOWNLOAD               ",
                "                                                              ",
                "══════════════════════════════════════════════════════════════"
            ].join("\n");
        }
    }, 500);
});

// ── Upload Zone ─────────────────────────────────────
function initUploadZone() {
    const zone = document.getElementById("uploadZone");
    const fileInput = document.getElementById("fileInput");
    const folderInput = document.getElementById("folderInput");
    const btnFiles = document.getElementById("btnChooseFiles");
    const btnFolder = document.getElementById("btnChooseFolder");
    if (!zone || !fileInput) return;

    // Ensure folder input has directory selection attributes
    if (folderInput) {
        folderInput.setAttribute("webkitdirectory", "");
        folderInput.setAttribute("directory", "");
    }

    // Zone click only when clicking zone itself (not buttons inside it)
    zone.addEventListener("click", (e) => {
        if (e.target.closest("button, input, .upload-file-item")) return;
        fileInput.click();
    });
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

    // Dedicated button listeners with proper stopPropagation
    if (btnFiles) {
        btnFiles.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            fileInput.click();
        });
    }
    if (btnFolder && folderInput) {
        btnFolder.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Some browsers block programmatic click on directory inputs
            try {
                folderInput.click();
            } catch (err) {
                showToast("Folder selection not supported in this browser. Use 'Choose Files' to select multiple PDFs.", "warning");
            }
        });
    }
}

function buildFileTree(files) {
    const root = { name: '', children: {}, files: [] };
    files.forEach((f, idx) => {
        const path = f.webkitRelativePath || f.name;
        const parts = path.split('/');
        let current = root;
        parts.forEach((part, i) => {
            if (i === parts.length - 1) {
                current.files.push({ name: part, file: f, idx: idx });
            } else {
                if (!current.children[part]) {
                    current.children[part] = { name: part, children: {}, files: [] };
                }
                current = current.children[part];
            }
        });
    });
    return root;
}

function renderTreeNode(node, pathPrefix, depth) {
    let html = '';
    const indent = depth * 16;

    // Render folders
    const folderNames = Object.keys(node.children).sort();
    folderNames.forEach(folderName => {
        const child = node.children[folderName];
        const folderPath = pathPrefix ? pathPrefix + '/' + folderName : folderName;
        const fileCount = countFilesRecursive(child);
        const folderId = 'tree-folder-' + folderPath.replace(/[^a-zA-Z0-9]/g, '-');
        html += `
            <div class="tree-folder" style="padding-left: ${indent}px">
                <div class="tree-folder-header" onclick="toggleTreeFolder('${folderId}')">
                    <svg class="tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color:var(--accent-amber)"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    <span class="tree-folder-name">${escapeHtml(folderName)}</span>
                    <span class="tree-folder-count">${fileCount} PDF${fileCount !== 1 ? 's' : ''}</span>
                </div>
                <div class="tree-folder-content" id="${folderId}">
                    ${renderTreeNode(child, folderPath, depth + 1)}
                </div>
            </div>
        `;
    });

    // Render files
    node.files.forEach(f => {
        html += `
            <div class="upload-file-item" style="margin-left: ${indent}px">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span class="upload-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                <span class="upload-file-size">${(f.file.size / (1024 * 1024)).toFixed(1)} MB</span>
                <button class="upload-file-remove" onclick="removeFile(${f.idx})">✕</button>
            </div>
        `;
    });

    return html;
}

function countFilesRecursive(node) {
    let count = node.files.length;
    for (const key in node.children) {
        count += countFilesRecursive(node.children[key]);
    }
    return count;
}

function toggleTreeFolder(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('collapsed');
    const header = el.previousElementSibling;
    if (header) header.classList.toggle('collapsed');
}

function renderFileList() {
    const list = document.getElementById("uploadFileList");
    const btn = document.getElementById("btnUpload");
    if (!selectedFiles.length) { list.innerHTML = ""; btn.disabled = true; return; }
    btn.disabled = false;

    const tree = buildFileTree(selectedFiles);
    list.innerHTML = renderTreeNode(tree, '', 0);
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

    // Check if this is a batch operation (more than 5 files)
    if (selectedFiles.length > 5) {
        addToBatchQueue(selectedFiles);
        selectedFiles = [];
        renderFileList();
        btn.disabled = false;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload & Start Processing</span>`;
        return;
    }

    // Single file processing (existing logic)
    const formData = new FormData();
    selectedFiles.forEach(f => formData.append("files", f, f.webkitRelativePath || f.name));

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
    for (let i = 0; i <= 4; i++) {
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
    else if (step === 3) startProcess("merge");
}

function resetPipeline() {
    pipelineAutoChain = false;
    selectedFiles = [];
    renderFileList();
    setPipelineStep(0);
    const btn = document.getElementById("btnUpload");
    btn.disabled = true;
    const modal = document.getElementById("mergeModal");
    if (modal) modal.classList.remove("open");
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
        updateBatchUI(); // Update batch queue to show processed files
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
            // Images done → auto start Auto Rotate
            showToast("Image conversion complete! Starting Auto Rotate...", "success");
            setTimeout(() => startPipelineStep(2), 1500);
        } else if (pipelineStep === 2) {
            // Auto Rotate done → Show choice modal
            showMergeConfirmModal();
        } else if (pipelineStep === 3) {
            // Merge done → show download
            showToast("PDF creation complete!", "success");
            setPipelineStep(4);
        }
    } else if (status === "error") {
        showToast("Process encountered an error. Check terminal for details.", "error");
    }
}

function showMergeConfirmModal() {
    const modal = document.getElementById("mergeModal");
    if (modal) modal.classList.add("open");
}

function handleMergeChoice(shouldMerge) {
    const modal = document.getElementById("mergeModal");
    if (modal) modal.classList.remove("open");

    if (shouldMerge) {
        showToast("Starting PDF merge...", "info");
        setTimeout(() => startPipelineStep(3), 500);
    } else {
        showToast("Skipping PDF merge. Preparing download...", "info");
        setPipelineStep(4);
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
        timer.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    const isRunning = data.status === "running" || data.status === "stopping";
    btnStop.disabled = !isRunning;

    // Update active step progress
    if (data.status === "running" || data.status === "finished") {
        const stepNum = pipelineStep;
        const fillId = "step" + stepNum + "Fill";
        const percentId = "step" + stepNum + "Percent";
        const detailId = "step" + stepNum + "Detail";
        const labelId = "step" + stepNum + "Label";
        const statusId = "step" + stepNum + "Status";

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
    updatePreviewTabs(data);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = typeof val === "number" ? val.toLocaleString() : val;
}

// ── Page Preview Gallery ────────────────────────────
let activePreviewTab = null; // { name, source }

function updatePreviewTabs(data) {
    const tabsContainer = document.getElementById("previewFolderTabs");
    const empty = document.getElementById("previewEmpty");
    const grid = document.getElementById("previewGrid");
    if (!tabsContainer) return;

    const inputPdfs = data.input_pdf_list || [];
    const converted = data.converted_folders || [];
    const output = data.output_folders || [];

    const hasAny = inputPdfs.length > 0 || converted.length > 0 || output.length > 0;

    if (!hasAny) {
        tabsContainer.innerHTML = "";
        if (empty) empty.style.display = "flex";
        if (grid) grid.innerHTML = "";
        activePreviewTab = null;
        return;
    }

    let html = "";

    // Main category tabs
    const categories = [];
    if (inputPdfs.length > 0) categories.push({ id: 'input', label: 'Input PDFs', count: inputPdfs.length, color: 'amber' });
    if (converted.length > 0) categories.push({ id: 'converted', label: 'Converted', count: converted.reduce((a, b) => a + (b.pages || 0), 0), color: 'blue' });
    if (output.length > 0) categories.push({ id: 'output', label: 'Output', count: output.reduce((a, b) => a + (b.pages || 0), 0), color: 'emerald' });

    categories.forEach(cat => {
        const isActive = activePreviewTab && activePreviewTab.category === cat.id;
        const colorMap = {
            amber: 'border-color:rgba(245,158,11,0.3);background:rgba(245,158,11,0.1);color:var(--accent-amber);',
            blue: 'border-color:rgba(99,102,241,0.3);background:rgba(99,102,241,0.1);color:var(--accent-blue);',
            emerald: 'border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:var(--accent-emerald);'
        };
        html += `<button class="preview-tab ${isActive ? 'active' : ''}" style="${colorMap[cat.color]}" onclick="selectCategory('${cat.id}')">${cat.label} <span style="opacity:0.6">(${cat.count})</span></button>`;
    });

    tabsContainer.innerHTML = html;

    // Auto-select first available category if none active
    if (!activePreviewTab) {
        if (categories.length > 0) {
            selectCategory(categories[0].id);
        }
    }
}

async function selectCategory(category) {
    activePreviewTab = { category };
    const tabs = document.querySelectorAll(".preview-tab");
    tabs.forEach(t => {
        const onclick = t.getAttribute("onclick") || "";
        t.classList.toggle("active", onclick.includes(`'${category}'`));
    });

    const empty = document.getElementById("previewEmpty");
    const grid = document.getElementById("previewGrid");
    if (empty) empty.style.display = "none";
    if (grid) grid.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px 0;">Loading...</div>`;

    try {
        const res = await fetch("/api/output-stats");
        const data = await res.json();

        if (category === 'input') {
            renderPdfList(data.input_pdf_list || []);
        } else if (category === 'converted') {
            renderFolderHierarchy(data.converted_folders || [], 'pdf_page');
        } else if (category === 'output') {
            renderFolderHierarchy(data.output_folders || [], 'output');
        }
    } catch (e) {
        if (grid) grid.innerHTML = `<div style="text-align:center;color:var(--accent-rose);padding:40px 0;">Failed to load data</div>`;
    }
}

async function selectPreviewTab(name, source) {
    activePreviewTab = { name, source };
    const tabs = document.querySelectorAll(".preview-tab");
    tabs.forEach(t => {
        const onclick = t.getAttribute("onclick") || "";
        const match = onclick.includes(`'${source}'`);
        const nameMatch = source === "input" ? onclick.includes("__input__") : onclick.includes(name);
        t.classList.toggle("active", match && nameMatch);
    });

    const empty = document.getElementById("previewEmpty");
    const grid = document.getElementById("previewGrid");
    if (empty) empty.style.display = "none";
    if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px 0;">Loading...</div>`;

    if (source === "input") {
        // Render input PDF list
        try {
            const res = await fetch("/api/output-stats");
            const data = await res.json();
            renderPdfList(data.input_pdf_list || []);
        } catch (e) {
            if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--accent-rose);padding:40px 0;">Failed to load PDF list</div>`;
        }
        return;
    }

    try {
        const res = await fetch(`/api/folder-images?folder=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}`);
        const data = await res.json();
        renderFolderTree(data.folders || [], data.images || [], name, source);
    } catch (e) {
        if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--accent-rose);padding:40px 0;">Failed to load previews</div>`;
    }
}

function renderFolderHierarchy(folders, source) {
    const grid = document.getElementById("previewGrid");
    const empty = document.getElementById("previewEmpty");
    if (!grid) return;

    // Remove grid layout for folder tree view
    grid.classList.remove("preview-grid");

    if (!folders || folders.length === 0) {
        grid.innerHTML = "";
        if (empty) empty.style.display = "flex";
        return;
    }

    if (empty) empty.style.display = "none";

    let html = '<div class="folder-tree-root">';

    folders.forEach(folder => {
        html += renderFolderNode(folder, source, 0);
    });

    html += '</div>';
    grid.innerHTML = html;
}

function renderFolderNode(folder, source, depth) {
    const hasChildren = folder.children && folder.children.length > 0;
    const hasImages = folder.pages && folder.pages > 0;
    const folderId = `folder-${folder.path.replace(/[\/\\]/g, '-')}`;
    const indent = depth * 20;

    let html = `
    <div class="folder-tree-node" style="margin-left:${indent}px">
        <div class="folder-header" onclick="toggleFolderNode('${escapeHtml(folder.path)}', '${source}')">
            <svg class="folder-chevron ${hasChildren || hasImages ? '' : 'hidden'}" id="chevron-${folderId}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
            </svg>
            <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M22 19a2 2 0 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="folder-name">${escapeHtml(folder.name)}</span>
            <span class="folder-count">${folder.pages || 0}</span>
        </div>
        <div class="folder-content collapsed" id="${folderId}">
    `;

    // Recursively render nested children folders
    if (hasChildren) {
        html += '<div class="folder-tree-children">';
        folder.children.forEach(child => {
            html += renderFolderNode(child, source, depth + 1);
        });
        html += '</div>';
    }

    // Container for lazily-loaded images
    html += `<div class="folder-images-container" id="images-${folderId}"></div>`;

    html += '</div></div>';
    return html;
}

function toggleFolderNode(folderPath, source) {
    const folderId = `folder-${folderPath.replace(/[\/\\]/g, '-')}`;
    const content = document.getElementById(folderId);
    const chevron = document.getElementById(`chevron-${folderId}`);

    if (!content) return;

    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        if (chevron) chevron.style.transform = 'rotate(90deg)';

        // Lazy-load images only (children already rendered)
        const imagesContainer = document.getElementById(`images-${folderId}`);
        if (imagesContainer && imagesContainer.dataset.loaded !== 'true') {
            loadFolderImages(folderPath, source, folderId);
        }
    } else {
        content.classList.add('collapsed');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
    }
}

async function loadFolderImages(folderPath, source, folderId) {
    const imagesContainer = document.getElementById(`images-${folderId}`);
    if (!imagesContainer || imagesContainer.dataset.loaded === 'true') return;

    try {
        const res = await fetch(`/api/folder-images?folder=${encodeURIComponent(folderPath)}&source=${encodeURIComponent(source)}`);
        const data = await res.json();

        let html = '';

        if (data.images && data.images.length > 0) {
            html += '<div class="folder-section-title">Images</div>';
            html += '<div class="subfolder-images">';
            data.images.forEach(img => {
                const safeUrl = escapeHtml(img.url);
                const safeName = escapeHtml(img.name);
                html += `
                <div class="preview-item" onclick="openLightbox('${safeUrl}', '${safeName}')" title="${safeName}">
                    <img src="${safeUrl}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'; this.parentElement.querySelector('.img-error').style.display='flex';">
                    <div class="img-error" style="display:none;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:6px;color:var(--text-muted);">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        <span style="font-size:0.65rem">Failed</span>
                    </div>
                    <div class="preview-item-label">${safeName}</div>
                </div>
                `;
            });
            html += '</div>';
        }

        imagesContainer.innerHTML = html;
        imagesContainer.dataset.loaded = 'true';
    } catch (e) {
        imagesContainer.innerHTML = '<div class="folder-error">Failed to load images</div>';
    }
}

function renderPdfList(pdfs) {
    const grid = document.getElementById("previewGrid");
    const empty = document.getElementById("previewEmpty");
    if (!grid) return;

    // Add grid layout for PDF cards
    grid.classList.add("preview-grid");

    if (pdfs.length === 0) {
        grid.innerHTML = "";
        if (empty) empty.style.display = "flex";
        return;
    }

    if (empty) empty.style.display = "none";
    grid.innerHTML = pdfs.map(p => {
        const parts = p.replace(/\\/g, "/").split("/");
        const name = parts[parts.length - 1] || p;
        const pdfUrl = `/api/pdf-file?path=${encodeURIComponent(p)}`;
        return `
        <div class="preview-item pdf-card" title="${escapeHtml(p)}" onclick="openPDFViewer('${escapeHtml(p)}', '${escapeHtml(name)}')">
            <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:8px;padding:8px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36" style="color:var(--accent-amber);flex-shrink:0">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                </svg>
                <div class="pdf-card-name">${escapeHtml(name)}</div>
            </div>
        </div>
    `}).join("");
}

function openLightbox(url, caption) {
    const lb = document.getElementById("lightbox");
    const lbImg = document.getElementById("lightboxImg");
    const lbCap = document.getElementById("lightboxCaption");
    if (!lb) return;
    lbImg.src = url;
    lbCap.textContent = caption || "";
    lb.classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeLightbox() {
    const lb = document.getElementById("lightbox");
    if (lb) lb.classList.remove("open");
    document.body.style.overflow = "";
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
});

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
    ["INPUT_FOLDER", "TEMP_FIXED_FOLDER", "BLANK_PAGES_FOLDER", "OUTPUT_PDF", "CHECKPOINT_FILE"].forEach(k => { const el = document.getElementById("cfg_" + k); if (el) data[k] = el.value; });
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

// ── 2D Hover Lift ─────────────────────────────────────────
function init2DHover() {
    const cards = document.querySelectorAll('.stat-card, .card:not(.terminal-card)');
    cards.forEach(card => {
        card.addEventListener('mouseenter', () => {
            card.style.transform = 'translateY(-2px)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });
}

// ── Theme System ───────────────────────────────────────────
function initThemeSystem() {
    // Apply saved theme
    setTheme(currentTheme, false);
    
    // Setup theme toggle button
    const themeToggle = document.getElementById('themeToggle');
    const themeDropdown = document.getElementById('themeDropdown');
    
    if (themeToggle && themeDropdown) {
        themeToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            themeDropdown.classList.toggle('show');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.theme-toggle-container')) {
                themeDropdown.classList.remove('show');
            }
        });
        
        // Update active state in dropdown
        updateThemeOptions();
    }
}

function setTheme(theme, save = true) {
    const root = document.documentElement;
    const themeToggle = document.getElementById('themeToggle');
    const themeDropdown = document.getElementById('themeDropdown');
    
    // Remove all theme classes
    root.removeAttribute('data-theme');
    
    // Apply new theme
    if (theme !== 'dark') {
        root.setAttribute('data-theme', theme);
    }
    
    currentTheme = theme;
    
    // Update theme toggle button appearance
    if (themeToggle) {
        const darkIcon = themeToggle.querySelector('.theme-icon-dark');
        const lightIcon = themeToggle.querySelector('.theme-icon-light');
        
        if (theme === 'light') {
            darkIcon.style.opacity = '0';
            darkIcon.style.transform = 'rotate(-180deg)';
            lightIcon.style.opacity = '1';
            lightIcon.style.transform = 'rotate(0deg)';
        } else {
            darkIcon.style.opacity = '1';
            darkIcon.style.transform = 'rotate(0deg)';
            lightIcon.style.opacity = '0';
            lightIcon.style.transform = 'rotate(-180deg)';
        }
    }
    
    // Update active state in dropdown
    updateThemeOptions();
    
    // Save to localStorage
    if (save) {
        localStorage.setItem('ocr-theme', theme);
        showToast(`Theme changed to ${getThemeDisplayName(theme)}`, 'success');
    }
    
    // Close dropdown
    if (themeDropdown) {
        themeDropdown.classList.remove('show');
    }
}

function updateThemeOptions() {
    const options = document.querySelectorAll('.theme-option');
    options.forEach(option => {
        const theme = option.getAttribute('data-theme');
        option.classList.toggle('active', theme === currentTheme);
    });
}

// ── Particles ───────────────────────────────────────
function initParticles() {
    const canvas = document.getElementById("particles");
    if (!canvas) return;
    for (let i = 0; i < 25; i++) {
        const dot = document.createElement("div");
        dot.style.cssText = `position:absolute;width:${2 + Math.random() * 3}px;height:${2 + Math.random() * 3}px;border-radius:50%;background:rgba(108,140,255,${0.05 + Math.random() * 0.1});left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation:float ${8 + Math.random() * 12}s ease-in-out infinite alternate;animation-delay:${-Math.random() * 10}s;`;
        canvas.appendChild(dot);
    }
}

// ── Toasts ──────────────────────────────────────────
let _lastToast = { msg: "", time: 0 };
function showToast(msg, type = "info", options = {}) {
    const now = Date.now();
    if (_lastToast.msg === msg && (now - _lastToast.time) < 2000) return;
    _lastToast = { msg, time: now };
    
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    // Add icon based on type
    const icon = getToastIcon(type);
    const title = getToastTitle(type);
    
    toast.innerHTML = `
        <div class="toast-content">
            <div class="toast-icon">${icon}</div>
            <div class="toast-text">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${escapeHtml(msg)}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()" title="Dismiss">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        </div>
        ${options.persistent ? '<div class="toast-progress"></div>' : ''}
    `;
    
    container.appendChild(toast);
    
    // Auto-dismiss unless persistent
    if (!options.persistent) {
        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
        }, options.duration || 4000);
    }
    
    // Play sound
    playNotificationSound(type);
    
    // Handle progress updates for persistent toasts
    if (options.persistent && options.progress) {
        updateToastProgress(toast, options.progress);
    }
}

function getToastIcon(type) {
    const icons = {
        success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>`,
        error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>`,
        warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3.71L12 7.29l9.47 9.47a2 2 0 0 0 1.71-3.71L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
        </svg>`,
        info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>`,
        processing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>`,
        complete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4"></path>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11z"></path>
        </svg>`
    };
    return icons[type] || icons.info;
}

function getToastTitle(type) {
    const titles = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Information',
        processing: 'Processing',
        complete: 'Complete'
    };
    return titles[type] || 'Notification';
}

function updateToastProgress(toast, progress) {
    const progressBar = toast.querySelector('.toast-progress');
    if (progressBar) {
        progressBar.style.width = `${progress}%`;
    }
}

function playNotificationSound(type) {
    if (!notificationSettings.soundEnabled) return;
    
    try {
        const audio = new Audio(notificationSounds[type] || notificationSounds.info);
        audio.volume = notificationSettings.volume;
        audio.play().catch(e => {
            console.log('Could not play notification sound:', e);
        });
    } catch (error) {
        console.log('Error playing notification sound:', error);
    }
}

function getThemeDisplayName(theme) {
    const names = {
        'dark': 'Dark Mode',
        'light': 'Light Mode',
        'purple-neon': 'Purple Neon',
        'cyber-blue': 'Cyber Blue'
    };
    return names[theme] || theme;
}

// ── Smart Notification System ───────────────────────────────────
let notificationSettings = {
    enabled: true,
    soundEnabled: true,
    volume: 0.5,
    persistent: false
};

// Notification sound effects
const notificationSounds = {
    success: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA',
    error: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA',
    warning: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA',
    info: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA',
    complete: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA',
    processing: 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAAAA'
};

function showSmartNotification(event, data) {
    const messages = {
        'processing-started': {
            message: 'Processing Started',
            description: data.fileName ? `Started processing ${data.fileName}` : 'Processing has begun',
            type: 'processing'
        },
        'rotation-completed': {
            message: 'Rotation Completed',
            description: data.fileName ? `Auto-rotation completed for ${data.fileName}` : 'Document rotation finished',
            type: 'success'
        },
        'pdf-ready': {
            message: 'PDF Ready for Download',
            description: `Your processed PDF is ready for download`,
            type: 'success'
        },
        'manual-review': {
            message: 'Manual Review Required',
            description: `${data.count} pages need manual review`,
            type: 'warning',
            persistent: true
        },
        'batch-completed': {
            message: 'Batch Processing Complete',
            description: `Processed ${data.processed} files successfully${data.failed ? `, ${data.failed} failed` : ''}`,
            type: 'complete'
        },
        'batch-item-failed': {
            message: 'Item Processing Failed',
            description: `Failed to process ${data.fileName}: ${data.error}`,
            type: 'error'
        },
        'theme-changed': {
            message: 'Theme Changed',
            description: `Theme changed to ${data.themeName}`,
            type: 'info'
        }
    };
    
    const notification = messages[event];
    if (!notification) return;
    
    showToast(
        notification.description,
        notification.type,
        {
            persistent: notification.persistent || false,
            duration: notification.type === 'error' ? 6000 : 4000
        }
    );
}

function showProcessingStarted(fileName) {
    showSmartNotification('processing-started', { fileName });
}

function showRotationCompleted(fileName) {
    showSmartNotification('rotation-completed', { fileName });
}

function showPDFReady(fileName) {
    showSmartNotification('pdf-ready', { fileName });
}

function showManualReview(count) {
    showSmartNotification('manual-review', { count });
}

function showBatchCompleted(processed, failed) {
    showSmartNotification('batch-completed', { processed, failed });
}

// ── Batch Processing Functions ───────────────────────────────────────
function addToBatchQueue(files) {
    files.forEach(file => {
        if (file.name.toLowerCase().endsWith('.pdf')) {
            batchQueue.push({
                id: Date.now() + Math.random(),
                file: file,
                name: file.name,
                size: (file.size / (1024 * 1024)).toFixed(1),
                status: 'waiting', // waiting, processing, completed, failed
                progress: 0,
                error: null,
                startTime: null,
                endTime: null
            });
        }
    });
    
    updateBatchUI();
    showToast(`Added ${files.length} files to batch queue`, 'success');
}

function clearBatchQueue() {
    if (batchState.isRunning) {
        showToast('Cannot clear queue while batch is running', 'error');
        return;
    }
    
    batchQueue = [];
    updateBatchUI();
    showToast('Batch queue cleared', 'info');
}

function addInputFolderFilesToBatch(pdfList) {
    if (!pdfList || pdfList.length === 0) {
        showToast('No PDF files found in input folder', 'error');
        return;
    }

    let addedCount = 0;
    pdfList.forEach(pdfPath => {
        // Create a mock file object for files already in input folder
        const mockFile = {
            name: pdfPath.split('/').pop() || pdfPath.split('\\').pop(),
            path: pdfPath,
            size: 0, // We don't know the size without additional API call
            isFromInputFolder: true
        };
        
        batchQueue.push({
            id: Date.now() + Math.random(),
            file: mockFile,
            name: mockFile.name,
            status: 'waiting',
            progress: 0,
            error: null,
            startTime: null,
            endTime: null
        });
        addedCount++;
    });
    
    updateBatchUI();
    showToast(`Added ${addedCount} PDF files from input folder to batch queue`, 'success');
    
    // Automatically start processing after adding files
    setTimeout(() => {
        startBatchProcessing();
    }, 500);
}

function startBatchProcessing() {
    console.log('Start batch clicked. Queue length:', batchQueue.length);
    console.log('Batch queue items:', batchQueue);
    
    if (batchQueue.length === 0) {
        // Check if there are any files in the input folder and automatically add them to queue
        fetch('/api/output-stats').then(res => res.json()).then(data => {
            if (data.input_pdfs > 0) {
                // Automatically add PDF files from input folder to batch queue
                addInputFolderFilesToBatch(data.input_pdf_list);
                return;
            } else {
                showToast('No files in queue to process. Upload PDF files first.', 'error');
            }
        }).catch(() => {
            showToast('No files in queue to process', 'error');
        });
        return;
    }
    
    if (batchState.isRunning) {
        showToast('Batch processing already running', 'error');
        return;
    }
    
    batchState.isRunning = true;
    batchState.isPaused = false;
    batchState.currentIndex = 0;
    batchState.totalProcessed = 0;
    batchState.totalFailed = 0;
    batchState.startTime = Date.now();
    
    updateBatchUI();
    processNextBatchItem();
    showToast('Batch processing started', 'success');
}

function pauseBatchProcessing() {
    if (!batchState.isRunning || batchState.isPaused) {
        return;
    }
    
    batchState.isPaused = true;
    updateBatchUI();
    showToast('Batch processing paused', 'info');
}

function resumeBatchProcessing() {
    if (!batchState.isRunning || !batchState.isPaused) {
        return;
    }
    
    batchState.isPaused = false;
    updateBatchUI();
    processNextBatchItem();
    showToast('Batch processing resumed', 'info');
}

function stopBatchProcessing() {
    if (!batchState.isRunning) {
        return;
    }
    
    batchState.isRunning = false;
    batchState.isPaused = false;
    
    // Reset all processing items back to waiting
    batchQueue.forEach(item => {
        if (item.status === 'processing') {
            item.status = 'waiting';
            item.progress = 0;
        }
    });
    
    updateBatchUI();
    showToast('Batch processing stopped', 'warning');
}

async function processNextBatchItem() {
    if (!batchState.isRunning || batchState.isPaused) {
        return;
    }
    
    // Find next waiting item
    const nextItem = batchQueue.find(item => item.status === 'waiting');
    if (!nextItem) {
        // Check if all items are completed
        const allCompleted = batchQueue.every(item => 
            item.status === 'completed' || item.status === 'failed'
        );
        
        if (allCompleted) {
            finishBatchProcessing();
        }
        return;
    }
    
    nextItem.status = 'processing';
    nextItem.startTime = Date.now();
    batchState.currentProcess = nextItem;
    
    updateBatchUI();
    
    try {
        // Check if file is already in input folder
        if (nextItem.file.isFromInputFolder) {
            // File is already in input folder, skip upload
            console.log(`File ${nextItem.name} is already in input folder, skipping upload`);
            nextItem.progress = 33;
            updateBatchUI();
        } else {
            // Upload the file first
            const formData = new FormData();
            formData.append('files', nextItem.file, nextItem.name);
            
            const uploadRes = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            const uploadData = await uploadRes.json();
            if (uploadData.error) {
                throw new Error(uploadData.error);
            }
            
            nextItem.progress = 33;
            updateBatchUI();
        }
        
        // Start processing pipeline
        await processBatchItem(nextItem);
        
    } catch (error) {
        nextItem.status = 'failed';
        nextItem.error = error.message;
        nextItem.endTime = Date.now();
        batchState.totalFailed++;
        
        updateBatchUI();
        showToast(`Failed to process ${nextItem.name}: ${error.message}`, 'error');
        
        // Continue to next item
        setTimeout(() => processNextBatchItem(), 1000);
    }
}

async function processBatchItem(item) {
    try {
        // Step 1: Convert to images
        item.progress = 50;
        updateBatchUI();
        
        // Set pipeline step to 1 for conversion progress display
        setPipelineStep(1);
        
        // Use new batch processing API for file isolation
        const convertRes = await fetch('/api/process-batch-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                file_path: item.file.path || item.file.name,
                script_type: 'convert'
            })
        });
        
        const convertData = await convertRes.json();
        if (convertData.error) {
            throw new Error(convertData.error);
        }
        
        // Wait for conversion to complete with progress updates
        await waitForProcessCompletion('convert');
        
        // Restore files after conversion
        await fetch('/api/restore-batch-files', { method: 'POST' });
        
        // Step 2: Auto rotate
        item.progress = 75;
        updateBatchUI();
        
        // Set pipeline step to 2 for rotation progress display
        setPipelineStep(2);
        
        // Use new batch processing API for file isolation
        const rotateRes = await fetch('/api/process-batch-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                file_path: item.file.path || item.file.name,
                script_type: 'rotate'
            })
        });
        
        const rotateData = await rotateRes.json();
        if (rotateData.error) {
            throw new Error(rotateData.error);
        }
        
        // Wait for rotation to complete with progress updates
        await waitForProcessCompletion('rotate');
        
        // Restore files after rotation
        await fetch('/api/restore-batch-files', { method: 'POST' });
        
        // Mark as completed
        item.status = 'completed';
        item.progress = 100;
        item.endTime = Date.now();
        batchState.totalProcessed++;
        
        updateBatchUI();
        
        // Continue to next item
        setTimeout(() => processNextBatchItem(), 500);
        
    } catch (error) {
        item.status = 'failed';
        item.error = error.message;
        item.endTime = Date.now();
        batchState.totalFailed++;
        
        updateBatchUI();
        setTimeout(() => processNextBatchItem(), 1000);
    }
}

function waitForProcessCompletion(scriptType) {
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Update status UI to show progress
                updateStatusUI(data);
                
                if (data.status === 'finished') {
                    clearInterval(checkInterval);
                    resolve();
                } else if (data.status === 'error') {
                    clearInterval(checkInterval);
                    reject(new Error(data.error_message || 'Process failed'));
                }
            } catch (error) {
                clearInterval(checkInterval);
                reject(error);
            }
        }, 1000); // Check more frequently for better progress updates
        
        // Timeout after 5 minutes
        setTimeout(() => {
            clearInterval(checkInterval);
            reject(new Error('Process timeout'));
        }, 300000);
    });
}

function finishBatchProcessing() {
    batchState.isRunning = false;
    batchState.currentProcess = null;
    
    const duration = Date.now() - batchState.startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    showToast(`Batch processing completed in ${minutes}m ${seconds}s. Processed: ${batchState.totalProcessed}, Failed: ${batchState.totalFailed}`, 'success');
    
    // Play completion sound if available
    playNotificationSound('complete');
    
    updateBatchUI();
}

function updateBatchUI() {
    // Update stats
    let total, processed, failed, progress;
    
    if (batchQueue.length > 0) {
        // Use batch queue stats when items are in queue
        total = batchQueue.length;
        processed = batchQueue.filter(item => item.status === 'completed').length;
        failed = batchQueue.filter(item => item.status === 'failed').length;
        progress = total > 0 ? Math.round((processed + failed) / total * 100) : 0;
    } else {
        // Use overall processing stats when queue is empty
        const statsElements = {
            outputImages: document.getElementById('outputImageCount'),
            blankPages: document.getElementById('blankPageCount')
        };
        
        total = parseInt(statsElements.outputImages?.textContent || '0') + 
                parseInt(statsElements.blankPages?.textContent || '0');
        processed = parseInt(statsElements.outputImages?.textContent || '0');
        failed = 0; // Failed count not available in main stats
        progress = total > 0 ? 100 : 0; // If there are processed files, show 100%
    }
    
    setText('batchTotal', total);
    setText('batchProcessed', processed);
    setText('batchFailed', failed);
    setText('batchProgress', progress + '%');
    setText('batchCount', `${total} files`);
    
    // Update buttons
    const btnStart = document.getElementById('btnStartBatch');
    const btnPause = document.getElementById('btnPauseBatch');
    const btnStop = document.getElementById('btnStopBatch');
    const btnClear = document.getElementById('btnClearQueue');
    
    if (btnStart) {
        btnStart.disabled = batchState.isRunning || total === 0;
        btnStart.innerHTML = batchState.isPaused ? 
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Resume</span>` :
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Start Batch</span>`;
    }
    
    if (btnPause) {
        btnPause.disabled = !batchState.isRunning || batchState.isPaused;
        btnPause.onclick = batchState.isPaused ? resumeBatchProcessing : pauseBatchProcessing;
    }
    
    if (btnStop) {
        btnStop.disabled = !batchState.isRunning;
    }
    
    if (btnClear) {
        btnClear.disabled = batchState.isRunning;
    }
    
    // Update queue items
    const queueContainer = document.getElementById('batchQueue');
    const emptyState = document.getElementById('batchEmpty');
    
    if (total === 0) {
        queueContainer.innerHTML = '';
        
        // Check if there are any processed files to show appropriate message
        const outputImages = parseInt(document.getElementById('outputImageCount')?.textContent || '0');
        const blankPages = parseInt(document.getElementById('blankPageCount')?.textContent || '0');
        const hasProcessedFiles = (outputImages + blankPages) > 0;
        
        if (hasProcessedFiles && batchQueue.length === 0) {
            // Show processed files summary instead of empty state
            queueContainer.innerHTML = `
                <div class="batch-summary" style="text-align: center; padding: 20px; color: var(--text-muted);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48" style="margin-bottom: 12px; opacity: 0.6;">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <div style="font-size: 1.1rem; margin-bottom: 8px;">Files Processed Outside Batch Queue</div>
                    <div style="font-size: 0.9rem; opacity: 0.8;">
                        ${outputImages} processed images • ${blankPages} blank pages
                    </div>
                    <div style="font-size: 0.8rem; opacity: 0.6; margin-top: 8px;">
                        Upload more files to add them to the batch queue
                    </div>
                </div>
            `;
        } else {
            // Show original empty state
            queueContainer.appendChild(emptyState);
        }
        return;
    }
    
    let html = '';
    batchQueue.forEach(item => {
        const statusIcon = getStatusIcon(item.status);
        const statusText = getStatusText(item.status);
        const progressHtml = item.status === 'processing' ? 
            `<div class="batch-item-progress">
                <div class="batch-item-progress-fill" style="width: ${item.progress}%"></div>
            </div>` : '';
        
        html += `
            <div class="batch-item ${item.status}">
                <div class="batch-item-info">
                    <div class="batch-item-icon">
                        ${statusIcon}
                    </div>
                    <div class="batch-item-details">
                        <div class="batch-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                        <div class="batch-item-status">
                            ${statusText}
                            ${item.error ? `<span style="color: var(--accent-rose)">- ${escapeHtml(item.error)}</span>` : ''}
                        </div>
                    </div>
                </div>
                ${progressHtml}
                <div class="batch-item-actions">
                    ${item.status === 'failed' ? `
                        <button class="btn-icon btn-icon-sm" onclick="retryBatchItem('${item.id}')" title="Retry">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                            </svg>
                        </button>
                    ` : ''}
                    <button class="btn-icon btn-icon-sm" onclick="removeBatchItem('${item.id}')" title="Remove">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    });
    
    queueContainer.innerHTML = html;
}

function getStatusIcon(status) {
    const icons = {
        waiting: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
        </svg>`,
        processing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>`,
        completed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>`,
        failed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>`
    };
    return icons[status] || icons.waiting;
}

function getStatusText(status) {
    const texts = {
        waiting: 'Waiting',
        processing: 'Processing',
        completed: 'Completed',
        failed: 'Failed'
    };
    return texts[status] || 'Unknown';
}

function removeBatchItem(itemId) {
    if (batchState.isRunning) {
        const item = batchQueue.find(i => i.id == itemId);
        if (item && item.status === 'processing') {
            showToast('Cannot remove item while it is being processed', 'error');
            return;
        }
    }
    
    batchQueue = batchQueue.filter(item => item.id != itemId);
    updateBatchUI();
    showToast('Item removed from queue', 'info');
}

function retryBatchItem(itemId) {
    const item = batchQueue.find(i => i.id == itemId);
    if (item) {
        item.status = 'waiting';
        item.progress = 0;
        item.error = null;
        item.startTime = null;
        item.endTime = null;
        updateBatchUI();
        showToast('Item queued for retry', 'info');
    }
}

// ── PDF Viewer Functions ───────────────────────────────────────
let pdfDoc = null;
let currentPage = 1;
let currentZoom = 1.0;
let pdfTextContent = '';
let searchResults = [];
let currentSearchIndex = 0;

async function openPDFViewer(pdfPath, pdfName) {
    const modal = document.getElementById('pdfViewerModal');
    const title = document.getElementById('pdfViewerTitle');
    const loading = document.getElementById('pdfLoading');
    const canvas = document.getElementById('pdfCanvas');
    
    if (!modal || !title || !loading || !canvas) return;
    
    // Show modal
    modal.classList.add('show');
    title.textContent = pdfName;
    loading.style.display = 'flex';
    
    try {
        // Load PDF
        const pdfUrl = `/api/pdf-file?path=${encodeURIComponent(pdfPath)}`;
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        pdfDoc = await loadingTask.promise;
        
        // Update page info
        document.getElementById('pdfTotalPages').textContent = pdfDoc.numPages;
        currentPage = 1;
        
        // Render first page
        await renderPDFPage(currentPage);
        
        // Generate page thumbnails
        await generatePDFThumbnails();
        
        // Extract text for searching
        await extractPDFText();
        
        // Hide loading
        loading.style.display = 'none';
        
        showToast('PDF loaded successfully', 'success');
        
    } catch (error) {
        console.error('Error loading PDF:', error);
        loading.style.display = 'none';
        showToast('Failed to load PDF: ' + error.message, 'error');
        closePDFViewer();
    }
}

async function renderPDFPage(pageNum) {
    if (!pdfDoc) return;
    
    const canvas = document.getElementById('pdfCanvas');
    const ctx = canvas.getContext('2d');
    
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: currentZoom });
        
        // Set canvas dimensions
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        // Render page
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        
        await page.render(renderContext).promise;
        
        // Update page info
        document.getElementById('pdfCurrentPage').textContent = pageNum;
        
        // Update navigation buttons
        updatePDFNavigation();
        
        // Update thumbnail active state
        updateThumbnailActive(pageNum);
        
    } catch (error) {
        console.error('Error rendering PDF page:', error);
        showToast('Failed to render page', 'error');
    }
}

async function generatePDFThumbnails() {
    const container = document.getElementById('pdfPageThumbnails');
    if (!container || !pdfDoc) return;
    
    let html = '';
    
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        html += `
            <div class="pdf-page-thumbnail" data-page="${i}" onclick="goToPDFPage(${i})">
                <canvas id="thumb-${i}"></canvas>
                <div class="pdf-page-number">${i}</div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    
    // Render thumbnails
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        await renderPDFThumbnail(i);
    }
}

async function renderPDFThumbnail(pageNum) {
    const canvas = document.getElementById(`thumb-${pageNum}`);
    if (!canvas || !pdfDoc) return;
    
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.3 });
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const ctx = canvas.getContext('2d');
        await page.render({
            canvasContext: ctx,
            viewport: viewport
        }).promise;
        
    } catch (error) {
        console.error('Error rendering thumbnail:', error);
    }
}

async function extractPDFText() {
    if (!pdfDoc) return;
    
    let fullText = '';
    
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        try {
            const page = await pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items
                .map(item => item.str)
                .join(' ');
            fullText += pageText + '\n';
        } catch (error) {
            console.error('Error extracting text from page', i, error);
        }
    }
    
    pdfTextContent = fullText;
    document.getElementById('pdfTextContent').textContent = fullText;
}

function goToPDFPage(pageNum) {
    if (pageNum < 1 || pageNum > pdfDoc.numPages) return;
    currentPage = pageNum;
    renderPDFPage(currentPage);
}

function previousPDFPage() {
    if (currentPage > 1) {
        goToPDFPage(currentPage - 1);
    }
}

function nextPDFPage() {
    if (currentPage < pdfDoc.numPages) {
        goToPDFPage(currentPage + 1);
    }
}

function updatePDFNavigation() {
    const prevBtn = document.getElementById('pdfPrevBtn');
    const nextBtn = document.getElementById('pdfNextBtn');
    
    if (prevBtn) {
        prevBtn.disabled = currentPage <= 1;
    }
    
    if (nextBtn) {
        nextBtn.disabled = currentPage >= pdfDoc.numPages;
    }
}

function updateThumbnailActive(pageNum) {
    const thumbnails = document.querySelectorAll('.pdf-page-thumbnail');
    thumbnails.forEach(thumb => {
        thumb.classList.toggle('active', parseInt(thumb.dataset.page) === pageNum);
    });
}

function zoomInPDF() {
    if (currentZoom < 3.0) {
        currentZoom += 0.25;
        updatePDFZoom();
    }
}

function zoomOutPDF() {
    if (currentZoom > 0.25) {
        currentZoom -= 0.25;
        updatePDFZoom();
    }
}

function resetPDFZoom() {
    currentZoom = 1.0;
    updatePDFZoom();
}

function updatePDFZoom() {
    document.getElementById('pdfZoomLevel').textContent = Math.round(currentZoom * 100) + '%';
    renderPDFPage(currentPage);
}

function searchInPDF() {
    const searchInput = document.getElementById('pdfSearchInput');
    const searchResults = document.getElementById('pdfSearchResults');
    const searchTerm = searchInput.value.trim();
    
    if (!searchTerm) {
        searchResults.classList.remove('show');
        clearPDFHighlights();
        return;
    }
    
    // Search in extracted text
    const lines = pdfTextContent.split('\n');
    const results = [];
    
    lines.forEach((line, lineIndex) => {
        const regex = new RegExp(searchTerm, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
            results.push({
                page: Math.floor(lineIndex / 20) + 1, // Rough estimation
                line: lineIndex,
                text: line.substring(match.index, match.index + match[0].length),
                context: line.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50)
            });
        }
    });
    
    displaySearchResults(results);
    highlightSearchResults(searchTerm);
}

function displaySearchResults(results) {
    const resultsContainer = document.getElementById('pdfSearchResults');
    
    if (results.length === 0) {
        resultsContainer.innerHTML = '<div class="pdf-search-result">No results found</div>';
        resultsContainer.classList.add('show');
        return;
    }
    
    let html = '';
    results.slice(0, 10).forEach((result, index) => {
        html += `
            <div class="pdf-search-result" onclick="goToSearchResult(${index})">
                <span class="pdf-search-result-page">Page ${result.page}</span>
                <span class="pdf-search-result-text">${escapeHtml(result.context)}</span>
            </div>
        `;
    });
    
    if (results.length > 10) {
        html += `<div class="pdf-search-result">... and ${results.length - 10} more results</div>`;
    }
    
    resultsContainer.innerHTML = html;
    resultsContainer.classList.add('show');
    searchResults = results;
    currentSearchIndex = 0;
}

function highlightSearchResults(searchTerm) {
    const textContent = document.getElementById('pdfTextContent');
    if (!textContent) return;
    
    let html = pdfTextContent;
    const regex = new RegExp(`(${searchTerm})`, 'gi');
    html = html.replace(regex, '<span class="pdf-text-highlight">$1</span>');
    
    textContent.innerHTML = html;
}

function clearPDFHighlights() {
    const textContent = document.getElementById('pdfTextContent');
    if (textContent) {
        textContent.textContent = pdfTextContent;
    }
}

function goToSearchResult(index) {
    if (searchResults[index]) {
        const result = searchResults[index];
        goToPDFPage(result.page);
        document.getElementById('pdfSearchResults').classList.remove('show');
    }
}

function closePDFViewer() {
    const modal = document.getElementById('pdfViewerModal');
    if (modal) {
        modal.classList.remove('show');
        pdfDoc = null;
        currentPage = 1;
        currentZoom = 1.0;
        pdfTextContent = '';
        searchResults = [];
        currentSearchIndex = 0;
    }
}

// Add keyboard shortcuts for PDF viewer
document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('pdfViewerModal');
    if (!modal || !modal.classList.contains('show')) return;
    
    switch(e.key) {
        case 'ArrowLeft':
            previousPDFPage();
            break;
        case 'ArrowRight':
            nextPDFPage();
            break;
        case '+':
        case '=':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomInPDF();
            }
            break;
        case '-':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomOutPDF();
            }
            break;
        case '0':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                resetPDFZoom();
            }
            break;
        case 'f':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                document.getElementById('pdfSearchInput').focus();
            }
            break;
        case 'Escape':
            closePDFViewer();
            break;
    }
});

// Initialize PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── Smart Notification Functions ──────────────────────────────────
function showProcessingStarted(fileName) {
    showSmartNotification('processing-started', { fileName });
}

function showRotationCompleted(fileName) {
    showSmartNotification('rotation-completed', { fileName });
}

function showPDFReady(fileName) {
    showSmartNotification('pdf-ready', { fileName });
}

function showManualReview(count) {
    showSmartNotification('manual-review', { count });
}

function showBatchCompleted(processed, failed) {
    showSmartNotification('batch-completed', { processed, failed });
}
