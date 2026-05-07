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
    init2DHover();
    initCustomCursor();
    initUploadZone();
    const btnUpload = document.getElementById("btnUpload");
    if (btnUpload) {
        btnUpload.addEventListener("click", uploadFiles);
    }
    document.getElementById("btnAutoScroll").classList.add("active");
    
    const welcomeArtContainer = document.getElementById("welcomeArt");
    if (welcomeArtContainer) {
        welcomeArtContainer.textContent = [
            "╔══════════════════════════════════════════════════════════════╗",
            "║                                                              ║",
            "║          OCR ROTATION ENGINE v10.2 PREMIUM                   ║",
            "║                                                              ║",
            "║  ═════════════════════════════════════════════════════════   ║",
            "║                                                              ║",
            "║     UPLOAD  +  CONVERT  +  ROTATE  +  DOWNLOAD               ║",
            "║                                                              ║",
            "║           Drop PDF files to get started                      ║",
            "║                                                              ║",
            "╚══════════════════════════════════════════════════════════════╝"
        ].join("\n");
    }
    
    // Loader
    const loader = document.getElementById("loader");
    const loaderPercent = document.getElementById("loader-percentage");
    const loaderFill = document.getElementById("loaderFill");
    const loaderStatus = document.getElementById("loaderStatus");
    if(loader && loaderPercent && loaderFill && loaderStatus) {
        let p = 0;
        const statusMessages = [
            "Initializing...",
            "Loading modules...",
            "Preparing OCR engine...",
            "Setting up environment...",
            "Finalizing setup...",
            "Almost ready..."
        ];
        const interval = setInterval(() => {
            p += Math.floor(Math.random() * 3) + 1;
            if(p >= 100) {
                p = 100;
                clearInterval(interval);
                loaderStatus.textContent = "Complete!";
                setTimeout(() => { loader.classList.add("hidden"); }, 800);
            }
            loaderPercent.textContent = p + "%";
            loaderFill.style.width = p + "%";
            
            // Update status message based on progress
            const statusIndex = Math.min(Math.floor(p / 20), statusMessages.length - 1);
            loaderStatus.textContent = statusMessages[statusIndex];
        }, 80);
    }
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
                <span class="upload-file-size">${(f.file.size / (1024*1024)).toFixed(1)} MB</span>
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
    else if (step === 2) startProcess("convert");
    else if (step === 3) startProcess("rotate");
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
            // PDF done → auto start Images
            showToast("PDF processing complete! Starting image conversion...", "success");
            setTimeout(() => startPipelineStep(2), 1500);
        } else if (pipelineStep === 2 && pipelineAutoChain) {
            // Images done → auto start Auto Rotate
            showToast("Image conversion complete! Starting Auto Rotate...", "success");
            setTimeout(() => startPipelineStep(3), 1500);
        } else if (pipelineStep === 3) {
            // Auto Rotate done → show download
            showToast("All processing complete! Results ready for download.", "success");
            setPipelineStep(4);
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
    if (converted.length > 0) categories.push({ id: 'converted', label: 'Converted', count: converted.reduce((a,b) => a + (b.pages || 0), 0), color: 'blue' });
    if (output.length > 0) categories.push({ id: 'output', label: 'Output', count: output.reduce((a,b) => a + (b.pages || 0), 0), color: 'emerald' });

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
        <div class="preview-item pdf-card" title="${escapeHtml(p)}" onclick="window.open('${escapeHtml(pdfUrl)}', '_blank')">
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
        document.querySelectorAll("button, a, .card, .stat-card, input, select, .action-btn, .btn-icon, .terminal-content, .upload-zone, .tree-folder-header, .upload-file-remove").forEach(el => {
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