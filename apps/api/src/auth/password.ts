import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 256;
const KEY_LENGTH = 32;
const COST = 131_072;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 256 * 1024 * 1024;

function validatePassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < MIN_PASSWORD_BYTES) throw new Error("Password must be at least 12 bytes");
  if (bytes > MAX_PASSWORD_BYTES) throw new Error("Password must be at most 256 bytes");
}

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_LENGTH, { N: cost, r: blockSize, p: parallelization, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return ["scrypt", COST, BLOCK_SIZE, PARALLELIZATION, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) return false;
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const stored = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length !== 16 || stored.length !== KEY_LENGTH) return false;
    const candidate = await derive(password, salt, cost, blockSize, parallelization);
    return timingSafeEqual(candidate, stored);
  } catch {
    return false;
  }
}
