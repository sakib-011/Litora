/* =========================================================
   config.js — SAFE frontend configuration only.
   Safe to expose: Supabase URL, Supabase anon/publishable key,
   Cloudinary cloud name, unsigned upload preset.
   NEVER put here: Supabase service_role key, Cloudinary API
   secret, database password.
   ========================================================= */

window.APP_CONFIG = {
    appName: "Litora",

    supabase: {
        // Project root URL only. No /rest/v1/ at the end.
        url: "https://wijuccrtjebgnqbbaymi.supabase.co",
        anonKey: "sb_publishable_bNVACofwMhkav-uoDaWT5Q_S4w358P3"
    },

    cloudinary: {
        cloudName: "udneqwjn",
        uploadPreset: "pdf_upolader", // must match the UNSIGNED preset name in your Cloudinary dashboard
        folder: "library-covers"
    },

    storage: {
        pdfBucket: "pdfs",
        maxPdfSizeMB: 50,
        maxCoverSizeMB: 5
    },

    pdfjs: {
        // Phase 9 loads PDF.js from this CDN
        libUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
        workerUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
    }
};