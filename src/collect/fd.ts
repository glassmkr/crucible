import { readProcFile } from "../lib/parse.js";

export interface FileDescriptorData {
  allocated: number;
  free: number;
  max: number;
  percent: number;
}

export function collectFileDescriptors(): FileDescriptorData {
  const raw = readProcFile("/proc/sys/fs/file-nr");
  if (!raw) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const allocated = parseInt(parts[0], 10);
  const free = parseInt(parts[1], 10);
  const max = parseInt(parts[2], 10);

  if (isNaN(allocated) || isNaN(max) || max === 0) {
    return { allocated: 0, free: 0, max: 0, percent: 0 };
  }

  const percent = Math.round(((allocated / max) * 100) * 10) / 10;
  return { allocated, free: isNaN(free) ? 0 : free, max, percent };
}
