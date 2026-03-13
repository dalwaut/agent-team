<?php
/**
 * Plugin Name: OPAI Connector
 * Description: Enables remote management from OP WordPress — updates, backups, health checks.
 * Version: 1.6.0
 * Author: BoutaByte / OPAI
 * License: GPL-2.0-or-later
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'OPAI_CONNECTOR_VERSION', '1.6.0' );
define( 'OPAI_CONNECTOR_DIR', plugin_dir_path( __FILE__ ) );
define( 'OPAI_CONNECTOR_BACKUP_DIR', WP_CONTENT_DIR . '/opai-backups' );

require_once OPAI_CONNECTOR_DIR . 'includes/class-auth.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-health.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-updater.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-backup.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-autologin.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-performance.php';
require_once OPAI_CONNECTOR_DIR . 'includes/class-self-update.php';

// Register WP-Cron hook for async backups (runs in background PHP process)
add_action( 'opai_backup_run', [ 'OPAI_Backup', 'run_scheduled_backup' ], 10, 2 );

// Auto-login fires on 'init' (before headers) via ?opai_autologin=1 query var
add_action( 'init', [ 'OPAI_AutoLogin', 'handle' ] );

/**
 * Register REST API routes.
 */
add_action( 'rest_api_init', function () {
    $ns = 'opai/v1';

    register_rest_route( $ns, '/health', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Health', 'handle' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/updates/check', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Updater', 'check' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/updates/apply', [
        'methods'             => 'POST',
        'callback'            => [ 'OPAI_Updater', 'apply' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/setup', [
        'methods'             => 'POST',
        'callback'            => function ( $request ) {
            $force = $request->get_param( 'force' );
            $existing = get_option( 'opai_connector_key', '' );

            if ( ! empty( $existing ) && ! $force ) {
                return rest_ensure_response( [
                    'status'        => 'configured',
                    'connector_key' => $existing,
                    'version'       => OPAI_CONNECTOR_VERSION,
                ] );
            }

            $key = OPAI_Auth::generate_key();
            return rest_ensure_response( [
                'status'        => 'configured',
                'connector_key' => $key,
                'version'       => OPAI_CONNECTOR_VERSION,
            ] );
        },
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/backup/create', [
        'methods'             => 'POST',
        'callback'            => [ 'OPAI_Backup', 'create' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/create-async', [
        'methods'             => 'POST',
        'callback'            => [ 'OPAI_Backup', 'create_async' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/dump-db', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Backup', 'dump_db' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/list', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Backup', 'list_backups' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/restore', [
        'methods'             => 'POST',
        'callback'            => [ 'OPAI_Backup', 'restore' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/download/(?P<id>[a-zA-Z0-9_-]+)', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Backup', 'download' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/status/(?P<id>[a-zA-Z0-9_-]+)', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Backup', 'status' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
    register_rest_route( $ns, '/backup/stream-tar', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Backup', 'stream_tar' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/performance/audit', [
        'methods'             => 'GET',
        'callback'            => [ 'OPAI_Performance', 'audit' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/connector/self-update', [
        'methods'             => 'POST',
        'callback'            => [ 'OPAI_SelfUpdate', 'update' ],
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );

    register_rest_route( $ns, '/themes/(?P<stylesheet>[a-zA-Z0-9_\-]+)/delete', [
        'methods'             => 'POST',
        'callback'            => function ( $request ) {
            $stylesheet = $request->get_param( 'stylesheet' );

            // Cannot delete the active theme.
            $active = get_option( 'stylesheet' );
            if ( $stylesheet === $active ) {
                return new WP_Error( 'cannot_delete_active', 'Cannot delete the active theme.', [ 'status' => 400 ] );
            }

            require_once ABSPATH . 'wp-admin/includes/theme.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $result = delete_theme( $stylesheet );
            if ( is_wp_error( $result ) ) {
                return new WP_Error( 'delete_failed', $result->get_error_message(), [ 'status' => 500 ] );
            }
            if ( $result === false ) {
                return new WP_Error( 'delete_failed', 'Theme could not be deleted.', [ 'status' => 500 ] );
            }

            return rest_ensure_response( [ 'status' => 'deleted', 'stylesheet' => $stylesheet ] );
        },
        'permission_callback' => [ 'OPAI_Auth', 'check' ],
    ] );
} );

/**
 * Add admin menu page for connection key.
 */
add_action( 'admin_menu', function () {
    add_options_page(
        'OPAI Connector',
        'OPAI Connector',
        'manage_options',
        'opai-connector',
        'opai_connector_settings_page'
    );
} );

/**
 * Show connection key notice on plugins page.
 */
add_action( 'admin_notices', function () {
    $screen = get_current_screen();
    if ( ! $screen || $screen->id !== 'plugins' ) return;

    $key = get_option( 'opai_connector_key', '' );
    if ( empty( $key ) ) {
        // Generate on first view
        $key = OPAI_Auth::generate_key();
    }

    echo '<div class="notice notice-info"><p>';
    echo '<strong>OPAI Connector</strong> is active. ';
    echo 'Your connection key: <code style="user-select:all;cursor:pointer;padding:2px 8px;background:#f0f0f0;border-radius:3px" title="Click to select">' . esc_html( $key ) . '</code> ';
    echo '&mdash; <a href="' . admin_url( 'options-general.php?page=opai-connector' ) . '">Settings</a>';
    echo '</p></div>';
} );

/**
 * Settings page renderer.
 */
function opai_connector_settings_page() {
    // Handle regenerate
    if ( isset( $_POST['opai_regenerate_key'] ) && check_admin_referer( 'opai_connector_settings' ) ) {
        OPAI_Auth::generate_key();
        echo '<div class="notice notice-success"><p>Connection key regenerated.</p></div>';
    }

    $key = get_option( 'opai_connector_key', '' );
    if ( empty( $key ) ) {
        $key = OPAI_Auth::generate_key();
    }

    ?>
    <div class="wrap">
        <h1>OPAI Connector</h1>
        <p>This plugin connects your WordPress site to <strong>OP WordPress</strong> for remote management.</p>

        <table class="form-table">
            <tr>
                <th scope="row">Connection Key</th>
                <td>
                    <input type="text" readonly value="<?php echo esc_attr( $key ); ?>"
                           class="regular-text" style="font-family:monospace;user-select:all;cursor:pointer"
                           onclick="this.select()" id="opai-key-field">
                    <button type="button" class="button" onclick="
                        var f=document.getElementById('opai-key-field');
                        f.select();
                        document.execCommand('copy');
                        this.textContent='Copied!';
                        setTimeout(function(){document.querySelector('.opai-copy-btn').textContent='Copy';},2000);
                    " class="opai-copy-btn">Copy</button>
                    <p class="description">
                        Copy this key and paste it into your site settings in OP WordPress.<br>
                        Go to <strong>OP WordPress &rarr; Sites &rarr; Settings &rarr; Connector Key</strong>.
                    </p>
                </td>
            </tr>
            <tr>
                <th scope="row">Version</th>
                <td><?php echo OPAI_CONNECTOR_VERSION; ?></td>
            </tr>
            <tr>
                <th scope="row">Status</th>
                <td>
                    <span style="color:green">&#9679;</span> Active
                </td>
            </tr>
        </table>

        <form method="post">
            <?php wp_nonce_field( 'opai_connector_settings' ); ?>
            <p>
                <input type="submit" name="opai_regenerate_key" class="button"
                       value="Regenerate Key"
                       onclick="return confirm('This will invalidate the current key. You will need to update it in OP WordPress.');">
            </p>
        </form>
    </div>
    <?php
}

/**
 * Add settings link on plugins page.
 */
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $links ) {
    array_unshift( $links,
        '<a href="' . admin_url( 'options-general.php?page=opai-connector' ) . '">Connection Key</a>'
    );
    return $links;
} );

/**
 * On activation: generate key + create backup dir.
 */
register_activation_hook( __FILE__, function () {
    // Generate key if not exists
    if ( empty( get_option( 'opai_connector_key', '' ) ) ) {
        OPAI_Auth::generate_key();
    }

    if ( ! file_exists( OPAI_CONNECTOR_BACKUP_DIR ) ) {
        wp_mkdir_p( OPAI_CONNECTOR_BACKUP_DIR );
    }
    $htaccess = OPAI_CONNECTOR_BACKUP_DIR . '/.htaccess';
    if ( ! file_exists( $htaccess ) ) {
        file_put_contents( $htaccess, "Deny from all\n" );
    }
    $index = OPAI_CONNECTOR_BACKUP_DIR . '/index.php';
    if ( ! file_exists( $index ) ) {
        file_put_contents( $index, "<?php // Silence is golden.\n" );
    }
} );
