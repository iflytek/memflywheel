/**
 * Internal helper: read and parse just the frontmatter header of a file by
 * reading its first FRONTMATTER_READ_BYTES bytes. Shared by extract/dream
 * relocation paths.
 */

import { open } from "node:fs/promises";

import { parseFrontmatter, FRONTMATTER_READ_BYTES } from "./frontmatter.js";
import { type MemoryFrontmatter } from "./types.js";

export async function readMemoryFrontmatterHeader(
  filePath: string,
): Promise<MemoryFrontmatter | null> {
  const fd = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(FRONTMATTER_READ_BYTES);
    await fd.read(buf, 0, FRONTMATTER_READ_BYTES, 0);
    const header = buf.toString("utf8").replace(/\0+$/, "");
    return parseFrontmatter(header);
  } finally {
    await fd.close();
  }
}
