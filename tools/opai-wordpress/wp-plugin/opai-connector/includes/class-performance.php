<?php
/**
 * OPAI Performance — server-side metrics collector.
 *
 * Gathers database health, cache status, plugin inventory, and PHP/WP
 * environment details that external tools (PageSpeed Insights) cannot see.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_Performance {

    /**
     * REST callback — returns a comprehensive server-side audit payload.
     */
    public static function audit( $request ) {
        global $wpdb;

        $data = [];

        // ── Autoloaded options ───────────────────────────────────
        $autoload_size = $wpdb->get_var(
            "SELECT SUM(LENGTH(option_value)) FROM {$wpdb->options} WHERE autoload = 'yes'"
        );
        $data['autoload_size_bytes'] = (int) $autoload_size;

        $top_autoloaded = $wpdb->get_results(
            "SELECT option_name, LENGTH(option_value) AS size_bytes
             FROM {$wpdb->options}
             WHERE autoload = 'yes'
             ORDER BY size_bytes DESC
             LIMIT 20",
            ARRAY_A
        );
        $data['autoloaded_top20'] = $top_autoloaded ?: [];

        // ── Transients ───────────────────────────────────────────
        $total_transients = (int) $wpdb->get_var(
            "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE '_transient_%'"
        );
        $expired_transients = (int) $wpdb->get_var(
            "SELECT COUNT(*) FROM {$wpdb->options}
             WHERE option_name LIKE '_transient_timeout_%'
             AND option_value < UNIX_TIMESTAMP()"
        );
        $data['total_transients']   = $total_transients;
        $data['expired_transients'] = $expired_transients;

        // ── Post revisions ───────────────────────────────────────
        $data['revision_count'] = (int) $wpdb->get_var(
            "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'revision'"
        );

        // ── Table sizes ──────────────────────────────────────────
        $db_name = DB_NAME;
        $tables = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT table_name AS `table`,
                        ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb
                 FROM information_schema.tables
                 WHERE table_schema = %s
                 ORDER BY (data_length + index_length) DESC
                 LIMIT 20",
                $db_name
            ),
            ARRAY_A
        );
        $data['table_sizes'] = $tables ?: [];

        // ── Active plugins ───────────────────────────────────────
        $active_plugins = get_option( 'active_plugins', [] );
        $plugin_info    = [];
        foreach ( $active_plugins as $plugin_file ) {
            $full_path = WP_PLUGIN_DIR . '/' . $plugin_file;
            $plugin_info[] = [
                'file'     => $plugin_file,
                'size_kb'  => file_exists( $full_path ) ? round( filesize( $full_path ) / 1024, 1 ) : 0,
            ];
        }
        $data['active_plugins']      = $plugin_info;
        $data['active_plugin_count'] = count( $active_plugins );

        // ── Theme ────────────────────────────────────────────────
        $theme = wp_get_theme();
        $data['theme']        = $theme->get( 'Name' );
        $data['parent_theme'] = $theme->parent() ? $theme->parent()->get( 'Name' ) : null;

        // ── Environment ──────────────────────────────────────────
        $data['php_version']          = phpversion();
        $data['mysql_version']        = $wpdb->db_version();
        $data['wp_version']           = get_bloginfo( 'version' );
        $data['memory_limit']         = ini_get( 'memory_limit' );
        $data['max_execution_time']   = (int) ini_get( 'max_execution_time' );

        // ── Object cache ─────────────────────────────────────────
        $object_cache_file = WP_CONTENT_DIR . '/object-cache.php';
        $data['object_cache'] = file_exists( $object_cache_file );
        $data['object_cache_type'] = null;

        if ( $data['object_cache'] ) {
            $header = file_get_contents( $object_cache_file, false, null, 0, 500 );
            if ( stripos( $header, 'redis' ) !== false ) {
                $data['object_cache_type'] = 'redis';
            } elseif ( stripos( $header, 'memcache' ) !== false ) {
                $data['object_cache_type'] = 'memcached';
            } else {
                $data['object_cache_type'] = 'unknown';
            }
        }

        // ── Page cache detection ─────────────────────────────────
        $page_cache = 'none';
        if ( defined( 'LSCWP_V' ) ) {
            $page_cache = 'litespeed';
        } elseif ( defined( 'WPFC_MAIN_PATH' ) ) {
            $page_cache = 'wp-fastest-cache';
        } elseif ( defined( 'WP_CACHE' ) && WP_CACHE ) {
            // Generic WP_CACHE constant — try to identify which plugin
            if ( defined( 'WPCACHEHOME' ) ) {
                $page_cache = 'wp-super-cache';
            } elseif ( class_exists( 'W3_Plugin_TotalCache' ) || defined( 'W3TC' ) ) {
                $page_cache = 'w3-total-cache';
            } else {
                $page_cache = 'wp-cache-generic';
            }
        }
        $data['page_cache_detected'] = $page_cache;

        // ── WP-Cron ──────────────────────────────────────────────
        $data['wp_cron_disabled'] = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;

        $cron_overdue = 0;
        $crons = _get_cron_array();
        if ( is_array( $crons ) ) {
            $now = time();
            foreach ( $crons as $timestamp => $hooks ) {
                if ( $timestamp < $now ) {
                    $cron_overdue += count( $hooks );
                }
            }
        }
        $data['cron_overdue'] = $cron_overdue;

        // ── Content counts ───────────────────────────────────────
        $post_counts = wp_count_posts();
        $page_counts = wp_count_posts( 'page' );
        $media_counts = wp_count_posts( 'attachment' );

        $data['post_count']  = isset( $post_counts->publish ) ? (int) $post_counts->publish : 0;
        $data['page_count']  = isset( $page_counts->publish ) ? (int) $page_counts->publish : 0;
        $data['media_count'] = isset( $media_counts->inherit ) ? (int) $media_counts->inherit : 0;

        // ── Upload dir size (capped at 5s) ───────────────────────
        $upload_dir  = wp_upload_dir();
        $upload_path = $upload_dir['basedir'];
        $data['upload_dir_size_mb'] = self::_dir_size_mb( $upload_path, 5 );

        return rest_ensure_response( $data );
    }

    /**
     * Recursively compute directory size in MB, capped by time limit.
     */
    private static function _dir_size_mb( $path, $max_seconds = 5 ) {
        if ( ! is_dir( $path ) ) {
            return 0;
        }

        $bytes  = 0;
        $start  = microtime( true );
        $stack  = [ $path ];

        while ( $stack ) {
            if ( ( microtime( true ) - $start ) > $max_seconds ) {
                break;
            }

            $dir = array_pop( $stack );
            $items = @scandir( $dir );
            if ( ! $items ) {
                continue;
            }

            foreach ( $items as $item ) {
                if ( $item === '.' || $item === '..' ) {
                    continue;
                }
                $full = $dir . '/' . $item;
                if ( is_file( $full ) ) {
                    $bytes += filesize( $full );
                } elseif ( is_dir( $full ) ) {
                    $stack[] = $full;
                }
            }
        }

        return round( $bytes / 1024 / 1024, 1 );
    }
}
