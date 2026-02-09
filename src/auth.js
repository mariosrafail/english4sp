const crypto = require("crypto");

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(String(plain), salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

function verifyPassword(plain, stored) {
  try {
    const [salt, hex] = String(stored || "").split(":");
    if (!salt || !hex) return false;
    const key = crypto.scryptSync(String(plain), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(hex, "hex"));
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
