/* =========================================================
   user.js — pages for signed-in users (global object: User)
   Profile page, library browsing, and book details page.
   Needs (loaded before): auth.js, ui.js, books.js
   ========================================================= */

const User = (() => {

    async function initProfilePage() {
        const user = await Auth.requireAuth();
        if (!user) return;

        let profile;
        try {
            profile = await Auth.getProfile(true);
        } catch (err) {
            console.error("[user.js] Could not load profile:", err);
            UI.toast.error("Unable to load your profile. Please refresh the page.");
            return;
        }

        const nameInput = document.getElementById("profileFullName");
        const nameError = document.getElementById("profileFullNameError");
        const saveBtn = document.getElementById("profileSaveBtn");

        function fill(p) {
            const name = p.full_name || "Reader";
            const avatarEl = document.getElementById("profileAvatar");
            if (avatarEl) avatarEl.textContent = name.trim().charAt(0).toUpperCase();
            const nameEl = document.getElementById("profileName");
            if (nameEl) nameEl.textContent = name;
            const emailEl = document.getElementById("profileEmail");
            if (emailEl) emailEl.textContent = p.email || user.email;
            const roleEl = document.getElementById("profileRole");
            if (roleEl) roleEl.textContent = p.role === "admin" ? "Administrator" : "Member";
            const joinedEl = document.getElementById("profileJoined");
            if (joinedEl) {
                joinedEl.textContent = "Joined " +
                    new Date(p.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
            }
            if (nameInput) nameInput.value = p.full_name || "";
        }
        fill(profile);

        const form = document.getElementById("profileForm");
        if (form) {
            form.addEventListener("submit", async (e) => {
                e.preventDefault();
                const fullName = nameInput.value.trim();
                nameError.textContent = fullName.length >= 2 ? "" : "Enter your full name.";
                if (nameError.textContent) return;

                UI.setLoading(saveBtn, true, "Saving profile...");
                try {
                    fill(await Auth.updateProfile({ full_name: fullName }));
                    UI.toast.success("Profile updated successfully.");
                } catch (err) {
                    console.error("[user.js] Profile update failed:", err);
                    UI.toast.error("Unable to update your profile. Please try again.");
                } finally {
                    UI.setLoading(saveBtn, false);
                }
            });
        }

        initRequestModal(user);
        window.loadMyRequests = () => loadMyRequests(user);
        loadMyRequests(user);
    }

    function initRequestModal(user) {
        const btn = document.getElementById("userRequestBtn");
        const modal = document.getElementById("userRequestModal");
        const form = document.getElementById("userRequestForm");
        const cancelBtn = document.getElementById("reqCancelBtn");

        if (!btn || !modal || !form) return;

        btn.addEventListener("click", () => {
            form.reset();
            const errEl = document.getElementById("reqTitleError");
            if (errEl) errEl.textContent = "";
            if (typeof modal.showModal === "function") modal.showModal();
            else modal.setAttribute("open", "true");
        });

        if (cancelBtn) {
            cancelBtn.addEventListener("click", () => {
                if (typeof modal.close === "function") modal.close();
                else modal.removeAttribute("open");
            });
        }

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const title = document.getElementById("reqTitle").value.trim();
            const author = document.getElementById("reqAuthor").value.trim();
            const notes = document.getElementById("reqNotes").value.trim();

            const errEl = document.getElementById("reqTitleError");
            if (!title) {
                if (errEl) errEl.textContent = "Book title is required.";
                return;
            }

            const submitBtn = form.querySelector('button[type="submit"]');
            UI.setLoading(submitBtn, true, "Submitting...");

            try {
                const profile = user ? await Auth.getProfile() : null;
                await RequestsService.createRequest({
                    title,
                    author,
                    version_notes: notes,
                    user_id: user ? user.id : "guest",
                    user_name: profile ? (profile.full_name || "User") : "User",
                    user_email: user ? user.email : ""
                });

                if (typeof modal.close === "function") modal.close();
                else modal.removeAttribute("open");

                UI.toast.success("Your book request has been submitted! Admin will review it soon.");
                if (window.loadMyRequests) window.loadMyRequests();
            } catch (err) {
                console.error("[user.js] Submit request error:", err);
                UI.toast.error("Unable to submit request.");
            } finally {
                UI.setLoading(submitBtn, false);
            }
        });
    }

    async function loadMyRequests(user) {
        const host = document.getElementById("myRequestsList");
        if (!host || !user) return;

        host.innerHTML = '<div class="skeleton" style="height:100px"></div>';
        try {
            const list = await RequestsService.listMyRequests(user.id, user.email);
            if (list.length === 0) {
                host.innerHTML = '<p class="muted" style="text-align:center; padding:1.5rem 0">You haven\'t requested any books yet.</p>';
                return;
            }

            host.innerHTML = `<div style="display:grid; gap:0.75rem">${list.map((r) => `
                <div class="glass" style="padding:0.9rem 1.1rem; border-radius:var(--radius-md); border:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem">
                    <div>
                        <strong style="font-size:1rem; display:block">${UI.esc(r.title)}</strong>
                        ${r.author ? `<span class="muted" style="font-size:0.85rem">by ${UI.esc(r.author)}</span>` : ""}
                        ${r.version_notes ? `<div class="muted" style="font-size:0.8rem; margin-top:0.25rem"><em>Notes: ${UI.esc(r.version_notes)}</em></div>` : ""}
                        ${r.admin_notes ? `<div class="muted" style="font-size:0.8rem; color:var(--accent); margin-top:0.25rem"><strong>Admin note:</strong> "${UI.esc(r.admin_notes)}"</div>` : ""}
                    </div>
                    <div style="text-align:right">
                        <span class="badge ${UI.esc(r.status)}">${UI.esc(r.status)}</span>
                        <div class="muted" style="font-size:0.75rem; margin-top:0.3rem">${new Date(r.created_at).toLocaleDateString()}</div>
                    </div>
                </div>`).join("")}</div>`;
        } catch (err) {
            console.error("[user.js] Load my requests failed:", err);
            host.innerHTML = '<p class="muted" style="text-align:center">Unable to load your requests.</p>';
        }
    }

    async function initBooksPage() {
        const user = await Auth.requireAuth();
        if (user) initRequestModal(user);

        return BooksService.createBrowser({
            publishedOnly: true,
            pageSize: 12,
            onOpen: (book) => location.assign(`book-details.html?id=${encodeURIComponent(book.id)}`)
        });
    }

    async function initBookDetailsPage() {
        const id = new URLSearchParams(location.search).get("id");
        const host = document.getElementById("bookDetail");
        if (!host) return;

        if (!id) {
            host.replaceChildren(UI.emptyState({
                icon: "fa-solid fa-book-open",
                title: "No book selected",
                text: "Choose a book from the library to view details."
            }));
            UI.refreshIcons();
            return;
        }

        try {
            const book = await BooksService.getBook(id, { publishedOnly: true });
            if (!book) {
                host.replaceChildren(UI.emptyState({
                    icon: "fa-solid fa-book-bookmark",
                    title: "Book not found",
                    text: "The book you are looking for does not exist or has been removed."
                }));
                UI.refreshIcons();
                return;
            }

            document.title = `${book.title} · ${window.APP_CONFIG.appName}`;

            const coverHtml = book.cover_url
                ? `<img src="${UI.esc(book.cover_url)}" alt="Cover of ${UI.esc(book.title)}">`
                : `<div class="book-cover-fallback">${UI.esc(book.title)}</div>`;

            host.innerHTML = `
                <div class="detail-grid">
                    <div class="detail-cover">${coverHtml}</div>
                    <div class="detail-info">
                        <span class="chip">${UI.esc(book.category)}</span>
                        <h1>${UI.esc(book.title)}</h1>
                        <p class="detail-author">by <strong>${UI.esc(book.author)}</strong></p>

                        <dl class="detail-meta">
                            <div>
                                <dt>Publication Year</dt>
                                <dd>${book.publication_year || "—"}</dd>
                            </div>
                            <div>
                                <dt>File Size</dt>
                                <dd>${BooksService.formatBytes(book.pdf_size)}</dd>
                            </div>
                        </dl>

                        <p class="detail-desc">${UI.esc(book.description || "No description available for this book.")}</p>

                        <div class="detail-actions">
                            <a href="reader.html?id=${encodeURIComponent(book.id)}" class="btn btn-primary">
                                <i class="fa-solid fa-book-open icon"></i> Read Book
                            </a>
                            <button class="btn btn-outline" id="dlBookBtn" type="button">
                                <i class="fa-solid fa-download icon"></i> Download PDF
                            </button>
                        </div>
                    </div>
                </div>`;

            const dlBtn = document.getElementById("dlBookBtn");
            if (dlBtn) {
                dlBtn.addEventListener("click", async () => {
                    UI.setLoading(dlBtn, true, "Preparing download...");
                    try {
                        const url = await BooksService.getDownloadUrl(book);
                        location.assign(url);
                    } catch (err) {
                        console.error("[user.js] Download error:", err);
                        UI.toast.error("Unable to download PDF. Please try again.");
                    } finally {
                        setTimeout(() => UI.setLoading(dlBtn, false), 800);
                    }
                });
            }

            UI.refreshIcons();
        } catch (err) {
            console.error("[user.js] Loading book details failed:", err);
            host.replaceChildren(UI.emptyState({
                icon: "fa-solid fa-triangle-exclamation",
                title: "Unable to load book details",
                text: "Please check your connection and try again."
            }));
            UI.refreshIcons();
        }
    }

    return { initProfilePage, initBooksPage, initBookDetailsPage };
})();

window.User = User;