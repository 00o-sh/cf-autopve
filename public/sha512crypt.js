/**
 * SHA-512-crypt ("$6$", what `mkpasswd -m sha-512` and `openssl passwd -6`
 * produce), following Ulrich Drepper's specification
 * (https://www.akkadia.org/drepper/SHA-crypt.txt), on WebCrypto's SHA-512.
 *
 * Used by the configurator to turn a typed root password into
 * root-password-hashed in the browser, so the plaintext is never sent,
 * stored or served. Loaded as a plain script; also importable in tests.
 */
(() => {
  const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const ROUNDS_DEFAULT = 5000;
  const ROUNDS_MIN = 1000;
  const ROUNDS_MAX = 999999999;

  const sha512 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** `len` bytes of `src` repeated. */
  function repeatTo(src, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = src[i % src.length];
    return out;
  }

  function encode(d) {
    let out = "";
    const b64 = (b2, b1, b0, n) => {
      let w = (b2 << 16) | (b1 << 8) | b0;
      for (let i = 0; i < n; i++) { out += ITOA64[w & 0x3f]; w >>= 6; }
    };
    const order = [
      [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
      [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
      [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
    ];
    for (const [a, b, c] of order) b64(d[a], d[b], d[c], 4);
    b64(0, 0, d[63], 2);
    return out;
  }

  /** A fresh 16-character salt from the crypt alphabet. */
  function randomSalt(length = 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => ITOA64[b & 0x3f]).join("");
  }

  /**
   * crypt(3) SHA-512 of `password`. `salt` is cut to 16 characters as the
   * specification requires. Rounds default to 5000 and are written into the
   * hash only when given explicitly, as crypt(3) does.
   */
  async function sha512crypt(password, salt = randomSalt(), rounds) {
    const enc = new TextEncoder();
    const P = enc.encode(password);
    const saltStr = String(salt).replace(/\$.*$/, "").slice(0, 16);
    const S = enc.encode(saltStr);
    const r = rounds === undefined ? ROUNDS_DEFAULT : Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Math.floor(rounds)));

    const B = await sha512(concat([P, S, P]));
    const aParts = [P, S, repeatTo(B, P.length)];
    for (let n = P.length; n > 0; n >>= 1) aParts.push(n & 1 ? B : P);
    const DA = await sha512(concat(aParts));

    const DP = await sha512(concat(Array(P.length).fill(P)));
    const Pp = repeatTo(DP, P.length);
    const DS = await sha512(concat(Array(16 + DA[0]).fill(S)));
    const Sp = repeatTo(DS, S.length);

    let C = DA;
    for (let i = 0; i < r; i++) {
      const parts = [i & 1 ? Pp : C];
      if (i % 3) parts.push(Sp);
      if (i % 7) parts.push(Pp);
      parts.push(i & 1 ? C : Pp);
      C = await sha512(concat(parts));
    }
    const roundsPart = rounds === undefined ? "" : `rounds=${r}$`;
    return `$6$${roundsPart}${saltStr}$${encode(C)}`;
  }

  globalThis.sha512crypt = sha512crypt;
  globalThis.sha512cryptSalt = randomSalt;
})();
