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

function tempToLeadStatus(temp) {
  if (temp === "hot") return "IN_PROGRESS";
  if (temp === "warm") return "OPEN";
  return "NEW";
}

async function syncToHubSpot(lead, token) {
  const descParts = [];
  if (lead.products && lead.products.length) descParts.push("Product interest: " + lead.products.join(", "));
  if (lead.followup) descParts.push("Follow-up: " + lead.followup);
  if (lead.notes) descParts.push("Notes: " + lead.notes);
  descParts.push("Captured by: " + (lead.capturedByName || lead.capturedBy || "Unknown"));
  descParts.push("Source: Innotrans 2026, Berlin");
  if (lead.scanned) descParts.push("Business card scanned: Yes");

  const properties = {
    firstname: lead.fname || "",
    lastname: lead.lname || "",
    email: lead.email || "",
    phone: lead.phone || "",
    company: lead.company || "",
    jobtitle: lead.title || "",
  };

  // Search for existing contact by email
  let contactId = null;
  const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: lead.email }] }],
      properties: ["id", "email"],
      limit: 1,
    }),
  });
  const searchText = await searchRes.text();
  if (!searchRes.ok) throw new Error("HubSpot search failed (" + searchRes.status + "): " + searchText);
  const searchData = JSON.parse(searchText);
  if (searchData.results && searchData.results.length > 0) {
    contactId = searchData.results[0].id;
  }

  // Create or update
  let hubspotContactId;
  if (contactId) {
    const updateRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/" + contactId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ properties }),
    });
    const updateText = await updateRes.text();
    if (!updateRes.ok) throw new Error("HubSpot update failed (" + updateRes.status + "): " + updateText);
    hubspotContactId = contactId;
  } else {
    const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ properties }),
    });
    const createText = await createRes.text();
    if (!createRes.ok) throw new Error("HubSpot create failed (" + createRes.status + "): " + createText);
    const created = JSON.parse(createText);
    hubspotContactId = created.id;
  }

  return hubspotContactId;
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

    // If syncing to HubSpot, call the API now
    if (updates.synced === true) {
      const HUBSPOT_TOKEN = env.HUBSPOT_TOKEN;
      if (!HUBSPOT_TOKEN) return json({ error: "HUBSPOT_TOKEN not set in Cloudflare environment" }, 500);
      try {
        const hubspotContactId = await syncToHubSpot(updated, HUBSPOT_TOKEN);
        updated.hubspotContactId = hubspotContactId;
        updated.syncedAt = new Date().toISOString();
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

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
