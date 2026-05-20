const https = require("https");

function postJSON(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: h, body: "Method not allowed" };

  const RESEND = "re_jfRWDZ2n_8FT7b9YmbEXwZjwFyi18eovv";
  const CLAUDE = process.env.ANTHROPIC_API_KEY || "";

  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;
    console.log("Action:", action, "| Anthropic key present:", !!CLAUDE);

    // ── personalize: generate AI insight paragraph ──────────────────────────
    if (action === "personalize") {
      const { name, brand, gapLabel, answerLog } = payload;
      if (!CLAUDE) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "API key missing" }) };

      const r = await postJSON("api.anthropic.com", "/v1/messages", {
        "x-api-key": CLAUDE, "anthropic-version": "2023-06-01",
      }, {
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: "You are a senior brand strategist at White and Salt. Write with precision, warmth, and authority. Direct tone, short punchy sentences mixed with longer ones. No bullet points. No em dashes. No generic phrases. Sound like a real person.",
        messages: [{ role: "user", content: `A founder completed the Brand Gap Audit.\nName: ${name}\nBrand: ${brand}\nPrimary gap: ${gapLabel}\nAnswers:\n${answerLog}\n\nWrite 4-5 sentences to ${name} directly. Open with something specific from their answers. Name what this gap is costing them concretely. Close with what changes when the gap closes. No em dashes. No generic phrases. Max 5 sentences.` }],
      });

      if (r.status !== 200) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Claude failed" }) };
      const text = r.body?.content?.find(b => b.type === "text")?.text || "";
      return { statusCode: 200, headers: h, body: JSON.stringify({ text }) };
    }

    // ── send-email ────────────────────────────────────────────────────────────
    if (action === "send-email") {
      const { to, subject, html, replyTo } = payload;
      const r = await postJSON("api.resend.com", "/emails", { "Authorization": `Bearer ${RESEND}` }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: Array.isArray(to) ? to : [to],
        reply_to: replyTo || undefined,
        subject, html,
      });
      if (r.status !== 200 && r.status !== 201) return { statusCode: 500, headers: h, body: JSON.stringify({ error: r.body }) };
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    // ── generate-and-send-audit ───────────────────────────────────────────────
    if (action === "generate-and-send-audit") {
      const { form, gap, secondary, answers, aiText, questions } = payload;
      if (!CLAUDE) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "API key missing" }) };

      const auditLog = (answers || []).map((a, i) => `${(questions || [])[i] || "Q" + i}: ${a}`).join("\n");
      const secList = (secondary || []).map(g => `${g.label}: ${g.tagline}`).join("\n");

      const prompt = `Write a premium brand audit report as a complete HTML email for ${form.name} at ${form.brand || "their brand"}.
Primary gap: ${gap.label} — ${gap.tagline}
What this gap is: ${gap.what}
Business impact: ${gap.business}
How it shows up: ${gap.shows_up}
How WAS solves it: ${gap.solve}
Secondary gaps: ${secList || "None"}
Personalized insight: ${aiText}
Quiz answers: ${auditLog}

Create a premium HTML email. Inline styles only. Max 680px centered.
1. Header: large W&S text (Georgia 56px bold), FREE BRAND GAP AUDIT subtitle
2. Greeting to ${form.name} with their personalized insight in italic Georgia
3. Dark block (#181818): gap label in Georgia 48px weight 300, tagline in white
4. Four #F7F7F7 sections: WHAT THIS GAP IS / WHAT IT'S COSTING YOU / WHERE YOU'RE FEELING IT / HOW WHITE AND SALT CLOSES THIS GAP
5. Secondary gaps if any
6. The WAS Process: Catch the Bug, Map the Gap, Design the Movement
7. Dark CTA block with pill button to https://www.whiteandsalt.com/contact
8. Footer: White and Salt · whiteandsalt.com · hello@whiteandsalt.com · San Diego CA
All text on dark backgrounds must be white. Return only complete HTML starting with <!DOCTYPE html>.`;

      const cr = await postJSON("api.anthropic.com", "/v1/messages", {
        "x-api-key": CLAUDE, "anthropic-version": "2023-06-01",
      }, {
        model: "claude-sonnet-4-20250514", max_tokens: 4000,
        system: "You are a senior brand strategist at White and Salt. Write premium brand audit reports in HTML with inline styles only.",
        messages: [{ role: "user", content: prompt }],
      });

      console.log("Claude status:", cr.status);
      if (cr.status !== 200) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Report generation failed", detail: cr.body }) };

      const htmlReport = cr.body?.content?.find(b => b.type === "text")?.text || "";
      if (!htmlReport) return { statusCode: 500, headers: h, body: JSON.stringify({ error: "Empty report" }) };

      console.log("Report generated:", htmlReport.length, "chars");

      await postJSON("api.resend.com", "/emails", { "Authorization": `Bearer ${RESEND}` }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: [form.email],
        subject: `Your Brand Gap Audit — ${gap.label}${form.brand ? " · " + form.brand : ""}`,
        html: htmlReport,
      });

      await postJSON("api.resend.com", "/emails", { "Authorization": `Bearer ${RESEND}` }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: ["hello@whiteandsalt.com"],
        reply_to: form.email,
        subject: `[Audit Sent] ${form.name} — ${gap.label}`,
        html: htmlReport,
      });

      console.log("Emails sent");
      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("Error:", err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
