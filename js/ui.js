/* =========================================================
   ui.js — reusable UI helpers (global object: UI)
   UI.toast.success/error/info(message)
   UI.modal.confirm({ title, message, confirmText, danger })  -> Promise<boolean>
   UI.initSidebar()
   UI.renderNavbar(current)   UI.ROOT
   UI.createBookCard(book, options) -> HTMLElement
   UI.refreshIcons()
   UI.setLoading(button, isLoading, loadingText)
   UI.emptyState({ icon, title, text })
   ========================================================= */

const UI = (() => {
    const ICONS = {
        success: "fa-solid fa-circle-check",
        error: "fa-solid fa-circle-exclamation",
        info: "fa-solid fa-circle-info"
    };

    // Pages inside /admin/ need "../" in front of links to root pages and assets
    const ROOT = location.pathname.includes("/admin/") ? "../" : "";

    /* ---------- Icons ---------- */
    function refreshIcons() {
        // FontAwesome renders CSS classes automatically.
    }

    /* ---------- Escape text before putting it in HTML ---------- */
    function esc(value) {
        const div = document.createElement("div");
        div.textContent = value ?? "";
        return div.innerHTML;
    }

    /* ---------- Navbar + mobile drawer ----------
       Put <div id="siteNav"></div> in a page and call UI.renderNavbar("home" | "books" | ...).
       Auth.initNav() then fills #navActions and #drawerAuth. */
    function renderNavbar(current = "") {
        const host = document.getElementById("siteNav");
        if (!host) return;
        const link = (href, label, key) =>
            `<a href="${ROOT}${href}"${current === key ? ' aria-current="page"' : ""}>${label}</a>`;
        host.innerHTML = `
            <header class="navbar">
                <div class="container navbar-inner">
                    <button class="btn btn-icon btn-ghost menu-toggle" data-sidebar-toggle aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">
                        <i class="fa-solid fa-bars icon"></i>
                    </button>
                    <a href="${ROOT}index.html" class="brand">
                        <span class="brand-mark"><i class="fa-solid fa-book-bookmark icon"></i></span>
                        <span>${esc(window.APP_CONFIG.appName)}</span>
                    </a>
                    <nav class="nav-links" aria-label="Main">${link("index.html", "Home", "home")}${link("books.html", "Books", "books")}</nav>
                    <div class="nav-actions" id="navActions"></div>
                </div>
            </header>
            <aside id="sidebar" class="sidebar sidebar--drawer" aria-label="Site menu">
                <div class="sidebar-title">Menu</div>
                <a href="${ROOT}index.html"><i class="fa-solid fa-house icon"></i>Home</a>
                <a href="${ROOT}books.html"><i class="fa-solid fa-book-open icon"></i>Books</a>
                <div id="drawerAuth"></div>
            </aside>
            <div class="sidebar-backdrop" id="sidebarBackdrop"></div>`;
        refreshIcons();
    }

    /* ---------- Toasts ---------- */
    function getToastStack() {
        let stack = document.getElementById("toastStack");
        if (!stack) {
            stack = document.createElement("div");
            stack.id = "toastStack";
            stack.className = "toast-stack";
            stack.setAttribute("role", "status");
            stack.setAttribute("aria-live", "polite");
            document.body.appendChild(stack);
        }
        return stack;
    }

    function showToast(type, message, duration = 4000) {
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        const iconClass = ICONS[type] || ICONS.info;
        toast.innerHTML = `
            <i class="${iconClass} icon"></i>
            <div class="toast-body">${esc(message)}</div>
            <button class="toast-close" aria-label="Dismiss notification"><i class="fa-solid fa-xmark icon"></i></button>`;
        getToastStack().appendChild(toast);

        const remove = () => {
            toast.classList.add("leaving");
            toast.addEventListener("animationend", () => toast.remove(), { once: true });
        };
        toast.querySelector(".toast-close").addEventListener("click", remove);
        if (duration > 0) setTimeout(remove, duration);
    }

    const toast = {
        success: (msg, ms) => showToast("success", msg, ms),
        error: (msg, ms) => showToast("error", msg, ms),
        info: (msg, ms) => showToast("info", msg, ms)
    };

    /* ---------- Modal ---------- */
    function confirmModal({ title = "Are you sure?", message = "", confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
        return new Promise((resolve) => {
            const previouslyFocused = document.activeElement;
            const overlay = document.createElement("div");
            overlay.className = "modal-overlay";
            overlay.innerHTML = `
                <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
                    <h3 id="modalTitle">${esc(title)}</h3>
                    <div class="modal-body">${message}</div>
                    <div class="modal-actions">
                        <button class="btn" data-role="cancel">${esc(cancelText)}</button>
                        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-role="confirm">${esc(confirmText)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            document.body.classList.add("no-scroll");

            const confirmBtn = overlay.querySelector('[data-role="confirm"]');
            const cancelBtn = overlay.querySelector('[data-role="cancel"]');
            cancelBtn.focus();

            function close(result) {
                document.removeEventListener("keydown", onKey);
                overlay.remove();
                document.body.classList.remove("no-scroll");
                if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
                resolve(result);
            }
            function onKey(e) {
                if (e.key === "Escape") close(false);
                if (e.key === "Tab") { // keep focus inside the dialog
                    const first = cancelBtn, last = confirmBtn;
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            }
            document.addEventListener("keydown", onKey);
            confirmBtn.addEventListener("click", () => close(true));
            cancelBtn.addEventListener("click", () => close(false));
            overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
        });
    }

    const modal = { confirm: confirmModal };

    /* ---------- Sidebar (mobile drawer) ---------- */
    function initSidebar() {
        const sidebar = document.getElementById("sidebar");
        const backdrop = document.getElementById("sidebarBackdrop");
        const toggles = document.querySelectorAll("[data-sidebar-toggle]");
        if (!sidebar) return;

        const setOpen = (open) => {
            sidebar.classList.toggle("open", open);
            if (backdrop) backdrop.classList.toggle("show", open);
            document.body.classList.toggle("no-scroll", open);
            toggles.forEach((t) => t.setAttribute("aria-expanded", String(open)));
        };
        toggles.forEach((t) => t.addEventListener("click", () => setOpen(!sidebar.classList.contains("open"))));
        if (backdrop) backdrop.addEventListener("click", () => setOpen(false));
        sidebar.querySelectorAll("a, button.side-link").forEach((el) => el.addEventListener("click", () => setOpen(false)));
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
        window.addEventListener("resize", () => { if (window.innerWidth > 760) setOpen(false); });
    }

    /* ---------- Loading state for buttons ---------- */
    function setLoading(button, isLoading, loadingText) {
        if (!button) return;
        if (isLoading) {
            button.dataset.label = button.innerHTML;
            button.classList.add("is-loading");
            button.disabled = true;
            if (loadingText) button.textContent = loadingText;
        } else {
            button.classList.remove("is-loading");
            button.disabled = false;
            if (button.dataset.label) button.innerHTML = button.dataset.label;
            refreshIcons();
        }
    }

    /* ---------- Empty state ---------- */
    function emptyState({ icon = "fa-solid fa-book", title = "Nothing here yet", text = "" } = {}) {
        const el = document.createElement("div");
        el.className = "empty-state";
        const iconClass = icon.includes("fa-") ? icon : `fa-solid fa-${icon}`;
        el.innerHTML = `
            <div class="empty-state-icon"><i class="${esc(iconClass)} icon"></i></div>
            <h3>${esc(title)}</h3>
            <p>${esc(text)}</p>`;
        return el;
    }

    /* ---------- Book card ----------
       book: { id, title, author, category, cover_url, status }
       options: { admin: boolean, onRead, onEdit, onDelete, onOpen } */
    const FALLBACKS = [["#7c83ff", "#2a2f6b"], ["#f0b54a", "#7a4a12"], ["#4fd3a3", "#0f5c47"], ["#ff7d90", "#6b1f33"]];

    function createBookCard(book, options = {}) {
        const card = document.createElement("article");
        card.className = "book-card glass";
        card.dataset.id = book.id;

        const [c1, c2] = FALLBACKS[(String(book.id).length + String(book.title).length) % FALLBACKS.length];
        const cover = book.cover_url
            ? `<img src="${esc(book.cover_url)}" alt="Cover of ${esc(book.title)}" loading="lazy">`
            : `<div class="book-cover-fallback" style="--c1:${c1};--c2:${c2}">${esc(book.title)}</div>`;
        const badge = options.admin && book.status ? `<span class="badge ${esc(book.status)}">${esc(book.status)}</span>` : "";

        const actions = options.admin
            ? `<div class="book-actions">
                   <button class="btn" data-act="read" aria-label="Read ${esc(book.title)}"><i class="fa-solid fa-book-open icon"></i>Read</button>
                   <button class="btn" data-act="edit" aria-label="Edit ${esc(book.title)}"><i class="fa-solid fa-pen-to-square icon"></i>Edit</button>
                   <button class="btn" data-act="delete" aria-label="Delete ${esc(book.title)}"><i class="fa-solid fa-trash-can icon"></i>Delete</button>
               </div>`
            : "";

        const hoverOverlay = !options.admin && options.onOpen
            ? `<div class="book-hover"><i class="fa-solid fa-book-open icon"></i> Read Book</div>`
            : "";

        const catsList = Array.isArray(book.categories_list) && book.categories_list.length > 0
            ? book.categories_list
            : (Array.isArray(book.categories) ? book.categories.map(c => typeof c === "object" ? c.name : c) : [book.category || "Uncategorized"]);
        const catBadges = `<div class="book-categories-wrap" style="display:flex; flex-wrap:wrap; gap:0.3rem;">${catsList.map(c => `<span class="book-category">${esc(c)}</span>`).join("")}</div>`;

        card.innerHTML = `
            <div class="book-cover">${cover}${badge}${hoverOverlay}</div>
            <div class="book-info">
                <h3 class="book-title">${esc(book.title)}</h3>
                <span class="book-meta">${esc(book.author)}</span>
                ${catBadges}
                ${actions}
            </div>`;

        const handlers = { read: options.onRead, edit: options.onEdit, delete: options.onDelete };
        card.querySelectorAll("[data-act]").forEach((btn) =>
            btn.addEventListener("click", (e) => { e.stopPropagation(); handlers[btn.dataset.act]?.(book); }));
        if (options.onOpen) {
            card.style.cursor = "pointer";
            card.setAttribute("tabindex", "0");
            card.setAttribute("role", "link");
            card.setAttribute("aria-label", `View details for ${book.title}`);
            card.addEventListener("click", () => options.onOpen(book));
            card.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); options.onOpen(book); }
            });
        }
        return card;
    }

    /* ---------- Password Toggles ---------- */
    function initPasswordToggles(container = document) {
        container.querySelectorAll("[data-toggle-password]").forEach((btn) => {
            if (btn.dataset.toggleBound) return;
            btn.dataset.toggleBound = "true";
            btn.addEventListener("click", () => {
                const targetId = btn.dataset.togglePassword;
                const input = document.getElementById(targetId) || btn.closest(".password-wrap")?.querySelector("input");
                if (!input) return;
                const show = input.type === "password";
                input.type = show ? "text" : "password";
                btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
                btn.innerHTML = `<i class="fa-solid fa-${show ? "eye-slash" : "eye"} icon"></i>`;
            });
        });
    }

    /* ---------- Password Strength Evaluator ---------- */
    function evaluatePasswordStrength(password) {
        if (!password) return { score: 0, label: "", class: "", isStrong: false };
        const minLen = password.length >= 8;
        const hasUpper = /[A-Z]/.test(password);
        const hasLower = /[a-z]/.test(password);
        const hasNum = /\d/.test(password);
        const hasSpec = /[^A-Za-z0-9]/.test(password);

        const isStrong = minLen && hasUpper && hasLower && (hasNum || hasSpec);

        if (isStrong) {
            return { score: 3, label: "Strong", class: "strong", isStrong: true };
        } else if (password.length >= 6 && ((hasUpper || hasLower) && (hasNum || hasSpec || password.length >= 8))) {
            return { score: 2, label: "Medium", class: "medium", isStrong: false };
        } else {
            return { score: 1, label: "Weak", class: "weak", isStrong: false };
        }
    }

    function bindPasswordStrength(inputEl, containerEl, fillEl, textEl) {
        if (!inputEl || !containerEl || !fillEl || !textEl) return;
        const update = () => {
            const val = inputEl.value;
            if (!val) {
                containerEl.hidden = true;
                return;
            }
            containerEl.hidden = false;
            const res = evaluatePasswordStrength(val);
            fillEl.className = `strength-fill ${res.class}`;
            textEl.className = `strength-text ${res.class}`;
            textEl.textContent = res.label;
        };
        inputEl.addEventListener("input", update);
        update();
    }

    return { ROOT, toast, modal, renderNavbar, initSidebar, createBookCard, refreshIcons, setLoading, emptyState, esc, initPasswordToggles, evaluatePasswordStrength, bindPasswordStrength };
})();

window.UI = UI;