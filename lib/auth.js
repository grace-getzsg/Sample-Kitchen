const crypto = require("node:crypto");

function authorized(request) {
  const expected = process.env.OWNER_IMPORT_TOKEN;
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { authorized };
