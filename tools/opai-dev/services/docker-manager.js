/**
 * OPAI Dev — Docker container lifecycle manager (via dockerode).
 *
 * Each user gets one Theia container:
 * - Image: opai-theia:latest (configurable)
 * - Port 3000 internal → host port from port-allocator (127.0.0.1 only)
 * - Volume: NFS workspace dir → /home/project
 * - Memory: 2GB, CPU: 1 core, no-new-privileges
 * - Bridge network: opai-dev-net
 */

const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const THEIA_IMAGE = process.env.THEIA_IMAGE || 'opai-theia:latest';
const NFS_ROOT = process.env.NFS_WORKSPACE_ROOT || '/workspace/users';
const OPAI_ROOT = process.env.OPAI_ROOT || '/workspace/synced/opai';
const NETWORK_NAME = 'opai-dev-net';
const CONTAINER_MEMORY = parseInt(process.env.CONTAINER_MEMORY || '2147483648', 10); // 2GB
const CONTAINER_CPU_PERIOD = parseInt(process.env.CONTAINER_CPU_PERIOD || '100000', 10);
const CONTAINER_CPU_QUOTA = parseInt(process.env.CONTAINER_CPU_QUOTA || '100000', 10); // 1 core
const CLAUDE_BRIDGE_SOCKET = process.env.CLAUDE_BRIDGE_SOCKET || '/tmp/opai-claude-bridge.sock';
const BRIDGE_SCRIPT_PATH = path.join(__dirname, '..', 'docker', 'scripts', 'opai-claude');

// Cached network gateway IP (discovered at startup)
let networkGateway = null;

/**
 * Ensure the bridge network exists. Caches the gateway IP for container env vars.
 */
async function ensureNetwork() {
  try {
    const info = await docker.getNetwork(NETWORK_NAME).inspect();
    networkGateway = info.IPAM?.Config?.[0]?.Gateway || null;
  } catch (_) {
    const net = await docker.createNetwork({
      Name: NETWORK_NAME,
      Driver: 'bridge',
      Internal: false,
    });
    const info = await net.inspect();
    networkGateway = info.IPAM?.Config?.[0]?.Gateway || null;
    console.log(`[docker] Created network ${NETWORK_NAME}`);
  }
  if (networkGateway) {
    console.log(`[docker] Network gateway: ${networkGateway}`);
  }
}

/**
 * Resolve the user's sandbox directory from UUID symlink.
 */
function resolveUserDir(userId) {
  const uuidPath = path.join(NFS_ROOT, userId);
  try {
    return fs.realpathSync(uuidPath);
  } catch {
    return null;
  }
}

/**
 * Ensure the user's project directory exists.
 * projectName can be a relative path like "Boutabyte" or "Boutabyte/src".
 * Admin users → OPAI workspace Projects/ with OPAI root as sandbox.
 * Regular users → their sandbox Projects/.
 * Returns { projectDir, sandboxDir }.
 */
function ensureProjectDir(userId, projectName, { role } = {}) {
  let baseRoot;

  if (role === 'admin') {
    baseRoot = OPAI_ROOT;
  } else {
    baseRoot = resolveUserDir(userId);
    if (!baseRoot) baseRoot = path.join(NFS_ROOT, userId);
  }

  const projectDir = path.join(baseRoot, 'Projects', projectName);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
    console.log(`[docker] Created project dir: ${projectDir}`);
  }
  return { projectDir, sandboxDir: baseRoot };
}

/**
 * Create and start a container for a user's project.
 * Options:
 *   role            — 'admin' or 'user'
 *   userPluginsDir  — absolute path to staged user plugins (or null)
 * Returns { containerId, port }.
 */
async function createContainer(userId, hostPort, projectName, { role, userPluginsDir } = {}) {
  await ensureNetwork();
  const { projectDir, sandboxDir } = ensureProjectDir(userId, projectName, { role });
  const containerName = `opai-dev-${userId.substring(0, 8)}-${hostPort}`;

  // Build volume binds
  const binds = [
    `${projectDir}:/home/project`,
    `${sandboxDir}:/home/opai`,
  ];

  // Mount user's staged extensions if any
  if (userPluginsDir) {
    binds.push(`${userPluginsDir}:/home/theia/user-plugins:ro`);
  }

  // Mount Claude bridge CLI wrapper (if it exists)
  if (fs.existsSync(BRIDGE_SCRIPT_PATH)) {
    binds.push(`${BRIDGE_SCRIPT_PATH}:/usr/local/bin/opai-claude:ro`);
  }

  // Mount Unix socket for Claude bridge (bypasses firewall)
  if (fs.existsSync(CLAUDE_BRIDGE_SOCKET)) {
    binds.push(`${CLAUDE_BRIDGE_SOCKET}:/tmp/opai-claude-bridge.sock`);
  }

  // Build environment variables
  const env = [];

  if (userPluginsDir) {
    env.push('THEIA_DEFAULT_PLUGINS=local-dir:/home/theia/plugins,local-dir:/home/theia/user-plugins');
  }

  // Future: inject shared/enterprise API key
  // if (process.env.SHARED_ANTHROPIC_KEY) {
  //   env.push(`ANTHROPIC_API_KEY=${process.env.SHARED_ANTHROPIC_KEY}`);
  // }

  const container = await docker.createContainer({
    Image: THEIA_IMAGE,
    name: containerName,
    ExposedPorts: { '3000/tcp': {} },
    Env: env,
    HostConfig: {
      PortBindings: {
        '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }],
      },
      Binds: binds,
      Memory: CONTAINER_MEMORY,
      CpuPeriod: CONTAINER_CPU_PERIOD,
      CpuQuota: CONTAINER_CPU_QUOTA,
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: '', MaximumRetryCount: 0 },
      NetworkMode: NETWORK_NAME,
    },
    Labels: {
      'opai.service': 'dev',
      'opai.user_id': userId,
      'opai.port': String(hostPort),
      'opai.project': projectName,
    },
  });

  await container.start();
  return { containerId: container.id, port: hostPort };
}

/**
 * Start a stopped container.
 */
async function startContainer(containerId) {
  const container = docker.getContainer(containerId);
  await container.start();
}

/**
 * Stop a running container.
 */
async function stopContainer(containerId) {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 10 });
  } catch (err) {
    // Already stopped or doesn't exist
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
}

/**
 * Remove a container.
 */
async function destroyContainer(containerId) {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

/**
 * Inspect a container. Returns null if not found.
 */
async function inspectContainer(containerId) {
  try {
    return await docker.getContainer(containerId).inspect();
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Check if container is running and healthy (responds on port 3000).
 */
async function isContainerRunning(containerId) {
  const info = await inspectContainer(containerId);
  return info?.State?.Running === true;
}

/**
 * Find orphan containers (labeled opai.service=dev) not tracked in DB.
 * Returns array of container objects.
 */
async function findOrphanContainers(knownContainerIds) {
  const knownSet = new Set(knownContainerIds);
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['opai.service=dev'] },
  });
  return containers.filter(c => !knownSet.has(c.Id));
}

/**
 * Remove orphan containers.
 */
async function cleanupOrphans(knownContainerIds) {
  const orphans = await findOrphanContainers(knownContainerIds);
  for (const orphan of orphans) {
    console.log(`[docker] Removing orphan container ${orphan.Id.substring(0, 12)}`);
    await destroyContainer(orphan.Id);
  }
  return orphans.length;
}

module.exports = {
  ensureNetwork,
  createContainer,
  startContainer,
  stopContainer,
  destroyContainer,
  inspectContainer,
  isContainerRunning,
  findOrphanContainers,
  cleanupOrphans,
};
