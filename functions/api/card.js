function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function normalizeName(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function generateQrIo(dataUrl, title, env) {
  if (!env.QRIO_API_KEY) return null;
  try {
    const res = await fetch("https://api.qr.io/v1/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: env.QRIO_API_KEY,
        data: dataUrl,
        qrtype: "static",
        title: title,
        transparent: "off",
        backcolor: "#FFFFFF",
        frontcolor: "#000000"
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    // QR.io's exact response field naming isn't fully documented; check the
    // common possibilities for either a hosted image URL or raw SVG markup.
    const raw = data.svg || data.qr_svg || data.file || data.url || data.image || null;
    if (!raw) return null;
    if (typeof raw === "string" && raw.trim().startsWith("<svg")) {
      return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(raw)));
    }
    return raw;
  } catch (e) {
    return null;
  }
}

async function getSession(request, env) {
  const token = (request.headers.get("authorization") || "").replace("Bearer ", "").trim();
  if (!token) return null;
  const session = await env.USERS.get("session:" + token, { type: "json" });
  if (!session || Date.now() > session.expiry) return null;
  return session;
}

function slugify(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "card";
}

async function uniqueSlug(baseSlug, env, ownEmail) {
  let slug = baseSlug;
  let n = 1;
  while (true) {
    const owner = await env.USERS.get("cardslug:" + slug);
    if (!owner || owner === ownEmail) return slug;
    n += 1;
    slug = baseSlug + "-" + n;
  }
}

