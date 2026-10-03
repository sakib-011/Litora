/* =========================================================
   supabase.js — creates the ONE Supabase client used by the app.
   Needs (loaded before this file): the supabase-js CDN script and config.js.
   Exposes:
     window.supabaseClient          the client (null if not configured)
     window.SupabaseService
        .tables                     table names, so other files never retype them
        .bucket                     PDF bucket name
        .isConfigured()             true when config.js has real values
        .getClient()                returns the client or throws a friendly error
        .testConnection()           Promise<{ ok, message }>
   Uses ONLY the anon/publishable key. Security comes from RLS (schema.sql).
   ========================================================= */

const SupabaseService = (() => {
    const cfg = window.APP_CONFIG.supabase;

    const configured =
        typeof cfg.url === "string" && cfg.url.startsWith("https://") &&
        typeof cfg.anonKey === "string" && cfg.anonKey.length > 20 &&
        !cfg.url.startsWith("YOUR_") && !cfg.anonKey.startsWith("YOUR_");

    let client = null;

    if (!window.supabase || !window.supabase.createClient) {
        console.error("[supabase.js] The supabase-js library did not load. Check the CDN <script> tag and your connection.");
    } else if (!configured) {
        console.warn("[supabase.js] Supabase is not configured yet. Add your URL and anon key to js/config.js.");
    } else {
        client = window.supabase.createClient(cfg.url, cfg.anonKey, {
            auth: {
                persistSession: true,      // keep the user logged in (localStorage)
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        });
    }

    function isConfigured() {
        return client !== null;
    }

    function getClient() {
        if (!client) {
            throw new Error("Supabase is not configured. Add your URL and anon key to js/config.js.");
        }
        return client;
    }

    // Reads categories (public by RLS) to prove URL + key + tables all work.
    async function testConnection() {
        if (!client) {
            return { ok: false, message: "Supabase is not configured. Add your URL and anon key to js/config.js." };
        }
        const { count, error } = await client
            .from("categories")
            .select("id", { count: "exact", head: true });

        if (error) {
            console.error("[supabase.js] Connection test failed:", error);
            return { ok: false, message: `Connected, but the query failed: ${error.message}. Did you run schema.sql?` };
        }
        return { ok: true, message: `Connected. Found ${count} categories.` };
    }

    return {
        tables: { profiles: "profiles", categories: "categories", books: "books" },
        bucket: window.APP_CONFIG.storage.pdfBucket,
        isConfigured,
        getClient,
        testConnection
    };
})();

window.SupabaseService = SupabaseService;
window.supabaseClient = SupabaseService.isConfigured() ? SupabaseService.getClient() : null;