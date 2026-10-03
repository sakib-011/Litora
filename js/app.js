/* =========================================================
   app.js — bootstraps every page.
   Phase 1: icons, sidebar, and the demo wiring for index.html.
   Later phases add auth checks and page-specific loaders here.
   ========================================================= */

// SAMPLE DATA — Phase 1 only. Replaced by real Supabase data in Phase 7.
const SAMPLE_BOOKS = [
    { id: "s1", title: "Computer Networks", author: "A. Tanenbaum", category: "Computer Science", cover_url: "", status: "published" },
    { id: "s2", title: "Clean Code", author: "R. Martin", category: "Software", cover_url: "", status: "published" },
    { id: "s3", title: "The Art of Design", author: "M. Okafor", category: "Design", cover_url: "", status: "draft" },
    { id: "s4", title: "Introduction to Algorithms", author: "T. Cormen", category: "Computer Science", cover_url: "", status: "published" }
];

document.addEventListener("DOMContentLoaded", () => {
    UI.renderNavbar(document.body.dataset.nav);   // pages with <div id="siteNav"></div>
    UI.refreshIcons();
    UI.initSidebar();

    // Page-specific startup. Each page sets <body data-page="...">.
    const pageStart = {
        login: () => Auth.initLoginPage(),
        register: () => Auth.initRegisterPage(),
        profile: () => window.User && User.initProfilePage(),
        "admin-dashboard": async () => {
            const profile = await Auth.requireAdmin();   // sends non-admins away
            if (!profile) return;
            const who = document.getElementById("adminWho");
            if (who) who.textContent = `Signed in as ${profile.full_name || profile.email} (administrator). Statistics and book management arrive in later phases.`;
        }
    };
    const start = pageStart[document.body.dataset.page];
    if (start) start();
    Auth.initNav();   // navbar buttons: Log in / Sign up, or Profile / Admin / Log out

    // Sample books (marked as sample data in the page)
    const grid = document.getElementById("sampleBooks");
    if (grid) {
        SAMPLE_BOOKS.forEach((book) => {
            grid.appendChild(UI.createBookCard(book, {
                admin: true,
                onRead: (b) => UI.toast.info(`Reader opens in Phase 9: "${b.title}"`),
                onEdit: (b) => UI.toast.info(`Editing arrives in Phase 8: "${b.title}"`),
                onDelete: async (b) => {
                    const ok = await UI.modal.confirm({
                        title: "Delete book?",
                        message: `Are you sure you want to delete <strong>"${UI.esc(b.title)}"</strong>? This will remove the book record, cover image and PDF.`,
                        confirmText: "Delete",
                        danger: true
                    });
                    if (ok) UI.toast.success("Book deleted successfully. (Demo only)");
                }
            }));
        });
        UI.refreshIcons();
    }

    // Links to pages that don't exist yet
    document.querySelectorAll("[data-soon]").forEach((el) =>
        el.addEventListener("click", (e) => {
            e.preventDefault();
            UI.toast.info(`${el.dataset.soon} is built in a later phase.`);
        }));

    // Demo buttons
    const actions = {
        "toast-success": () => UI.toast.success("Book created successfully."),
        "toast-error": () => UI.toast.error("Unable to upload PDF. Please check your connection and try again."),
        "toast-info": () => UI.toast.info("Loading books..."),
        "modal-confirm": async () => {
            const ok = await UI.modal.confirm({ title: "Log out?", message: "You will need to sign in again to continue reading.", confirmText: "Log out" });
            UI.toast[ok ? "success" : "info"](ok ? "Logged out. (Demo only)" : "Cancelled.");
        },
        "supabase-test": async (btn) => {
            UI.setLoading(btn, true, "Testing...");
            try {
                const result = await SupabaseService.testConnection();
                UI.toast[result.ok ? "success" : "error"](result.message, 6000);
            } catch (err) {
                console.error(err);
                UI.toast.error("Unable to reach Supabase. Please check your connection and try again.");
            } finally {
                UI.setLoading(btn, false);
            }
        },
        "button-loading": (btn) => {
            UI.setLoading(btn, true, "Saving book...");
            setTimeout(() => { UI.setLoading(btn, false); UI.toast.success("Book updated successfully."); }, 1800);
        }
    };
    document.querySelectorAll("[data-action]").forEach((btn) =>
        btn.addEventListener("click", () => actions[btn.dataset.action]?.(btn)));

    // Cover upload test (Phase 3). Real add-book form comes in Phase 6.
    const pickerHost = document.getElementById("coverPickerDemo");
    if (pickerHost) {
        const uploadBtn = document.getElementById("coverUploadBtn");
        const deleteBtn = document.getElementById("coverDeleteBtn");
        const result = document.getElementById("coverResult");
        let deleteToken = null;

        const picker = CloudinaryService.createCoverPicker(pickerHost, {
            onChange: (file) => { uploadBtn.disabled = !file; }
        });

        uploadBtn.addEventListener("click", async () => {
            const file = picker.getFile();
            if (!file) return;
            UI.setLoading(uploadBtn, true, "Uploading cover...");
            try {
                const res = await CloudinaryService.uploadCover(file, `test-${Date.now()}`, {
                    onProgress: (p) => { uploadBtn.textContent = `Uploading cover... ${p}%`; }
                });
                deleteToken = res.delete_token;
                deleteBtn.hidden = !deleteToken;
                result.textContent = `public_id: ${res.public_id}\n${res.secure_url}`;
                picker.clear();
                picker.setExistingUrl(res.secure_url); // shows the optimized Cloudinary version
                UI.toast.success("Cover uploaded successfully.");
            } catch (err) {
                console.error(err);
                UI.toast.error(`Upload failed. ${err.message}`, 7000);
            } finally {
                UI.setLoading(uploadBtn, false);
                uploadBtn.disabled = !picker.getFile();
            }
        });

        deleteBtn.addEventListener("click", async () => {
            UI.setLoading(deleteBtn, true, "Deleting...");
            const ok = await CloudinaryService.deleteByToken(deleteToken);
            UI.setLoading(deleteBtn, false);
            if (ok) {
                deleteToken = null;
                deleteBtn.hidden = true;
                result.textContent = "";
                picker.setExistingUrl("");
                UI.toast.success("Test cover deleted.");
            } else {
                UI.toast.error("Could not delete it. The delete token lasts about 10 minutes.");
            }
        });
    }

    // PDF upload test (Phase 5). Real add-book form comes in Phase 6.
    const pdfHost = document.getElementById("pdfPickerDemo");
    if (pdfHost) {
        const uploadBtn = document.getElementById("pdfUploadBtn");
        const openBtn = document.getElementById("pdfOpenBtn");
        const deleteBtn = document.getElementById("pdfDeleteBtn");
        const result = document.getElementById("pdfResult");
        let uploadedPath = null;

        const picker = StorageService.createPdfPicker(pdfHost, {
            onChange: (file) => { uploadBtn.disabled = !file; }
        });

        uploadBtn.addEventListener("click", async () => {
            const file = picker.getFile();
            if (!file) return;
            UI.setLoading(uploadBtn, true, "Uploading PDF...");
            try {
                const res = await StorageService.uploadPdf(file, `test-${Date.now()}`);
                uploadedPath = res.pdf_path;
                result.textContent = `pdf_path: ${res.pdf_path}\npdf_size: ${StorageService.formatBytes(res.pdf_size)}`;
                openBtn.hidden = false;
                deleteBtn.hidden = false;
                picker.clear();
                UI.toast.success("PDF uploaded successfully.");
            } catch (err) {
                console.error(err);
                UI.toast.error(`Upload failed. ${err.message}`, 7000);
            } finally {
                UI.setLoading(uploadBtn, false);
                uploadBtn.disabled = !picker.getFile();
            }
        });

        openBtn.addEventListener("click", async () => {
            UI.setLoading(openBtn, true, "Loading PDF...");
            try {
                const url = await StorageService.getSignedUrl(uploadedPath, 300);
                window.open(url, "_blank", "noopener");
            } catch (err) {
                UI.toast.error(err.message);
            } finally {
                UI.setLoading(openBtn, false);
            }
        });

        deleteBtn.addEventListener("click", async () => {
            UI.setLoading(deleteBtn, true, "Deleting PDF...");
            const ok = await StorageService.deletePdf(uploadedPath);
            UI.setLoading(deleteBtn, false);
            if (ok) {
                uploadedPath = null;
                openBtn.hidden = true;
                deleteBtn.hidden = true;
                result.textContent = "";
                UI.toast.success("Test PDF deleted.");
            } else {
                UI.toast.error("Unable to delete the PDF. You may not have permission.");
            }
        });
    }

    // Hero search: redirect to books.html with query
    const searchForm = document.getElementById("heroSearch");
    if (searchForm) {
        searchForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const input = document.getElementById("heroQuery");
            const q = (input ? input.value : "").trim();
            location.assign(q ? `books.html?q=${encodeURIComponent(q)}` : "books.html");
        });
    }
});