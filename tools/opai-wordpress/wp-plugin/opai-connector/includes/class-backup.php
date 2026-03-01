<?php
/**
 * OPAI Connector — Full-site backup & restore engine.
 *
 * Creates a single ZIP containing the entire WordPress installation
 * (core files, wp-config.php, plugins, themes, uploads, media, .htaccess)
 * plus a database dump (db.sql) inside the archive.
 *
 * Based on the WE OneZip Backup engine — proven on Hostinger shared hosting.
 *
 * Storage format (flat):
 *   wp-content/opai-backups/{id}.zip        — the backup archive
 *   wp-content/opai-backups/{id}.meta.json   — metadata sidecar
 *
 * Retention: auto-delete backups older than 30 days.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class OPAI_Backup {

    /** Directories / files to exclude from file backups. */
    private static function _get_excludes() {
        return [
            OPAI_CONNECTOR_BACKUP_DIR,
            WP_CONTENT_DIR . '/cache',
            WP_CONTENT_DIR . '/uploads/cache',
            WP_CONTENT_DIR . '/backups',
            WP_CONTENT_DIR . '/updraft',
            WP_CONTENT_DIR . '/ai1wm-backups',
            WP_CONTENT_DIR . '/wpvividbackups',
            WP_CONTENT_DIR . '/wpvivid_staging',
            WP_CONTENT_DIR . '/litespeed',
            ABSPATH . 'wp-config.php~',
            ABSPATH . '.git',
            ABSPATH . '.svn',
            ABSPATH . 'node_modules',
        ];
    }

    /** Prefix-based excludes for directories matching a pattern (e.g. backup_*). */
    private static function _is_backup_dir( $name ) {
        return strpos( $name, 'backup_' ) === 0;
    }

    // ── REST endpoints ───────────────────────────────────

    /**
     * POST /wp-json/opai/v1/backup/create
     * Body: { "type": "full"|"database"|"files" }
     */
    public static function create( $request ) {
        @set_time_limit( 0 );

        $type = $request->get_param( 'type' ) ?: 'full';
        $id   = date( 'Ymd_His' ) . '_' . wp_generate_password( 6, false, false );

        $include_db    = in_array( $type, [ 'full', 'database' ], true );
        $include_files = in_array( $type, [ 'full', 'files' ], true );

        wp_mkdir_p( OPAI_CONNECTOR_BACKUP_DIR );

        $zip_path      = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.zip';
        $meta_path     = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.meta.json';
        $progress_path = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.progress.json';

        // Write initial progress
        self::_write_progress( $progress_path, [
            'phase'      => 'starting',
            'pct'        => 0,
            'started_at' => gmdate( 'c' ),
            'backup_id'  => $id,
        ] );

        // ── Database dump ────────────────────────────────
        $db_tmp = null;
        if ( $include_db ) {
            self::_write_progress( $progress_path, [
                'phase'      => 'database',
                'pct'        => 5,
                'db_done'    => false,
                'backup_id'  => $id,
            ] );

            $db_result = self::_dump_database();
            if ( ! $db_result['ok'] ) {
                @unlink( $progress_path );
                return new WP_Error( 'backup_db_failed', $db_result['error'], [ 'status' => 500 ] );
            }
            $db_tmp = $db_result['tmp_file'];

            self::_write_progress( $progress_path, [
                'phase'      => 'database',
                'pct'        => 15,
                'db_done'    => true,
                'backup_id'  => $id,
            ] );
        }

        // ── Files — ZipArchive, but only wp-content + config (not full ABSPATH) ──
        if ( ! class_exists( 'ZipArchive' ) ) {
            @unlink( $progress_path );
            return new WP_Error( 'backup_failed', 'ZipArchive extension not available', [ 'status' => 500 ] );
        }

        $zip = new ZipArchive();
        if ( $zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE ) !== true ) {
            @unlink( $progress_path );
            return new WP_Error( 'backup_failed', 'Unable to create ZIP archive', [ 'status' => 500 ] );
        }

        if ( $include_files ) {
            $added = 0;

            // ── wp-admin (core admin panel) ──
            if ( is_dir( ABSPATH . 'wp-admin' ) ) {
                self::_write_progress( $progress_path, [
                    'phase' => 'files', 'section' => 'wp-admin', 'pct' => 15,
                    'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
                ] );
                self::_add_path_to_zip( $zip, ABSPATH . 'wp-admin', 'wp-admin', $added, $progress_path, $id );
            }

            // ── wp-includes (core libraries) ──
            $wpinc_dir = ABSPATH . WPINC;
            if ( is_dir( $wpinc_dir ) ) {
                self::_write_progress( $progress_path, [
                    'phase' => 'files', 'section' => 'wp-includes', 'pct' => 30,
                    'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
                ] );
                self::_add_path_to_zip( $zip, $wpinc_dir, WPINC, $added, $progress_path, $id );
            }

            // ── wp-content (themes, plugins, uploads — with excludes) ──
            self::_write_progress( $progress_path, [
                'phase' => 'files', 'section' => 'wp-content', 'pct' => 50,
                'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
            ] );
            self::_add_path_to_zip( $zip, WP_CONTENT_DIR, 'wp-content', $added, $progress_path, $id );

            // ── Root files (wp-config.php, .htaccess, index.php, etc.) ──
            $root_files = glob( ABSPATH . '*.php' );
            if ( is_array( $root_files ) ) {
                foreach ( $root_files as $root_file ) {
                    $zip->addFile( $root_file, basename( $root_file ) );
                    $added++;
                }
            }
            if ( file_exists( ABSPATH . '.htaccess' ) ) {
                $zip->addFile( ABSPATH . '.htaccess', '.htaccess' );
            }
        }

        // Add db.sql
        if ( $db_tmp && is_file( $db_tmp ) ) {
            $zip->addFile( $db_tmp, 'db.sql' );
        }

        self::_write_progress( $progress_path, [
            'phase'      => 'finalizing',
            'pct'        => 92,
            'backup_id'  => $id,
        ] );

        $zip->close();

        // Clean up temp DB file
        if ( $db_tmp && is_file( $db_tmp ) ) {
            @unlink( $db_tmp );
        }

        // Verify the ZIP was actually written
        if ( ! file_exists( $zip_path ) || filesize( $zip_path ) === 0 ) {
            @unlink( $progress_path );
            return new WP_Error( 'backup_failed', 'ZIP file was not created', [ 'status' => 500 ] );
        }

        $size = filesize( $zip_path );

        // ── Write metadata sidecar ───────────────────────
        $meta = [
            'id'         => $id,
            'type'       => $type,
            'size_bytes' => $size,
            'wp_version' => get_bloginfo( 'version' ),
            'plugins'    => get_option( 'active_plugins', [] ),
            'created_at' => gmdate( 'c' ),
        ];
        file_put_contents( $meta_path, wp_json_encode( $meta, JSON_PRETTY_PRINT ) );

        // Write final progress then clean up
        self::_write_progress( $progress_path, [
            'phase'      => 'completed',
            'pct'        => 100,
            'size_bytes' => $size,
            'backup_id'  => $id,
        ] );
        @unlink( $progress_path );

        // Cleanup old backups
        self::_cleanup_old();

        return rest_ensure_response( [
            'status'       => 'completed',
            'backup_id'    => $id,
            'type'         => $type,
            'size_bytes'   => $size,
            'storage_path' => $zip_path,
        ] );
    }


    /**
     * POST /wp-json/opai/v1/backup/create-async
     * Schedules a backup via WP-Cron and returns immediately.
     * Used on hosts with strict web server timeouts (e.g. Hostinger).
     * The caller polls /backup/status/{id} for progress.
     */
    public static function create_async( $request ) {
        $type = $request->get_param( 'type' ) ?: 'full';
        $id   = date( 'Ymd_His' ) . '_' . wp_generate_password( 6, false, false );

        wp_mkdir_p( OPAI_CONNECTOR_BACKUP_DIR );

        $progress_path = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.progress.json';

        // Write initial progress so polling can start immediately
        self::_write_progress( $progress_path, [
            'phase'      => 'queued',
            'pct'        => 0,
            'started_at' => gmdate( 'c' ),
            'backup_id'  => $id,
        ] );

        // Store params for the cron callback
        $args = [ $id, $type ];

        // Schedule a single-fire cron event to run immediately
        wp_schedule_single_event( time(), 'opai_backup_run', $args );

        // Trigger WP-Cron now via a non-blocking loopback request
        // This fires the cron in a separate PHP process
        wp_remote_post( site_url( '/wp-cron.php?doing_wp_cron=1' ), [
            'timeout'   => 0.01,
            'blocking'  => false,
            'sslverify' => false,
        ] );

        return rest_ensure_response( [
            'status'    => 'queued',
            'backup_id' => $id,
            'type'      => $type,
            'async'     => true,
        ] );
    }

    /**
     * WP-Cron callback — runs the actual backup in a background process.
     * Not subject to web server request timeout limits.
     */
    public static function run_scheduled_backup( $id, $type ) {
        @set_time_limit( 0 );
        @ini_set( 'memory_limit', '256M' );

        $include_db    = in_array( $type, [ 'full', 'database' ], true );
        $include_files = in_array( $type, [ 'full', 'files' ], true );

        wp_mkdir_p( OPAI_CONNECTOR_BACKUP_DIR );

        $zip_path      = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.zip';
        $meta_path     = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.meta.json';
        $progress_path = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.progress.json';

        // Update progress to "starting"
        self::_write_progress( $progress_path, [
            'phase'      => 'starting',
            'pct'        => 2,
            'started_at' => gmdate( 'c' ),
            'backup_id'  => $id,
        ] );

        // ── Database dump ────────────────────────────────
        $db_tmp = null;
        if ( $include_db ) {
            self::_write_progress( $progress_path, [
                'phase'      => 'database',
                'pct'        => 5,
                'db_done'    => false,
                'backup_id'  => $id,
            ] );

            $db_result = self::_dump_database();
            if ( ! $db_result['ok'] ) {
                self::_write_progress( $progress_path, [
                    'phase'    => 'failed',
                    'pct'      => 0,
                    'error'    => $db_result['error'],
                    'backup_id' => $id,
                ] );
                return;
            }
            $db_tmp = $db_result['tmp_file'];

            self::_write_progress( $progress_path, [
                'phase'      => 'database',
                'pct'        => 15,
                'db_done'    => true,
                'backup_id'  => $id,
            ] );
        }

        // ── Files — ZipArchive ──
        if ( ! class_exists( 'ZipArchive' ) ) {
            self::_write_progress( $progress_path, [
                'phase'    => 'failed',
                'pct'      => 0,
                'error'    => 'ZipArchive extension not available',
                'backup_id' => $id,
            ] );
            return;
        }

        $zip = new ZipArchive();
        if ( $zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE ) !== true ) {
            self::_write_progress( $progress_path, [
                'phase'    => 'failed',
                'pct'      => 0,
                'error'    => 'Unable to create ZIP archive',
                'backup_id' => $id,
            ] );
            return;
        }

        if ( $include_files ) {
            $added = 0;

            if ( is_dir( ABSPATH . 'wp-admin' ) ) {
                self::_write_progress( $progress_path, [
                    'phase' => 'files', 'section' => 'wp-admin', 'pct' => 15,
                    'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
                ] );
                self::_add_path_to_zip( $zip, ABSPATH . 'wp-admin', 'wp-admin', $added, $progress_path, $id );
            }

            $wpinc_dir = ABSPATH . WPINC;
            if ( is_dir( $wpinc_dir ) ) {
                self::_write_progress( $progress_path, [
                    'phase' => 'files', 'section' => 'wp-includes', 'pct' => 30,
                    'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
                ] );
                self::_add_path_to_zip( $zip, $wpinc_dir, WPINC, $added, $progress_path, $id );
            }

            self::_write_progress( $progress_path, [
                'phase' => 'files', 'section' => 'wp-content', 'pct' => 50,
                'files_added' => $added, 'db_done' => $include_db, 'backup_id' => $id,
            ] );
            self::_add_path_to_zip( $zip, WP_CONTENT_DIR, 'wp-content', $added, $progress_path, $id );

            $root_files = glob( ABSPATH . '*.php' );
            if ( is_array( $root_files ) ) {
                foreach ( $root_files as $root_file ) {
                    $zip->addFile( $root_file, basename( $root_file ) );
                    $added++;
                }
            }
            if ( file_exists( ABSPATH . '.htaccess' ) ) {
                $zip->addFile( ABSPATH . '.htaccess', '.htaccess' );
            }
        }

        if ( $db_tmp && is_file( $db_tmp ) ) {
            $zip->addFile( $db_tmp, 'db.sql' );
        }

        self::_write_progress( $progress_path, [
            'phase'      => 'finalizing',
            'pct'        => 92,
            'backup_id'  => $id,
        ] );

        $zip->close();

        if ( $db_tmp && is_file( $db_tmp ) ) {
            @unlink( $db_tmp );
        }

        if ( ! file_exists( $zip_path ) || filesize( $zip_path ) === 0 ) {
            self::_write_progress( $progress_path, [
                'phase'    => 'failed',
                'pct'      => 0,
                'error'    => 'ZIP file was not created',
                'backup_id' => $id,
            ] );
            return;
        }

        $size = filesize( $zip_path );

        // Write metadata sidecar
        $meta = [
            'id'         => $id,
            'type'       => $type,
            'size_bytes' => $size,
            'wp_version' => get_bloginfo( 'version' ),
            'plugins'    => get_option( 'active_plugins', [] ),
            'created_at' => gmdate( 'c' ),
        ];
        file_put_contents( $meta_path, wp_json_encode( $meta, JSON_PRETTY_PRINT ) );

        // Final progress — keep the file for a few seconds so pollers see completion
        self::_write_progress( $progress_path, [
            'phase'      => 'completed',
            'pct'        => 100,
            'size_bytes' => $size,
            'backup_id'  => $id,
        ] );

        self::_cleanup_old();
    }


    /**
     * GET /wp-json/opai/v1/backup/list
     */
    public static function list_backups( $request ) {
        $backups = [];
        $base    = OPAI_CONNECTOR_BACKUP_DIR;

        if ( ! is_dir( $base ) ) {
            return rest_ensure_response( [] );
        }

        foreach ( scandir( $base ) as $entry ) {
            if ( $entry === '.' || $entry === '..' ) continue;

            // New flat format: {id}.meta.json
            if ( substr( $entry, -10 ) === '.meta.json' ) {
                $meta_file = $base . '/' . $entry;
                $meta = json_decode( file_get_contents( $meta_file ), true );
                if ( $meta ) {
                    $backups[] = $meta;
                }
                continue;
            }

            // Legacy format: {id}/meta.json (subdirectory)
            if ( is_dir( $base . '/' . $entry ) ) {
                $meta_file = $base . '/' . $entry . '/meta.json';
                if ( file_exists( $meta_file ) ) {
                    $meta = json_decode( file_get_contents( $meta_file ), true );
                    if ( $meta ) {
                        $backups[] = $meta;
                    }
                }
            }
        }

        // Sort newest first
        usort( $backups, function ( $a, $b ) {
            return strcmp( $b['created_at'] ?? '', $a['created_at'] ?? '' );
        } );

        return rest_ensure_response( $backups );
    }

    /**
     * GET /wp-json/opai/v1/backup/download/{id}
     */
    public static function download( $request ) {
        $id   = sanitize_file_name( $request->get_param( 'id' ) );
        $base = OPAI_CONNECTOR_BACKUP_DIR;

        // New flat format
        $zip_path = $base . '/' . $id . '.zip';
        if ( file_exists( $zip_path ) ) {
            self::_stream_file( $zip_path, $id . '.zip' );
        }

        // Legacy format: {id}/wp-content.zip or {id}/database.sql
        $legacy_dir = $base . '/' . $id;
        if ( is_dir( $legacy_dir ) ) {
            foreach ( [ '/wp-content.zip', '/database.sql' ] as $file ) {
                $path = $legacy_dir . $file;
                if ( file_exists( $path ) ) {
                    self::_stream_file( $path, $id . basename( $file ) );
                }
            }
        }

        return new WP_Error( 'not_found', 'Backup file not found', [ 'status' => 404 ] );
    }

    /**
     * GET /wp-json/opai/v1/backup/status/{id}
     * Returns progress for an in-progress or completed backup.
     */
    public static function status( $request ) {
        $id = sanitize_file_name( $request->get_param( 'id' ) );

        // "latest" — find the most recent progress file
        if ( $id === 'latest' ) {
            $latest_file = null;
            $latest_time = 0;
            $base = OPAI_CONNECTOR_BACKUP_DIR;
            if ( is_dir( $base ) ) {
                foreach ( scandir( $base ) as $entry ) {
                    if ( substr( $entry, -14 ) !== '.progress.json' ) continue;
                    $path = $base . '/' . $entry;
                    $mtime = filemtime( $path );
                    if ( $mtime > $latest_time ) {
                        $latest_time = $mtime;
                        $latest_file = $path;
                    }
                }
            }
            if ( $latest_file ) {
                $data = json_decode( file_get_contents( $latest_file ), true );
                return rest_ensure_response( $data ?: [ 'phase' => 'unknown' ] );
            }
            return rest_ensure_response( [ 'phase' => 'idle' ] );
        }

        $progress_path = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.progress.json';
        $zip_path      = OPAI_CONNECTOR_BACKUP_DIR . '/' . $id . '.zip';

        if ( file_exists( $progress_path ) ) {
            $data = json_decode( file_get_contents( $progress_path ), true );
            return rest_ensure_response( $data ?: [ 'phase' => 'unknown' ] );
        }

        if ( file_exists( $zip_path ) ) {
            return rest_ensure_response( [
                'phase'      => 'completed',
                'pct'        => 100,
                'size_bytes' => filesize( $zip_path ),
            ] );
        }

        return rest_ensure_response( [ 'phase' => 'not_found' ] );
    }

    /**
     * GET /wp-json/opai/v1/backup/dump-db
     * Streams the database SQL dump directly as a response.
     * No ZIP, no temp file retention. The caller saves it.
     * This avoids ZipArchive requirements and shared hosting timeouts.
     */
    public static function dump_db( $request ) {
        @set_time_limit( 0 );
        @ini_set( 'memory_limit', '256M' );

        global $wpdb;

        $mysqli = @new mysqli( DB_HOST, DB_USER, DB_PASSWORD, DB_NAME );
        if ( $mysqli->connect_errno ) {
            return new WP_Error( 'db_error', 'DB connection failed: ' . $mysqli->connect_error, [ 'status' => 500 ] );
        }
        $mysqli->set_charset( $wpdb->charset ?: 'utf8mb4' );

        while ( ob_get_level() ) ob_end_clean();

        header( 'Content-Type: application/sql' );
        header( 'Content-Disposition: attachment; filename="db.sql"' );
        header( 'Cache-Control: no-cache' );

        echo "-- OPAI Connector DB export\n";
        echo "-- Date: " . date( 'c' ) . "\n\n";
        echo "SET NAMES " . $mysqli->character_set_name() . ";\n";
        echo "SET FOREIGN_KEY_CHECKS=0;\n\n";

        $tables_res = $mysqli->query( 'SHOW TABLES' );
        if ( ! $tables_res ) {
            echo "-- ERROR: Failed to list tables\n";
            $mysqli->close();
            exit;
        }

        $tables = [];
        while ( $r = $tables_res->fetch_array( MYSQLI_NUM ) ) {
            $tables[] = $r[0];
        }

        foreach ( $tables as $table ) {
            $create_res = $mysqli->query( "SHOW CREATE TABLE `{$table}`" );
            $create_row = $create_res ? $create_res->fetch_array( MYSQLI_NUM ) : null;
            if ( ! $create_row ) continue;

            echo "\n-- Structure for `{$table}`\n";
            echo "DROP TABLE IF EXISTS `{$table}`;\n";
            echo $create_row[1] . ";\n\n";
            echo "-- Data for `{$table}`\n";

            $mysqli->real_query( "SELECT * FROM `{$table}`" );
            $data_res = $mysqli->use_result();
            if ( ! $data_res ) {
                echo "-- (empty or error)\n";
                continue;
            }

            $fields = [];
            foreach ( $data_res->fetch_fields() as $m ) {
                $fields[] = "`{$m->name}`";
            }
            $field_list = implode( ',', $fields );

            $batch = [];
            $batch_count = 0;
            while ( $row = $data_res->fetch_array( MYSQLI_NUM ) ) {
                $vals = [];
                foreach ( $row as $v ) {
                    $vals[] = is_null( $v ) ? 'NULL' : "'" . $mysqli->real_escape_string( $v ) . "'";
                }
                $batch[] = '(' . implode( ',', $vals ) . ')';
                $batch_count++;

                if ( $batch_count >= 500 ) {
                    echo "INSERT INTO `{$table}` ({$field_list}) VALUES\n";
                    echo implode( ",\n", $batch ) . ";\n";
                    flush();
                    $batch = [];
                    $batch_count = 0;
                }
            }
            if ( $batch ) {
                echo "INSERT INTO `{$table}` ({$field_list}) VALUES\n";
                echo implode( ",\n", $batch ) . ";\n";
            }

            $data_res->free();
            echo "\n";
            flush();
        }

        echo "SET FOREIGN_KEY_CHECKS=1;\n";
        $mysqli->close();
        exit;
    }

    /**
     * Stream a file in 512 KB chunks to avoid memory/output-buffer limits.
     */
    private static function _stream_file( $path, $filename ) {
        $size = filesize( $path );

        @set_time_limit( 0 );
        while ( ob_get_level() ) {
            ob_end_clean();
        }

        header( 'Content-Type: application/octet-stream' );
        header( 'Content-Disposition: attachment; filename="' . $filename . '"' );
        header( 'Content-Length: ' . $size );
        header( 'Cache-Control: no-cache, must-revalidate' );
        header( 'Pragma: no-cache' );

        $fh = fopen( $path, 'rb' );
        if ( $fh ) {
            while ( ! feof( $fh ) ) {
                echo fread( $fh, 524288 ); // 512 KB
                flush();
            }
            fclose( $fh );
        }
        exit;
    }

    /**
     * POST /wp-json/opai/v1/backup/restore
     * Body: { "backup_id": "..." }
     */
    public static function restore( $request ) {
        $backup_id = $request->get_param( 'backup_id' );
        if ( empty( $backup_id ) ) {
            return new WP_Error( 'missing_id', 'backup_id is required', [ 'status' => 400 ] );
        }

        $backup_id = sanitize_file_name( $backup_id );
        $base      = OPAI_CONNECTOR_BACKUP_DIR;
        $errors    = [];

        // ── Determine format ─────────────────────────────
        $zip_path   = $base . '/' . $backup_id . '.zip';
        $legacy_dir = $base . '/' . $backup_id;

        if ( file_exists( $zip_path ) ) {
            // New format: single ZIP with everything
            $result = self::_restore_from_zip( $zip_path );
            if ( ! $result['ok'] ) {
                $errors[] = $result['error'];
            }
        } elseif ( is_dir( $legacy_dir ) ) {
            // Legacy format: separate files in a subdirectory
            $db_file  = $legacy_dir . '/database.sql';
            $zip_file = $legacy_dir . '/wp-content.zip';

            if ( file_exists( $db_file ) ) {
                $result = self::_restore_database_from_file( $db_file );
                if ( ! $result['ok'] ) {
                    $errors[] = 'DB restore failed: ' . $result['error'];
                }
            }
            if ( file_exists( $zip_file ) ) {
                $result = self::_restore_files_legacy( $zip_file );
                if ( ! $result['ok'] ) {
                    $errors[] = 'Files restore failed: ' . $result['error'];
                }
            }
        } else {
            return new WP_Error( 'not_found', 'Backup not found', [ 'status' => 404 ] );
        }

        if ( ! empty( $errors ) ) {
            return new WP_Error( 'restore_partial', implode( '; ', $errors ), [ 'status' => 500 ] );
        }

        return rest_ensure_response( [
            'status'    => 'restored',
            'backup_id' => $backup_id,
        ] );
    }

    // ── Database dump (mysqli, batched — ported from OneZip) ──

    private static function _dump_database() {
        global $wpdb;

        $mysqli = @new mysqli( DB_HOST, DB_USER, DB_PASSWORD, DB_NAME );
        if ( $mysqli->connect_errno ) {
            return [ 'ok' => false, 'error' => 'DB connection failed: ' . $mysqli->connect_error ];
        }
        $mysqli->set_charset( $wpdb->charset ?: 'utf8mb4' );

        $tmp = wp_tempnam( 'opai-db-' );
        if ( ! $tmp ) {
            $mysqli->close();
            return [ 'ok' => false, 'error' => 'Could not create temp file for DB dump' ];
        }

        $fh = fopen( $tmp, 'wb' );
        if ( ! $fh ) {
            $mysqli->close();
            return [ 'ok' => false, 'error' => 'Could not open temp file for writing' ];
        }

        $W = function ( $s ) use ( $fh ) { fwrite( $fh, $s ); };

        $W( "-- OPAI Connector DB export\n" );
        $W( "-- Date: " . date( 'c' ) . "\n\n" );
        $W( "SET NAMES " . $mysqli->character_set_name() . ";\n" );
        $W( "SET FOREIGN_KEY_CHECKS=0;\n\n" );

        $tables_res = $mysqli->query( 'SHOW TABLES' );
        if ( ! $tables_res ) {
            fclose( $fh );
            $mysqli->close();
            return [ 'ok' => false, 'error' => 'Failed to list tables: ' . $mysqli->error ];
        }

        $tables = [];
        while ( $r = $tables_res->fetch_array( MYSQLI_NUM ) ) {
            $tables[] = $r[0];
        }

        foreach ( $tables as $table ) {
            $create_res = $mysqli->query( "SHOW CREATE TABLE `{$table}`" );
            $create_row = $create_res ? $create_res->fetch_array( MYSQLI_NUM ) : null;
            if ( ! $create_row ) {
                fclose( $fh );
                $mysqli->close();
                return [ 'ok' => false, 'error' => 'SHOW CREATE failed for ' . $table ];
            }

            $W( "\n-- Structure for `{$table}`\n" );
            $W( "DROP TABLE IF EXISTS `{$table}`;\n" );
            $W( $create_row[1] . ";\n\n" );
            $W( "-- Data for `{$table}`\n" );

            // Use unbuffered query to stream rows without OFFSET pagination.
            // OFFSET-based pagination is O(n^2) and kills shared hosting on large tables.
            $mysqli->real_query( "SELECT * FROM `{$table}`" );
            $data_res = $mysqli->use_result();
            if ( ! $data_res ) {
                $W( "-- (empty or error)\n" );
                continue;
            }

            $fields = [];
            foreach ( $data_res->fetch_fields() as $m ) {
                $fields[] = "`{$m->name}`";
            }
            $field_list = implode( ',', $fields );

            $batch = [];
            $batch_count = 0;
            while ( $row = $data_res->fetch_array( MYSQLI_NUM ) ) {
                $vals = [];
                foreach ( $row as $v ) {
                    $vals[] = is_null( $v ) ? 'NULL' : "'" . $mysqli->real_escape_string( $v ) . "'";
                }
                $batch[] = '(' . implode( ',', $vals ) . ')';
                $batch_count++;

                // Flush every 500 rows to keep memory low
                if ( $batch_count >= 500 ) {
                    $W( "INSERT INTO `{$table}` ({$field_list}) VALUES\n" );
                    $W( implode( ",\n", $batch ) . ";\n" );
                    $batch = [];
                    $batch_count = 0;
                }
            }

            // Flush remaining rows
            if ( $batch ) {
                $W( "INSERT INTO `{$table}` ({$field_list}) VALUES\n" );
                $W( implode( ",\n", $batch ) . ";\n" );
            }

            $data_res->free();
            $W( "\n" );
        }

        $W( "SET FOREIGN_KEY_CHECKS=1;\n" );
        fclose( $fh );
        $mysqli->close();

        return [ 'ok' => true, 'tmp_file' => $tmp ];
    }

    // ── Recursive file walker (ported from OneZip) ───────

    private static function _add_path_to_zip( $zip, $path, $rel, &$added_count, $progress_path = null, $backup_id = null ) {
        $path     = rtrim( $path, DIRECTORY_SEPARATOR );
        $excludes = self::_get_excludes();

        // Check excludes
        foreach ( $excludes as $ex ) {
            if ( $ex && strpos( $path, rtrim( $ex, DIRECTORY_SEPARATOR ) ) === 0 ) return;
        }

        if ( is_file( $path ) ) {
            $local = ltrim( $rel, '/' );
            $zip->addFile( $path, $local );
            $added_count++;
            return;
        }

        $items = @scandir( $path );
        if ( $items === false ) return;

        foreach ( $items as $item ) {
            if ( $item === '.' || $item === '..' ) continue;

            $full     = $path . DIRECTORY_SEPARATOR . $item;
            $relative = $rel === '' ? $item : $rel . '/' . $item;

            // Skip symlinks
            if ( is_link( $full ) ) continue;

            // Check excludes
            foreach ( $excludes as $ex ) {
                if ( $ex && strpos( $full, rtrim( $ex, DIRECTORY_SEPARATOR ) ) === 0 ) continue 2;
            }

            // Skip backup_* directories inside wp-content
            if ( is_dir( $full ) && self::_is_backup_dir( $item ) ) continue;

            if ( is_dir( $full ) ) {
                self::_add_path_to_zip( $zip, $full, $relative, $added_count, $progress_path, $backup_id );
            } elseif ( is_file( $full ) && is_readable( $full ) ) {
                $zip->addFile( $full, $relative );
                $added_count++;

                // Update progress every 50 files — linear: 15..90% over ~6000 files
                if ( $progress_path && $added_count % 50 === 0 ) {
                    $pct = min( 90, 15 + (int) ( 75 * min( $added_count, 6000 ) / 6000 ) );
                    self::_write_progress( $progress_path, [
                        'phase'       => 'files',
                        'files_added' => $added_count,
                        'db_done'     => true,
                        'pct'         => $pct,
                        'backup_id'   => $backup_id,
                    ] );
                }
            }
        }
    }

    /** Write progress JSON file atomically. */
    private static function _write_progress( $path, $data ) {
        $tmp = $path . '.tmp';
        file_put_contents( $tmp, wp_json_encode( $data ) );
        rename( $tmp, $path );
    }

    // ── Restore from single ZIP (new format) ─────────────

    private static function _restore_from_zip( $zip_path ) {
        if ( ! class_exists( 'ZipArchive' ) ) {
            return [ 'ok' => false, 'error' => 'ZipArchive not available' ];
        }

        $zip = new ZipArchive();
        if ( $zip->open( $zip_path ) !== true ) {
            return [ 'ok' => false, 'error' => 'Failed to open backup ZIP' ];
        }

        // Extract to a temp directory first
        $tmp_dir = OPAI_CONNECTOR_BACKUP_DIR . '/_restore_tmp_' . uniqid();
        wp_mkdir_p( $tmp_dir );

        $zip->extractTo( $tmp_dir );
        $zip->close();

        $errors = [];

        // Import database if db.sql exists
        $db_file = $tmp_dir . '/db.sql';
        if ( file_exists( $db_file ) ) {
            $result = self::_restore_database_from_file( $db_file );
            if ( ! $result['ok'] ) {
                $errors[] = 'DB restore failed: ' . $result['error'];
            }
            // Remove db.sql so we don't copy it into ABSPATH
            @unlink( $db_file );
        }

        // Copy files over ABSPATH (skip the backup directory itself)
        $backup_dir_name = basename( OPAI_CONNECTOR_BACKUP_DIR );
        self::_copy_recursive( $tmp_dir, ABSPATH, $backup_dir_name );

        // Clean up temp dir
        self::_rmdir_recursive( $tmp_dir );

        if ( ! empty( $errors ) ) {
            return [ 'ok' => false, 'error' => implode( '; ', $errors ) ];
        }

        return [ 'ok' => true ];
    }

    /** Recursively copy $src contents into $dest, skipping $skip_name. */
    private static function _copy_recursive( $src, $dest, $skip_name = '' ) {
        $items = @scandir( $src );
        if ( $items === false ) return;

        foreach ( $items as $item ) {
            if ( $item === '.' || $item === '..' ) continue;
            if ( $skip_name && $item === $skip_name ) continue;

            $s = $src . '/' . $item;
            $d = $dest . '/' . $item;

            if ( is_dir( $s ) ) {
                wp_mkdir_p( $d );
                self::_copy_recursive( $s, $d, $skip_name );
            } elseif ( is_file( $s ) ) {
                @copy( $s, $d );
            }
        }
    }

    // ── Database restore (mysqli) ────────────────────────

    private static function _restore_database_from_file( $file ) {
        $sql = file_get_contents( $file );
        if ( empty( $sql ) ) {
            return [ 'ok' => false, 'error' => 'Empty SQL file' ];
        }

        $mysqli = @new mysqli( DB_HOST, DB_USER, DB_PASSWORD, DB_NAME );
        if ( $mysqli->connect_errno ) {
            return [ 'ok' => false, 'error' => 'DB connection failed: ' . $mysqli->connect_error ];
        }

        $mysqli->multi_query( $sql );

        // Drain all result sets
        do {
            $result = $mysqli->store_result();
            if ( $result ) $result->free();
        } while ( $mysqli->more_results() && $mysqli->next_result() );

        $error = $mysqli->error;
        $mysqli->close();

        if ( $error ) {
            return [ 'ok' => false, 'error' => 'SQL import error: ' . $error ];
        }

        return [ 'ok' => true ];
    }

    // ── Legacy restore helpers (for old-format backups) ──

    private static function _restore_files_legacy( $zip_file ) {
        if ( ! class_exists( 'ZipArchive' ) ) {
            return [ 'ok' => false, 'error' => 'ZipArchive not available' ];
        }

        $zip = new ZipArchive();
        if ( $zip->open( $zip_file ) !== true ) {
            return [ 'ok' => false, 'error' => 'Failed to open ZIP' ];
        }

        $zip->extractTo( WP_CONTENT_DIR );
        $zip->close();

        return [ 'ok' => true ];
    }

    // ── Stream tar archive of WordPress files ─────────────

    /**
     * GET /wp-json/opai/v1/backup/stream-tar
     * Streams all WordPress files as a tar archive directly to the response.
     * No ZipArchive required. No temp file. The OPAI server saves it.
     *
     * Tar format: POSIX ustar — 512-byte header per file + data + padding.
     */
    public static function stream_tar( $request ) {
        @set_time_limit( 0 );
        @ini_set( 'memory_limit', '256M' );

        while ( ob_get_level() ) ob_end_clean();

        header( 'Content-Type: application/x-tar' );
        header( 'Content-Disposition: attachment; filename="files.tar"' );
        header( 'Cache-Control: no-cache' );

        $base = rtrim( ABSPATH, '/' );

        // Walk wp-admin, wp-includes, wp-content, root files
        $dirs = [];
        if ( is_dir( $base . '/wp-admin' ) )    $dirs[] = [ $base . '/wp-admin', 'wp-admin' ];
        if ( is_dir( $base . '/' . WPINC ) )     $dirs[] = [ $base . '/' . WPINC, WPINC ];
        if ( is_dir( WP_CONTENT_DIR ) )           $dirs[] = [ WP_CONTENT_DIR, 'wp-content' ];

        foreach ( $dirs as $dir_spec ) {
            self::_stream_dir_tar( $dir_spec[0], $dir_spec[1] );
        }

        // Root files (*.php, .htaccess)
        $root_files = glob( $base . '/*.php' );
        if ( is_array( $root_files ) ) {
            foreach ( $root_files as $f ) {
                if ( is_file( $f ) && is_readable( $f ) ) {
                    self::_stream_file_tar( $f, basename( $f ) );
                }
            }
        }
        if ( file_exists( $base . '/.htaccess' ) ) {
            self::_stream_file_tar( $base . '/.htaccess', '.htaccess' );
        }

        // End-of-archive marker: two 512-byte zero blocks
        echo str_repeat( "\0", 1024 );
        flush();
        exit;
    }

    /**
     * Recursively stream a directory as tar entries.
     */
    private static function _stream_dir_tar( $abs_path, $rel_path ) {
        $abs_path = rtrim( $abs_path, DIRECTORY_SEPARATOR );
        $excludes = self::_get_excludes();

        // Check excludes
        foreach ( $excludes as $ex ) {
            if ( $ex && strpos( $abs_path, rtrim( $ex, DIRECTORY_SEPARATOR ) ) === 0 ) return;
        }

        $items = @scandir( $abs_path );
        if ( $items === false ) return;

        foreach ( $items as $item ) {
            if ( $item === '.' || $item === '..' ) continue;

            $full = $abs_path . DIRECTORY_SEPARATOR . $item;
            $rel  = $rel_path . '/' . $item;

            if ( is_link( $full ) ) continue;

            foreach ( $excludes as $ex ) {
                if ( $ex && strpos( $full, rtrim( $ex, DIRECTORY_SEPARATOR ) ) === 0 ) continue 2;
            }

            if ( is_dir( $full ) && self::_is_backup_dir( $item ) ) continue;

            if ( is_dir( $full ) ) {
                self::_stream_dir_tar( $full, $rel );
            } elseif ( is_file( $full ) && is_readable( $full ) ) {
                self::_stream_file_tar( $full, $rel );
            }
        }
    }

    /**
     * Stream a single file as a POSIX ustar tar entry.
     */
    private static function _stream_file_tar( $abs_path, $tar_name ) {
        $size = @filesize( $abs_path );
        if ( $size === false ) return;

        // Build 512-byte tar header
        $header = self::_tar_header( $tar_name, $size, filemtime( $abs_path ) );
        echo $header;

        // Stream file data in 512KB chunks
        $fh = @fopen( $abs_path, 'rb' );
        if ( $fh ) {
            $written = 0;
            while ( ! feof( $fh ) ) {
                $chunk = fread( $fh, 524288 );
                echo $chunk;
                $written += strlen( $chunk );
                // Flush every ~2MB to keep output flowing
                if ( $written % ( 2 * 1024 * 1024 ) < 524288 ) flush();
            }
            fclose( $fh );
        }

        // Pad to 512-byte boundary
        $remainder = $size % 512;
        if ( $remainder > 0 ) {
            echo str_repeat( "\0", 512 - $remainder );
        }
    }

    /**
     * Build a POSIX ustar tar header (512 bytes).
     */
    private static function _tar_header( $name, $size, $mtime ) {
        // Truncate name if needed (handle long names with prefix field)
        $prefix = '';
        if ( strlen( $name ) > 100 ) {
            // Split into prefix (up to 155) + name (up to 100)
            $slash_pos = strrpos( substr( $name, 0, 156 ), '/' );
            if ( $slash_pos !== false ) {
                $prefix = substr( $name, 0, $slash_pos );
                $name   = substr( $name, $slash_pos + 1 );
            }
            // If name still too long, truncate (lossy but functional)
            $name   = substr( $name, 0, 100 );
            $prefix = substr( $prefix, 0, 155 );
        }

        $header = '';
        $header .= str_pad( $name, 100, "\0" );              // name [0..99]
        $header .= str_pad( '0000644', 8, "\0" );             // mode [100..107]
        $header .= str_pad( '0001000', 8, "\0" );             // uid [108..115]
        $header .= str_pad( '0001000', 8, "\0" );             // gid [116..123]
        $header .= str_pad( decoct( $size ), 11, '0', STR_PAD_LEFT ) . "\0"; // size [124..135] — 11 octal + null
        $header .= str_pad( decoct( $mtime ), 11, '0', STR_PAD_LEFT ) . "\0"; // mtime [136..147]
        $header .= '        ';                                  // checksum placeholder [148..155] — 8 spaces
        $header .= '0';                                        // typeflag [156] — regular file
        $header .= str_repeat( "\0", 100 );                    // linkname [157..256]
        $header .= 'ustar' . "\0";                             // magic [257..262]
        $header .= '00';                                       // version [263..264]
        $header .= str_pad( 'www-data', 32, "\0" );           // uname [265..296]
        $header .= str_pad( 'www-data', 32, "\0" );           // gname [297..328]
        $header .= str_repeat( "\0", 8 );                      // devmajor [329..336]
        $header .= str_repeat( "\0", 8 );                      // devminor [337..344]
        $header .= str_pad( $prefix, 155, "\0" );              // prefix [345..499]
        $header .= str_repeat( "\0", 12 );                     // padding [500..511]

        // Calculate checksum (sum of all bytes, treating checksum field as spaces)
        $checksum = 0;
        for ( $i = 0; $i < 512; $i++ ) {
            $checksum += ord( $header[ $i ] );
        }
        // Write checksum at offset 148 (6 octal digits + null + space)
        $chk_str = str_pad( decoct( $checksum ), 6, '0', STR_PAD_LEFT ) . "\0 ";
        $header = substr( $header, 0, 148 ) . $chk_str . substr( $header, 156 );

        return $header;
    }

    // ── Cleanup ──────────────────────────────────────────

    private static function _cleanup_old() {
        $base      = OPAI_CONNECTOR_BACKUP_DIR;
        $threshold = time() - ( 30 * 86400 );

        if ( ! is_dir( $base ) ) return;

        foreach ( scandir( $base ) as $entry ) {
            if ( $entry === '.' || $entry === '..' ) continue;

            // New flat format: {id}.meta.json
            if ( substr( $entry, -10 ) === '.meta.json' ) {
                $meta_path = $base . '/' . $entry;
                $meta = json_decode( file_get_contents( $meta_path ), true );
                if ( ! $meta || empty( $meta['created_at'] ) ) continue;

                if ( strtotime( $meta['created_at'] ) < $threshold ) {
                    $id = $meta['id'] ?? substr( $entry, 0, -10 );
                    @unlink( $base . '/' . $id . '.zip' );
                    @unlink( $meta_path );
                }
                continue;
            }

            // Legacy format: subdirectory with meta.json
            $path = $base . '/' . $entry;
            if ( ! is_dir( $path ) ) continue;

            $meta_file = $path . '/meta.json';
            if ( ! file_exists( $meta_file ) ) continue;

            $meta = json_decode( file_get_contents( $meta_file ), true );
            if ( ! $meta || empty( $meta['created_at'] ) ) continue;

            if ( strtotime( $meta['created_at'] ) < $threshold ) {
                self::_rmdir_recursive( $path );
            }
        }
    }

    private static function _rmdir_recursive( $dir ) {
        if ( ! is_dir( $dir ) ) return;
        foreach ( scandir( $dir ) as $item ) {
            if ( $item === '.' || $item === '..' ) continue;
            $path = $dir . '/' . $item;
            is_dir( $path ) ? self::_rmdir_recursive( $path ) : @unlink( $path );
        }
        @rmdir( $dir );
    }
}
