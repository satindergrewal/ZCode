/**
 * Volume probe: identify the physical volume via stat().dev, walk up to the mount point, statfs capacity.
 * Any failure returns null (UI shows usage, not capacity); never throws.
 */
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageVolume } from "@zcode/shared";
import type { VolumeProbePort } from "../app/ports.js";

async function probeStorageVolume(path: string): Promise<StorageVolume | null> {
  try {
    const deviceId = (await stat(path)).dev;
    let mountPoint = path;
    // Walk up while the parent shares the same dev; root or dev change is the mount point.
    for (;;) {
      const parent = dirname(mountPoint);
      if (parent === mountPoint) break;
      let parentDev: number | bigint;
      try {
        parentDev = (await stat(parent)).dev;
      } catch {
        break;
      }
      if (parentDev !== deviceId) break;
      mountPoint = parent;
    }
    const fs = await statfs(mountPoint);
    return {
      deviceId: String(deviceId),
      mountPoint,
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
    };
  } catch {
    return null;
  }
}

export function createFsVolumeProbe(): VolumeProbePort {
  return { probe: probeStorageVolume };
}
