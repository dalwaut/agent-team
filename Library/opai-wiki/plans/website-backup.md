# Website Backup Procedure

Standard operating procedure for backing up client/project websites. Used when migrating sites between hosts, archiving for review, or creating restorable snapshots.

---

## Overview

A structured, priority-ordered backup workflow that captures:
- **Full filesystem** (WordPress core, themes, plugins, uploads, config)
- **Database** (SQL dump of all tables)
- **Public-facing site** (HTML crawl for visual reference)
- **API data** (REST API exports where available)

The procedure is designed for the Claude Code sandbox environment (no sudo, limited tooling — wget, curl, python3 only).

---

## Backup Directory Structure

```
Clients/{SiteName}/backup/
├── ftp-mirror/          # Full server filesystem via FTP
│   └── {host}/          # Mirrors remote directory tree
├── website-mirror/      # Public HTML crawl
│   └── {domain}/
├── api-export/          # REST API JSON exports
│   ├── posts.json
│   ├── pages.json
│   ├── categories.json
│   ├── tags.json
│   ├── media.json
│   ├── comments.json
│   └── users.json
├── db/                  # Database dumps (if obtained via SSH)
└── {name}.sql           # Database dump (if provided by user)
```

---

## Procedure (Priority Order)

### Step 1: Read Access Credentials

- Check `notes/Access/{SiteName}.md` for credentials
- Identify available methods: FTP, SSH, cPanel, WP admin, API keys
- Note host IP, ports, usernames, passwords

### Step 2: Test Connectivity (parallel, fast)

Run all tests simultaneously to save time:

| Test | Command | Timeout |
|------|---------|---------|
| Website alive | `curl -s --connect-timeout 10 -o /dev/null -w "%{http_code} %{time_total}s" https://domain.com/` | 10s |
| FTP login | `wget --spider --ftp-user='USER' --ftp-password='PASS' ftp://HOST/` | 30s |
| SSH login | `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no user@host 'echo connected'` | 10s |

### Step 3: File Backup (pick best available method)

**Priority 1 — SSH** (fastest, most complete)
```bash
ssh user@host 'tar czf /tmp/site-backup.tar.gz /path/to/site'
scp user@host:/tmp/site-backup.tar.gz ./backup/
# Can also mysqldump directly
```

**Priority 2 — FTP Mirror** (reliable fallback)
```bash
wget --mirror --ftp-user='USER' --ftp-password='PASS' ftp://HOST/ -P ftp-mirror
```
- Run in background for large sites
- Monitor progress: `du -sh ftp-mirror/ && find ftp-mirror/ -type f | wc -l`

**Priority 3 — Website Crawl** (public pages only, always run as supplement)
```bash
wget --mirror --convert-links --adjust-extension --page-requisites \
  --no-parent --timeout=30 --tries=3 --wait=1 -e robots=off \
  -P website-mirror https://domain.com/
```

**If all fail** → Ask user for assistance (cPanel file manager export, hosting panel backup tool, etc.)

### Step 4: Database Backup (pick best available method)

**Priority 1 — SSH + mysqldump**
```bash
ssh user@host 'mysqldump -u DB_USER -pDB_PASS DB_NAME' > backup/db/database.sql
```
- Get DB credentials from `wp-config.php` (or equivalent config file)

**Priority 2 — Ask user for phpMyAdmin/cPanel export**
- Tell user exactly which database to export (read from wp-config.php)
- Ask them to place `.sql` file in `notes/Archive/` with descriptive name
- Copy into `Clients/{SiteName}/backup/`

**Priority 3 — WordPress REST API** (minimal content only)
```bash
for endpoint in posts pages categories tags media comments users; do
  curl -s "https://domain.com/wp-json/wp/v2/${endpoint}?per_page=100" > api-export/${endpoint}.json
done
```

**Always**: Read `wp-config.php` from the file backup to capture DB name, user, host, salts, and custom settings — essential for restoration.

### Step 5: Verify & Summarize

- Count total files and sizes per directory
- For WordPress: identify version, theme, plugins list, uploads size
- Note what IS and ISN'T backed up
- Document anything needed for restoration (DB creds, config changes, DNS)

---

## WordPress-Specific Notes

### Key files to verify in backup
| File | Contains |
|------|----------|
| `wp-config.php` | DB credentials, salts, custom defines, cache settings |
| `wp-content/themes/` | Active theme + child themes |
| `wp-content/plugins/` | All installed plugins (often largest directory) |
| `wp-content/uploads/` | Media library (images, documents, etc.) |
| `.htaccess` | Rewrite rules, security headers |

### Restoration on Hostinger
1. Upload files via FTP or File Manager
2. Import SQL dump via phpMyAdmin
3. Update `wp-config.php` with new DB credentials
4. Update `siteurl` and `home` in `wp_options` table
5. Flush permalinks (Settings → Permalinks → Save)

---

## Gotchas & Lessons Learned

| Issue | Solution |
|-------|----------|
| FTP username format | Try both plain username AND full email (`user@domain.com`) — some hosts require email format |
| FTP password with special chars | Use `--ftp-user` and `--ftp-password` flags, NOT URL-embedded credentials |
| SSH without password in access file | Don't waste time — try FTP or ask user for password |
| No sudo in sandbox | Can't install packages (lftp, sshpass, mysql-client). Work with wget, curl, python3 |
| Large WP sites | Can be 500MB+ and take 1-2 hours via FTP. Always run in background |
| Plugins directory | Usually the largest (300MB+ for WooCommerce sites) |
| DB on localhost | Remote mysql connections won't work — need SSH or phpMyAdmin |
| `CREATE TABLE IF NOT EXISTS IF NOT EXISTS` | phpMyAdmin export quirk — harmless but notable |
| Monitoring downloads | Check every 2-5 minutes, not every few seconds. Use `du -sh` + `find | wc -l` |

---

## Completed Backups

| Site | Date | Location | Size | Notes |
|------|------|----------|------|-------|
| shopholisticmedicine.com | 2026-02-17 | `Clients/ShopHolisticMedicine/backup/` | 589 MB | WP 6.9.1, Avada theme, WooCommerce, 67 DB tables, 32,718 files |

---

## Dependencies

- **Tools available**: wget, curl, python3 (no mysql, lftp, sshpass)
- **Access files**: `notes/Access/{SiteName}.md`
- **Output location**: `Clients/{SiteName}/backup/`
- **DB dump staging**: User uploads to `notes/Archive/` if manual export needed
