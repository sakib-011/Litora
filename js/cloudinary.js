/* =========================================================
   cloudinary.js — book cover images (global object: CloudinaryService)

   CloudinaryService.isConfigured()
   CloudinaryService.validateCover(file)          -> Promise<{ valid, error }>
   CloudinaryService.uploadCover(file, bookId, { replace, onProgress })
                                                  -> Promise<{ secure_url, public_id, delete_token, width, height, bytes }>
   CloudinaryService.coverUrl(secureUrl, "thumb" | "card" | "large")   optimized 2:3 URL
   CloudinaryService.deleteByToken(token)         -> Promise<boolean>  (cleanup right after an upload)
   CloudinaryService.createCoverPicker(container, { existingUrl, onChange })
                                                  -> { getFile, hasNewFile, validate, clear, setExistingUrl, setError }

   Browser -> Cloudinary (unsigned preset) -> secure_url + public_id -> Supabase books table.
   No API secret is used anywhere in the browser.
   Needs (loaded before): config.js, ui.js
   ========================================================= */

const CloudinaryService = (() => {
    const cfg = window.APP_CONFIG.cloudinary;
    const maxMB = window.APP_CONFIG.storage.maxCoverSizeMB;

    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
    const SIZES = {
        thumb: { w: 200, h: 300 },
        card: { w: 400, h: 600 },
        large: { w: 800, h: 1200 }
    };

    function isConfigured() {
        return Boolean(cfg.cloudName && cfg.uploadPreset) &&
            !cfg.cloudName.startsWith("YOUR_") && !cfg.uploadPreset.startsWith("YOUR_");
    }

    /* ---------- Validation ---------- */

    // Reads the first bytes of the file to confirm it really is JPEG, PNG or WEBP.
    // Extension and MIME type can be faked; the file signature cannot (easily).
    async function hasImageSignature(file) {
        const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
        const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                     b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
        return jpeg || png || webp;
    }

    async function validateCover(file) {
        const fail = (error) => ({ valid: false, error });
        if (!file) return fail("Choose a cover image.");

        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) return fail("Cover must be a JPG, PNG or WEBP image.");
        if (!ALLOWED_TYPES.includes(file.type)) return fail("Cover must be a JPG, PNG or WEBP image.");
        if (file.size === 0) return fail("This file is empty.");
        if (file.size > maxMB * 1024 * 1024) return fail(`Cover must be smaller than ${maxMB} MB.`);
        if (!(await hasImageSignature(file))) return fail("This file is not a valid image.");

        return { valid: true, error: "" };
    }

    /* ---------- Upload ---------- */

    // bookId  -> the book's UUID. The image is stored as  library-covers/<bookId>
    // replace -> true when swapping the cover of an existing book. Cloudinary's unsigned
    //            uploads cannot overwrite, so a timestamp is appended:  library-covers/<bookId>-<time>
    function uploadCover(file, bookId, { replace = false, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            if (!isConfigured()) {
                return reject(new Error("Cloudinary is not configured. Add your cloud name and upload preset to js/config.js."));
            }
            if (!bookId) return reject(new Error("A book ID is required to upload a cover."));

            const form = new FormData();
            form.append("file", file);
            form.append("upload_preset", cfg.uploadPreset);
            form.append("folder", cfg.folder);
            form.append("public_id", replace ? `${bookId}-${Date.now()}` : String(bookId));

            const xhr = new XMLHttpRequest();
            xhr.open("POST", `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`);
            xhr.timeout = 60000;

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                let data = null;
                try { data = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
                if (xhr.status >= 200 && xhr.status < 300 && data && data.secure_url) {
                    resolve({
                        secure_url: data.secure_url,
                        public_id: data.public_id,
                        delete_token: data.delete_token || null,
                        width: data.width,
                        height: data.height,
                        bytes: data.bytes
                    });
                } else {
                    console.error("[cloudinary.js] Upload failed:", xhr.status, xhr.responseText);
                    reject(new Error((data && data.error && data.error.message) || `Cloudinary returned status ${xhr.status}.`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error. Please check your connection and try again."));
            xhr.ontimeout = () => reject(new Error("The upload took too long. Please try again."));
            xhr.send(form);
        });
    }

    /* ---------- URLs ---------- */

    // Turns a stored secure_url into an optimized, cropped 2:3 image (auto format + quality).
    function coverUrl(url, size = "card") {
        if (!url || !url.includes("/image/upload/")) return url || "";
        const s = SIZES[size] || SIZES.card;
        return url.replace("/image/upload/", `/image/upload/c_fill,g_auto,w_${s.w},h_${s.h},f_auto,q_auto/`);
    }

    /* ---------- Cleanup ---------- */

    // Deletes an image right after upload (valid ~10 minutes) using the delete token
    // Cloudinary returns when "Return delete token" is on in the preset.
    // Use it if saving the book fails after the cover was already uploaded.
    // Deleting OLD covers later needs a signed server-side call (see setup notes).
    async function deleteByToken(token) {
        if (!token || !isConfigured()) return false;
        try {
            const form = new FormData();
            form.append("token", token);
            const res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/delete_by_token`, { method: "POST", body: form });
            const data = await res.json().catch(() => ({}));
            return res.ok && data.result === "ok";
        } catch (err) {
            console.error("[cloudinary.js] deleteByToken failed:", err);
            return false;
        }
    }

    /* ---------- Cover picker (drop zone + preview) ---------- */
    let pickerCount = 0;

    function createCoverPicker(container, { existingUrl = "", onChange } = {}) {
        const inputId = `coverInput${++pickerCount}`;
        container.innerHTML = `
            <div class="cover-picker">
                <input type="file" id="${inputId}" class="sr-only" aria-label="Cover image file"
                       accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp">
                <div class="cover-drop" role="button" tabindex="0" aria-label="Choose a cover image">
                    <img class="cover-preview" alt="Cover preview" hidden>
                    <div class="cover-empty">
                        <i class="fa-solid fa-file-image icon" style="font-size:2.2rem;color:var(--accent);margin-bottom:0.4rem"></i>
                        <strong>Add cover image</strong>
                        <span class="muted">Drop a file or click. JPG, PNG or WEBP, 2:3 ratio, up to ${maxMB} MB.</span>
                    </div>
                </div>
                <div class="cover-actions">
                    <button type="button" class="btn" data-role="replace" hidden><i class="fa-solid fa-arrows-rotate icon"></i> Replace</button>
                    <button type="button" class="btn" data-role="remove" hidden><i class="fa-solid fa-xmark icon"></i> Remove</button>
                </div>
                <span class="field-error" role="alert"></span>
            </div>`;
        UI.refreshIcons();

        const input = container.querySelector("input");
        const drop = container.querySelector(".cover-drop");
        const img = container.querySelector(".cover-preview");
        const empty = container.querySelector(".cover-empty");
        const replaceBtn = container.querySelector('[data-role="replace"]');
        const removeBtn = container.querySelector('[data-role="remove"]');
        const errorEl = container.querySelector(".field-error");

        let file = null;       // newly chosen file (not uploaded yet)
        let objectUrl = null;  // local preview URL for that file
        let existing = existingUrl;

        function setError(message) { errorEl.textContent = message || ""; }

        function render() {
            const hasPreview = Boolean(file || existing);
            img.hidden = !hasPreview;
            empty.hidden = hasPreview;
            replaceBtn.hidden = !hasPreview;
            removeBtn.hidden = !file;
            if (file) {
                img.src = objectUrl;
                img.alt = `Preview of ${file.name}`;
            } else if (existing) {
                img.src = coverUrl(existing, "card");
                img.alt = "Current book cover";
            } else {
                img.removeAttribute("src");
            }
        }

        async function handleFile(candidate) {
            const result = await validateCover(candidate);
            if (!result.valid) {
                setError(result.error);
                UI.toast.error(`Invalid image. ${result.error}`);
                return;
            }
            setError("");
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            file = candidate;
            objectUrl = URL.createObjectURL(file);
            render();
            if (onChange) onChange(file);
        }

        function clear() {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            file = null;
            objectUrl = null;
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
            input.value = ""; // lets the same file be chosen again later
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
            clear,
            setError,
            setExistingUrl(url) { existing = url || ""; render(); },
            // Call before saving. Pass { required: false } when editing and keeping the current cover.
            validate({ required = true } = {}) {
                if (required && !file && !existing) {
                    setError("Choose a cover image.");
                    return false;
                }
                return true;
            }
        };
    }

    return { isConfigured, validateCover, uploadCover, coverUrl, deleteByToken, createCoverPicker };
})();

window.CloudinaryService = CloudinaryService;