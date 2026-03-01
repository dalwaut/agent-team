# farmOS — Deployment & Operations Wiki

> **Project**: Morning Dew Homestead farm management
> **URL**: `https://farm.morningdewhomestead.com`
> **Repo**: `dalwaut/farmOS` (fork) — cloned to `Projects/FarmOS/repo/`
> **Version**: 4.0.0-beta3 (Drupal 11, PHP 8.4)

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| Host | BB VPS (`72.60.115.74`, Hostinger KVM4) |
| Containers | `farmos-www` (app), `farmos-db` (PostgreSQL 16) |
| Compose file | `/opt/farmos/docker-compose.yml` on BB VPS |
| Proxy | Coolify Traefik v3, TLS via Let's Encrypt |
| DNS | `farm.morningdewhomestead.com` A record in **Hostinger** (NOT GoDaddy) |
| Domain NS | `ns1.dns-parking.com` / `ns2.dns-parking.com` (Hostinger) |
| Docker networks | `farmos` (internal DB), `coolify` (external Traefik) |
| Volumes | `farmos-db`, `farmos-sites`, `farmos-keys` |

### Traefik Labels (working config)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.farmos.rule=Host(`farm.morningdewhomestead.com`)
  - traefik.http.routers.farmos.entrypoints=https
  - traefik.http.routers.farmos.tls=true
  - traefik.http.routers.farmos.tls.certresolver=letsencrypt
  - traefik.http.services.farmos.loadbalancer.server.port=80
  - traefik.http.routers.farmos-http.rule=Host(`farm.morningdewhomestead.com`)
  - traefik.http.routers.farmos-http.entrypoints=http
  - traefik.http.routers.farmos-http.middlewares=farmos-redirect-https
  - traefik.http.middlewares.farmos-redirect-https.redirectscheme.scheme=https
```

### Gotchas

- **Traefik entrypoints**: Coolify uses `http`/`https` (NOT `web`/`websecure`)
- **Traefik serversTransport**: Cannot cross-reference Docker labels to file provider configs — causes 503 "transport not found". Don't use it.
- **Cold start**: First request after container restart may take 10-30s (PHP/Drupal bootstrap). Subsequent requests are fast (~0.7s).
- **Traefik stale routing after restart**: `docker compose restart` on farmOS can leave Traefik (`coolify-proxy`) with stale backend references. Symptom: persistent 504 at exactly 30s, but container responds fine directly. Fix: `docker restart coolify-proxy`. Diagnosed 2026-02-27.
- **Compose YAML with backticks**: Shell heredocs mangle backtick escaping in Traefik `Host()` rules. Use Python `yaml.dump()` to generate the file instead.

---

## Database

| Field | Value |
|-------|-------|
| Engine | PostgreSQL 16 |
| Host | `db` (Docker internal) |
| Port | 5432 |
| Database | `farm` |
| User | `farm` |
| Password | Stored in vault: `farmos/db-password` |

---

## Users & Roles

### Role System

farmOS has its own role modules that must be enabled separately from Drupal's default roles:

| Module | Provides |
|--------|----------|
| `farm_role` | Base role framework |
| `farm_manager` | Full farm management access |
| `farm_worker` | Day-to-day operations access |
| `farm_viewer` | Read-only access |
| `farm_account_admin` | User account management |
| `role_delegation` | Delegate role assignment to non-admin users |

**Critical**: Without these modules enabled, new users get "Access Denied" / 403 even after login. Only bare Drupal roles (anonymous, authenticated) exist by default.

### Drupal uid=1 Gotcha & Permission Fix (2026-02-27)

farmOS role modules create the roles but ship with **zero permissions assigned**. The first user created during install (uid=1) is Drupal's hardcoded superuser — it bypasses ALL permission checks, so the missing permissions are invisible to that account. Every other user, even with identical roles, gets nothing.

**Symptoms**: Non-uid=1 users see empty dashboards, can't create assets/logs, get 403 on admin pages — despite having `farm_manager` role.

**Fix — grant all 374 permissions to `farm_manager`**:

```bash
ssh root@bb-vps
docker exec farmos-www drush php:eval '
$all = array_keys(\Drupal::service("user.permissions")->getPermissions());
$role = \Drupal\user\Entity\Role::load("farm_manager");
foreach ($all as $perm) {
  $role->grantPermission($perm);
}
$role->save();
echo "Granted " . count($role->getPermissions()) . "/" . count($all) . " permissions\n";
'
docker exec farmos-www drush cr
```

**When to repeat**: After farmOS upgrades, new module installs, or adding new roles. New modules register new permissions that won't be auto-assigned to existing roles. Re-run the script above after any module change.

**Verify**:
```bash
docker exec farmos-www drush php:eval '
$role = \Drupal\user\Entity\Role::load("farm_manager");
$all = array_keys(\Drupal::service("user.permissions")->getPermissions());
echo count($role->getPermissions()) . "/" . count($all) . " permissions\n";
'
```

### Current Users

| User | Role | Notes |
|------|------|-------|
| dallas (uid=1) | farm_manager + farm_account_admin | Drupal superuser — bypasses all permission checks |
| denise (uid=4) | farm_manager + farm_account_admin | Full admin via explicit permissions (374/374). Credentials in vault |

---

## API & External Access

### Enabled Modules

All API modules are enabled and functional:

- `farm_api` — Core farmOS API
- `farm_api_default_consumer` — Default OAuth consumer
- `farm_api_oauth` — OAuth2 scope definitions
- `jsonapi` — JSON:API spec endpoints
- `jsonapi_schema` — Schema discovery
- `simple_oauth` — OAuth2 token server
- `simple_oauth_password_grant` — Password grant type
- `subrequests` — Batch API requests
- `consumers` — OAuth consumer management
- `simple_oauth_static_scope` — Static OAuth scopes

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/api` | JSON:API root — lists all available resource types |
| `/api/[entity-type]/[bundle]` | CRUD for specific types (e.g., `/api/log/observation`) |
| `/api/asset/land` | Land assets |
| `/api/log/harvest` | Harvest logs |
| `/oauth/authorize` | OAuth2 authorization |
| `/oauth/token` | OAuth2 token exchange |

