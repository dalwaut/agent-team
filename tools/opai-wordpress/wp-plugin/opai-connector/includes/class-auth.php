<?php
/**
 * OPAI Connector — Authentication.
 *
 * Supports two auth methods (checked in order):
 *   1. X-OPAI-Key header — shared secret stored in wp_options
 *   2. Basic Auth (Application Password) — uses WP's built-in validation
 *
 * Method 2 means the connector works immediately after install if the site
 * already has an Application Password set up (which it does if connected
 * to OP WordPress).
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_Auth {

    /**
     * REST permission callback — validates authentication.
     *
     * @param WP_REST_Request $request
     * @return bool|WP_Error
     */
    public static function check( $request ) {
        // Method 1: X-OPAI-Key header
        $key = $request->get_header( 'X-OPAI-Key' );
        if ( ! empty( $key ) ) {
            $stored = get_option( 'opai_connector_key', '' );
            if ( ! empty( $stored ) && hash_equals( $stored, $key ) ) {
                return true;
            }
            // If key was provided but wrong, don't fall through — fail
            return new WP_Error(
                'opai_invalid_key',
                'Invalid OPAI key.',
                [ 'status' => 403 ]
            );
        }

        // Method 2: Basic Auth (Application Password)
        // WordPress automatically validates Basic Auth and sets the current user
        $user = wp_get_current_user();
        if ( $user && $user->ID > 0 ) {
            // Require administrator capability for connector operations
            if ( $user->has_cap( 'manage_options' ) ) {
                return true;
            }
            return new WP_Error(
                'opai_insufficient_permissions',
                'User does not have administrator privileges.',
                [ 'status' => 403 ]
            );
        }

        return new WP_Error(
            'opai_auth_required',
            'Authentication required. Provide X-OPAI-Key header or Basic Auth credentials.',
            [ 'status' => 401 ]
        );
    }

    /**
     * Generate and store a new connector key. Returns the key.
     *
     * @return string
     */
    public static function generate_key() {
        $key = wp_generate_password( 48, false );
        update_option( 'opai_connector_key', $key );
        return $key;
    }
}
