import { open } from "node:fs/promises";
import { normalizeDashboardModel } from "./model.mjs";

export function createStaticDataProvider(model, options) {
  return async () => normalizeDashboardModel(model, options);
}

export function createJsonFileDataProvider(filePath, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  return async () => {
    const handle = await open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new TypeError("Dashboard data source must be a file");
      if (stat.size > maxFileBytes) {
        throw new RangeError(`Dashboard data file exceeds ${maxFileBytes} bytes`);
      }
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      return normalizeDashboardModel(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
        options,
      );
    } finally {
      await handle.close();
    }
  };
}
