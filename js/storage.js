/* =========================================================
   storage.js — book PDFs in Supabase Storage (global object: StorageService)

   StorageService.validatePdf(file)             -> Promise<{ valid, error }>
   StorageService.pdfPathFor(bookId)            -> "<bookId>.pdf"
   StorageService.uploadPdf(file, bookId)       -> Promise<{ pdf_path, pdf_size }>   (also used to REPLACE)
   StorageService.deletePdf(path)               -> Promise<boolean>
   StorageService.getSignedUrl(path, seconds)   -> Promise<string>   (private bucket, expires)
   StorageService.getDownloadUrl(path, name)    -> Promise<string>   (forces a download)
   StorageService.inspectPdf(file, canvas?)     -> Promise<{ pages } | { error } | null>
   StorageService.loadPdfJs()                   -> Promise<pdfjsLib>
   StorageService.createPdfPicker(container, { existing, onChange })
                                                -> { getFile, hasNewFile, validate, clear, setExisting, setError, getPages }
   StorageService.formatBytes(n)

   Flow: Browser -> Supabase Storage (bucket library-pdfs/<bookId>.pdf) -> pdf_path -> books table.
   The bucket is PRIVATE. The reader gets a short-lived signed URL, never a public link.
   Replacing a PDF overwrites the SAME path, so no old file is left behind.
   Needs (loaded before): config.js, ui.js, supabase.js
   ========================================================= */

