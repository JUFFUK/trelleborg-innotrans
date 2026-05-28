/**
 * POST /api/hubspot
 * Body: { leadId }
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getAuthUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;
  return env.USERS.get("session:" + token, { type: "json" });
}

function tempToLeadStatus(temp) {
  if (temp === "hot") return "IN_PROGRESS";
  if (temp === "warm") return "OPEN";
  return "NEW";
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const user = await getAuthUser(request, env);
  if (!user) return json({ error: "Unauthorised" }, 401);

  const HUBSPOT_TOKEN = env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) {
    return json({ error: "HUBSPOT_TOKEN not set in environment" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { leadId } = body;
  if (!leadId) return json({ error: "leadId is required" }, 400);

  const lead = await env.LEADS.get("lead:" + leadId, { type: "json" });
  if (!lead) return json({ error: "Lead not found in KV" }, 404);

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
    lead_status: tempToLeadStatus(lead.temp),
    description: descParts.join(" | "),
  };

  // ── Search for existing contact ──
  let contactId = null;
  try {
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + HUBSPOT_TOKEN,
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: lead.email }] }],
        properties: ["id", "email"],
        limit: 1,
      }),
    });

    const searchText = await searchRes.text();
    if (!searchRes.ok) {
      return json({ error: "HubSpot search failed (" + searchRes.status + "): " + searchText }, 502);
    }
    const searchData = JSON.parse(searchText);
    if (searchData.results && searchData.results.length > 0) {
      contactId = searchData.results[0].id;
    }
  } catch (e) {
    return json({ error: "HubSpot search exception: " + e.message }, 502);
  }

  // ── Create or update ──
  let hubspotContactId;

  if (contactId) {
    const updateRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/" + contactId, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + HUBSPOT_TOKEN,
      },
      body: JSON.stringify({ properties }),
    });

    const updateText = await updateRes.text();
    if (!updateRes.ok) {
      return json({ error: "HubSpot update failed (" + updateRes.status + "): " + updateText }, 502);
    }
    hubspotContactId = contactId;
  } else {
    const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + HUBSPOT_TOKEN,
      },
      body: JSON.stringify({ properties }),
    });

    const createText = await createRes.text();
    if (!createRes.ok) {
      return json({ error: "HubSpot create failed (" + createRes.status + "): " + createText }, 502);
    }
    const created = JSON.parse(createText);
    hubspotContactId = created.id;
  }

  // ── Mark synced in KV ──
  lead.synced = true;
  lead.hubspotContactId = hubspotContactId;
  lead.syncedAt = new Date().toISOString();
  await env.LEADS.put("lead:" + leadId, JSON.stringify(lead));

  return json(lead);
}
