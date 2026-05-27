function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function getSession(request, env) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
  if (!token) return null;
  const session = await env.USERS.get("session:" + token, { type: "json" });
  if (!session || Date.now() > session.expiry) return null;
  return session;
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });
  }

  const session = await getSession(request, env);
  if (!session) return json({ error: "Unauthorised" }, 401);

  const url = new URL(request.url);

  if (request.method === "GET") {
    const list = await env.LEADS.list();
    const leads = await Promise.all(list.keys.map(k => env.LEADS.get(k.name, { type: "json" })));
    const valid = leads.filter(Boolean);
    const filtered = session.role === "manager" ? valid : valid.filter(l => l.capturedBy === session.userId);
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return json(filtered);
  }

  if (request.method === "POST") {
    const body = await request.json();
    const id = "lead_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const lead = { id, ...body, capturedBy: session.userId, capturedByName: session.name, synced: false, createdAt: new Date().toISOString() };
    await env.LEADS.put(id, JSON.stringify(lead));
    return json(lead, 201);
  }

  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Lead ID required" }, 400);
    const existing = await env.LEADS.get(id, { type: "json" });
    if (!existing) return json({ error: "Lead not found" }, 404);
    if (session.role !== "manager" && existing.capturedBy !== session.userId) return json({ error: "Forbidden" }, 403);
    const updates = await request.json();
    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    await env.LEADS.put(id, JSON.stringify(updated));
    return json(updated);
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Lead ID required" }, 400);
    const existing = await env.LEADS.get(id, { type: "json" });
    if (!existing) return json({ error: "Lead not found" }, 404);
    if (session.role !== "manager" && existing.capturedBy !== session.userId) return json({ error: "Forbidden" }, 403);
    await env.LEADS.delete(id);
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
