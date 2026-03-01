/**
 * Supabase client for Boutabyte MCP
 * Uses service_role key to bypass RLS for admin operations
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (!supabase) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY;

        if (!url || !key) {
            throw new Error(
                'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables. ' +
                'Set these in your MCP server configuration.'
            );
        }

        supabase = createClient(url, key, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }
    return supabase;
}

// ============================================
// SUB_APPS (Web Apps)
// ============================================

export interface CreateSubAppInput {
    name: string;
    slug: string;
    description?: string;
    excerpt?: string;
    meta_description?: string;
    focus_keyphrase?: string;
    storage_type: string;
    storage_path: string;
    entry_point?: string;
    tier_requirement?: string;
    tags?: string[];
    category_id?: string;
    demo_mode?: boolean;
    frontend_display?: boolean;
    approved?: boolean;
    bundle_size_mb?: number;
    icon?: string;
    logo_url?: string;
    created_by?: string;
}

export async function createSubApp(input: CreateSubAppInput) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('sub_apps')
        .insert({
            name: input.name,
            slug: input.slug,
            description: input.description || null,
            excerpt: input.excerpt || null,
            meta_description: input.meta_description || null,
            focus_keyphrase: input.focus_keyphrase || null,
            storage_type: input.storage_type,
            storage_path: input.storage_path,
            entry_point: input.entry_point || 'index.html',
            tier_requirement: input.tier_requirement || 'free',
            tags: input.tags || [],
            category_id: input.category_id || null,
            demo_mode: input.demo_mode ?? false,
            frontend_display: input.frontend_display ?? true,
            approved: input.approved ?? true,
            bundle_size_mb: input.bundle_size_mb || null,
            icon: input.icon || null,
            logo_url: input.logo_url || null,
            created_by: input.created_by || process.env.DEFAULT_ADMIN_USER_ID || null,
        })
        .select()
        .single();

    if (error) throw new Error(`Failed to create sub_app: ${error.message}`);
    return data;
}

export async function getSubAppBySlug(slug: string) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('sub_apps')
        .select('*')
        .eq('slug', slug)
        .single();

    if (error && error.code !== 'PGRST116') {
        throw new Error(`Failed to query sub_apps: ${error.message}`);
    }
    return data;
}

export async function updateSubApp(id: string, updates: Record<string, any>) {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('sub_apps')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw new Error(`Failed to update sub_app: ${error.message}`);
    return data;
}

export async function listSubApps() {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('sub_apps')
        .select('id, name, slug, description, storage_type, storage_path, approved, tier_requirement, demo_mode, frontend_display, created_at, updated_at')
        .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list sub_apps: ${error.message}`);
    return data || [];
}

// ============================================
// MOBILE_APPS
// ============================================

export async function listMobileApps() {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('mobile_apps')
        .select('id, name, slug, platform, version, storage_type, storage_path, approved, tier_requirement, created_at, updated_at')
        .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list mobile_apps: ${error.message}`);
    return data || [];
}

// ============================================
// WP_PLUGINS
// ============================================

export async function listPlugins() {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('wp_plugins')
        .select('id, name, slug, version, description, tier_requirement, is_active, created_at, updated_at')
        .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list wp_plugins: ${error.message}`);
    return data || [];
}

// ============================================
// N8N_AUTOMATIONS
// ============================================

export async function listAutomations() {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('n8n_automations')
        .select('ID, Name, Description, Category, is_active, createdAt, updatedAt')
        .order('createdAt', { ascending: false });

    if (error) throw new Error(`Failed to list n8n_automations: ${error.message}`);
    return data || [];
}

// ============================================
// WEBAPP CATEGORIES
// ============================================

export async function listCategories() {
    const sb = getSupabase();
    const { data, error } = await sb
        .from('webapp_categories')
        .select('id, name, slug, description, icon, display_order, is_active')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

    if (error) throw new Error(`Failed to list categories: ${error.message}`);
    return data || [];
}
