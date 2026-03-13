-- 044: Add warning_links column to wp_link_scans
-- Supports severity classification: broken (real) vs warning (likely false positive)

ALTER TABLE wp_link_scans ADD COLUMN IF NOT EXISTS warning_links INT DEFAULT 0;
