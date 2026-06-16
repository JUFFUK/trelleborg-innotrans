import bcrypt from "bcryptjs";

function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
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
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // ── LOGIN ──
  if (request.method === "POST" && action === "login") {
    const { email, password } = await request.json();
    if (!email || !password) return json({ error: "Email and password required" }, 400);
    const user = await env.USERS.get("user:" + email.toLowerCase(), { type: "json" });
    if (!user) return json({ error: "Invalid email or password" }, 401);
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    const expiry = Date.now() + 8 * 60 * 60 * 1000;
    await env.USERS.put("user:" + email.toLowerCase(), JSON.stringify({
      ...user,
      lastLoginAt: new Date().toISOString()
    }));
    await env.USERS.put("session:" + token, JSON.stringify({
      userId: email.toLowerCase(), name: user.name, role: user.role, expiry
    }), { expirationTtl: 28800 });
    return json({ token, name: user.name, email: email.toLowerCase(), role: user.role });
  }

  // ── REGISTER ──
  if (request.method === "POST" && action === "register") {
    const { email, password, name, role, adminSecret } = await request.json();
    if (!email || !password || !name) return json({ error: "Name, email and password required" }, 400);
    if (adminSecret !== env.ADMIN_SECRET) return json({ error: "Invalid admin secret" }, 403);
    const existing = await env.USERS.get("user:" + email.toLowerCase());
    if (existing) return json({ error: "User already exists" }, 409);
    const passwordHash = await bcrypt.hash(password, 10);
    await env.USERS.put("user:" + email.toLowerCase(), JSON.stringify({
      name, email: email.toLowerCase(),
      role: role === "manager" ? "manager" : "team",
      passwordHash, createdAt: new Date().toISOString(),
      lastLoginAt: null
    }));
    return json({ success: true });
  }

  // ── LOGOUT ──
  if (request.method === "POST" && action === "logout") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (token) await env.USERS.delete("session:" + token);
    return json({ success: true });
  }

  // ── VERIFY ──
  if (request.method === "GET" && action === "verify") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ valid: false }, 401);
    const session = await env.USERS.get("session:" + token, { type: "json" });
    if (!session || Date.now() > session.expiry) return json({ valid: false }, 401);
    return json({ valid: true, name: session.name, email: session.userId, role: session.role });
  }

  // ── LIST USERS (manager only) ──
  if (request.method === "GET" && action === "list-users") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorised" }, 401);
    const session = await env.USERS.get("session:" + token, { type: "json" });
    if (!session || Date.now() > session.expiry) return json({ error: "Unauthorised" }, 401);
    if (session.role !== "manager") return json({ error: "Forbidden" }, 403);
    const list = await env.USERS.list({ prefix: "user:" });
    const users = await Promise.all(
      list.keys.map(k => env.USERS.get(k.name, { type: "json" }))
    );
    const safe = users.filter(Boolean).map(u => ({
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || null
    }));
    safe.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return json(safe);
  }

  // ── DELETE USER (manager only) ──
  if (request.method === "POST" && action === "delete-user") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorised" }, 401);
    const session = await env.USERS.get("session:" + token, { type: "json" });
    if (!session || Date.now() > session.expiry) return json({ error: "Unauthorised" }, 401);
    if (session.role !== "manager") return json({ error: "Forbidden" }, 403);
    const { email } = await request.json();
    if (!email) return json({ error: "Email required" }, 400);
    if (email.toLowerCase() === session.userId) return json({ error: "You cannot delete your own account" }, 400);
    await env.USERS.delete("user:" + email.toLowerCase());
    return json({ success: true });
  }

  // ── UPDATE USER ROLE (manager only) ──
  if (request.method === "POST" && action === "update-role") {
    const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorised" }, 401);
    const session = await env.USERS.get("session:" + token, { type: "json" });
    if (!session || Date.now() > session.expiry) return json({ error: "Unauthorised" }, 401);
    if (session.role !== "manager") return json({ error: "Forbidden" }, 403);
    const { email, role } = await request.json();
    if (!email || !role) return json({ error: "Email and role required" }, 400);
    if (email.toLowerCase() === session.userId) return json({ error: "You cannot change your own role" }, 400);
    const user = await env.USERS.get("user:" + email.toLowerCase(), { type: "json" });
    if (!user) return json({ error: "User not found" }, 404);
    await env.USERS.put("user:" + email.toLowerCase(), JSON.stringify({
      ...user,
      role: role === "manager" ? "manager" : "team"
    }));
    return json({ success: true });
  }

  return json({ error: "Not found" }, 404);
}
