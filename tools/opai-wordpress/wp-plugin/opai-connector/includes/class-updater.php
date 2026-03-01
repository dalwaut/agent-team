<?php
/**
 * OPAI Connector — WordPress core, plugin, and theme updater.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_Updater {

    /**
     * GET /wp-json/opai/v1/updates/check
     * Returns available updates for core, plugins, and themes.
     *
     * Optional query param: ?refresh=0 to skip transient refresh (read cached only).
     * Default is refresh=1 which forces wp_update_plugins() etc.
     */
    public static function check( $request ) {
        // Ensure required admin files are loaded (REST API context
        // doesn't have these by default — causes fatals on some hosts)
        if ( ! function_exists( 'get_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        if ( ! function_exists( 'get_core_updates' ) ) {
            require_once ABSPATH . 'wp-admin/includes/update.php';
        }

        $do_refresh = $request->get_param( 'refresh' ) !== '0';
        $refreshed = false;
        $refresh_warnings = [];

        if ( $do_refresh ) {
            // Try to force WordPress to refresh update transients.
            // Some hosts disable functions that these calls depend on,
            // causing fatal errors. We register a shutdown handler to
            // still return data if a fatal occurs during refresh.
            register_shutdown_function( [ __CLASS__, '_shutdown_handler' ] );

            $old_handler = set_error_handler( function( $errno, $errstr ) use ( &$refresh_warnings ) {
                $refresh_warnings[] = $errstr;
                return true;
            } );

            try {
                if ( function_exists( 'wp_update_plugins' ) ) {
                    wp_update_plugins();
                }
                if ( function_exists( 'wp_update_themes' ) ) {
                    wp_update_themes();
                }
                if ( function_exists( 'wp_version_check' ) ) {
                    wp_version_check();
                }
                $refreshed = true;
            } catch ( \Throwable $e ) {
                $refresh_warnings[] = $e->getMessage();
            }

            restore_error_handler();
        }

        $result = [
            'core'    => self::_core_updates(),
            'plugins' => self::_plugin_updates(),
            'themes'  => self::_theme_updates(),
            'refreshed' => $refreshed,
        ];

        $result['total'] = count( $result['plugins'] ) + count( $result['themes'] )
                           + ( $result['core']['available'] ? 1 : 0 );

        if ( ! empty( $refresh_warnings ) ) {
            $result['refresh_warnings'] = $refresh_warnings;
        }

        return rest_ensure_response( $result );
    }

    /**
     * Shutdown handler — if a fatal error occurs during update check,
     * output the transient data we have and exit cleanly.
     */
    public static function _shutdown_handler() {
        $error = error_get_last();
        if ( $error && in_array( $error['type'], [ E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR ], true ) ) {
            // Fatal error during refresh — return stale transient data
            if ( ! headers_sent() ) {
                header( 'Content-Type: application/json; charset=UTF-8' );
                http_response_code( 200 );
            }

            if ( ! function_exists( 'get_plugins' ) ) {
                require_once ABSPATH . 'wp-admin/includes/plugin.php';
            }

            $result = [
                'core'    => self::_core_updates(),
                'plugins' => self::_plugin_updates(),
                'themes'  => self::_theme_updates(),
                'refreshed' => false,
                'refresh_warnings' => [ 'Fatal error during refresh: ' . $error['message'] ],
            ];
            $result['total'] = count( $result['plugins'] ) + count( $result['themes'] )
                               + ( $result['core']['available'] ? 1 : 0 );

            // Clean any output buffers
            while ( ob_get_level() > 0 ) {
                ob_end_clean();
            }

            echo wp_json_encode( $result );
            exit;
        }
    }

    /**
     * POST /wp-json/opai/v1/updates/apply
     * Body: { "type": "all"|"plugins"|"themes"|"core", "items": ["plugin-slug", ...] }
     */
    public static function apply( $request ) {
        $type  = $request->get_param( 'type' ) ?: 'all';
        $items = $request->get_param( 'items' ) ?: [];

        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/plugin.php';

        // Silent skin — no output
        $skin = new Automatic_Upgrader_Skin();
        $results = [];

        // Plugins
        if ( in_array( $type, [ 'all', 'plugins' ], true ) ) {
            $plugin_updates = self::_plugin_updates();
            $upgrader = new Plugin_Upgrader( $skin );

            foreach ( $plugin_updates as $pu ) {
                $file = $pu['file'];
                // If items specified, only update those
                if ( ! empty( $items ) && ! in_array( $pu['slug'], $items, true ) ) {
                    continue;
                }
                $ok = $upgrader->upgrade( $file );
                $results[] = [
                    'type'   => 'plugin',
                    'name'   => $pu['name'],
                    'slug'   => $pu['slug'],
                    'from'   => $pu['version'],
                    'to'     => $pu['new_version'],
                    'status' => ( $ok && ! is_wp_error( $ok ) ) ? 'updated' : 'failed',
                    'error'  => is_wp_error( $ok ) ? $ok->get_error_message() : null,
                ];
            }
        }

        // Themes
        if ( in_array( $type, [ 'all', 'themes' ], true ) ) {
            $theme_updates = self::_theme_updates();
            $upgrader = new Theme_Upgrader( $skin );

            foreach ( $theme_updates as $tu ) {
                if ( ! empty( $items ) && ! in_array( $tu['slug'], $items, true ) ) {
                    continue;
                }
                $ok = $upgrader->upgrade( $tu['slug'] );
                $results[] = [
                    'type'   => 'theme',
                    'name'   => $tu['name'],
                    'slug'   => $tu['slug'],
                    'from'   => $tu['version'],
                    'to'     => $tu['new_version'],
                    'status' => ( $ok && ! is_wp_error( $ok ) ) ? 'updated' : 'failed',
                    'error'  => is_wp_error( $ok ) ? $ok->get_error_message() : null,
                ];
            }
        }

        // Core
        if ( in_array( $type, [ 'all', 'core' ], true ) ) {
            $core = self::_core_updates();
            if ( $core['available'] ) {
                require_once ABSPATH . 'wp-admin/includes/class-core-upgrader.php';
                $upgrader = new Core_Upgrader( $skin );
                $ok = $upgrader->upgrade( $core['update_object'] );
                $results[] = [
                    'type'   => 'core',
                    'name'   => 'WordPress',
                    'from'   => $core['current'],
                    'to'     => $core['new_version'],
                    'status' => ( $ok && ! is_wp_error( $ok ) ) ? 'updated' : 'failed',
                    'error'  => is_wp_error( $ok ) ? $ok->get_error_message() : null,
                ];
            }
        }

        return rest_ensure_response( [
            'applied' => count( $results ),
            'results' => $results,
        ] );
    }

    // ── Helpers ──────────────────────────────────────────

    private static function _core_updates() {
        global $wp_version;
        $updates = get_core_updates();
        $available = false;
        $new_ver   = $wp_version;
        $obj       = null;

        if ( is_array( $updates ) ) {
            foreach ( $updates as $u ) {
                if ( isset( $u->response ) && $u->response === 'upgrade' ) {
                    $available = true;
                    $new_ver   = $u->current;
                    $obj       = $u;
                    break;
                }
            }
        }

        return [
            'available'     => $available,
            'current'       => $wp_version,
            'new_version'   => $new_ver,
            'update_object' => $obj,
        ];
    }

    private static function _plugin_updates() {
        $updates = get_site_transient( 'update_plugins' );
        $list    = [];

        if ( ! empty( $updates->response ) && is_array( $updates->response ) ) {
            $all_plugins = get_plugins();
            foreach ( $updates->response as $file => $info ) {
                $name = isset( $all_plugins[ $file ] ) ? $all_plugins[ $file ]['Name'] : $file;
                $ver  = isset( $all_plugins[ $file ] ) ? $all_plugins[ $file ]['Version'] : '?';
                $list[] = [
                    'file'        => $file,
                    'slug'        => $info->slug ?? basename( dirname( $file ) ),
                    'name'        => $name,
                    'version'     => $ver,
                    'new_version' => $info->new_version ?? '?',
                ];
            }
        }

        return $list;
    }

    private static function _theme_updates() {
        $updates = get_site_transient( 'update_themes' );
        $list    = [];

        if ( ! empty( $updates->response ) && is_array( $updates->response ) ) {
            foreach ( $updates->response as $slug => $info ) {
                $theme = wp_get_theme( $slug );
                $list[] = [
                    'slug'        => $slug,
                    'name'        => $theme->exists() ? $theme->get( 'Name' ) : $slug,
                    'version'     => $theme->exists() ? $theme->get( 'Version' ) : '?',
                    'new_version' => $info['new_version'] ?? '?',
                ];
            }
        }

        return $list;
    }
}
