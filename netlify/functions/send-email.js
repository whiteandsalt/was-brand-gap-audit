const https = require("https");

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const RESEND = process.env.RESEND_API_KEY || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function validEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

async function logToFlodesk(email, firstName) {
  const KEY = (process.env.FLODESK_API_KEY || "").trim();
  const SEGMENT = (process.env.FLODESK_SEGMENT_ID || "").trim();

  console.log("Flodesk attempt — key length:", KEY.length, "email:", email, "segment:", SEGMENT);

  if (!KEY) {
    console.log("Flodesk skipped: no API key");
    return;
  }
  if (!validEmail(email)) {
    console.log("Flodesk skipped: invalid email:", email);
    return;
  }

  const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");

  // Build payload — include segment_ids in the upsert so it works even if subscriber already exists
  const subscriberPayload = {
    email: email.trim(),
    first_name: (firstName || "").trim() || undefined,
    segment_ids: SEGMENT ? [SEGMENT] : undefined,
  };

  console.log("Flodesk upsert payload:", JSON.stringify(subscriberPayload));

  try {
    const up = await post(
      "api.flodesk.com",
      "/v1/subscribers",
      { Authorization: auth },
      subscriberPayload
    );
    console.log("Flodesk upsert status:", up.status, "body:", JSON.stringify(up.body));
  } catch (e) {
    console.error("Flodesk error:", e.message);
  }
}

async function sendMail(to, subject, html, replyTo) {
  return post("api.resend.com", "/emails", { Authorization: "Bearer " + RESEND }, {
    from: "White and Salt <hello@whiteandsalt.com>",
    to: Array.isArray(to) ? to : [to],
    reply_to: validEmail(replyTo) ? replyTo.trim() : undefined,
    subject,
    html,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method not allowed" };
  }

  const CLAUDE = process.env.ANTHROPIC_API_KEY || "";
  console.log("Handler called, action:", JSON.parse(event.body || "{}").action);

  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;

    if (action === "send-email") {
      const { to, subject, html, replyTo, leadEmail, leadName } = payload;
      console.log("Sending email to:", to, "leadEmail:", leadEmail, "leadName:", leadName);
      const r = await sendMail(to, subject, html, replyTo);
      console.log("Resend status:", r.status);

      await logToFlodesk(leadEmail || replyTo, leadName);

      if (r.status !== 200 && r.status !== 201) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: r.body }) };
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    if (action === "personalize") {
      const { name, brand, gapLabel, answerLog } = payload;
      if (!CLAUDE) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "No API key" }) };
      }
      const r = await post(
        "api.anthropic.com",
        "/v1/messages",
        { "x-api-key": CLAUDE, "anthropic-version": "2023-06-01" },
        {
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          system: "You are a senior brand strategist at White and Salt. Direct, warm, real. No bullet points. No em dashes. Max 5 sentences.",
          messages: [
            {
              role: "user",
              content:
                "A founder completed the Brand Gap Audit.\nName: " +
                name +
                "\nBrand: " +
                brand +
                "\nPrimary gap: " +
                gapLabel +
                "\nAnswers:\n" +
                answerLog +
                "\n\nWrite 4-5 sentences to " +
                name +
                " directly. Open with something specific from their answers. Name what this gap costs them concretely. Close with what changes when the gap closes. No em dashes.",
            },
          ],
        }
      );
      console.log("Claude status:", r.status);
      if (r.status !== 200) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Claude failed", detail: r.body }) };
      }
      const text = r.body.content.find((b) => b.type === "text")?.text || "";
      return { statusCode: 200, headers: cors, body: JSON.stringify({ text }) };
    }

    if (action === "generate-and-send-audit") {
      const { form, gap, secondary, answers, aiText, questions } = payload;
      if (!CLAUDE) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "No API key" }) };
      }
      const auditLog = (answers || []).map((a, i) => ((questions || [])[i] || "Q" + i) + ": " + a).join("\n");
      const secList = (secondary || []).map((g) => g.label + ": " + g.tagline).join("\n");

      const r = await post(
        "api.anthropic.com",
        "/v1/messages",
        { "x-api-key": CLAUDE, "anthropic-version": "2023-06-01" },
        {
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: "You are a senior brand strategist at White and Salt. Write premium brand audit reports in HTML with inline styles only. No external resources.",
          messages: [
            {
              role: "user",
              content:
                "Write a premium HTML email brand audit report for " +
                form.name +
                " at " +
                (form.brand || "their brand") +
                ".\n\nPrimary gap: " +
                gap.label +
                " - " +
                gap.tagline +
                "\nWhat: " +
                gap.what +
                "\nBusiness impact: " +
                gap.business +
                "\nShows up: " +
                gap.shows_up +
                "\nSolve: " +
                gap.solve +
                "\nSecondary gaps: " +
                (secList || "None") +
                "\nInsight: " +
                aiText +
                "\nAnswers:\n" +
                auditLog +
                "\n\nCreate a complete HTML email. Inline styles only. Max 680px centered.\n1. Header: W&S in large Georgia serif bold, BRAND GAP AUDIT subtitle\n2. Greeting to " +
                form.name +
                " with insight in italic Georgia\n3. Dark block (#181818): gap label Georgia 48px weight 300, tagline white\n4. Four #F7F7F7 sections with full copy\n5. Process: Catch the Bug, Map the Gap, Design the Movement\n6. Dark CTA with pill button to https://www.whiteandsalt.com/contact\n7. Footer\nAll text on dark = white. Return only HTML starting with <!DOCTYPE html>.",
            },
          ],
        }
      );
      console.log("Claude status:", r.status);
      if (r.status !== 200) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Claude failed" }) };
      }
      const html = r.body.content.find((b) => b.type === "text")?.text || "";
      if (!html) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Empty report" }) };
      }
      await sendMail(form.email, "Your Brand Gap Audit — " + gap.label + (form.brand ? " · " + form.brand : ""), html);
      await sendMail("hello@whiteandsalt.com", "[Audit Sent] " + form.name + " — " + gap.label, html, form.email);
      console.log("Audit sent to", form.email);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Unknown action: " + action }) };
  } catch (err) {
    console.error("Uncaught:", err.message, err.stack);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
