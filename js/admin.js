/* =========================================================
   admin.js — shared admin shell + admin page controllers (global object: Admin)

   Admin.initShell(activeKey)       fills the admin sidebar and adds admin links to the mobile drawer
   Admin.initAddBookPage(profile)   controller for admin/add-book.html

   Later phases add: initBooksPage, initEditBookPage, initDashboard, ...
   Needs (loaded before): ui.js, auth.js, cloudinary.js, storage.js, books.js
   ========================================================= */

const Admin = (() => {
    const LINKS = [
        { key: "dashboard", href: "index.html", icon: "fa-solid fa-chart-line", label: "Dashboard" },
        { key: "books", href: "books.html", icon: "fa-solid fa-book-open", label: "Books" },
        { key: "add-book", href: "add-book.html", icon: "fa-solid fa-circle-plus", label: "Add Book" },
        { key: "requests", href: "requests.html", icon: "fa-solid fa-code-pull-request", label: "Book Requests" },
        { key: "categories", href: "categories.html", icon: "fa-solid fa-tags", label: "Categories" },
        { key: "reader", href: "../reader.html", icon: "fa-solid fa-file-pdf", label: "PDF Reader" },
        { key: "users", href: "users.html", icon: "fa-solid fa-users", label: "Users" },
        { key: "settings", href: "settings.html", icon: "fa-solid fa-gear", label: "Settings" }
    ];

    function linksHtml(active) {
        return LINKS.map((l) =>
            `<a href="${l.href}"${l.key === active ? ' class="active" aria-current="page"' : ""}><i class="${l.icon} icon"></i>${l.label}</a>`
        ).join("");
    }

    function initShell(active) {
        const side = document.getElementById("adminSidebar");
        if (side) side.innerHTML = `<div class="sidebar-title">Admin</div>${linksHtml(active)}`;

        // Mobile: the drawer made by UI.renderNavbar also gets the admin links.
        const drawerAuth = document.getElementById("drawerAuth");
        if (drawerAuth) drawerAuth.insertAdjacentHTML("beforebegin", `<div class="sidebar-title">Admin</div>${linksHtml(active)}`);
        UI.refreshIcons();
    }

    /* ---------- Add Book page ---------- */
    async function initAddBookPage(profile) {
        const form = document.getElementById("bookForm");
        const submitBtn = document.getElementById("saveBookBtn");
        const categoryCheckboxes = document.getElementById("categoryCheckboxes");
        const alertBox = form.querySelector(".form-alert");

        const coverPicker = CloudinaryService.createCoverPicker(document.getElementById("coverPicker"));
        const pdfPicker = StorageService.createPdfPicker(document.getElementById("pdfPicker"));

        const params = new URLSearchParams(location.search);
        const urlTitle = params.get("title");
        const urlAuthor = params.get("author");
        if (urlTitle) document.getElementById("bookTitle").value = urlTitle;
        if (urlAuthor) document.getElementById("bookAuthor").value = urlAuthor;

        // Error spans use the pattern  <input id="bookTitle">  +  <span id="bookTitleError">
        const fields = { title: "bookTitle", author: "bookAuthor", category_id: "bookCategory", description: "bookDescription", publication_year: "bookYear", status: "bookStatus" };

        function setFieldError(key, message) {
            const id = fields[key];
            const span = document.getElementById(`${id}Error`);
            const input = document.getElementById(id);
            if (span) span.textContent = message || "";
            if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
        }
        function clearErrors() {
            Object.keys(fields).forEach((k) => setFieldError(k, ""));
            alertBox.hidden = true;
            alertBox.textContent = "";
        }
        function showAlert(message) { alertBox.textContent = message; alertBox.hidden = false; }

        // Load categories from Supabase
        try {
            const categories = await BooksService.listCategories();
            if (categories.length === 0) {
                categoryCheckboxes.innerHTML = '<span class="muted">No categories yet</span>';
                showAlert("Create at least one category before adding a book.");
                submitBtn.disabled = true;
            } else {
                categoryCheckboxes.innerHTML = categories.map((c) => `
                    <label class="custom-checkbox" style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                        <input type="checkbox" name="categories" value="${UI.esc(c.id)}">
                        <span>${UI.esc(c.name)}</span>
                    </label>
                `).join("");
            }
        } catch (err) {
            console.error("[admin.js] Could not load categories:", err);
            categoryCheckboxes.innerHTML = '<span class="muted">Unable to load categories</span>';
            showAlert("Unable to load categories. Please refresh the page.");
            submitBtn.disabled = true;
        }

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearErrors();

            const selectedCatIds = Array.from(document.querySelectorAll('input[name="categories"]:checked')).map(cb => cb.value);
            if (selectedCatIds.length === 0) {
                setFieldError("category_id", "Select at least one category");
                return;
            }
            const values = {
                title: document.getElementById("bookTitle").value,
                author: document.getElementById("bookAuthor").value,
                category_id: selectedCatIds[0] || "",
                category_ids: selectedCatIds,
                description: document.getElementById("bookDescription").value,
                publication_year: document.getElementById("bookYear").value.trim(),
                status: document.getElementById("bookStatus").value
            };

            // Validate everything first so all errors show at once
            const info = BooksService.validateBookInfo(values);
            Object.entries(info.errors).forEach(([k, msg]) => setFieldError(k, msg));
            const coverOk = coverPicker.validate();
            const pdfOk = pdfPicker.validate();
            if (!info.valid || !coverOk || !pdfOk) {
                UI.toast.error("Please fix the highlighted fields.");
                const firstBad = form.querySelector('[aria-invalid="true"]');
                if (firstBad) firstBad.focus();
                return;
            }

            UI.setLoading(submitBtn, true, "Saving book...");
            try {
                await BooksService.createBook({
                    values,
                    coverFile: coverPicker.getFile(),
                    pdfFile: pdfPicker.getFile(),
                    createdBy: profile.id,
                    onStatus: (text) => { submitBtn.textContent = text; }
                });
                UI.toast.success("Book created successfully.");
                setTimeout(() => location.assign("books.html"), 900);
            } catch (err) {
                UI.toast.error(err.userMessage || "Unable to save the book. Please try again.");
                showAlert(err.userMessage || "Unable to save the book. Please try again.");
                UI.setLoading(submitBtn, false);
            }
        });
    }

    /* ---------- Small shared helpers ---------- */
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
    const readBook = (book) => location.assign(`../reader.html?id=${encodeURIComponent(book.id)}`);
    const editBook = (book) => location.assign(`edit-book.html?id=${encodeURIComponent(book.id)}`);
    const tbl = (name) => (SupabaseService.tables && SupabaseService.tables[name]) || name;

    function messageBox(icon, title, text, linkHref, linkText) {
        const box = UI.emptyState({ icon, title, text });
        if (linkHref) {
            const a = document.createElement("a");
            a.className = "btn";
            a.href = linkHref;
            a.textContent = linkText;
            box.appendChild(a);
        }
        return box;
    }

    /* ---------- Delete a book (used by Books page and Dashboard) ---------- */
    let deleting = false;
    async function confirmAndDeleteBook(book, onDone) {
        if (deleting) return;
        const ok = await UI.modal.confirm({
            title: "Delete Book?",
            message: `Are you sure you want to delete <strong>"${UI.esc(book.title)}"</strong>?<br><br>This will remove the book record and its PDF. This cannot be undone.`,
            confirmText: "Delete",
            danger: true
        });
        if (!ok) return;

        deleting = true;
        UI.toast.info("Deleting book...", 2000);
        try {
            const result = await BooksService.deleteBook(book.id);
            UI.toast.success("Book deleted successfully.");
            if (!result.pdfRemoved) UI.toast.error("The book was deleted, but its PDF could not be removed from storage.", 7000);
            if (onDone) onDone();
        } catch (err) {
            console.error("[admin.js] Delete failed:", err);
            UI.toast.error(err.userMessage || "Unable to delete the book. Please try again.");
        } finally {
            deleting = false;
        }
    }

    /* ---------- Books page (list, search, filter, sort, grid/table) ---------- */
    function initBooksPage() {
        const browser = BooksService.createBrowser({
            admin: true,
            pageSize: 12,
            onRead: readBook,
            onEdit: editBook,
            onDelete: (book) => confirmAndDeleteBook(book, () => browser.reload())
        });
        return browser;
    }

    /* ---------- Edit Book page ---------- */
    async function initEditBookPage() {
        const id = new URLSearchParams(location.search).get("id");
        const form = document.getElementById("bookForm");
        const loading = document.getElementById("editLoading");
        const submitBtn = document.getElementById("saveBookBtn");
        const categoryCheckboxes = document.getElementById("categoryCheckboxes");
        const alertBox = form.querySelector(".form-alert");

        let book;
        try {
            book = await BooksService.getBook(id);
        } catch (err) {
            console.error("[admin.js] Loading book failed:", err);
            loading.replaceWith(messageBox("wifi-off", "Unable to load this book", "Please check your connection and try again.", "books.html", "Back to books"));
            UI.refreshIcons();
            return;
        }
        if (!book) {
            loading.replaceWith(messageBox("book-x", "Book not found", "It may have been deleted.", "books.html", "Back to books"));
            UI.refreshIcons();
            return;
        }

        const fields = { title: "bookTitle", author: "bookAuthor", category_id: "bookCategory", description: "bookDescription", publication_year: "bookYear", status: "bookStatus" };
        function setFieldError(key, message) {
            const fieldId = fields[key];
            const span = document.getElementById(`${fieldId}Error`);
            const input = document.getElementById(fieldId);
            if (span) span.textContent = message || "";
            if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
        }
        function clearErrors() {
            Object.keys(fields).forEach((k) => setFieldError(k, ""));
            alertBox.hidden = true;
            alertBox.textContent = "";
        }
        function showAlert(message) { alertBox.textContent = message; alertBox.hidden = false; }

        // Categories, then pre-fill every field with the saved values
        try {
            const categories = await BooksService.listCategories();
            categoryCheckboxes.innerHTML = categories.map((c) => `
                <label class="custom-checkbox" style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                    <input type="checkbox" name="categories" value="${UI.esc(c.id)}">
                    <span>${UI.esc(c.name)}</span>
                </label>
            `).join("");
        } catch (err) {
            console.error("[admin.js] Could not load categories:", err);
            categoryCheckboxes.innerHTML = '<span class="muted">Unable to load categories</span>';
            showAlert("Unable to load categories. Please refresh the page.");
            submitBtn.disabled = true;
        }
        document.getElementById("bookTitle").value = book.title || "";
        document.getElementById("bookAuthor").value = book.author || "";
        const savedCatIds = book.category_ids || (book.category_id ? [book.category_id] : []);
        document.querySelectorAll('input[name="categories"]').forEach((cb) => {
            cb.checked = savedCatIds.includes(cb.value);
        });
        document.getElementById("bookYear").value = book.publication_year ?? "";
        document.getElementById("bookDescription").value = book.description || "";
        document.getElementById("bookStatus").value = book.status || "draft";

        document.title = `Edit ${book.title} · Admin`;
        document.getElementById("editSubtitle").textContent = `Editing "${book.title}"`;
        document.getElementById("currentPdfName").textContent = (book.pdf_path || "").split("/").pop() || "PDF file";
        document.getElementById("currentPdfSize").textContent = BooksService.formatBytes(book.pdf_size);
        document.getElementById("currentPdfLink").href = `../reader.html?id=${encodeURIComponent(book.id)}`;

        const coverPicker = CloudinaryService.createCoverPicker(document.getElementById("coverPicker"), { existingUrl: book.cover_raw });
        const pdfPicker = StorageService.createPdfPicker(document.getElementById("pdfPicker"));

        loading.remove();
        form.hidden = false;
        UI.refreshIcons();

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearErrors();

            const selectedCatIds = Array.from(document.querySelectorAll('input[name="categories"]:checked')).map(cb => cb.value);
            if (selectedCatIds.length === 0) {
                setFieldError("category_id", "Select at least one category");
                return;
            }
            const values = {
                title: document.getElementById("bookTitle").value,
                author: document.getElementById("bookAuthor").value,
                category_id: selectedCatIds[0] || "",
                category_ids: selectedCatIds,
                description: document.getElementById("bookDescription").value,
                publication_year: document.getElementById("bookYear").value.trim(),
                status: document.getElementById("bookStatus").value
            };
            const coverFile = coverPicker.getFile();   // null = keep the current cover
            const pdfFile = pdfPicker.getFile();       // null = keep the current PDF

            const info = BooksService.validateBookInfo(values);
            Object.entries(info.errors).forEach(([k, msg]) => setFieldError(k, msg));
            const coverOk = coverFile ? coverPicker.validate({ required: false }) : true;
            const pdfOk = pdfFile ? pdfPicker.validate() : true;
            if (!info.valid || !coverOk || !pdfOk) {
                UI.toast.error("Please fix the highlighted fields.");
                const firstBad = form.querySelector('[aria-invalid="true"]');
                if (firstBad) firstBad.focus();
                return;
            }

            UI.setLoading(submitBtn, true, "Saving changes...");
            try {
                await BooksService.updateBook({
                    id: book.id,
                    values,
                    coverFile,
                    pdfFile,
                    current: book,
                    onStatus: (text) => { submitBtn.textContent = text; }
                });
                UI.toast.success("Book updated successfully.");
                setTimeout(() => location.assign("books.html"), 900);
            } catch (err) {
                UI.toast.error(err.userMessage || "Unable to update the book. Please try again.");
                showAlert(err.userMessage || "Unable to update the book. Please try again.");
                UI.setLoading(submitBtn, false);
            }
        });
    }

    /* ---------- Dashboard ---------- */
    async function initDashboard() {
        const client = SupabaseService.getClient();
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
        const countOf = async (query) => {
            const { count, error } = await query;
            if (error) { console.error("[admin.js] count failed:", error); return "—"; }
            return count ?? 0;
        };
        const head = (name) => client.from(tbl(name)).select("id", { count: "exact", head: true });

        async function loadStats() {
            const [total, published, draft, categories, users] = await Promise.all([
                countOf(head("books")),
                countOf(head("books").eq("status", "published")),
                countOf(head("books").eq("status", "draft")),
                countOf(head("categories")),
                countOf(head("profiles"))
            ]);
            set("statTotal", total); set("statPublished", published); set("statDraft", draft);
            set("statCategories", categories); set("statUsers", users);
        }

        async function loadBooks(hostId, sort) {
            const host = document.getElementById(hostId);
            try {
                const { books } = await BooksService.listBooks({ sort, pageSize: 5 });
                if (books.length === 0) {
                    host.replaceChildren(messageBox("book-x", "No books yet", "Add your first book to see it here.", "add-book.html", "Add book"));
                } else {
                    const grid = document.createElement("div");
                    grid.className = "book-grid";
                    books.forEach((b) => grid.appendChild(UI.createBookCard(b, {
                        admin: true, onRead: readBook, onEdit: editBook,
                        onDelete: (book) => confirmAndDeleteBook(book, loadAll)
                    })));
                    host.replaceChildren(grid);
                }
            } catch (err) {
                console.error("[admin.js] Dashboard books failed:", err);
                host.replaceChildren(messageBox("wifi-off", "Unable to load books", "Please refresh the page."));
            }
            UI.refreshIcons();
        }

        async function loadUsers() {
            const host = document.getElementById("latestUsers");
            const { data, error } = await client.from(tbl("profiles"))
                .select("id, full_name, email, role, created_at").order("created_at", { ascending: false }).limit(5);
            if (error) {
                console.error("[admin.js] Latest users failed:", error);
                host.replaceChildren(messageBox("wifi-off", "Unable to load users", "Please refresh the page."));
            } else if (!data.length) {
                host.replaceChildren(messageBox("users", "No users yet", ""));
            } else {
                host.innerHTML = `<ul class="user-list">${data.map((p) => `
                    <li class="user-item">
                        <span class="avatar" aria-hidden="true">${UI.esc((p.full_name || p.email || "?").charAt(0).toUpperCase())}</span>
                        <div class="user-text"><strong>${UI.esc(p.full_name || "Unnamed")}</strong><span class="muted">${UI.esc(p.email || "")}</span></div>
                        <span class="role-pill ${UI.esc(p.role)}">${UI.esc(p.role)}</span>
                        <span class="muted user-date">${UI.esc(fmtDate(p.created_at))}</span>
                    </li>`).join("")}</ul>`;
            }
            UI.refreshIcons();
        }

        function loadAll() {
            loadStats();
            loadBooks("recentAdded", "newest");
            loadBooks("recentUpdated", "updated");
        }
        loadAll();
        loadUsers();
    }

    /* ---------- Categories page ---------- */
    async function initCategoriesPage() {
        const form = document.getElementById("catForm");
        const nameInput = document.getElementById("catName");
        const descInput = document.getElementById("catDescription");
        const submitBtn = document.getElementById("catSubmit");
        const cancelBtn = document.getElementById("catCancel");
        const formTitle = document.getElementById("catFormTitle");
        const alertBox = form.querySelector(".form-alert");
        const list = document.getElementById("catList");
        let editingId = null;
        let rows = [];

        const addLabel = '<i class="fa-solid fa-plus icon"></i>Add category';
        const saveLabel = '<i class="fa-solid fa-floppy-disk icon"></i>Save changes';

        function setErr(inputId, message) {
            document.getElementById(`${inputId}Error`).textContent = message || "";
            document.getElementById(inputId).setAttribute("aria-invalid", message ? "true" : "false");
        }
        function clearErrors() {
            setErr("catName", ""); setErr("catDescription", "");
            alertBox.hidden = true; alertBox.textContent = "";
        }
        function resetForm() {
            editingId = null;
            form.reset();
            clearErrors();
            formTitle.textContent = "Add category";
            submitBtn.innerHTML = addLabel;
            cancelBtn.hidden = true;
        }

        function render() {
            if (rows.length === 0) {
                list.replaceChildren(messageBox("fa-solid fa-tags", "No categories yet", "Add your first category using the form."));
                return;
            }
            const body = rows.map((c) => `
                <tr data-id="${UI.esc(c.id)}">
                    <td data-label="Name"><strong>${UI.esc(c.name)}</strong></td>
                    <td data-label="Description">${c.description ? UI.esc(c.description) : '<span class="muted">—</span>'}</td>
                    <td data-label="Books">${c.book_count}</td>
                    <td data-label="Actions"><div class="row-actions">
                        <button class="btn" type="button" data-act="edit" aria-label="Edit ${UI.esc(c.name)}"><i class="fa-solid fa-pen-to-square icon"></i></button>
                        <button class="btn" type="button" data-act="delete" aria-label="Delete ${UI.esc(c.name)}" ${c.book_count > 0 ? 'disabled title="Move or delete its books first"' : ""}><i class="fa-solid fa-trash-can icon"></i></button>
                    </div></td>
                </tr>`).join("");
            const wrap = document.createElement("div");
            wrap.className = "table-wrap glass";
            wrap.innerHTML = `<table class="book-table">
                <thead><tr><th scope="col">Name</th><th scope="col">Description</th><th scope="col">Books</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${body}</tbody></table>`;
            list.replaceChildren(wrap);
        }

        async function load() {
            list.innerHTML = '<div class="skeleton" style="height:180px"></div>';
            try {
                rows = await CategoriesService.listWithCounts();
                render();
            } catch (err) {
                console.error("[admin.js] Loading categories failed:", err);
                list.replaceChildren(messageBox("fa-solid fa-triangle-exclamation", "Unable to load categories", "Please check your connection and try again."));
            }
        }

        list.addEventListener("click", async (e) => {
            const btn = e.target.closest("tr[data-id] [data-act]");
            if (!btn || btn.disabled) return;
            const cat = rows.find((c) => c.id === btn.closest("tr").dataset.id);
            if (!cat) return;

            if (btn.dataset.act === "edit") {
                editingId = cat.id;
                nameInput.value = cat.name;
                descInput.value = cat.description || "";
                clearErrors();
                formTitle.textContent = "Edit category";
                submitBtn.innerHTML = saveLabel;
                cancelBtn.hidden = false;
                nameInput.focus();
                return;
            }

            const ok = await UI.modal.confirm({
                title: "Delete Category?",
                message: `Are you sure you want to delete <strong>"${UI.esc(cat.name)}"</strong>?`,
                confirmText: "Delete",
                danger: true
            });
            if (!ok) return;
            try {
                await CategoriesService.remove(cat.id);
                UI.toast.success("Category deleted successfully.");
                if (editingId === cat.id) resetForm();
                load();
            } catch (err) {
                console.error("[admin.js] Category delete failed:", err);
                UI.toast.error(err.userMessage || "Unable to delete the category.");
            }
        });

        cancelBtn.addEventListener("click", resetForm);

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearErrors();
            const values = { name: nameInput.value, description: descInput.value };
            const check = CategoriesService.validate(values);
            setErr("catName", check.errors.name);
            setErr("catDescription", check.errors.description);
            if (!check.valid) return;

            UI.setLoading(submitBtn, true, editingId ? "Saving..." : "Adding...");
            try {
                if (editingId) {
                    await CategoriesService.update(editingId, values);
                    UI.toast.success("Category updated successfully.");
                } else {
                    await CategoriesService.create(values);
                    UI.toast.success("Category created successfully.");
                }
                UI.setLoading(submitBtn, false);
                resetForm();
                load();
            } catch (err) {
                console.error("[admin.js] Category save failed:", err);
                alertBox.textContent = err.userMessage || "Unable to save the category.";
                alertBox.hidden = false;
                UI.setLoading(submitBtn, false);
            }
        });

        load();
    }

    /* ---------- Users page (Full CRUD: List, Search, Filter, Add, Edit, Delete) ---------- */
    async function initUsersPage() {
        const host = document.getElementById("userResults");
        const search = document.getElementById("userSearch");
        const roleFilter = document.getElementById("roleFilter");
        const count = document.getElementById("userCount");
        const addUserBtn = document.getElementById("addUserBtn");

        const userModal = document.getElementById("userModal");
        const userModalTitle = document.getElementById("userModalTitle");
        const userModalForm = document.getElementById("userModalForm");
        const userModalId = document.getElementById("userModalId");
        const userModalName = document.getElementById("userModalName");
        const userModalEmail = document.getElementById("userModalEmail");
        const userModalPass = document.getElementById("userModalPass");
        const userModalPassGroup = document.getElementById("userModalPassGroup");
        const userModalRole = document.getElementById("userModalRole");
        const userModalCancel = document.getElementById("userModalCancel");
        const userModalSave = document.getElementById("userModalSave");

        let users = [];

        function render() {
            const q = search ? search.value.trim().toLowerCase() : "";
            const role = roleFilter ? roleFilter.value : "all";

            const shown = users.filter((u) => {
                const matchesQ = !q || `${u.full_name || ""} ${u.email || ""}`.toLowerCase().includes(q);
                const matchesRole = role === "all" || u.role === role;
                return matchesQ && matchesRole;
            });

            if (count) count.textContent = `${shown.length} ${shown.length === 1 ? "user" : "users"}`;

            if (shown.length === 0) {
                host.replaceChildren(messageBox("fa-solid fa-user-xmark", q || role !== "all" ? "No users match your criteria" : "No users yet", "Add a new user using the button above."));
                return;
            }

            const wrap = document.createElement("div");
            wrap.className = "table-wrap glass";
            wrap.innerHTML = `<table class="book-table">
                <thead>
                    <tr>
                        <th scope="col">User</th>
                        <th scope="col">Email</th>
                        <th scope="col">Role</th>
                        <th scope="col">Joined</th>
                        <th scope="col"><span class="sr-only">Actions</span></th>
                    </tr>
                </thead>
                <tbody>${shown.map((u) => `
                    <tr data-id="${UI.esc(u.id)}">
                        <td data-label="User">
                            <div class="user-cell">
                                <span class="avatar" aria-hidden="true">${UI.esc((u.full_name || u.email || "?").charAt(0).toUpperCase())}</span>
                                <strong>${UI.esc(u.full_name || "Unnamed")}</strong>
                            </div>
                        </td>
                        <td data-label="Email">${UI.esc(u.email || "—")}</td>
                        <td data-label="Role"><span class="role-pill ${UI.esc(u.role)}">${UI.esc(u.role)}</span></td>
                        <td data-label="Joined">${UI.esc(fmtDate(u.created_at))}</td>
                        <td data-label="Actions">
                            <div class="row-actions">
                                <button class="btn" type="button" data-act="edit" title="Edit User" aria-label="Edit ${UI.esc(u.full_name || u.email)}">
                                    <i class="fa-solid fa-pen-to-square icon"></i>
                                </button>
                                <button class="btn" type="button" data-act="toggle-role" title="Toggle Admin/User Role" aria-label="Change role for ${UI.esc(u.full_name || u.email)}">
                                    <i class="fa-solid fa-user-shield icon"></i>
                                </button>
                                <button class="btn" type="button" data-act="delete" title="Delete User" aria-label="Delete ${UI.esc(u.full_name || u.email)}">
                                    <i class="fa-solid fa-trash-can icon"></i>
                                </button>
                            </div>
                        </td>
                    </tr>`).join("")}
                </tbody>
            </table>`;

            host.replaceChildren(wrap);
        }

        async function loadUsers() {
            host.innerHTML = '<div class="skeleton" style="height:220px"></div>';
            const { data, error } = await SupabaseService.getClient().from(tbl("profiles"))
                .select("id, full_name, email, avatar_url, role, created_at")
                .order("created_at", { ascending: false })
                .limit(200);

            if (error) {
                console.error("[admin.js] Loading users failed:", error);
                host.replaceChildren(messageBox("fa-solid fa-triangle-exclamation", "Unable to load users", "You may not have permission, or the connection failed."));
                return;
            }
            users = data || [];
            render();
        }

        // Initialize password toggle and strength meter for modal
        UI.initPasswordToggles(userModal);
        const userModalPassStrength = document.getElementById("userModalPassStrength");
        const userModalStrengthFill = document.getElementById("userModalStrengthFill");
        const userModalStrengthText = document.getElementById("userModalStrengthText");
        UI.bindPasswordStrength(userModalPass, userModalPassStrength, userModalStrengthFill, userModalStrengthText);

        function openUserModal(user = null) {
            if (!userModal) return;
            userModalForm.reset();
            document.querySelectorAll(".field-error").forEach((el) => el.textContent = "");
            if (userModalPassStrength) userModalPassStrength.hidden = true;

            if (user) {
                userModalTitle.textContent = "Edit User";
                userModalId.value = user.id;
                userModalName.value = user.full_name || "";
                userModalEmail.value = user.email || "";
                userModalRole.value = user.role || "user";
                if (userModalPassGroup) userModalPassGroup.style.display = "none";
            } else {
                userModalTitle.textContent = "Add User";
                userModalId.value = "";
                userModalRole.value = "user";
                if (userModalPassGroup) userModalPassGroup.style.display = "grid";
            }

            if (typeof userModal.showModal === "function") {
                userModal.showModal();
            } else {
                userModal.setAttribute("open", "true");
            }
        }

        function closeUserModal() {
            if (!userModal) return;
            if (typeof userModal.close === "function") {
                userModal.close();
            } else {
                userModal.removeAttribute("open");
            }
        }

        if (addUserBtn) {
            addUserBtn.addEventListener("click", () => {
                UI.modal.confirm({
                    title: "Adding Users",
                    message: "For security reasons, Supabase does not allow creating new user accounts directly from the frontend admin panel (it requires backend master keys).<br><br>To add a new user:<ol><li>Have them sign up via the public <b>Register</b> page.</li><li>Or, create them manually inside your <b>Supabase Dashboard &rarr; Authentication &rarr; Add User</b>.</li></ol>Once the user exists, they will automatically appear here, and you can edit their role to Admin if needed.",
                    confirmText: "Got it",
                    cancelText: null
                });
            });
        }
        if (userModalCancel) userModalCancel.addEventListener("click", closeUserModal);

        if (userModalForm) {
            userModalForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                document.querySelectorAll("#userModalForm .field-error").forEach((el) => el.textContent = "");
                const id = userModalId.value;
                const fullName = userModalName.value.trim();
                const email = userModalEmail.value.trim();
                const pass = userModalPass ? userModalPass.value.trim() : "";
                const role = userModalRole.value;

                let valid = true;

                if (!fullName) {
                    document.getElementById("userModalNameError").textContent = "Full name is required.";
                    valid = false;
                }
                if (!email || !email.includes("@")) {
                    document.getElementById("userModalEmailError").textContent = "Valid email address is required.";
                    valid = false;
                }
                if (!id) {
                    const strength = UI.evaluatePasswordStrength(pass);
                    if (!strength.isStrong) {
                        document.getElementById("userModalPassError").textContent = "Password must be strong (min 8 chars, uppercase, lowercase & number/symbol).";
                        valid = false;
                    }
                }
                if (!valid) return;

                UI.setLoading(userModalSave, true, id ? "Saving..." : "Creating...");
                const client = SupabaseService.getClient();

                try {
                    if (id) {
                        const { error } = await client.from(tbl("profiles")).update({
                            full_name: fullName,
                            email: email,
                            role: role
                        }).eq("id", id);
                        if (error) throw error;
                        UI.toast.success("User updated successfully.");
                    } else {
                        const newId = crypto.randomUUID();
                        const { error } = await client.from(tbl("profiles")).insert({
                            id: newId,
                            full_name: fullName,
                            email: email,
                            role: role,
                            created_at: new Date().toISOString()
                        });
                        if (error) throw error;
                        UI.toast.success("User created successfully.");
                    }
                    closeUserModal();
                    loadUsers();
                } catch (err) {
                    console.error("[admin.js] User save error:", err);
                    UI.toast.error(err.message || "Unable to save user.");
                } finally {
                    UI.setLoading(userModalSave, false);
                }
            });
        }

        if (host) {
            host.addEventListener("click", async (e) => {
                const btn = e.target.closest("button[data-act]");
                if (!btn) return;
                const tr = btn.closest("tr[data-id]");
                if (!tr) return;
                const user = users.find((u) => u.id === tr.dataset.id);
                if (!user) return;

                const act = btn.dataset.act;

                if (act === "edit") {
                    openUserModal(user);
                } else if (act === "toggle-role") {
                    const newRole = user.role === "admin" ? "user" : "admin";
                    const ok = await UI.modal.confirm({
                        title: `Change role to ${newRole.toUpperCase()}?`,
                        message: `Are you sure you want to change <strong>${UI.esc(user.full_name || user.email)}</strong> to role <strong>"${newRole}"</strong>?`,
                        confirmText: "Change Role",
                        danger: false
                    });
                    if (!ok) return;

                    try {
                        const { error } = await SupabaseService.getClient().from(tbl("profiles"))
                            .update({ role: newRole }).eq("id", user.id);
                        if (error) throw error;
                        UI.toast.success(`Role changed to ${newRole}.`);
                        loadUsers();
                    } catch (err) {
                        console.error("[admin.js] Role toggle failed:", err);
                        UI.toast.error("Failed to update role.");
                    }
                } else if (act === "delete") {
                    const ok = await UI.modal.confirm({
                        title: "Delete User?",
                        message: `Are you sure you want to delete profile for <strong>"${UI.esc(user.full_name || user.email)}"</strong>?<br><br>This cannot be undone.`,
                        confirmText: "Delete User",
                        danger: true
                    });
                    if (!ok) return;

                    try {
                        const { error } = await SupabaseService.getClient().from(tbl("profiles"))
                            .delete().eq("id", user.id);
                        if (error) throw error;
                        UI.toast.success("User deleted successfully.");
                        loadUsers();
                    } catch (err) {
                        console.error("[admin.js] Delete user failed:", err);
                        UI.toast.error("Unable to delete user profile.");
                    }
                }
            });
        }

        if (search) search.addEventListener("input", render);
        if (roleFilter) roleFilter.addEventListener("change", render);

        loadUsers();
    }

    /* ---------- Settings page ---------- */
    async function initSettingsPage(profile) {
        const form = document.getElementById("profileForm");
        const nameInput = document.getElementById("setName");
        const saveBtn = document.getElementById("setSave");
        const nameError = document.getElementById("setNameError");

        nameInput.value = profile.full_name || "";
        document.getElementById("setEmail").value = profile.email || "";
        document.getElementById("setRole").value = profile.role || "";

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const fullName = nameInput.value.trim();
            nameError.textContent = fullName.length >= 2 ? "" : "Enter your full name.";
            if (fullName.length < 2) return;
            UI.setLoading(saveBtn, true, "Saving...");
            try {
                await Auth.updateProfile({ full_name: fullName });
                UI.toast.success("Profile updated successfully.");
            } catch (err) {
                console.error("[admin.js] Profile update failed:", err);
                UI.toast.error("Unable to update your profile. Please try again.");
            } finally {
                UI.setLoading(saveBtn, false);
            }
        });

        // Read-only connection status (values come from js/config.js; no secrets are shown)
        const cfg = window.APP_CONFIG;
        const rowsHtml = [
            ["Supabase", SupabaseService.isConfigured() ? "Configured" : "Not configured", SupabaseService.isConfigured()],
            ["Cloudinary (covers)", CloudinaryService.isConfigured() ? "Configured" : "Not configured", CloudinaryService.isConfigured()],
            ["PDF bucket", cfg.storage.pdfBucket, true],
            ["Max PDF size", `${cfg.storage.maxPdfSizeMB} MB`, true],
            ["Max cover size", `${cfg.storage.maxCoverSizeMB} MB`, true]
        ].map(([label, value, ok]) =>
            `<div class="kv-row"><dt>${UI.esc(label)}</dt><dd class="${ok ? "" : "kv-bad"}">${UI.esc(value)}</dd></div>`).join("");
        document.getElementById("connectionStatus").innerHTML = rowsHtml;

        document.getElementById("setLogout").addEventListener("click", () => Auth.confirmLogout());
    }

    /* ---------- Book Requests Page ---------- */
    async function initRequestsPage() {
        const host = document.getElementById("requestResults");
        const count = document.getElementById("requestCount");
        const statusFilter = document.getElementById("requestStatusFilter");
        const rejectModal = document.getElementById("rejectModal");
        const rejectModalForm = document.getElementById("rejectModalForm");
        const rejectModalReqId = document.getElementById("rejectModalReqId");
        const rejectModalNotes = document.getElementById("rejectModalNotes");
        const rejectModalCancel = document.getElementById("rejectModalCancel");

        let requests = [];

        function render() {
            const filter = statusFilter ? statusFilter.value : "all";
            const shown = filter === "all" ? requests : requests.filter((r) => r.status === filter);

            if (count) count.textContent = `${shown.length} ${shown.length === 1 ? "request" : "requests"}`;

            if (shown.length === 0) {
                host.replaceChildren(messageBox("fa-solid fa-inbox", filter !== "all" ? `No ${filter} requests` : "No book requests yet", "User requests for new books will appear here."));
                return;
            }

            const wrap = document.createElement("div");
            wrap.className = "table-wrap glass";
            wrap.innerHTML = `<table class="book-table">
                <thead>
                    <tr>
                        <th scope="col">User</th>
                        <th scope="col">Book Requested</th>
                        <th scope="col">Version / Notes</th>
                        <th scope="col">Status</th>
                        <th scope="col">Requested On</th>
                        <th scope="col"><span class="sr-only">Actions</span></th>
                    </tr>
                </thead>
                <tbody>${shown.map((r) => `
                    <tr data-id="${UI.esc(r.id)}">
                        <td data-label="User">
                            <div class="user-cell">
                                <span class="avatar" aria-hidden="true">${UI.esc((r.user_name || r.user_email || "?").charAt(0).toUpperCase())}</span>
                                <div>
                                    <strong>${UI.esc(r.user_name || "User")}</strong>
                                    <div class="muted" style="font-size:0.8rem">${UI.esc(r.user_email || "")}</div>
                                </div>
                            </div>
                        </td>
                        <td data-label="Book Requested">
                            <strong>${UI.esc(r.title)}</strong>
                            ${r.author ? `<div class="muted" style="font-size:0.85rem">by ${UI.esc(r.author)}</div>` : ""}
                        </td>
                        <td data-label="Version / Notes">${r.version_notes ? UI.esc(r.version_notes) : '<span class="muted">—</span>'}</td>
                        <td data-label="Status">
                            <span class="badge ${UI.esc(r.status)}">${UI.esc(r.status)}</span>
                            ${r.admin_notes ? `<div class="muted" style="font-size:0.75rem;margin-top:0.2rem">"${UI.esc(r.admin_notes)}"</div>` : ""}
                        </td>
                        <td data-label="Requested On">${UI.esc(fmtDate(r.created_at))}</td>
                        <td data-label="Actions">
                            <div class="row-actions">
                                <button class="btn btn-primary" type="button" data-act="upload-fulfill" title="Upload Book & Fulfill Request">
                                    <i class="fa-solid fa-cloud-arrow-up icon"></i> Fulfill
                                </button>
                                <button class="btn" type="button" data-act="reject" title="Reject Request" ${r.status === "rejected" ? "disabled" : ""}>
                                    <i class="fa-solid fa-ban icon"></i> Reject
                                </button>
                            </div>
                        </td>
                    </tr>`).join("")}
                </tbody>
            </table>`;

            host.replaceChildren(wrap);
        }

        async function loadRequests() {
            host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
            requests = await RequestsService.listAll();
            render();
        }

        if (host) {
            host.addEventListener("click", async (e) => {
                const btn = e.target.closest("button[data-act]");
                if (!btn || btn.disabled) return;
                const tr = btn.closest("tr[data-id]");
                if (!tr) return;
                const req = requests.find((r) => r.id === tr.dataset.id);
                if (!req) return;

                const act = btn.dataset.act;

                if (act === "upload-fulfill") {
                    const ok = await UI.modal.confirm({
                        title: "Fulfill Request & Upload Book?",
                        message: `You are fulfilling the request for <strong>"${UI.esc(req.title)}"</strong> by <strong>${UI.esc(req.user_name)}</strong>.<br><br>Clicking continue will mark this request fulfilled, notify the user by email, and open the Add Book form.`,
                        confirmText: "Fulfill & Add Book",
                        danger: false
                    });
                    if (!ok) return;

                    await RequestsService.updateStatus(req.id, "fulfilled", "Uploaded to library");
                    RequestsService.sendNotificationEmail({
                        user_email: req.user_email,
                        user_name: req.user_name,
                        book_title: req.title,
                        status: "fulfilled",
                        admin_notes: "The book has been added to our digital library collection."
                    });

                    location.assign(`add-book.html?title=${encodeURIComponent(req.title)}&author=${encodeURIComponent(req.author || "")}`);
                } else if (act === "reject") {
                    rejectModalReqId.value = req.id;
                    rejectModalNotes.value = "";
                    if (typeof rejectModal.showModal === "function") rejectModal.showModal();
                    else rejectModal.setAttribute("open", "true");
                }
            });
        }

        if (rejectModalCancel) {
            rejectModalCancel.addEventListener("click", () => {
                if (typeof rejectModal.close === "function") rejectModal.close();
                else rejectModal.removeAttribute("open");
            });
        }

        if (rejectModalForm) {
            rejectModalForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                const reqId = rejectModalReqId.value;
                const reason = rejectModalNotes.value.trim() || "Currently unavailable";

                const req = requests.find((r) => r.id === reqId);
                await RequestsService.updateStatus(reqId, "rejected", reason);

                if (req) {
                    RequestsService.sendNotificationEmail({
                        user_email: req.user_email,
                        user_name: req.user_name,
                        book_title: req.title,
                        status: "rejected",
                        admin_notes: reason
                    });
                }

                if (typeof rejectModal.close === "function") rejectModal.close();
                else rejectModal.removeAttribute("open");

                UI.toast.info("Request rejected and user notified with rejected badge.");
                loadRequests();
            });
        }

        if (statusFilter) statusFilter.addEventListener("change", render);

        loadRequests();
    }

    return {
        initShell, initAddBookPage, initBooksPage, initEditBookPage,
        initDashboard, initCategoriesPage, initUsersPage, initSettingsPage, initRequestsPage
    };
})();

window.Admin = Admin;