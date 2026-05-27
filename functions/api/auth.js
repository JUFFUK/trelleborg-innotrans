// Uses Web Crypto API — no npm dependencies needed

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  const hashArray = new Uint8Array(bits);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
  return saltHex + ":" + hashHex;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  const hashArray = new Uint8Array(bits);
  const newHashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
  return newHashHex === hashHex;
}

function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  const rand = crypto.getRandomValues(new Uint8Array(64));
  for (let i = 0; i < 64; i++) token += chars[rand[i] % chars.length];
  return token;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (request.method === "POST" && action === "login") {
    const { email, password } = await request.json();
    if (!email || !password) return json({ error: "Email and password required" }, 400);
    const user = await env.USERS.get("user:" + email.toLowerCase(), { type: "json" });
    if (!user) return json({ error: "Invalid email or password" }, 401);
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    const expiry = Date.now() + 8 * 60 * 60 * 1000;
    await env.USERS.put("session:" + token, JSON.stringify({
      userId: email.toLowerCase(), name: user.name, role: user.role, expiry
    }), { expirationTtl: 28800 });
    return json({ token, name: user.name, email: email.toLowerCase(), role: user.role });
  }

  if (request.method === "POST" && action === "register") {
    const { email, password, name, role, adminSecret } = await request.json();
    if (!email || !password || !name) return json({ error: "Name, email and password required" }, 400);
    if (adminSecret !== env.ADMIN_SECRET) return json({ error: "Invalid admin secret" }, 403);
    const existing = await env.USERS.get("user:" + email.toLowerCase());
    if (existing) return json({ error: "User already exists" }, 409);
    const passwordHash = await hashPassword(password);
    await env.USERS.put("user:" + email.toLowerCase(), JSON.stringify({
      name, email: email.toLowerCase(),
      role: role === "manager" ? "manager" : "team",
      passwordHash, createdAt: new Date().toISOString()
    }));
    return json({ success: true });
  }

  if (request.method === "POST" && action === "logout") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (token) await env.USERS.delete("session:" + token);
    return json({ success: true });
  }

  if (request.method === "GET" && action === "verify") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ valid: false }, 401);
    const session = await env.USERS.get("session:" + token, { type: "json" });
    if (!session || Date.now() > session.expiry) return json({ valid: false }, 401);
    return json({ valid: true, name: session.name, email: session.userId, role: session.role });
  }

  return json({ error: "Not found" }, 404);
}
