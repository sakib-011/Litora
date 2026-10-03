/* =========================================================
   requests.js — Book Requests service (RequestsService)
   Direct Supabase database integration for book requests.
   ========================================================= */

const RequestsService = (() => {
    const tbl = (name) => (SupabaseService.tables && SupabaseService.tables[name]) || name;

    async function listAll() {
        const client = SupabaseService.getClient();
        const { data, error } = await client
            .from(tbl("book_requests"))
            .select("*")
            .order("created_at", { ascending: false });

        if (error) {
            console.error("[requests.js] Error fetching book requests:", error);
            return [];
        }
        return data || [];
    }

    async function listMyRequests(userId, email) {
        const client = SupabaseService.getClient();
        let query = client.from(tbl("book_requests")).select("*").order("created_at", { ascending: false });
        if (userId) {
            query = query.or(`user_id.eq.${userId}${email ? `,user_email.eq.${email}` : ""}`);
        } else if (email) {
            query = query.eq("user_email", email);
        }

        const { data, error } = await query;
        if (error) {
            console.error("[requests.js] Error fetching my requests:", error);
            return [];
        }
        return data || [];
    }

    async function createRequest({ title, author, version_notes, user_id, user_name, user_email }) {
        const newReq = {
            id: crypto.randomUUID(),
            user_id: user_id || null,
            user_name: user_name || "Anonymous",
            user_email: user_email || "",
            title: title.trim(),
            author: (author || "").trim(),
            version_notes: (version_notes || "").trim(),
            status: "pending",
            admin_notes: "",
            created_at: new Date().toISOString()
        };

        const client = SupabaseService.getClient();
        const { data, error } = await client.from(tbl("book_requests")).insert(newReq).select().single();
        if (error) {
            console.error("[requests.js] Create request failed:", error);
            throw error;
        }
        return data || newReq;
    }

    async function updateStatus(requestId, status, admin_notes = "") {
        const client = SupabaseService.getClient();
        const { data, error } = await client
            .from(tbl("book_requests"))
            .update({ status, admin_notes })
            .eq("id", requestId)
            .select()
            .single();

        if (error) {
            console.error("[requests.js] Update status failed:", error);
            throw error;
        }
        return data;
    }

    function sendNotificationEmail({ user_email, user_name, book_title, status, admin_notes }) {
        if (!user_email) return;

        const subject = status === "fulfilled"
            ? `Good news! Your book request for "${book_title}" has been uploaded to Litora`
            : `Update on your book request for "${book_title}"`;

        const statusLabel = status === "fulfilled" ? "Fulfilled & Uploaded" : "Request Declined";

        console.log(`%c[EMAIL NOTIFICATION] To: ${user_email}\nSubject: ${subject}\nStatus: ${statusLabel}\nNotes: ${admin_notes || "None"}`, "color:#4fd3a3; font-weight:bold; font-size:12px;");

        UI.toast.success(`Notification email sent to ${user_email}`, 5000);
    }

    return {
        listAll,
        listMyRequests,
        createRequest,
        updateStatus,
        sendNotificationEmail
    };
})();

window.RequestsService = RequestsService;
