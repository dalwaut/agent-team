<?php
/**
 * OPAI Connector — Self-Update Endpoint.
 *
 * Receives a new connector ZIP via REST API and extracts it in-place,
 * bypassing wp-admin login entirely.  This allows updates even when
 * admin_password auth is broken (security plugin, WAF, wrong password).
 *
 * Protected by the same OPAI_Auth::check() as all other endpoints.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_SelfUpdate {

    /**
     * Handle POST /opai/v1/connector/self-update
     *
     * Expects a multipart file upload with key "plugin" containing the ZIP.
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response|WP_Error
     */
    public static function update( $request ) {
        $files = $request->get_file_params();

        if ( empty( $files['plugin'] ) || empty( $files['plugin']['tmp_name'] ) ) {
            return new WP_Error(
                'no_file',
                'No plugin ZIP file provided. Send as multipart field "plugin".',
                [ 'status' => 400 ]
            );
        }

        $tmp_zip = $files['plugin']['tmp_name'];
        if ( ! file_exists( $tmp_zip ) ) {
            return new WP_Error( 'upload_failed', 'Uploaded file not found on disk.', [ 'status' => 400 ] );
        }

        // ── Validate ZIP contents ────────────────────────────────
        $zip = new ZipArchive();
        $opened = $zip->open( $tmp_zip );
        if ( $opened !== true ) {
            return new WP_Error( 'invalid_zip', 'Could not open ZIP file.', [ 'status' => 400 ] );
        }

        // Must contain opai-connector/opai-connector.php
        $main_file = $zip->getFromName( 'opai-connector/opai-connector.php' );
        if ( $main_file === false ) {
            $zip->close();
            return new WP_Error(
                'invalid_plugin',
                'ZIP must contain opai-connector/opai-connector.php.',
                [ 'status' => 400 ]
            );
        }

        // Verify plugin header
        if ( strpos( $main_file, 'Plugin Name: OPAI Connector' ) === false ) {
            $zip->close();
            return new WP_Error(
                'invalid_plugin',
                'opai-connector.php does not contain expected plugin header.',
                [ 'status' => 400 ]
            );
        }

        // Extract new version from header
        $new_version = '0.0.0';
        if ( preg_match( '/Version:\s*([0-9.]+)/', $main_file, $m ) ) {
            $new_version = $m[1];
        }

        $zip->close();

        // ── Set up WP_Filesystem ─────────────────────────────────
        require_once ABSPATH . 'wp-admin/includes/file.php';
        WP_Filesystem();
        global $wp_filesystem;

        if ( ! $wp_filesystem ) {
            return new WP_Error(
                'filesystem_error',
                'Could not initialize WP_Filesystem.',
                [ 'status' => 500 ]
            );
        }

        $plugins_dir = $wp_filesystem->wp_plugins_dir();
        $target_dir  = $plugins_dir . 'opai-connector/';
        $backup_dir  = $plugins_dir . 'opai-connector-backup-' . time() . '/';

        // ── Backup current plugin ────────────────────────────────
        if ( $wp_filesystem->is_dir( $target_dir ) ) {
            $copied = copy_dir( $target_dir, $backup_dir );
            if ( is_wp_error( $copied ) ) {
                return new WP_Error(
                    'backup_failed',
                    'Could not back up current plugin: ' . $copied->get_error_message(),
                    [ 'status' => 500 ]
                );
            }
        }

        // ── Extract new version ──────────────────────────────────
        $result = unzip_file( $tmp_zip, $plugins_dir );

        if ( is_wp_error( $result ) ) {
            // Restore backup
            if ( $wp_filesystem->is_dir( $backup_dir ) ) {
                $wp_filesystem->delete( $target_dir, true );
                $wp_filesystem->move( $backup_dir, $target_dir );
            }
            return new WP_Error(
                'extract_failed',
                'Failed to extract ZIP: ' . $result->get_error_message(),
                [ 'status' => 500 ]
            );
        }

        // ── Verify new version loads ─────────────────────────────
        $main_php = $target_dir . 'opai-connector.php';
        if ( ! $wp_filesystem->exists( $main_php ) ) {
            // Restore backup
            if ( $wp_filesystem->is_dir( $backup_dir ) ) {
                $wp_filesystem->delete( $target_dir, true );
                $wp_filesystem->move( $backup_dir, $target_dir );
            }
            return new WP_Error(
                'verify_failed',
                'Extraction succeeded but opai-connector.php not found — rolled back.',
                [ 'status' => 500 ]
            );
        }

        // Clean up backup
        if ( $wp_filesystem->is_dir( $backup_dir ) ) {
            $wp_filesystem->delete( $backup_dir, true );
        }

        // Clean up temp ZIP
        @unlink( $tmp_zip );

        return rest_ensure_response( [
            'status'       => 'updated',
            'old_version'  => OPAI_CONNECTOR_VERSION,
            'new_version'  => $new_version,
        ] );
    }
}
