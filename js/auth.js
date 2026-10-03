/* =========================================================
   auth.js — authentication, sessions, roles (global object: Auth)

   Data:     register(), login(), logout(), getUser(), getProfile(), updateProfile()
   Roles:    isAdmin(profile)
   Guards:   requireAuth(), requireAdmin(), redirectIfLoggedIn()
   UI:       initNav(), confirmLogout(), initLoginPage(), initRegisterPage()
   Routes:   Auth.paths

   IMPORTANT: guards only decide what the PAGE shows. Real protection is Row Level
   Security in the database (supabase/schema.sql). Even if someone bypasses a guard,
   they still cannot read drafts or change books unless the database says they're an admin.

   Needs (loaded before): supabase-js, config.js, ui.js, supabase.js
   ========================================================= */

const Auth = (() => {
    const ROOT = UI.ROOT;
    const ROUTES = {
        home: `${ROOT}index.html`,
        login: `${ROOT}login.html`,
        register: `${ROOT}register.html`,
        profile: `${ROOT}profile.html`,
        userHome: `${ROOT}books.html`,           // regular users land here after login
        adminHome: `${ROOT}admin/index.html`     // admins land here after login
    };
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    let cachedProfile = null;
    let loggingOut = false;

    const client = () => SupabaseService.getClient();

    /* ---------- Friendly errors (technical details go to the console) ---------- */
    function friendlyError(err) {
        const msg = ((err && err.message) || "").toLowerCase();
        if (msg.includes("not configured")) return err.message;
        if (msg.includes("invalid login credentials")) return "Incorrect email or password.";
        if (msg.includes("already registered") || msg.includes("already been registered")) return "An account with this email already exists.";
        if (msg.includes("email not confirmed")) return "Please confirm your email first. Check your inbox for the link.";
        if (msg.includes("rate limit") || (err && err.status === 429)) return "Too many attempts. Please wait a minute and try again.";
        if (msg.includes("failed to fetch") || msg.includes("network")) return "Unable to reach the server. Please check your connection and try again.";
        if (msg.includes("password")) return "That password isn't accepted. Try a longer one.";
        return "Something went wrong. Please try again.";
    }

    /* ---------- Session and profile ---------- */
    async function getUser() {
        const { data, error } = await client().auth.getSession();
        if (error) throw error;
        return data.session ? data.session.user : null;
    }

    async function getProfile(force = false) {
        if (cachedProfile && !force) return cachedProfile;
        const user = await getUser();
        if (!user) return null;
        const { data, error } = await client()
            .from(SupabaseService.tables.profiles)
            .select("*")
            .eq("id", user.id)
            .single();
        if (error) {
            console.error("[auth.js] Could not load profile:", error);
            throw error;
        }
        cachedProfile = data;
        return data;
    }

    async function updateProfile({ full_name }) {
        const user = await getUser();
        if (!user) throw new Error("You are not logged in.");
        const { data, error } = await client()
            .from(SupabaseService.tables.profiles)
            .update({ full_name })
            .eq("id", user.id)
            .select()
            .single();
        if (error) throw error;
        cachedProfile = data;
        return data;
    }

    // Role comes from the database row, never from anything the browser can edit.
    const isAdmin = (profile) => Boolean(profile && profile.role === "admin");

    /* ---------- Register / login / logout ---------- */
    async function register({ fullName, email, password }) {
        const { data, error } = await client().auth.signUp({
            email,
            password,
            options: {
                data: { full_name: fullName },                          // the DB trigger copies this into profiles
                emailRedirectTo: new URL(ROUTES.login, location.href).href
            }
        });
        if (error) throw error;
        // With email confirmation on, Supabase hides "already registered" by returning no identities.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
            throw new Error("User already registered");
        }
        return { user: data.user, needsConfirmation: !data.session };
    }

    async function login(email, password) {
        const { data, error } = await client().auth.signInWithPassword({ email, password });
        if (error) throw error;
        cachedProfile = null;
        const profile = await getProfile(true);
        return { user: data.user, profile };
    }

    async function logout() {
        loggingOut = true;
        const { error } = await client().auth.signOut();
        if (error) { loggingOut = false; throw error; }
        cachedProfile = null;
    }

    async function confirmLogout() {
        const ok = await UI.modal.confirm({
            title: "Log out?",
            message: "You will need to log in again to read books.",
            confirmText: "Log out"
        });
        if (!ok) return;
        try {
            await logout();
            location.href = `${ROUTES.login}?loggedout=1`;
        } catch (err) {
            console.error("[auth.js] Logout failed:", err);
            UI.toast.error("Unable to log out. Please try again.");
        }
    }

    /* ---------- Redirects ---------- */

    // Only allow simple relative page paths such as "profile.html" or "admin/books.html".
    // Anything else (full URLs, "//evil.com", "..") is ignored, so ?next= can't be abused.
    function safeNext(value) {
        if (!value) return null;
        const ok = /^[\w\-./]+\.html(\?[\w=&%.\-]*)?$/.test(value) && !value.includes("..") && !value.startsWith("/");
        return ok ? value : null;
    }

    function currentPagePath() {
        const parts = location.pathname.split("/");
        const path = (ROOT !== "" ? parts.slice(-2) : parts.slice(-1)).join("/");
        return path + location.search;
    }

    function redirectAfterLogin(profile) {
        const admin = isAdmin(profile);
        const next = safeNext(new URLSearchParams(location.search).get("next"));
        if (next && (admin || !next.startsWith("admin/"))) {
            location.replace(ROOT + next);
            return;
        }
        location.replace(admin ? ROUTES.adminHome : ROUTES.userHome);
    }

    async function redirectIfLoggedIn() {
        try {
            const user = await getUser();
            if (!user) return;
            redirectAfterLogin(await getProfile());
        } catch (err) {
            console.error("[auth.js] redirectIfLoggedIn:", err);
        }
    }

    /* ---------- Page guards ---------- */
    function showSetupNotice() {
        const main = document.querySelector("main");
        if (main) {
            main.replaceChildren(UI.emptyState({
                icon: "plug-zap",
                title: "Supabase is not configured",
                text: "Add your project URL and anon key to js/config.js, then reload this page."
            }));
        }
        document.body.classList.remove("guarded");
        UI.refreshIcons();
    }

    // Sends logged-out visitors to the login page (and brings them back afterwards).
    async function requireAuth({ reveal = true } = {}) {
        if (!SupabaseService.isConfigured()) { showSetupNotice(); return null; }
        try {
            const user = await getUser();
            if (!user) {
                location.replace(`${ROUTES.login}?next=${encodeURIComponent(currentPagePath())}`);
                return null;
            }
            // If the user logs out in another tab, leave this page too.
            client().auth.onAuthStateChange((event) => {
                if (event === "SIGNED_OUT" && !loggingOut) location.replace(ROUTES.login);
            });
            if (reveal) document.body.classList.remove("guarded");
            return user;
        } catch (err) {
            console.error("[auth.js] requireAuth:", err);
            UI.toast.error(friendlyError(err));
            return null;
        }
    }

    async function requireAdmin() {
        const user = await requireAuth({ reveal: false });
        if (!user) return null;
        try {
            const profile = await getProfile();
            if (!isAdmin(profile)) {
                UI.toast.error("You don't have permission to view that page.");
                setTimeout(() => location.replace(ROUTES.userHome), 1200);
                return null;
            }
            document.body.classList.remove("guarded");
            return profile;
        } catch (err) {
            UI.toast.error(friendlyError(err));
            return null;
        }
    }

    /* ---------- Navbar (login/sign up buttons, or profile/admin/logout) ---------- */
    async function initNav() {
        const actions = document.getElementById("navActions");
        const drawer = document.getElementById("drawerAuth");
        let user = null, profile = null;

        if ((actions || drawer) && SupabaseService.isConfigured()) {
            try {
                user = await getUser();
                if (user) profile = await getProfile();
            } catch (err) {
                console.error("[auth.js] initNav:", err);
            }
        }

        if (actions || drawer) {
            const first = user ? UI.esc(((profile && profile.full_name) || "Account").split(" ")[0]) : "";
            const admin = isAdmin(profile);

            if (actions) {
                actions.innerHTML = user
                    ? `${admin ? `<a class="btn btn-text-only" href="${ROUTES.adminHome}"><i class="fa-solid fa-chart-line icon"></i>Admin</a>` : ""}
                       <a class="btn btn-ghost btn-text-only" href="${ROUTES.profile}"><i class="fa-solid fa-user icon"></i>${first}</a>
                       <button class="btn btn-text-only" data-logout><i class="fa-solid fa-right-from-bracket icon"></i>Log out</button>`
                    : `<a class="btn btn-ghost btn-text-only" href="${ROUTES.login}">Log in</a>
                       <a class="btn btn-primary" href="${ROUTES.register}">Sign up</a>`;
            }
            if (drawer) {
                drawer.innerHTML = user
                    ? `${admin ? `<a href="${ROUTES.adminHome}"><i class="fa-solid fa-chart-line icon"></i>Admin</a>` : ""}
                       <a href="${ROUTES.profile}"><i class="fa-solid fa-user icon"></i>${first}</a>
                       <button class="side-link" data-logout><i class="fa-solid fa-right-from-bracket icon"></i>Log out</button>`
                    : `<a href="${ROUTES.login}"><i class="fa-solid fa-right-to-bracket icon"></i>Log in</a>
                       <a href="${ROUTES.register}"><i class="fa-solid fa-user-plus icon"></i>Sign up</a>`;
            }
            UI.refreshIcons();
        }

        document.querySelectorAll("[data-logout]").forEach((btn) =>
            btn.addEventListener("click", () => {
                const drawerEl = document.getElementById("sidebar");
                if (drawerEl) drawerEl.classList.remove("open");
                confirmLogout();
            }));
    }

    /* ---------- Form helpers ---------- */
    // Error spans follow the pattern  <input id="loginEmail">  +  <span id="loginEmailError">
    function fieldError(inputId, message) {
        const span = document.getElementById(`${inputId}Error`);
        const input = document.getElementById(inputId);
        if (span) span.textContent = message || "";
        if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
        return !message;
    }

    function clearFormErrors(form) {
        form.querySelectorAll(".field-error").forEach((el) => { el.textContent = ""; });
        form.querySelectorAll("input").forEach((el) => el.removeAttribute("aria-invalid"));
        const alertEl = form.querySelector(".form-alert");
        if (alertEl) { alertEl.hidden = true; alertEl.textContent = ""; }
    }

    function formAlert(form, message) {
        const alertEl = form.querySelector(".form-alert");
        if (alertEl) { alertEl.textContent = message; alertEl.hidden = false; }
    }

    function initPasswordToggles() {
        document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const input = document.getElementById(btn.dataset.togglePassword);
                const show = input.type === "password";
                input.type = show ? "text" : "password";
                btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
                btn.innerHTML = `<i class="fa-solid fa-${show ? "eye-slash" : "eye"} icon"></i>`;
                UI.refreshIcons();
            });
        });
    }

    /* ---------- Login page ---------- */
    async function initLoginPage() {
        initPasswordToggles();
        const form = document.getElementById("loginForm");
        const button = document.getElementById("loginBtn");

        if (!SupabaseService.isConfigured()) {
            formAlert(form, "Supabase is not configured yet. Add your URL and anon key to js/config.js.");
        } else {
            await redirectIfLoggedIn();
        }
        if (new URLSearchParams(location.search).get("loggedout")) UI.toast.info("You have been logged out.");

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearFormErrors(form);
            const email = document.getElementById("loginEmail").value.trim();
            const password = document.getElementById("loginPassword").value;

            const okEmail = fieldError("loginEmail", EMAIL_RE.test(email) ? "" : "Enter a valid email address.");
            const okPass = fieldError("loginPassword", password ? "" : "Enter your password.");
            if (!okEmail || !okPass) return;

            UI.setLoading(button, true, "Logging in...");
            try {
                const { profile } = await login(email, password);
                UI.toast.success("Login successful.");
                setTimeout(() => redirectAfterLogin(profile), 700);
            } catch (err) {
                console.error("[auth.js] Login failed:", err);
                formAlert(form, friendlyError(err));
                UI.setLoading(button, false);
            }
        });
    }

    /* ---------- Register page ---------- */
    async function initRegisterPage() {
        UI.initPasswordToggles();
        const form = document.getElementById("registerForm");
        const button = document.getElementById("registerBtn");

        const regPass = document.getElementById("regPassword");
        const regPassStrength = document.getElementById("regPasswordStrength");
        const regStrengthFill = document.getElementById("regStrengthFill");
        const regStrengthText = document.getElementById("regStrengthText");
        UI.bindPasswordStrength(regPass, regPassStrength, regStrengthFill, regStrengthText);

        if (!SupabaseService.isConfigured()) {
            formAlert(form, "Supabase is not configured yet. Add your URL and anon key to js/config.js.");
        } else {
            await redirectIfLoggedIn();
        }

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearFormErrors(form);
            const fullName = document.getElementById("regName").value.trim();
            const email = document.getElementById("regEmail").value.trim();
            const password = regPass.value;
            const confirm = document.getElementById("regConfirm").value;

            const strength = UI.evaluatePasswordStrength(password);

            const results = [
                fieldError("regName", fullName.length >= 2 ? "" : "Enter your full name."),
                fieldError("regEmail", EMAIL_RE.test(email) ? "" : "Enter a valid email address."),
                fieldError("regPassword", strength.isStrong ? "" : "Password must be strong (at least 8 chars, uppercase, lowercase & number/symbol)."),
                fieldError("regConfirm", confirm === password ? "" : "Passwords do not match.")
            ];
            if (results.includes(false)) return;

            UI.setLoading(button, true, "Creating account...");
            try {
                const { needsConfirmation } = await register({ fullName, email, password });
                if (needsConfirmation) {
                    form.hidden = true;
                    document.getElementById("registerSuccess").hidden = false;
                    document.getElementById("registerSuccessEmail").textContent = email;
                    UI.setLoading(button, false);
                } else {
                    UI.toast.success("Account created successfully.");
                    setTimeout(() => location.replace(ROUTES.userHome), 700);
                }
            } catch (err) {
                console.error("[auth.js] Registration failed:", err);
                formAlert(form, friendlyError(err));
                UI.setLoading(button, false);
            }
        });
    }

    return {
        paths: ROUTES,
        register, login, logout, confirmLogout,
        getUser, getProfile, updateProfile, isAdmin,
        requireAuth, requireAdmin, redirectIfLoggedIn,
        initNav, initLoginPage, initRegisterPage,
        friendlyError
    };
})();

window.Auth = Auth;