const StorageService = (() => {
    const cfg = window.APP_CONFIG;
    const BUCKET = cfg.storage.pdfBucket;
    const MAX_MB = cfg.storage.maxPdfSizeMB;

    const signedCache = new Map(); // path -> { url, expiresAt }

    const client = () => SupabaseService.getClient();
    const forget = (path) => { signedCache.delete(path); signedCache.delete(`${path}|dl`); };

    function formatBytes(bytes) {
        if (!bytes && bytes !== 0) return "";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // Turns technical errors into messages for people; details go to the console.
    function friendlyError(err, fallback) {
        const msg = ((err && err.message) || "").toLowerCase();
        const status = Number(err && (err.statusCode || err.status));
        if (msg.includes("not configured")) return err.message;
        if (msg.includes("row-level security") || msg.includes("unauthorized") || status === 401 || status === 403) {
            return "You don't have permission to perform this action.";
        }
        if (msg.includes("exceeded") || msg.includes("too large") || msg.includes("maximum allowed size") || status === 413) {
            return `The PDF is larger than the ${MAX_MB} MB limit.`;
        }
        if (msg.includes("mime")) return "Only PDF files are accepted.";
        if (msg.includes("bucket not found")) return "The storage bucket was not found. Run the database setup first.";
        if (msg.includes("not found")) return "PDF not found.";
        if (msg.includes("failed to fetch") || msg.includes("network")) {
            return "Please check your connection and try again.";
        }
        return fallback;
    }

    function assertBookId(bookId) {
        if (!bookId || !/^[\w-]+$/.test(String(bookId))) {
            throw new Error("A valid book ID is required.");
        }
    }

    const pdfPathFor = (bookId) => { assertBookId(bookId); return `${bookId}.pdf`; };

    /* ---------- Validation ---------- */
    // Checks extension, MIME type, size AND the real file header ("%PDF-").
    async function validatePdf(file) {
        const fail = (error) => ({ valid: false, error });
        if (!file) return fail("Choose a PDF file.");

        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (ext !== "pdf") return fail("Only PDF files are accepted.");
        if (file.type !== "application/pdf") return fail("Only PDF files are accepted.");
        if (file.size === 0) return fail("This file is empty.");
        if (file.size > MAX_MB * 1024 * 1024) return fail(`The PDF must be smaller than ${MAX_MB} MB.`);

        const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
        const text = Array.from(head, (b) => String.fromCharCode(b)).join("");
        if (!text.includes("%PDF-")) return fail("This file is not a valid PDF.");

        return { valid: true, error: "" };
    }

    /* ---------- Upload / replace / delete ---------- */

    // Uploads <bookId>.pdf. upsert:true means the same call REPLACES an existing PDF in place.
    async function uploadPdf(file, bookId) {
        const check = await validatePdf(file);
        if (!check.valid) throw new Error(check.error);

        const path = pdfPathFor(bookId);
        const { error } = await client().storage.from(BUCKET).upload(path, file, {
            contentType: "application/pdf",
            upsert: true,
            cacheControl: "60"
        });
        if (error) {
            console.error("[storage.js] Upload failed:", error);
            throw new Error(friendlyError(error, "Unable to upload PDF. Please check your connection and try again."));
        }
        forget(path);
        return { pdf_path: path, pdf_size: file.size };
    }

    // Returns true only when the file was really removed (RLS can silently remove nothing).
    async function deletePdf(path) {
        if (!path) return false;
        const { data, error } = await client().storage.from(BUCKET).remove([path]);
        forget(path);
        if (error) {
            console.error("[storage.js] Delete failed:", error);
            return false;
        }
        return Array.isArray(data) && data.length > 0;
    }

    /* ---------- URLs ---------- */

    // Short-lived link to a private PDF. The database decides (RLS) whether this user may have it.
    async function getSignedUrl(path, expiresIn = 3600, downloadName) {
        if (!path) throw new Error("This book has no PDF.");

        const key = downloadName ? `${path}|dl` : path;
        const hit = signedCache.get(key);
        if (hit && hit.expiresAt - Date.now() > 60000) return hit.url;

        const options = downloadName ? { download: downloadName } : undefined;
        const { data, error } = await client().storage.from(BUCKET).createSignedUrl(path, expiresIn, options);
        if (error || !data || !data.signedUrl) {
            console.error("[storage.js] Signed URL failed:", error);
            throw new Error(friendlyError(error, "PDF could not be loaded."));
        }
        signedCache.set(key, { url: data.signedUrl, expiresAt: Date.now() + expiresIn * 1000 });
        return data.signedUrl;
    }

    const getDownloadUrl = (path, filename = "book.pdf") => getSignedUrl(path, 300, filename);

    /* ---------- PDF.js (loaded only when needed) ---------- */
    let pdfjsPromise = null;

    function loadPdfJs() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (!pdfjsPromise) {
            pdfjsPromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = cfg.pdfjs.libUrl;
                script.onload = () => {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.pdfjs.workerUrl;
                    resolve(window.pdfjsLib);
                };
                script.onerror = () => { pdfjsPromise = null; reject(new Error("PDF.js failed to load.")); };
                document.head.appendChild(script);
            });
        }
        return pdfjsPromise;
    }

    // Reads page count and (optionally) draws page 1 onto a canvas.
    // Returns { pages }, { error } for unreadable PDFs, or null if PDF.js itself is unavailable.
    async function inspectPdf(file, canvas) {
        let lib;
        try { lib = await loadPdfJs(); } catch (err) { console.warn("[storage.js]", err.message); return null; }

        try {
            const data = new Uint8Array(await file.arrayBuffer());
            const pdf = await lib.getDocument({ data }).promise;
            const pages = pdf.numPages;
            if (canvas) {
                const page = await pdf.getPage(1);
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: 180 / base.width });
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            }
            pdf.destroy();
            return { pages };
        } catch (err) {
            console.warn("[storage.js] PDF could not be read:", err);
            if (err && err.name === "PasswordException") return { error: "Password-protected PDFs are not supported." };
            return { error: "This PDF appears to be damaged and can't be opened." };
        }
    }

    /* ---------- PDF picker (drop zone + file card) ---------- */
    let pickerCount = 0;

    function createPdfPicker(container, { existing = null, onChange } = {}) {
        const inputId = `pdfInput${++pickerCount}`;
        container.innerHTML = `
            <div class="pdf-picker">
                <input type="file" id="${inputId}" class="sr-only" aria-label="PDF file" accept=".pdf,application/pdf">
                <div class="pdf-drop" role="button" tabindex="0" aria-label="Choose a PDF file">
                    <div class="pdf-empty">
                        <i class="fa-solid fa-file-pdf icon" style="font-size:2.2rem;color:var(--accent);margin-bottom:0.4rem"></i>
                        <strong>Add PDF File</strong>
                        <span class="muted">Drop a file or click. PDF only, up to ${MAX_MB} MB.</span>
                    </div>
                    <div class="pdf-file" hidden>
                        <canvas class="pdf-thumb" hidden></canvas>
                        <div class="pdf-meta">
                            <strong class="pdf-name"></strong>
                            <span class="muted pdf-size"></span>
                            <span class="muted pdf-pages"></span>
                        </div>
                    </div>
                </div>
                <div class="cover-actions">
                    <button type="button" class="btn" data-role="replace" hidden><i class="fa-solid fa-arrows-rotate icon"></i> Replace</button>
                    <button type="button" class="btn" data-role="remove" hidden><i class="fa-solid fa-xmark icon"></i> Remove</button>
                </div>
                <span class="field-error" role="alert"></span>
            </div>`;
        UI.refreshIcons();

        const q = (sel) => container.querySelector(sel);
        const input = q("input");
        const drop = q(".pdf-drop");
        const emptyEl = q(".pdf-empty");
        const fileEl = q(".pdf-file");
        const thumb = q(".pdf-thumb");
        const nameEl = q(".pdf-name");
        const sizeEl = q(".pdf-size");
        const pagesEl = q(".pdf-pages");
        const replaceBtn = q('[data-role="replace"]');
        const removeBtn = q('[data-role="remove"]');
        const errorEl = q(".field-error");

        let file = null;          // newly chosen file (not uploaded yet)
        let current = existing;   // { path, size, pages? } of the PDF already saved, when editing
        let pages = null;
        let token = 0;            // ignores slow inspections of a file that was already replaced

        const setError = (m) => { errorEl.textContent = m || ""; };

        function render() {
            const shown = file ? { name: file.name, size: file.size } : current ? { name: current.path, size: current.size } : null;
            emptyEl.hidden = Boolean(shown);
            fileEl.hidden = !shown;
            replaceBtn.hidden = !shown;
            removeBtn.hidden = !file;
            if (shown) {
                nameEl.textContent = shown.name;
                sizeEl.textContent = formatBytes(shown.size);
                const p = file ? pages : current && current.pages;
                pagesEl.textContent = p ? `${p} pages` : file ? "Reading PDF..." : "";
            }
            if (!file) thumb.hidden = true;
        }

        async function handleFile(candidate) {
            const result = await validatePdf(candidate);
            if (!result.valid) {
                setError(result.error);
                UI.toast.error(`Invalid PDF. ${result.error}`);
                return;
            }
            setError("");
            file = candidate;
            pages = null;
            const mine = ++token;
            render();
            if (onChange) onChange(file);

            const info = await inspectPdf(candidate, thumb);
            if (mine !== token) return; // user picked another file meanwhile
            if (info && info.error) {
                clear();
                setError(info.error);
                UI.toast.error(`Invalid PDF. ${info.error}`);
                return;
            }
            if (info) {
                pages = info.pages;
                thumb.hidden = false;
            } else {
                pagesEl.textContent = ""; // PDF.js unavailable: skip pages and thumbnail
            }
            render();
        }

        function clear() {
            token++;
            file = null;
            pages = null;
            input.value = "";
            setError("");
            render();
            if (onChange) onChange(null);
        }

        const openPicker = () => input.click();
        drop.addEventListener("click", openPicker);
        drop.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
        });
        replaceBtn.addEventListener("click", openPicker);
        removeBtn.addEventListener("click", clear);
        input.addEventListener("change", () => {
            const chosen = input.files && input.files[0];
            input.value = "";
            if (chosen) handleFile(chosen);
        });
        drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
        drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
        drop.addEventListener("drop", (e) => {
            e.preventDefault();
            drop.classList.remove("dragover");
            const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (dropped) handleFile(dropped);
        });

        render();

        return {
            getFile: () => file,
            hasNewFile: () => file !== null,
            getPages: () => pages,
            clear,
            setError,
            setExisting(value) { current = value; render(); },
            // Call before saving. Pass { required: false } when editing and keeping the current PDF.
            validate({ required = true } = {}) {
                if (required && !file && !current) {
                    setError("Choose a PDF file.");
                    return false;
                }
                return true;
            }
        };
    }

    return {
        formatBytes, validatePdf, pdfPathFor, uploadPdf, deletePdf,
        getSignedUrl, getDownloadUrl, inspectPdf, loadPdfJs, createPdfPicker
    };
})();

window.StorageService = StorageService;