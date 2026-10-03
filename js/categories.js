/* =========================================================
   categories.js — category data operations (global object: CategoriesService)

   CategoriesService.listWithCounts()          -> Promise<[{ id, name, description, created_at, book_count }]>
   CategoriesService.validate({ name, description }) -> { valid, errors }
   CategoriesService.create({ name, description })
   CategoriesService.update(id, { name, description })
   CategoriesService.remove(id)                refuses while books still use the category

   RLS decides who may write; the browser only asks.
   Needs (loaded before): supabase.js
   ========================================================= */

const CategoriesService = (() => {
    const client = () => SupabaseService.getClient();
    const table = (name) => (SupabaseService.tables && SupabaseService.tables[name]) || name;

    function friendlyError(err) {
        const msg = ((err && err.message) || "").toLowerCase();
        if (err && err.userMessage) return err.userMessage;
        if (err && err.code === "23505") return "A category with that name already exists.";
        if (err && err.code === "23503") return "This category is still used by books. Move them to another category first.";
        if (err && (err.code === "42501" || msg.includes("row-level security"))) return "You don't have permission to perform this action.";
        if (msg.includes("failed to fetch") || msg.includes("network")) return "Unable to reach the server. Please check your connection and try again.";
        return "Something went wrong. Please try again.";
    }

    function validate({ name = "", description = "" } = {}) {
        const errors = {};
        const n = name.trim();
        if (!n) errors.name = "Enter a category name.";
        else if (n.length > 80) errors.name = "Name must be 80 characters or fewer.";
        if (description.length > 500) errors.description = "Description must be 500 characters or fewer.";
        return { valid: Object.keys(errors).length === 0, errors };
    }

    async function listWithCounts() {
        const { data, error } = await client()
            .from(table("categories"))
            .select("id, name, description, created_at, book_categories(count)")
            .order("name", { ascending: true });
        if (error) throw error;
        return (data || []).map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            created_at: row.created_at,
            book_count: row.book_categories && row.book_categories[0] ? row.book_categories[0].count : 0
        }));
    }

    async function create({ name, description }) {
        const { data, error } = await client()
            .from(table("categories"))
            .insert({ name: name.trim(), description: description.trim() || null })
            .select()
            .single();
        if (error) { error.userMessage = friendlyError(error); throw error; }
        return data;
    }

    async function update(id, { name, description }) {
        const { data, error } = await client()
            .from(table("categories"))
            .update({ name: name.trim(), description: description.trim() || null, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select()
            .single();
        if (error) {
            if (error.code === "PGRST116") error.code = "42501"; // RLS hid the row
            error.userMessage = friendlyError(error);
            throw error;
        }
        return data;
    }

    async function remove(id) {
        const { count, error: countError } = await client()
            .from(table("books"))
            .select("id", { count: "exact", head: true })
            .eq("category_id", id);
        if (countError) { countError.userMessage = friendlyError(countError); throw countError; }
        if (count > 0) {
            throw Object.assign(new Error("Category in use"), {
                userMessage: `This category has ${count} ${count === 1 ? "book" : "books"}. Move ${count === 1 ? "it" : "them"} to another category first.`
            });
        }

        const { data, error } = await client().from(table("categories")).delete().eq("id", id).select("id");
        if (error) { error.userMessage = friendlyError(error); throw error; }
        if (!data || data.length === 0) {
            throw Object.assign(new Error("Delete blocked"), { userMessage: "You don't have permission to perform this action." });
        }
    }

    return { listWithCounts, validate, create, update, remove, friendlyError };
})();

window.CategoriesService = CategoriesService;