### OAuth2 Authentication

- Default client: `client_id=farm` (password grant)
- Scopes: `farm_manager`, `farm_worker`, `farm_viewer`
- RSA keypair needed: Generate via Admin > Configuration > Web Services > Consumers > Settings

### Example API Call

```bash
# Get access token
curl -X POST https://farm.morningdewhomestead.com/oauth/token \
  -d "grant_type=password&client_id=farm&username=dallas&password=PASSWORD"

# List all land assets
curl -H "Authorization: Bearer TOKEN" \
  https://farm.morningdewhomestead.com/api/asset/land
```

---

## Data Model

### Core Entity Types

| Entity | Purpose | Examples |
|--------|---------|---------|
| **Asset** | Things being tracked | Land, Plant, Animal, Equipment, Structure, Sensor |
| **Log** | Events/actions | Activity, Observation, Input, Harvest, Seeding, Medical |
| **Quantity** | Numeric data on logs | Amounts, weights, counts, time tracking |
| **Plan** | Multi-step plans | Crop plans, grazing rotations |
| **Data Stream** | Sensor/IoT data | Time-series from sensors |

### Asset Types

Land, Plant, Animal, Equipment, Compost, Structure, Sensor, Water, Material, Product, Group

Key attributes on all assets: Name, Flags, Geometry, Intrinsic geometry, Is location, Is fixed, Notes, ID Tags, Data, Archived

### Log Types

Activity, Observation, Input, Harvest, Lab test, Maintenance, Medical, Seeding, Transplanting

Key attributes on all logs: Name, Timestamp, Status (pending/done/abandoned), Flags, Geometry, Is movement, Notes, Data

### Location Logic