function publicFields(card) {
  return {
    slug: card.slug,
    name: card.name,
    title: card.title || "",
    function: card.function || "",
    businessUnit: card.businessUnit || "",
    company: card.company || "Trelleborg Antivibration Solutions",
    email: card.email,
    phone: card.phone || "",
    linkedin: card.linkedin || "",
    photoUrl: card.photoUrl || "",
    qrImageUrl: card.qrImageUrl || ""
  };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,PATCH,POST", "Access-Control-Allow-Headers": "Content-Type,Authorization" } });
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const emailParam = url.searchParams.get("email");
  const wantsAll = url.searchParams.get("all") === "1";
  const wantsBulk = url.searchParams.get("bulk") === "1";

  // ── PUBLIC LOOKUP (no auth, used by card.html) ──
  if (request.method === "GET" && slug) {
    const email = await env.USERS.get("cardslug:" + slug);
    if (!email) return json({ error: "Card not found" }, 404);
    const card = await env.USERS.get("card:" + email, { type: "json" });
    if (!card) return json({ error: "Card not found" }, 404);
    return json(publicFields(card));
  }

  // Everything below requires a signed-in session
  const session = await getSession(request, env);
  if (!session) return json({ error: "Unauthorised" }, 401);

  // ── MANAGER: bulk-import function/business unit by matching names against existing accounts ──
  if (request.method === "POST" && wantsBulk) {
    if (session.role !== "manager") return json({ error: "Forbidden" }, 403);
    const body = await request.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];

    const list = await env.USERS.list({ prefix: "user:" });
    const allUsers = (await Promise.all(list.keys.map(k => env.USERS.get(k.name, { type: "json" })))).filter(Boolean);

    const matched = [];
    const unmatched = [];

    for (const row of rows) {
      const fullName = `${row.firstName || ""} ${row.lastName || ""}`.trim();
      const rowEmail = (row.email || "").trim().toLowerCase();
      if (!fullName && !rowEmail) continue;

      // Prefer matching by email, given directly, over matching by name
      let user = null;
      if (rowEmail) {
        user = allUsers.find(u => u.email.toLowerCase() === rowEmail);
      }
      if (!user && fullName) {
        const target = normalizeName(fullName);
        user = allUsers.find(u => normalizeName(u.name) === target);
      }
      if (!user) {
        unmatched.push(fullName || rowEmail);
        continue;
      }

      let functionValue = (row.department || "").trim();
      const businessUnitValue = (row.company || "").trim();
      // A department value identical to the company looks like a data gap
      // (e.g. "ECF" listed as both), not a real function, so leave it blank.
      if (functionValue && businessUnitValue && functionValue.toLowerCase() === businessUnitValue.toLowerCase()) {
        functionValue = "";
      }
      const jobTitleValue = (row.jobTitle || "").trim();

      const existing = await env.USERS.get("card:" + user.email, { type: "json" });
      const card = {
        ...(existing || {
          email: user.email,
          name: user.name,
          company: "Trelleborg Antivibration Solutions",
          createdAt: new Date().toISOString()
        }),
        email: user.email,
        name: user.name,
        title: jobTitleValue || (existing && existing.title) || "",
        function: functionValue,
        businessUnit: businessUnitValue,
        updatedAt: new Date().toISOString()
      };
      if (!card.slug) {
        card.slug = await uniqueSlug(slugify(user.name), env, user.email);
        await env.USERS.put("cardslug:" + card.slug, user.email);
      }
      if (!card.qrImageUrl) {
        const publicUrl = url.origin + "/card.html?id=" + card.slug;
        const qrImageUrl = await generateQrIo(publicUrl, user.name + " — Trelleborg", env);
        if (qrImageUrl) card.qrImageUrl = qrImageUrl;
      }
      await env.USERS.put("card:" + user.email, JSON.stringify(card));
      matched.push({ name: user.name, email: user.email, function: functionValue, businessUnit: businessUnitValue });
    }

    return json({ matched, unmatched });
  }

  // ── LIST EVERY TEAM MEMBER'S CARD (any signed-in team member, to share colleagues' cards) ──
  if (request.method === "GET" && wantsAll) {
    const list = await env.USERS.list({ prefix: "user:" });
    const users = await Promise.all(list.keys.map(k => env.USERS.get(k.name, { type: "json" })));
    const results = await Promise.all(users.filter(Boolean).map(async u => {
      const card = await env.USERS.get("card:" + u.email, { type: "json" });
      return {
        email: u.email,
        name: u.name,
        title: (card && card.title) || "",
        function: (card && card.function) || "",
        businessUnit: (card && card.businessUnit) || "",
        phone: (card && card.phone) || "",
        linkedin: (card && card.linkedin) || "",
        photoUrl: (card && card.photoUrl) || "",
        slug: (card && card.slug) || ""
      };
    }));
    results.sort((a, b) => a.name.localeCompare(b.name));
    return json(results);
  }

  // Work out whose card this request is for: yourself, or, for managers
  // only, another team member's via ?email=
  let targetEmail = session.userId;
  let targetName = session.name;
  if (emailParam && emailParam.toLowerCase() !== session.userId) {
    if (session.role !== "manager") return json({ error: "Forbidden" }, 403);
    const targetUser = await env.USERS.get("user:" + emailParam.toLowerCase(), { type: "json" });
    if (!targetUser) return json({ error: "User not found" }, 404);
    targetEmail = targetUser.email;
    targetName = targetUser.name;
  }

  // ── GET A CARD (creates a default one on first visit) ──
  if (request.method === "GET") {
    let card = await env.USERS.get("card:" + targetEmail, { type: "json" });
    if (!card) {
      const newSlug = await uniqueSlug(slugify(targetName), env, targetEmail);
      const publicUrl = url.origin + "/card.html?id=" + newSlug;
      const qrImageUrl = await generateQrIo(publicUrl, targetName + " — Trelleborg", env);
      card = {
        email: targetEmail,
        name: targetName,
        title: "",
        company: "Trelleborg Antivibration Solutions",
        phone: "",
        linkedin: "",
        photoUrl: "",
        slug: newSlug,
        qrImageUrl: qrImageUrl || "",
        createdAt: new Date().toISOString()
      };
      await env.USERS.put("card:" + targetEmail, JSON.stringify(card));
      await env.USERS.put("cardslug:" + newSlug, targetEmail);
    }
    return json(card);
  }

  // ── UPDATE A CARD ──
  if (request.method === "PATCH") {
    const existing = await env.USERS.get("card:" + targetEmail, { type: "json" });
    const body = await request.json();
    const allowed = ["title", "phone", "linkedin", "photoUrl", "function", "businessUnit"];
    const updates = {};
    for (const key of allowed) {
      if (typeof body[key] === "string") updates[key] = body[key].trim();
    }
    const card = {
      ...(existing || {
        email: targetEmail,
        name: targetName,
        company: "Trelleborg Antivibration Solutions",
        createdAt: new Date().toISOString()
      }),
      ...updates,
      email: targetEmail,
      name: targetName,
      updatedAt: new Date().toISOString()
    };
    if (!card.slug) {
      card.slug = await uniqueSlug(slugify(targetName), env, targetEmail);
      await env.USERS.put("cardslug:" + card.slug, targetEmail);
    }
    if (!card.qrImageUrl) {
      const publicUrl = url.origin + "/card.html?id=" + card.slug;
      const qrImageUrl = await generateQrIo(publicUrl, targetName + " — Trelleborg", env);
      if (qrImageUrl) card.qrImageUrl = qrImageUrl;
    }
    await env.USERS.put("card:" + targetEmail, JSON.stringify(card));
    return json(card);
  }

  return json({ error: "Method not allowed" }, 405);
}
