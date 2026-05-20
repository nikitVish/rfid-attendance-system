<?php
if (! defined('ABSPATH')) exit;

function rad_activate_tables(){
    global $wpdb;
    $charset_collate = $wpdb->get_charset_collate();
    $tables = array();

    $tables[] = "CREATE TABLE {$wpdb->prefix}rad_teachers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) DEFAULT '',
      phone VARCHAR(80) DEFAULT '',
      email VARCHAR(120) DEFAULT '',
      role VARCHAR(60) DEFAULT 'Staff',
      department VARCHAR(120) DEFAULT '',
      classroom_id BIGINT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) $charset_collate;";

    $tables[] = "CREATE TABLE {$wpdb->prefix}rad_entity_meta (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(60) NOT NULL,
      entity_id BIGINT UNSIGNED NOT NULL,
      field_key VARCHAR(120) NOT NULL,
      meta_value LONGTEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) $charset_collate;";

    $tables[] = "CREATE TABLE {$wpdb->prefix}rad_timetables (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      classroom_id BIGINT NOT NULL,
      day_of_week TINYINT NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      subject VARCHAR(255) DEFAULT '',
      teacher_id BIGINT NULL,
      meta LONGTEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) $charset_collate;";

    $tables[] = "CREATE TABLE {$wpdb->prefix}rad_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      uid VARCHAR(128) NOT NULL,
      device_id VARCHAR(120) DEFAULT '',
      scan_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      time_in DATETIME NULL,
      time_out DATETIME NULL,
      total_seconds INT UNSIGNED DEFAULT 0,
      status VARCHAR(60) DEFAULT '',
      remarks TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) $charset_collate;";

    $tables[] = "CREATE TABLE {$wpdb->prefix}rad_grace (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      duration INT NOT NULL DEFAULT 2,
      unit VARCHAR(10) DEFAULT 'minute',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) $charset_collate;";

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    foreach ($tables as $sql) {
        dbDelta($sql);
    }

    $row = $wpdb->get_row("SELECT id FROM {$wpdb->prefix}rad_grace LIMIT 1");
    if (! $row) {
        $wpdb->insert($wpdb->prefix . 'rad_grace', array('duration' => 2, 'unit' => 'minute'));
    }
}
