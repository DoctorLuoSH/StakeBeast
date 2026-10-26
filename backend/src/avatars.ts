/**
 * Avatar handling. Placeholder avatars are generated deterministically from
 * the address bytes (a colored field of soft circles) so a first-time login
 * always yields the same 256x256 webp; uploads are re-encoded to 256x256 webp.
 */

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export function avatarPath(dataDir: string, address: string): string {
  return join(dataDir, 'avatars', `${address}.webp`);
}

export function avatarUrl(address: string): string {
  return `/api/avatars/${address}`;
}

export async function generatePlaceholderAvatar(address: string, dataDir: string): Promise<void> {
  mkdirSync(join(dataDir, 'avatars'), { recursive: true });
  const hex = address.slice(2).toLowerCase();
  const byte = (i: number) => parseInt(hex.slice((i * 2) % 40, (i * 2) % 40 + 2), 16);
  const hue = Math.round((byte(0) / 255) * 360);
  const accent = (hue + 60 + Math.round((byte(1) / 255) * 120)) % 360;
  const shapes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const cx = 32 + Math.round((byte(2 + i * 3) / 255) * 192);
    const cy = 32 + Math.round((byte(3 + i * 3) / 255) * 192);
    const r = 24 + Math.round((byte(4 + i * 3) / 255) * 56);
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${accent}, 70%, 60%, 0.55)"/>`);
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">` +
    `<rect width="256" height="256" fill="hsl(${hue}, 55%, 22%)"/>${shapes.join('')}</svg>`;
  await sharp(Buffer.from(svg)).resize(256, 256).webp().toFile(avatarPath(dataDir, address));
}

export async function saveAvatarUpload(
  buffer: Buffer,
  address: string,
  dataDir: string,
): Promise<void> {
  mkdirSync(join(dataDir, 'avatars'), { recursive: true });
  const out = await sharp(buffer).resize(256, 256).webp().toBuffer();
  await writeFile(avatarPath(dataDir, address), out);
}
