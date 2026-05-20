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

const RESEND = "re_jfRWDZ2n_8FT7b9YmbEXwZjwFyi18eovv";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

async function sendMail(to, subject, html, replyTo) {
  return post("api.resend.com", "/emails", { Authorization: "Bearer " + RESEND }, {
    from: "White and Salt <hello@whiteandsalt.com>",
    to: Array.isArray(to) ? to : [to],
    reply_to: replyTo || undefined,
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
  console.log("Claude key present:", !!CLAUDE, "length:", CLAUDE.length);

  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;

    // send-email
    if (action === "send-email") {
      const { to, subject, html, replyTo } = payload;
      console.log("Sending email to:", to, "subject:", subject);
      const r = await sendMail(to, subject, html, replyTo);
      console.log("Resend status:", r.status);
      if (r.status !== 200 && r.status !== 201) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ error: r.body }) };
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    // personalize
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

    // generate-and-send-audit
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
                "\n\nCreate a complete HTML email. Inline styles only. Max 680px centered.\n1. Header: W&S in large Georgia serif bold, FREE BRAND GAP AUDIT subtitle\n2. Greeting to " +
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
