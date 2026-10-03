/* =========================================================
   books.js — book data operations (global object: BooksService)

   Phase 6 (this file so far):
   BooksService.listCategories()                  -> Promise<[{ id, name }]>
   BooksService.validateBookInfo(values)          -> { valid, errors: { field: message } }
   BooksService.createBook({ values, coverFile, pdfFile, createdBy, onStatus })
                                                  -> Promise<book row>

   Later phases add: listBooks, getBook, updateBook, deleteBook, search.

   ASSUMED from earlier phases (adjust the ADAPTER block if your names differ):
     SupabaseService.getClient()
     SupabaseService.tables.books / .categories      (falls back to "books" / "categories")
     CloudinaryService.uploadCover(file, bookId)     -> { secure_url, public_id, delete_token }
     CloudinaryService.deleteByToken(token)
     StorageService.uploadPdf(file, bookId)          -> { path, url?, size? }
     StorageService.deletePdf(path)

   Needs (loaded before): config.js, ui.js, supabase.js, cloudinary.js, storage.js
   ========================================================= */

const BooksService = (() => {
    const client = () => SupabaseService.getClient();
    const table = (name) => (SupabaseService.tables && SupabaseService.tables[name]) || name;

    /* ---------- ADAPTER: the only place that touches storage.js ---------- */
    const pdfStore = {
        async upload(file, bookId) {
            if (!window.StorageService || typeof StorageService.uploadPdf !== "function") {
                throw new Error("StorageService.uploadPdf is missing. Check js/storage.js.");
            }
            const r = await StorageService.uploadPdf(file, bookId);
            const path = r.path || r.pdf_path;
            if (!path) throw new Error("PDF upload did not return a storage path.");
            let url = r.url || r.publicUrl || r.pdf_url || null;
            if (!url) {
                // Stored for reference. With a PRIVATE bucket this link is not openable;
                // the reader uses signed URLs built from pdf_path.
                url = client().storage.from(window.APP_CONFIG.storage.pdfBucket).getPublicUrl(path).data.publicUrl;
            }
            return { path, url, size: r.size ?? file.size };
        },
        async remove(path) {
            try {
                if (path && window.StorageService && typeof StorageService.deletePdf === "function") {
                    await StorageService.deletePdf(path);
                }
            } catch (err) {
                console.error("[books.js] PDF cleanup failed:", err);
            }
        }
    };

    /* ---------- Categories (for the form dropdown) ---------- */
    async function listCategories() {
        const { data, error } = await client()
            .from(table("categories"))
            .select("id, name")
            .order("name", { ascending: true });
        if (error) throw error;
        return data || [];
    }

    /* ---------- Validation of the text fields ---------- */    /* ---------- Validation of the text fields ---------- */
    function validateBookInfo(v) {
        const errors = {};
        const title = (v.title || "").trim();
        const author = (v.author || "").trim();

        if (!title) errors.title = "Enter the book title.";
        else if (title.length > 200) errors.title = "Title must be 200 characters or fewer.";

        if (!author) errors.author = "Enter the author's name.";
        else if (author.length > 150) errors.author = "Author must be 150 characters or fewer.";

        const hasCategory = Boolean(v.category_id || (Array.isArray(v.category_ids) && v.category_ids.length > 0));
        if (!hasCategory) errors.category_id = "Choose at least one category.";

        if ((v.description || "").length > 5000) errors.description = "Description must be 5000 characters or fewer.";

        if (v.publication_year !== "" && v.publication_year != null) {
            const year = Number(v.publication_year);
            const max = new Date().getFullYear() + 1;
            if (!Number.isInteger(year) || year < 1000 || year > max) {
                errors.publication_year = `Enter a year between 1000 and ${max}.`;
            }
        }

        if (!["draft", "published"].includes(v.status)) errors.status = "Choose draft or published.";

        return { valid: Object.keys(errors).length === 0, errors };
    }

    function friendlyError(err) {
        const msg = ((err && err.message) || "").toLowerCase();
        if (err && (err.code === "42501" || msg.includes("row-level security"))) return "You don't have permission to perform this action.";
        if (msg.includes("failed to fetch") || msg.includes("network")) return "Unable to reach the server. Please check your connection and try again.";
        if (msg.includes("cloudinary")) return err.message;
        if (msg.includes("storage") || msg.includes("pdf")) return `Unable to upload PDF. ${err.message}`;
        return "Unable to save the book. Please try again.";
    }

    /* ---------- Create ----------
       Order: cover -> PDF -> database row.
       If anything fails, files already uploaded are removed and NO row is created. */
    async function createBook({ values, coverFile, pdfFile, createdBy, onStatus = () => {} }) {
        const check = validateBookInfo(values);
        if (!check.valid) throw new Error("Please fix the highlighted fields.");
        if (!coverFile) throw new Error("Choose a cover image.");
        if (!pdfFile) throw new Error("Choose a PDF file.");
        if (!createdBy) throw new Error("You are not logged in.");

        const categoryIds = Array.isArray(values.category_ids) && values.category_ids.length > 0
            ? values.category_ids
            : (values.category_id ? [values.category_id] : []);

        const bookId = crypto.randomUUID();
        let cover = null;
        let pdf = null;

        try {
            onStatus("Uploading cover...");
            cover = await CloudinaryService.uploadCover(coverFile, bookId);
            UI.toast.success("Cover uploaded successfully.");

            onStatus("Uploading PDF...");
            pdf = await pdfStore.upload(pdfFile, bookId);
            UI.toast.success("PDF uploaded successfully.");

            onStatus("Saving book...");
            const row = {
                id: bookId,
                title: values.title.trim(),
                author: values.author.trim(),
                category_id: categoryIds[0] || null,
                category_ids: categoryIds,
                description: (values.description || "").trim() || null,
                publication_year: values.publication_year === "" ? null : Number(values.publication_year),
                cover_url: cover.secure_url,
                pdf_path: pdf.path,
                pdf_size: pdf.size,
                status: values.status,
                created_by: createdBy
            };
            const { data, error } = await client().from(table("books")).insert(row).select().single();
            if (error) throw error;

            if (categoryIds.length > 0) {
                try {
                    await client().from(table("book_categories")).insert(categoryIds.map(cid => ({ book_id: bookId, category_id: cid })));
                } catch (catErr) {
                    console.warn("[books.js] Could not insert into book_categories table:", catErr);
                }
            }

            return data;
        } catch (err) {
            console.error("[books.js] createBook failed:", err);
            // Clean up so nothing is orphaned.
            if (pdf) await pdfStore.remove(pdf.path);
            if (cover && cover.delete_token) await CloudinaryService.deleteByToken(cover.delete_token);
            err.userMessage = friendlyError(err);
            throw err;
        }
    }

    async function updateBook({ id, values, coverFile, pdfFile, current, onStatus = () => {} }) {
        const check = validateBookInfo(values);
        if (!check.valid) throw new Error("Please fix the highlighted fields.");
        if (!id) throw new Error("Book ID is required.");

        const categoryIds = Array.isArray(values.category_ids) && values.category_ids.length > 0
            ? values.category_ids
            : (values.category_id ? [values.category_id] : []);

        let newCover = null;
        let newPdf = null;

        try {
            const row = {
                title: values.title.trim(),
                author: values.author.trim(),
                category_id: categoryIds[0] || null,
                category_ids: categoryIds,
                description: (values.description || "").trim() || null,
                publication_year: values.publication_year === "" ? null : Number(values.publication_year),
                status: values.status,
                updated_at: new Date().toISOString()
            };

            if (coverFile) {
                onStatus("Uploading new cover...");
                newCover = await CloudinaryService.uploadCover(coverFile, id, { replace: true });
                row.cover_url = newCover.secure_url;
            }

            if (pdfFile) {
                onStatus("Uploading new PDF...");
                newPdf = await pdfStore.upload(pdfFile, id);
                row.pdf_path = newPdf.path;
                row.pdf_size = newPdf.size;
            }

            onStatus("Saving changes...");
            const { data, error } = await client().from(table("books")).update(row).eq("id", id).select().single();
            if (error) throw error;

            if (categoryIds.length > 0) {
                try {
                    await client().from(table("book_categories")).delete().eq("book_id", id);
                    await client().from(table("book_categories")).insert(categoryIds.map(cid => ({ book_id: id, category_id: cid })));
                } catch (catErr) {
                    console.warn("[books.js] Could not update book_categories junction table:", catErr);
                }
            }

            return data;
        } catch (err) {
            console.error("[books.js] updateBook failed:", err);
            if (newPdf) await pdfStore.remove(newPdf.path);
            if (newCover && newCover.delete_token) await CloudinaryService.deleteByToken(newCover.delete_token);
            err.userMessage = friendlyError(err);
            throw err;
        }
    }

    async function deleteBook(id) {
        if (!id) throw new Error("Book ID is required.");
        const { data: book } = await client().from(table("books")).select("pdf_path").eq("id", id).maybeSingle();

        const { error } = await client().from(table("books")).delete().eq("id", id);
        if (error) {
            const err = new Error(error.message);
            err.userMessage = friendlyError(error);
            throw err;
        }

        let pdfRemoved = true;
        if (book && book.pdf_path) {
            pdfRemoved = await pdfStore.remove(book.pdf_path);
        }
        return { ok: true, pdfRemoved };
    }

    async function loadHomepageBooks() {
        const grid = document.getElementById("booksGrid");
        const loading = document.getElementById("booksLoading");
        const empty = document.getElementById("booksEmpty");
        if (!grid) return;

        try {
            if (loading) loading.hidden = false;
            if (empty) empty.hidden = true;

            const res = await listBooks({ publishedOnly: true, pageSize: 8 });
            if (loading) loading.hidden = true;

            if (!res.books || res.books.length === 0) {
                if (empty) empty.hidden = false;
                return;
            }

            grid.innerHTML = "";
            res.books.forEach((book) => {
                grid.appendChild(UI.createBookCard(book, {
                    onOpen: (b) => location.assign(`book-details.html?id=${encodeURIComponent(b.id)}`)
                }));
            });
            UI.refreshIcons();
        } catch (err) {
            console.error("[books.js] loadHomepageBooks failed:", err);
            if (loading) loading.hidden = true;
            if (empty) {
                empty.hidden = false;
                const p = empty.querySelector("p");
                if (p) p.textContent = "Unable to load books right now. Please check your connection.";
            }
        }
    }


    /* =====================================================
       PHASE 7 — reading books
       BooksService.listBooks({ search, categoryId, status, publishedOnly, sort, page, pageSize })
                                  -> Promise<{ books, total, page, pageSize }>
       BooksService.getBook(id, { publishedOnly })   -> Promise<book | null>
       BooksService.getDownloadUrl(book)             -> Promise<signed url that downloads the PDF>
       BooksService.createBrowser(options)           -> shared search/filter/sort/pager controller
                                                         used by admin/books.html and books.html
       BooksService.formatBytes / formatDate
       ===================================================== */

    const SORTS = {
        newest: { column: "created_at", ascending: false },
        oldest: { column: "created_at", ascending: true },
        title_asc: { column: "title", ascending: true },
        title_desc: { column: "title", ascending: false },
        author_asc: { column: "author", ascending: true },
        updated: { column: "updated_at", ascending: false }
    };
    const LIST_COLUMNS = "id,title,author,description,publication_year,cover_url,pdf_size,status,created_at,updated_at,category_id,category_ids,book_categories(categories(name))";
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Removes characters that would break the PostgREST filter syntax.
    const cleanSearch = (q) => String(q || "").replace(/[%*,()\\"]/g, " ").replace(/\s+/g, " ").trim();

    function formatBytes(n) {
        if (!n) return "—";
        const units = ["B", "KB", "MB", "GB"];
        let i = 0, v = Number(n);
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }
    function formatDate(iso) {
        if (!iso) return "—";
        return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }

    // Turns a database row into the shape UI.createBookCard expects.
    function normalizeBook(row, size = "card") {
        let categoriesList = [];
        if (Array.isArray(row.book_categories) && row.book_categories.length > 0) {
            categoriesList = row.book_categories.map((bc) => bc.categories?.name).filter(Boolean);
        } else if (Array.isArray(row.categories) && row.categories.length > 0) {
            categoriesList = row.categories.map((c) => (typeof c === "object" ? c.name : c));
        } else if (row.categories && typeof row.categories === "object" && row.categories.name) {
            categoriesList = [row.categories.name];
        }

        return {
            ...row,
            categories_list: categoriesList,
            category: categoriesList.length > 0 ? categoriesList.join(", ") : "Uncategorized",
            cover_raw: row.cover_url,
            cover_url: row.cover_url ? CloudinaryService.coverUrl(row.cover_url, size) : ""
        };
    }

    async function listBooks({ search = "", categoryId = "", status = "", publishedOnly = false, sort = "newest", page = 1, pageSize = 12 } = {}) {
        let query = client().from(table("books")).select(LIST_COLUMNS, { count: "exact" });

        // Users only ever ask for published books. RLS enforces this again in the database.
        if (publishedOnly) query = query.eq("status", "published");
        else if (status) query = query.eq("status", status);

        if (categoryId) query = query.contains("category_ids", [categoryId]);

        const q = cleanSearch(search);
        if (q) {
            // Title and author are matched directly; category names are matched by looking up their ids first.
            const { data: cats, error: catErr } = await client().from(table("categories")).select("id").ilike("name", `%${q}%`);
            if (catErr) throw catErr;
            const ids = (cats || []).map((c) => c.id);
            const parts = [`title.ilike."*${q}*"`, `author.ilike."*${q}*"`];
            if (ids.length) parts.push(`category_ids.cd.{${ids.join(",")}}`);
            query = query.or(parts.join(","));
        }

        const s = SORTS[sort] || SORTS.newest;
        query = query.order(s.column, { ascending: s.ascending }).order("id", { ascending: true });

        const from = (page - 1) * pageSize;
        const { data, error, count } = await query.range(from, from + pageSize - 1);
        if (error) throw error;
        return { books: (data || []).map((r) => normalizeBook(r)), total: count || 0, page, pageSize };
    }

    async function getBook(id, { publishedOnly = false } = {}) {
        if (!UUID_RE.test(String(id || ""))) return null;
        let query = client().from(table("books")).select("*, book_categories(categories(name))").eq("id", id);
        if (publishedOnly) query = query.eq("status", "published");
        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        return data ? normalizeBook(data, "large") : null;
    }

    // Short-lived signed link (works for a private bucket). The download parameter makes the browser save the file.
    async function getDownloadUrl(book) {
        if (!book || !book.pdf_path) throw new Error("This book has no PDF.");
        const filename = `${String(book.title || "book").replace(/[^\w\- ]+/g, "").trim() || "book"}.pdf`;
        const { data, error } = await client().storage
            .from(window.APP_CONFIG.storage.pdfBucket)
            .createSignedUrl(book.pdf_path, 60, { download: filename });
        if (error) throw error;
        return data.signedUrl;
    }

    /* ---------- Shared browser controller ----------
       Expects these ids on the page (all optional except bookResults):
       searchInput, categoryFilter, statusFilter, sortSelect, viewGrid, viewTable,
       resultCount, bookResults, bookPager
       options: { admin, publishedOnly, pageSize, onOpen, onRead, onEdit, onDelete }
       State lives in the URL (?q=&category=&sort=&page=) so pages can be linked and refreshed. */
    function createBrowser(options = {}) {
        const o = { admin: false, publishedOnly: false, pageSize: 12, ...options };
        const $ = (id) => document.getElementById(id);
        const el = {
            search: $("searchInput"), category: $("categoryFilter"), status: $("statusFilter"), sort: $("sortSelect"),
            gridBtn: $("viewGrid"), tableBtn: $("viewTable"), count: $("resultCount"), results: $("bookResults"), pager: $("bookPager")
        };

        const params = new URLSearchParams(location.search);
        const state = {
            search: params.get("q") || "",
            categoryId: params.get("category") || "",
            status: o.admin ? params.get("status") || "" : "",
            sort: SORTS[params.get("sort")] ? params.get("sort") : "newest",
            page: Math.max(1, parseInt(params.get("page"), 10) || 1),
            view: "grid"
        };
        let requestId = 0;
        let last = null;

        function syncUrl() {
            const p = new URLSearchParams();
            if (state.search) p.set("q", state.search);
            if (state.categoryId) p.set("category", state.categoryId);
            if (state.status) p.set("status", state.status);
            if (state.sort !== "newest") p.set("sort", state.sort);
            if (state.page > 1) p.set("page", String(state.page));
            history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
        }

        function showSkeleton() {
            el.results.setAttribute("aria-busy", "true");
            el.results.innerHTML = `<div class="book-grid">${Array.from({ length: o.pageSize }, () => '<div class="skeleton book-skeleton"></div>').join("")}</div>`;
            if (el.count) el.count.textContent = "Loading books...";
            if (el.pager) el.pager.innerHTML = "";
        }

        function renderTable(books) {
            const rows = books.map((b) => `
                <tr data-id="${UI.esc(b.id)}">
                    <td data-label="Cover">${b.cover_raw
                        ? `<img class="table-cover" src="${UI.esc(CloudinaryService.coverUrl(b.cover_raw, "thumb"))}" alt="Cover of ${UI.esc(b.title)}" loading="lazy">`
                        : '<div class="table-cover table-cover--empty" aria-hidden="true"><i class="fa-solid fa-book icon"></i></div>'}</td>
                    <td data-label="Title"><strong class="table-title">${UI.esc(b.title)}</strong></td>
                    <td data-label="Author"><span class="table-sub">${UI.esc(b.author)}</span></td>
                    <td data-label="Category"><span class="table-badge">${UI.esc(b.category)}</span></td>
                    <td data-label="Year"><span class="table-sub">${b.publication_year ?? "—"}</span></td>
                    <td data-label="Status"><span class="status-pill ${UI.esc(b.status)}"><span class="status-dot"></span>${UI.esc(b.status)}</span></td>
                    <td data-label="Updated"><span class="table-sub">${UI.esc(formatDate(b.updated_at))}</span></td>
                    <td data-label="Actions"><div class="row-actions">
                        <button class="btn" data-act="read" title="Read ${UI.esc(b.title)}" aria-label="Read ${UI.esc(b.title)}"><i class="fa-solid fa-book-open icon"></i></button>
                        <button class="btn" data-act="edit" title="Edit ${UI.esc(b.title)}" aria-label="Edit ${UI.esc(b.title)}"><i class="fa-solid fa-pen-to-square icon"></i></button>
                        <button class="btn" data-act="delete" title="Delete ${UI.esc(b.title)}" aria-label="Delete ${UI.esc(b.title)}"><i class="fa-solid fa-trash-can icon"></i></button>
                    </div></td>
                </tr>`).join("");
            const wrap = document.createElement("div");
            wrap.className = "table-wrap glass";
            wrap.innerHTML = `<table class="book-table">
                <thead><tr><th scope="col">Cover</th><th scope="col">Title</th><th scope="col">Author</th><th scope="col">Category</th><th scope="col">Year</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col" style="text-align:right">Actions</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
            return wrap;
        }

        function renderPager(total) {
            if (!el.pager) return;
            const pages = Math.max(1, Math.ceil(total / o.pageSize));
            if (pages <= 1) { el.pager.innerHTML = ""; return; }
            el.pager.innerHTML = `
                <button class="btn" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""} aria-label="Previous page"><i data-lucide="chevron-left" class="icon"></i>Prev</button>
                <span class="pager-info" aria-current="page">Page ${state.page} of ${pages}</span>
                <button class="btn" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""} aria-label="Next page">Next<i data-lucide="chevron-right" class="icon"></i></button>`;
        }

        function render() {
            const { books, total } = last;
            el.results.removeAttribute("aria-busy");
            if (el.count) el.count.textContent = total === 0 ? "" : `${total} ${total === 1 ? "book" : "books"}`;

            if (books.length === 0) {
                const filtered = state.search || state.categoryId || state.status;
                el.results.replaceChildren(UI.emptyState({
                    icon: filtered ? "search-x" : "book-x",
                    title: filtered ? "No books match your search" : "No books yet",
                    text: filtered ? "Try a different search or clear the filters." : (o.admin ? "Add your first book to get started." : "Check back soon.")
                }));
                renderPager(0);
                UI.refreshIcons();
                return;
            }

            if (o.admin && state.view === "table") {
                el.results.replaceChildren(renderTable(books));
            } else {
                const grid = document.createElement("div");
                grid.className = "book-grid";
                const cardOptions = o.admin
                    ? { admin: true, onRead: o.onRead, onEdit: o.onEdit, onDelete: o.onDelete }
                    : { onOpen: o.onOpen };
                books.forEach((b) => grid.appendChild(UI.createBookCard(b, cardOptions)));
                el.results.replaceChildren(grid);
            }
            renderPager(total);
            UI.refreshIcons();
        }

        async function load() {
            const token = ++requestId;
            syncUrl();
            showSkeleton();
            try {
                const res = await listBooks({ ...state, publishedOnly: o.publishedOnly, pageSize: o.pageSize });
                if (token !== requestId) return; // a newer request replaced this one

                // The page number may be past the end after filtering or deleting.
                if (res.books.length === 0 && res.total > 0 && state.page > 1) {
                    state.page = Math.ceil(res.total / o.pageSize);
                    return load();
                }
                last = res;
                render();
            } catch (err) {
                if (token !== requestId) return;
                console.error("[books.js] Loading books failed:", err);
                const box = UI.emptyState({ icon: "wifi-off", title: "Unable to load books", text: "Please check your connection and try again." });
                const retry = document.createElement("button");
                retry.className = "btn";
                retry.textContent = "Try again";
                retry.addEventListener("click", load);
                box.appendChild(retry);
                el.results.removeAttribute("aria-busy");
                el.results.replaceChildren(box);
                if (el.count) el.count.textContent = "";
                if (el.pager) el.pager.innerHTML = "";
                UI.refreshIcons();
            }
        }

        function setView(view) {
            state.view = view;
            if (el.gridBtn) el.gridBtn.setAttribute("aria-pressed", String(view === "grid"));
            if (el.tableBtn) el.tableBtn.setAttribute("aria-pressed", String(view === "table"));
            if (last) render();
        }

        function resetAndLoad() { state.page = 1; load(); }

        async function init() {
            if (el.search) el.search.value = state.search;
            if (el.sort) el.sort.value = state.sort;
            if (el.status) el.status.value = state.status;

            if (el.category) {
                try {
                    const cats = await listCategories();
                    el.category.insertAdjacentHTML("beforeend", cats.map((c) => `<option value="${UI.esc(c.id)}">${UI.esc(c.name)}</option>`).join(""));
                    el.category.value = state.categoryId;
                    if (el.category.value !== state.categoryId) state.categoryId = "";
                } catch (err) {
                    console.error("[books.js] Could not load categories:", err);
                }
            }

            let timer;
            if (el.search) el.search.addEventListener("input", () => {
                clearTimeout(timer);
                timer = setTimeout(() => { state.search = el.search.value; resetAndLoad(); }, 300);
            });
            if (el.category) el.category.addEventListener("change", () => { state.categoryId = el.category.value; resetAndLoad(); });
            if (el.status) el.status.addEventListener("change", () => { state.status = el.status.value; resetAndLoad(); });
            if (el.sort) el.sort.addEventListener("change", () => { state.sort = el.sort.value; resetAndLoad(); });
            if (el.gridBtn) el.gridBtn.addEventListener("click", () => setView("grid"));
            if (el.tableBtn) el.tableBtn.addEventListener("click", () => setView("table"));

            if (el.pager) el.pager.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-page]");
                if (!btn || btn.disabled) return;
                state.page = Number(btn.dataset.page);
                load().then(() => el.results.scrollIntoView({ behavior: "smooth", block: "start" }));
            });

            // Table row buttons (grid cards wire their own buttons in UI.createBookCard)
            el.results.addEventListener("click", (e) => {
                const btn = e.target.closest("tr[data-id] [data-act]");
                if (!btn || !last) return;
                const book = last.books.find((b) => b.id === btn.closest("tr").dataset.id);
                const handler = { read: o.onRead, edit: o.onEdit, delete: o.onDelete }[btn.dataset.act];
                if (book && handler) handler(book);
            });

            setView("grid");
            await load();
        }

        init();
        return { reload: load, state };
    }

    return {
        listCategories, validateBookInfo, createBook, updateBook, deleteBook, loadHomepageBooks, friendlyError,
        listBooks, getBook, getDownloadUrl, createBrowser, formatBytes, formatDate
    };
})();

window.BooksService = BooksService;
window.loadHomepageBooks = BooksService.loadHomepageBooks;