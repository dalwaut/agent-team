<?php
/**
 * OPAI Connector — Health check endpoint.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_Health {

    /**
     * GET /wp-json/opai/v1/health
     *
     * @return WP_REST_Response
     */
    public static function handle( $request ) {
        global $wpdb, $wp_version;

        // DB check
        $db_ok = true;
        try {
            $wpdb->query( 'SELECT 1' );
        } catch ( \Exception $e ) {
            $db_ok = false;
        }

        // Disk space — wrapped for shared hosts that disable these functions
        $free_bytes  = 0;
        $total_bytes = 0;
        if ( function_exists( 'disk_free_space' ) ) {
            $free_bytes = @disk_free_space( ABSPATH );
            if ( $free_bytes === false ) $free_bytes = 0;
        }
        if ( function_exists( 'disk_total_space' ) ) {
            $total_bytes = @disk_total_space( ABSPATH );
            if ( $total_bytes === false ) $total_bytes = 0;
        }

        // Plugins
        $active_plugins = get_option( 'active_plugins', [] );
        $all_plugins    = function_exists( 'get_plugins' ) ? get_plugins() : [];
        if ( empty( $all_plugins ) && function_exists( 'get_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
            $all_plugins = get_plugins();
        }

        // Active theme
        $theme      = wp_get_theme();
        $theme_name = $theme->exists() ? $theme->get( 'Name' ) : '';

        return rest_ensure_response( [
            'status'            => $db_ok ? 'healthy' : 'degraded',
            'wp_version'        => $wp_version,
            'php_version'       => phpversion(),
            'db_ok'             => $db_ok,
            'disk_free_bytes'   => $free_bytes,
            'disk_total_bytes'  => $total_bytes,
            'disk_free_pct'     => $total_bytes > 0 ? round( ( $free_bytes / $total_bytes ) * 100, 1 ) : 0,
            'active_plugins'    => count( $active_plugins ),
            'total_plugins'     => count( $all_plugins ),
            'active_theme'      => $theme_name,
            'memory_limit'      => ini_get( 'memory_limit' ),
            'connector_version' => OPAI_CONNECTOR_VERSION,
            'timestamp'         => gmdate( 'c' ),
        ] );
    }
}
