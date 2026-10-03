/* =========================================================
   pdf-reader.js — PDF.js reader (global object: PdfReader)

   PdfReader.initPage()      controller for reader.html  (?id=<book uuid>&page=<n>)
   PdfReader.createViewer()  PDF.js viewer wired to the controls in reader.html

   How it works
     1. Logged-in check (Auth.requireAuth). Admins may open drafts, users only published books.
     2. The book row is read from Supabase (RLS checks access again in the database).
     3. A signed URL (valid 1 hour) is created for the PRIVATE pdf in Supabase Storage.
     4. PDF.js downloads it. Every page gets an empty placeholder (so the scrollbar is the right
        length), and only the pages near the screen are drawn on <canvas>. Pages that scroll far
        away are released from memory again.
     5. Scroll normally to read. Prev/Next, the page box and the keyboard jump between pages.

   Needs (loaded before): config.js, ui.js, supabase.js, auth.js, cloudinary.js, books.js
   PDF.js itself is loaded from the CDN set in config.js (APP_CONFIG.pdfjs).
   ========================================================= */

const PdfReader = (() => {
    const cfg = window.APP_CONFIG.pdfjs;
    const ZOOM_MIN = 0.3;
    const ZOOM_MAX = 4;
    const ZOOM_STEP = 0.25;
    const MAX_CANVAS_PIXELS = 16e6; // keeps big zoom levels inside what phones can draw
    const PAGE_GAP_OFFSET = 12;     // space left above a page when jumping to it
    const $ = (id) => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    /* ---------- Load PDF.js once ---------- */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error("Unable to load the PDF viewer library."));
            document.head.appendChild(s);
        });
    }
    async function ensurePdfJs() {
        if (!window.pdfjsLib) await loadScript(cfg.libUrl);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.workerUrl;
        return window.pdfjsLib;
    }

    function friendlyPdfError(err) {
        const name = (err && err.name) || "";
        const msg = ((err && err.message) || "").toLowerCase();
        if (name === "PasswordException") return "This PDF is password protected and can't be opened here.";
        if (name === "InvalidPDFException") return "This file isn't a valid PDF.";
        if (msg.includes("failed to fetch") || msg.includes("network")) return "Unable to reach the server. Please check your connection and try again.";
        if (msg.includes("viewer library")) return err.message;
        return "PDF could not be loaded.";
    }

    /* ---------- Viewer ---------- */
    function createViewer() {
        const root = $("reader");
        const stage = $("stage");
        const wrap = $("canvasWrap");
        const overlay = $("overlay");
        const els = {
            prev: $("prevBtn"), next: $("nextBtn"), pageInput: $("pageInput"), pageTotal: $("pageTotal"),
            zoomIn: $("zoomInBtn"), zoomOut: $("zoomOutBtn"), fit: $("fitBtn"), zoomLabel: $("zoomLabel"),
            fs: $("fsBtn"), download: $("downloadBtn"), sr: $("srStatus")
        };

        let pdf = null;
        let page = 1;          // the page currently at the top of the screen
        let total = 0;
        let scale = 1;
        let fit = true;        // true = fit page width
        let base = null;       // size of page 1 at scale 1, used to estimate pages not drawn yet
        let pageEls = [];      // one placeholder <div> per page (index 0 = page 1)
        let observer = null;
        let lastOpen = null;   // lets "Try again" reload the document
        const sizes = new Map(); // real page sizes (scale 1), filled in as pages are drawn

        /* ----- overlay panels ----- */
        function showLoading(text) {
            overlay.hidden = false;
            overlay.innerHTML = `<div class="reader-panel">
                <div class="spinner" aria-hidden="true"></div>
                <p>${UI.esc(text)}</p>
                <div class="progress" id="progress" hidden><span id="progressBar"></span></div>
            </div>`;
        }
        function setProgress(fraction) {
            const box = $("progress");
            const bar = $("progressBar");
            if (!box || !bar) return;
            box.hidden = false;
            bar.style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
        }
        function hideOverlay() { overlay.hidden = true; overlay.innerHTML = ""; }

        // actions: [{ label, href?, onClick?, primary? }]
        function showPanel({ icon = "alert-circle", title, text = "", actions = [] }) {
            overlay.hidden = false;
            overlay.innerHTML = "";
            const panel = document.createElement("div");
            panel.className = "reader-panel";
            panel.innerHTML = `<i data-lucide="${UI.esc(icon)}" class="icon panel-icon"></i><h2>${UI.esc(title)}</h2><p class="muted">${UI.esc(text)}</p>`;
            const row = document.createElement("div");
            row.className = "panel-actions";
            actions.forEach((a) => {
                const el = document.createElement(a.href ? "a" : "button");
                el.className = `btn${a.primary ? " btn-primary" : ""}`;
                el.textContent = a.label;
                if (a.href) el.href = a.href; else { el.type = "button"; el.addEventListener("click", a.onClick); }
                row.appendChild(el);
            });
            panel.appendChild(row);
            overlay.appendChild(panel);
            UI.refreshIcons();
        }

        /* ----- controls ----- */
        function setControlsEnabled(on) {
            [els.prev, els.next, els.pageInput, els.zoomIn, els.zoomOut, els.fit].forEach((el) => { el.disabled = !on; });
            if (on) updateNav();
        }
        function updateNav() {
            els.prev.disabled = page <= 1;
            els.next.disabled = page >= total;
            if (document.activeElement !== els.pageInput) els.pageInput.value = page;
            els.pageTotal.textContent = total || "–";
            els.zoomOut.disabled = scale <= ZOOM_MIN;
            els.zoomIn.disabled = scale >= ZOOM_MAX;
            els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
            els.fit.setAttribute("aria-pressed", String(fit));
        }
        // Keep ?page=N in the address bar (debounced; scrolling fires constantly)
        let syncTimer;
        function scheduleSync() {
            clearTimeout(syncTimer);
            syncTimer = setTimeout(() => {
                const p = new URLSearchParams(location.search);
                p.set("page", String(page));
                history.replaceState(null, "", `?${p}`);
                els.sr.textContent = `Page ${page} of ${total}`;
            }, 300);
        }

        /* ----- layout: one placeholder per page, sized from the real or estimated page size ----- */
        function padX() {
            const cs = getComputedStyle(wrap);
            return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        }
        function computeFit() { return clamp((stage.clientWidth - padX()) / base.w, ZOOM_MIN, ZOOM_MAX); }
        function sizeEl(el, n) {
            const s = sizes.get(n) || base;
            el.style.width = `${Math.floor(s.w * scale)}px`;
            el.style.height = `${Math.floor(s.h * scale)}px`;
        }
        const labelHtml = (n) => `<span class="page-label">${n}</span>`;

        function buildPages() {
            if (observer) observer.disconnect();
            pageEls = [];
            const frag = document.createDocumentFragment();
            for (let n = 1; n <= total; n++) {
                const el = document.createElement("div");
                el.className = "pdf-page";
                el.dataset.page = String(n);
                el.innerHTML = labelHtml(n);
                el._token = 0;
                sizeEl(el, n);
                frag.appendChild(el);
                pageEls.push(el);
            }
            wrap.replaceChildren(frag);

            // Draw pages within one screen of the viewport; release the ones that move further away.
            observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    const n = Number(entry.target.dataset.page);
                    if (entry.isIntersecting) renderInto(n); else release(n);
                });
            }, { root: stage, rootMargin: "100% 0px" });
            pageEls.forEach((el) => observer.observe(el));
        }

        // After a zoom or resize: resize every placeholder, keep the reader at the same spot, redraw what is visible.
        function relayout() {
            if (!pdf) return;
            const anchor = pageEls[page - 1];
            const frac = anchor ? (stage.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0;
            pageEls.forEach((el, i) => sizeEl(el, i + 1));
            const a = pageEls[page - 1];
            if (a) stage.scrollTop = a.offsetTop + frac * a.offsetHeight;
            observer.disconnect();                              // re-observing triggers a fresh pass:
            pageEls.forEach((el) => observer.observe(el));      // visible pages redraw, far ones are released
            updateNav();
        }

        /* ----- drawing a page ----- */
        // The real size of a page can differ from the estimate. If a page ABOVE the screen changes
        // height, scroll by the same amount so the text on screen doesn't jump.
        function adoptRealSize(el, n, natural) {
            const prev = sizes.get(n);
            if (prev && prev.w === natural.width && prev.h === natural.height) return;
            const oldHeight = el.offsetHeight;
            const oldTop = el.offsetTop;
            sizes.set(n, { w: natural.width, h: natural.height });
            sizeEl(el, n);
            const delta = el.offsetHeight - oldHeight;
            if (delta && oldTop + oldHeight <= stage.scrollTop) stage.scrollTop += delta;
        }

        async function renderInto(n) {
            const el = pageEls[n - 1];
            if (!el || !pdf) return;
            if (el.dataset.state === "ready" && el._renderedScale === scale) return;

            const token = ++el._token;
            if (el._task) { try { el._task.cancel(); } catch (_) { /* already finished */ } el._task = null; }

            try {
                const pdfPage = await pdf.getPage(n);
                if (token !== el._token) return;

                const natural = pdfPage.getViewport({ scale: 1 });
                const viewport = pdfPage.getViewport({ scale });
                let ratio = Math.min(window.devicePixelRatio || 1, 2);
                ratio = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));

                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
                canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
                canvas.setAttribute("role", "img");
                canvas.setAttribute("aria-label", `Page ${n} of ${total}`);

                const task = pdfPage.render({
                    canvasContext: canvas.getContext("2d"),
                    viewport,
                    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null
                });
                el._task = task;
                await task.promise;
                if (token !== el._token) return;
                el._task = null;

                adoptRealSize(el, n, natural);
                el.replaceChildren(canvas);
                el.classList.add("rendered");
                el.dataset.state = "ready";
                el._renderedScale = scale;
            } catch (err) {
                if (err && err.name === "RenderingCancelledException") return;
                console.error(`[pdf-reader.js] Page ${n} failed to render:`, err);
                if (token !== el._token) return;
                el.classList.remove("rendered");
                el.dataset.state = "failed";
                el._renderedScale = null;
                el.innerHTML = `<button type="button" class="page-retry btn">Page ${n} could not be displayed. Try again</button>`;
                el.querySelector("button").addEventListener("click", () => {
                    el.innerHTML = labelHtml(n);
                    el.dataset.state = "";
                    renderInto(n);
                });
            }
        }

        function release(n) {
            const el = pageEls[n - 1];
            if (!el) return;
            el._token++;
            if (el._task) { try { el._task.cancel(); } catch (_) { /* already finished */ } el._task = null; }
            if (el.dataset.state) {
                el.innerHTML = labelHtml(n);
                el.classList.remove("rendered");
                el.dataset.state = "";
                el._renderedScale = null;
            }
        }

        /* ----- which page is on screen? (binary search over the placeholders' positions) ----- */
        function updateCurrentPage() {
            if (!pageEls.length) return;
            const probe = stage.scrollTop + stage.clientHeight * 0.3;
            let lo = 0, hi = pageEls.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (pageEls[mid].offsetTop <= probe) lo = mid; else hi = mid - 1;
            }
            let n = lo + 1;
            if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2) n = total; // reached the end
            if (stage.scrollTop <= 1) n = 1;
            if (n !== page) { page = n; updateNav(); scheduleSync(); }
        }
        let ticking = false;
        stage.addEventListener("scroll", () => {
            if (!pdf || ticking) return;
            ticking = true;
            requestAnimationFrame(() => { ticking = false; updateCurrentPage(); });
        }, { passive: true });

        /* ----- navigation and zoom ----- */
        function goTo(num, { smooth = false } = {}) {
            if (!pdf) return;
            const n = clamp(Math.round(Number(num)) || page, 1, total);
            page = n;
            updateNav();
            stage.scrollTo({ top: Math.max(0, pageEls[n - 1].offsetTop - PAGE_GAP_OFFSET), behavior: smooth ? "smooth" : "auto" });
            scheduleSync();
        }
        function setZoom(next) {
            if (!pdf) return;
            fit = false;
            scale = Math.round(clamp(next, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
            relayout();
        }
        function fitWidth() {
            if (!pdf) return;
            fit = true;
            scale = computeFit();
            relayout();
        }

        /* ----- fullscreen (falls back to an in-page expanded mode where the API is missing, e.g. iPhone) ----- */
        function updateFsIcon() {
            const on = Boolean(document.fullscreenElement) || root.classList.contains("reader--expanded");
            els.fs.innerHTML = `<i data-lucide="${on ? "minimize" : "maximize"}" class="icon"></i>`;
            els.fs.setAttribute("aria-label", on ? "Exit fullscreen" : "Enter fullscreen");
            UI.refreshIcons();
        }
        function toggleFullscreen() {
            if (document.fullscreenEnabled) {
                if (document.fullscreenElement) document.exitFullscreen();
                else root.requestFullscreen().catch((err) => console.error("[pdf-reader.js] Fullscreen failed:", err));
            } else {
                root.classList.toggle("reader--expanded");
                updateFsIcon();
            }
        }

        /* ----- open a document ----- */
        // getUrl: async () => url   (called again on "Try again", so an expired signed URL is replaced)
        async function open(getUrl, { startPage = 1 } = {}) {
            lastOpen = { getUrl, startPage };
            showLoading("Loading PDF...");
            setControlsEnabled(false);
            try {
                const lib = await ensurePdfJs();
                const url = await getUrl();
                if (pdf) { pdf.destroy(); pdf = null; }

                const task = lib.getDocument({ url });
                task.onProgress = ({ loaded, total: size }) => { if (size) setProgress(loaded / size); };
                const doc = await task.promise;

                // Page 1 gives the size estimate for every placeholder
                const first = (await doc.getPage(1)).getViewport({ scale: 1 });
                base = { w: first.width, h: first.height };
                sizes.clear();
                sizes.set(1, base);

                pdf = doc;
                total = doc.numPages;
                page = clamp(startPage, 1, total);
                fit = true;
                scale = computeFit();
                els.pageInput.max = total;

                buildPages();
                hideOverlay();
                setControlsEnabled(true);
                if (page > 1) goTo(page);
            } catch (err) {
                console.error("[pdf-reader.js] Loading PDF failed:", err);
                showPanel({
                    title: "Unable to open this PDF",
                    text: friendlyPdfError(err),
                    actions: [{ label: "Try again", primary: true, onClick: () => open(lastOpen.getUrl, { startPage: page }) }]
                });
            }
        }

        /* ----- events ----- */
        els.prev.addEventListener("click", () => goTo(page - 1, { smooth: true }));
        els.next.addEventListener("click", () => goTo(page + 1, { smooth: true }));
        els.pageInput.addEventListener("change", () => goTo(els.pageInput.value));
        els.pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); goTo(els.pageInput.value); stage.focus(); } });
        els.zoomIn.addEventListener("click", () => setZoom(scale + ZOOM_STEP));
        els.zoomOut.addEventListener("click", () => setZoom(scale - ZOOM_STEP));
        els.fit.addEventListener("click", fitWidth);
        els.fs.addEventListener("click", toggleFullscreen);
        document.addEventListener("fullscreenchange", updateFsIcon);

        // Arrow Up/Down, Space, PageUp/PageDown, Home/End scroll natively while the page area has focus.
        document.addEventListener("keydown", (e) => {
            if (!pdf || e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
            const canTurn = stage.scrollWidth <= stage.clientWidth + 1; // when zoomed wide, ←/→ scroll sideways instead
            switch (e.key) {
                case "ArrowLeft": if (canTurn) { e.preventDefault(); goTo(page - 1, { smooth: true }); } break;
                case "ArrowRight": if (canTurn) { e.preventDefault(); goTo(page + 1, { smooth: true }); } break;
                case "+": case "=": e.preventDefault(); setZoom(scale + ZOOM_STEP); break;
                case "-": case "_": e.preventDefault(); setZoom(scale - ZOOM_STEP); break;
                case "0": fitWidth(); break;
                case "f": case "F": toggleFullscreen(); break;
                case "Escape": if (root.classList.contains("reader--expanded")) toggleFullscreen(); break;
            }
        });

        // Re-fit when the window changes size (rotate phone, resize, enter fullscreen)
        let resizeTimer;
        new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!pdf || !fit) return;
                const next = computeFit();
                if (Math.abs(next - scale) > 0.005) { scale = next; relayout(); }
            }, 150);
        }).observe(stage);

        updateFsIcon();
        setControlsEnabled(false);

        return { open, showPanel, showLoading, hideOverlay, downloadButton: els.download };
    }

    /* ---------- Page controller (reader.html) ---------- */
    async function initPage() {
        const viewer = createViewer();

        const user = await Auth.requireAuth();   // sends logged-out visitors to login and back here
        if (!user) return;

        const params = new URLSearchParams(location.search);
        const id = params.get("id");

        let profile = null;
        try { profile = await Auth.getProfile(); } catch (err) { console.error("[pdf-reader.js] Profile load failed:", err); }
        const admin = Auth.isAdmin(profile);
        const libraryHref = admin ? "admin/books.html" : "books.html";

        // Back button: return to wherever the reader came from, otherwise to the library or book page
        const backBtn = $("backBtn");
        backBtn.href = id && !admin ? `book-details.html?id=${encodeURIComponent(id)}` : libraryHref;
        backBtn.addEventListener("click", (e) => {
            if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
                e.preventDefault();
                history.back();
            }
        });

        if (!id) {
            viewer.showPanel({
                icon: "book-open", title: "No book selected", text: "Choose a book from the library to start reading.",
                actions: [{ label: "Browse books", href: libraryHref, primary: true }]
            });
            return;
        }

        viewer.showLoading("Loading book...");
        let book;
        try {
            book = await BooksService.getBook(id, { publishedOnly: !admin });
        } catch (err) {
            console.error("[pdf-reader.js] Loading book failed:", err);
            viewer.showPanel({
                icon: "wifi-off", title: "Unable to load this book", text: "Please check your connection and try again.",
                actions: [{ label: "Try again", primary: true, onClick: () => location.reload() }, { label: "Back to library", href: libraryHref }]
            });
            return;
        }
        if (!book) {
            viewer.showPanel({
                icon: "book-x", title: "Book not found", text: "It may have been removed or is not available yet.",
                actions: [{ label: "Back to library", href: libraryHref, primary: true }]
            });
            return;
        }

        $("readerTitle").textContent = book.title;
        $("readerAuthor").textContent = book.author;
        document.title = `${book.title} · ${window.APP_CONFIG.appName}`;

        // Download (a short-lived signed link that saves the file)
        const dl = viewer.downloadButton;
        dl.addEventListener("click", async () => {
            UI.setLoading(dl, true);
            try {
                location.assign(await BooksService.getDownloadUrl(book));
            } catch (err) {
                console.error("[pdf-reader.js] Download failed:", err);
                UI.toast.error("Unable to download this PDF. You may not have permission, or the file is missing.");
            } finally {
                setTimeout(() => UI.setLoading(dl, false), 800);
            }
        });

        // Signed URL for the private bucket, passed straight to PDF.js
        const getUrl = async () => {
            if (!book.pdf_path) throw new Error("This book has no PDF.");
            const { data, error } = await SupabaseService.getClient().storage
                .from(window.APP_CONFIG.storage.pdfBucket)
                .createSignedUrl(book.pdf_path, 3600);
            if (error) throw error;
            return data.signedUrl;
        };

        viewer.open(getUrl, { startPage: parseInt(params.get("page"), 10) || 1 });
    }

    return { initPage, createViewer };
})();

window.PdfReader = PdfReader;