- Assets with `is_location = true` can have other assets moved to them
- Assets with `is_fixed = true` have intrinsic geometry (don't move)
- Movement is recorded via logs with `is_movement = true`
- A log's "Asset" field = what the action happened TO
- A log's "Location" field = where the action happened IN

### Hierarchy & Groups

- Assets have `parent` field for hierarchical relationships (e.g., bed inside field)
- Group assets can "contain" other assets via group membership
- Group membership changes are recorded via logs with `is_group_assignment = true`

---

## Maps & Layers

### Architecture

farmOS uses the `farmOS-map` library (OpenLayers-based). Map layers are added via **behaviors** — Drupal config entities paired with JS files and PHP event subscribers.

### Default Layers

The farmOS-map library includes a default **OpenStreetMap** base layer in a "Base layers" group with `fold: "close"` (collapsed by default).

### Custom Module: `farm_map_free`

We created a custom Drupal module that adds 4 free satellite/topo layers without API keys:

| Layer | Source | Visible by Default |
|-------|--------|--------------------|
| Satellite (ESRI) | `server.arcgisonline.com/.../World_Imagery/...` | No |
| USGS Imagery | `basemap.nationalmap.gov/.../USGSImageryOnly/...` | No |
| Topographic | `tile.opentopomap.org/{z}/{x}/{y}.png` | No |
| ESRI Topo | `server.arcgisonline.com/.../World_Topo_Map/...` | No |

**Module location**: `/opt/drupal/web/modules/custom/farm_map_free/` (inside container)

**Module structure**:
```
farm_map_free/
  farm_map_free.info.yml          # Module definition
  farm_map_free.libraries.yml     # JS library declaration
  farm_map_free.services.yml      # Event subscriber registration
  config/install/
    farm_map.map_behavior.free_layers.yml   # Behavior config entity
  js/
    farmOS.map.behaviors.free_layers.js     # Layer definitions
  src/EventSubscriber/
    MapRenderEventSubscriber.php            # Attaches behavior to all maps
```

**How farmOS map behaviors work**:
1. Define a `map_behavior` config entity (YAML) with a library reference
2. Create a JS file that registers `farmOS.map.behaviors.<name>.attach(instance)`
3. Create a PHP `EventSubscriber` that calls `$event->addBehavior('<name>')` on `MapRenderEvent`
4. The event subscriber attaches the JS library to the page whenever a map renders
5. `instance.addLayer('xyz', { title, url, group: 'Base layers', base: true })` adds XYZ tile layers

**Key detail**: The default `MapRenderEventSubscriber` only adds behaviors listed in the map type config (empty for `default`) plus hardcoded `wkt` and `enable_side_panel`. Custom behaviors MUST use their own event subscriber to auto-attach.

### Mapbox / Google Maps

Both are supported via `farm_map_mapbox` and `farm_map_google` modules but require API keys:
- Mapbox: Free tier 200k tiles/month, key set via `drush config:set farm_map_mapbox.settings api_key <token>`
- Google: Requires Maps JavaScript API key

Currently disabled (no API keys configured). Can re-enable later if needed.

---

## Locations Page & Drag-and-Drop

The Locations page (`/locations`) shows a tree hierarchy of all location assets using the **InspireTree** library.

### How It Works

1. Location assets (any asset with `is_location = true`) appear in the tree
2. Click **"Toggle drag and drop"** to enable rearranging
3. Drag items to change parent-child relationships
4. Click **"Save"** to persist changes (creates revision log on each moved asset)
5. Click **"Reset"** to undo changes

### Prerequisites

- Must have location assets created first (tree is empty otherwise)
- InspireTree JS loaded from CDN (`cdn.jsdelivr.net/gh/helion3/inspire-tree@6.0.1/...`)
- Dependencies: lodash, underscore (both loaded from CDN)

### Creating Location Assets

1. Go to **Assets > Add asset > Land** (or Structure, Water, etc.)
2. Name it (e.g., "Main Farm", "North Pasture")
3. Check **"Is location"** checkbox
4. Optionally check **"Is fixed"** and draw intrinsic geometry
5. Save — it now appears on the Locations page

### Hierarchy Tips

- Set parent relationships via drag-and-drop OR by editing individual assets
- Common pattern: Farm > Fields > Beds (Land assets nested via parent field)
- Multiple parents allowed but circular references are not
- Hierarchy is stored in the `parent` entity reference field on assets

---

## Vault Secrets

All farmOS credentials are stored under the `farmos/` prefix in OPAI vault:

```
farmos/db-host
farmos/db-port
farmos/db-name
farmos/db-user
farmos/db-password
farmos/site-name
farmos/site-url
farmos/admin-user
farmos/admin-email
farmos/drupal-hash-salt
farmos/denise-user
farmos/denise-password
farmos/tls-issuer
farmos/tls-expiry
farmos/docker-compose-path
```

---

## Weekly Sync (Automated Backup + Deploy)

Automated weekly job that backs up farmOS, checks for upstream updates, merges, deploys, and verifies. Runs Sundays at 4 AM via systemd timer. Sends Telegram alerts at every phase; creates TeamHub tasks on failure.

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/farmos-weekly-sync.sh` | Main cron script — 5 phases (backup, update check, merge, deploy, verify) |
| `scripts/farmos-setup.sh` | Standalone setup: permissions, module install, user verification |
| `Projects/FarmOS/deploy/restore.sh` | Disaster recovery — rebuild from backup |

### Flags

```bash
./scripts/farmos-weekly-sync.sh                  # Full run
./scripts/farmos-weekly-sync.sh --dry-run        # Read-only preview
./scripts/farmos-weekly-sync.sh --from-phase 4   # Resume from phase N (after fixing a failure)
./scripts/farmos-weekly-sync.sh --test-fail 3    # Simulate failure at phase N

./scripts/farmos-setup.sh                        # Full setup
./scripts/farmos-setup.sh --perms-only           # Just fix permissions
./scripts/farmos-setup.sh --module-only          # Just install farm_map_free
```

### 5 Phases

1. **Backup** — DB dump, module files, docker-compose.yml, Drupal config export
2. **Update Check** — `git fetch upstream`, compare `origin/4.x...upstream/4.x`. Exits early if no updates.
3. **Merge** — `git merge upstream/4.x`, push to origin. Stops on conflict.
4. **Deploy** — `docker compose pull`, recreate if image changed, re-inject module, re-grant permissions
5. **Verify** — HTTP check, API JSON check, drush status, module enabled, 370+ permissions

### Backup Artifacts

```
Projects/FarmOS/deploy/
  docker-compose.yml              # From VPS (version-controlled)
  custom-modules/farm_map_free/   # 6 module files (version-controlled)
  config-export/                  # Drupal config YAML (version-controlled)
  backups/
    farmos-latest.sql             # DB dump (.gitignore'd — local only)
  restore.sh                      # Disaster recovery
```

### Systemd

- Timer: `opai-farmos-sync.timer` — `OnCalendar=Sun *-*-* 04:00:00`, Persistent
- Service: `opai-farmos-sync.service` — oneshot, 10-min timeout
- Registered in `opai-control.sh` TIMERS array

### Logs

- File: `logs/farmos-sync.log` (appended each run)
- JSON summary: `logs/farmos-sync-latest.json`
- Journald: `journalctl --user -u opai-farmos-sync`

### On Failure

- Stops immediately (no further phases)
- Telegram alert with error details
- TeamHub task with remediation steps, assigned to Dallas, due next day
- Priority: `critical` for deploy/verify failures, `high` for merge/backup
- **Telegram goes to Dallas's personal DM** (chat ID `1666403499`), NOT a group chat

---

## Common Operations

### Container Management

```bash
# SSH to BB VPS
ssh root@bb-vps

# Container status
docker ps | grep farmos

# Restart farmOS
cd /opt/farmos && docker compose restart

# View logs
docker logs farmos-www --tail 50

# Drush commands (inside container)
docker exec farmos-www drush cr                    # Cache rebuild
docker exec farmos-www drush pm:list --status=enabled  # List modules
docker exec farmos-www drush en <module> -y        # Enable module
docker exec farmos-www drush pm:uninstall <module> -y  # Disable module
docker exec farmos-www drush uli                   # One-time login link
docker exec farmos-www drush config:get <config>   # Read config
docker exec farmos-www drush config:set <config> <key> <value>  # Set config

# Run commands as root in container (for file operations)
docker exec -u root farmos-www <command>
```

### Module Management

```bash
# Enable a module
docker exec farmos-www drush en farm_map_mapbox -y

# Disable a module
docker exec farmos-www drush pm:uninstall farm_map_mapbox -y

# List all available (not just enabled) modules
docker exec farmos-www drush pm:list

# After module changes, always clear cache
docker exec farmos-www drush cr
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| "No route found" after install | `drush cr` (cache rebuild) |
| New users get 403 / Access Denied | Enable role modules, assign roles, AND run the permission grant script (see "uid=1 Gotcha" above) — roles ship with zero permissions |
| 504 Gateway Timeout (cold start) | First request after idle can take 10-30s. Wait and retry. |
| 504 Gateway Timeout (persistent) | Traefik stale routing — `docker compose restart` on farmOS can leave Traefik with stale backend references. farmOS container responds fine directly (`docker exec farmos-www curl localhost:80` → 403 in <1s) but Traefik times out at exactly 30s. **Fix**: `docker restart coolify-proxy` (restart Traefik). Confirmed 2026-02-27. |
| Map layers not showing after module install | `drush cr` + delete JS aggregates: `rm -rf sites/default/files/js/*` |
| Custom module changes not taking effect | Uninstall + reinstall module, then `drush cr` |
| Files/permissions in container | Use `docker exec -u root` for write operations, then `chown -R www-data:www-data` |
