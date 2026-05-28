/**
 * POST /api/hubspot
 * Body: { leadId }
 *
 * Finds the lead in KV, creates or updates a HubSpot contact,
 * marks the lead as synced, and returns the updated lead.
 *
 * Required Cloudflare env variable: HUBSPOT_TOKEN
 * (HubSpot Private App token with crm.objects.contacts.write scope)
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

function getAuthUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;
  return env.USERS.get("session:" + token, { type: "json" });
}

// Map lead temperature to a HubSpot lead status value
function tempToLeadStatus(temp) {
  if (temp === "hot") return "IN_PROGRESS";
  if (temp === "warm") return "OPEN";
  return "NEW";
}

export async function onRequest({ request, env }) {
  // CORS preflight
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

  // Auth check
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: "Unauthorised" }, 401);

  const HUBSPOT_TOKEN = env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) {
    return json({ error: "HUBSPOT_TOKEN environment variable not set" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { leadId } = body;
  if (!leadId) return json({ error: "leadId is required" }, 400);

  // Load the lead from KV
  const lead = await env.LEADS.get("lead:" + leadId, { type: "json" });
  if (!lead) return json({ error: "Lead not found" }, 404);

  // Build HubSpot contact properties
  const properties = {
    firstname: lead.fname || "",
    lastname: lead.lname || "",
    email: lead.email || "",
    phone: lead.phone || "",
    company: lead.company || "",
    jobtitle: lead.title || "",
    lead_status: tempToLeadStatus(lead.temp),
    // Store Innotrans-specific data in notes / description fields
    hs_lead_status: tempToLeadStatus(lead.temp),
    notes_last_updated: new Date().toISOString(),
  };

  // Build a combined notes string to go into HubSpot
  const notesParts = [];
  if (lead.products && lead.products.length) {
    notesParts.push("Product interest: " + lead.products.join(", "));
  }
  if (lead.followup) {
    notesParts.push("Follow-up: " + lead.followup);
  }
  if (lead.notes) {
    notesParts.push("Notes: " + lead.notes);
  }
  notesParts.push("Captured by: " + (lead.capturedByName || lead.capturedBy || "Unknown"));
  notesParts.push("Source: Innotrans 2026, Berlin");
  if (lead.scanned) notesParts.push("Business card scanned: Yes");

  // HubSpot uses a separate Notes/Engagement API for notes,
  // but we can also store a summary in the "description" property.
  // We'll create a note engagement after contact creation.

  // ── Step 1: Search for existing contact by email ──
  let contactId = null;

  try {
    const searchRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + HUBSPOT_TOKEN,
        },
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "email",
                  operator: "EQ",
                  value: lead.email,
                },
              ],
            },
          ],
          properties: ["id", "email"],
          limit: 1,
        }),
      }
    );

    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.results && searchData.results.length > 0) {
        contactId = searchData.results[0].id;
      }
    }
  } catch (e) {
    // Search failed — we'll try to create anyway
    console.error("HubSpot search error:", e);
  }

  // ── Step 2: Create or update the contact ──
  let hubspotContactId;

  if (contactId) {
    // Update existing contact
    const updateRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/" + contactId,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + HUBSPOT_TOKEN,
        },
        body: JSON.stringify({ properties }),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.json();
      return json({ error: "HubSpot update failed: " + (err.message || updateRes.status) }, 502);
    }

    hubspotContactId = contactId;
  } else {
    // Create new contact
    const createRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + HUBSPOT_TOKEN,
        },
        body: JSON.stringify({ properties }),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.json();
      return json({ error: "HubSpot create failed: " + (err.message || createRes.status) }, 502);
    }

    const created = await createRes.json();
    hubspotContactId = created.id;
  }

  // ── Step 3: Create a Note engagement with the full context ──
  if (notesParts.length && hubspotContactId) {
    try {
      await fetch("https://api.hubapi.com/engagements/v1/engagements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + HUBSPOT_TOKEN,
        },
        body: JSON.stringify({
          engagement: {
            active: true,
            type: "NOTE",
            timestamp: Date.now(),
          },
          associations: {
            contactIds: [parseInt(hubspotContactId)],
          },
          metadata: {
            body: notesParts.join("\n"),
          },
        }),
      });
    } catch (e) {
      // Note creation failing shouldn't block the overall sync
      console.error("HubSpot note error:", e);
    }
  }

  // ── Step 4: Mark lead as synced in KV ──
  lead.synced = true;
  lead.hubspotContactId = hubspotContactId;
  lead.syncedAt = new Date().toISOString();

  await env.LEADS.put("lead:" + leadId, JSON.stringify(lead));

  return json(lead);
}
