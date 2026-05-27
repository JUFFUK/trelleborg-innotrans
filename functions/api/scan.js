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
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });
  }

  const session = await getSession(request, env);
  if (!session) return json({ error: "Unauthorised" }, 401);

  if (!env.ANTHROPIC_API_KEY) return json({ error: "API key not configured" }, 500);

  const { imageBase64, imageType } = await request.json();
  if (!imageBase64 || !imageType) return json({ error: "Image data required" }, 400);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: imageType, data: imageBase64 } },
          { type: "text", text: "This is a business card. Extract contact details and return ONLY a JSON object with keys: firstName, lastName, email, phone, company, jobTitle. Use empty string for missing fields. No preamble, no markdown, raw JSON only." }
        ]
      }]
    })
  });

  const data = await response.json();
  if (!response.ok) return json({ error: data.error?.message || "AI extraction failed" }, 500);

  const raw = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return json(parsed);
  } catch {
    return json({ error: "Could not parse card details" }, 500);
  }
}
