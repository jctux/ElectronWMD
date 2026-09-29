import path from 'path';

// Not /tmp: the helper runs as root, and other users can plant files and symlinks in a world-writable directory
const DEFAULT_BASE_DIR = '/var/run/ewmd';

export function getSocketDir(baseDir?: string): string {
  return baseDir
    || process.env.EWWORKDIR
    || DEFAULT_BASE_DIR;
}

export function getUidSuffix(): string {
  return process.env.ORIGINAL_UID || process.env.SUDO_UID || process.getuid!().toString();
}

export function getSocketPath(baseDir?: string): string {
  const dir = getSocketDir(baseDir);
  const uid = getUidSuffix();
  return path.join(dir, `ewmd-${uid}.sock`);
} 

export function getPidPath(baseDir?: string): string {
  const dir = getSocketDir(baseDir);
  const uid = getUidSuffix();
  return path.join(dir, `ewmd-${uid}.pid`);
}
