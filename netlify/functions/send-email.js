const https = require("https");

function postJSON(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
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
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };
  }

  const RESEND_KEY = "re_jfRWDZ2n_8FT7b9YmbEXwZjwFyi18eovv";
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;

    // ── send-email: sends a pre-built HTML email via Resend ──────────────────
    if (action === "send-email") {
      const { to, subject, html, replyTo } = payload;

      const result = await postJSON("api.resend.com", "/emails", {
        "Authorization": `Bearer ${RESEND_KEY}`,
      }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: Array.isArray(to) ? to : [to],
        reply_to: replyTo || undefined,
        subject,
        html,
      });

      if (result.status !== 200 && result.status !== 201) {
        console.error("Resend error:", result.body);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: result.body }) };
      }

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
    }

    // ── generate-and-send-audit: generates report via Claude then emails it ──
    if (action === "generate-and-send-audit") {
      const { form, gap, secondary, answers, siteCtx, aiText, questions } = payload;

      if (!ANTHROPIC_KEY) {
        console.error("ANTHROPIC_API_KEY not set");
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "API key not configured" }) };
      }

      const auditLog = (answers || []).map((a, i) =>
        `${(questions || [])[i] || "Q" + i}: ${a || "skipped"}`
      ).join("\n");

      const siteNote = siteCtx
        ? `Website: ${form.url}. Industry: ${siteCtx.industry}. Type: ${siteCtx.businessType}. Offering: ${siteCtx.keyOffering}.`
        : "No website provided.";

      const secList = (secondary || []).map(g => `${g.label}: ${g.tagline}`).join("\n");

      const prompt = `Generate a complete HTML brand audit report email for ${form.name} at ${form.brand || "their brand"}.

Primary gap: ${gap.label}
Tagline: ${gap.tagline}
What this gap is: ${gap.what}
Business impact: ${gap.business}
How it shows up: ${gap.shows_up}
How WAS solves it: ${gap.solve}
Secondary gaps: ${secList || "None"}
Personalized insight: ${aiText}
${siteNote}

Quiz answers:
${auditLog}

Create a premium HTML email with inline styles only. Max width 680px centered. Structure:
1. Header: "W&S" in large bold Georgia serif (56px, weight 900), "FREE BRAND GAP AUDIT" in small caps below, thin divider
2. "Hi ${form.name}," greeting, then the personalized insight in italic Georgia text
3. Dark block (#181818 background, white text): gap label in large Georgia serif (48px weight 300), tagline below in white
4. Four sections on #F7F7F7 background with generous padding: WHAT THIS GAP IS / WHAT IT'S COSTING YOU / WHERE YOU'RE FEELING IT / HOW WHITE AND SALT CLOSES THIS GAP
5. Secondary gaps if any
6. Process overview: Catch the Bug, Map the Gap, Design the Movement
7. Dark CTA block: "Ready to close it?" heading, pill button linking to https://www.whiteandsalt.com/contact
8. Footer: White and Salt · whiteandsalt.com · hello@whiteandsalt.com · San Diego CA

All text on dark backgrounds must be white or rgba(255,255,255,0.75). Body text #626161. Headings #181818. Return only complete HTML starting with <!DOCTYPE html>.`;

      const claudeResult = await postJSON("api.anthropic.com", "/v1/messages", {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      }, {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: "You are a senior brand strategist at White and Salt. Write premium brand audit reports in HTML with inline styles only. No external resources. Make it feel like a $50K agency deliverable.",
        messages: [{ role: "user", content: prompt }],
      });

      const htmlReport = claudeResult.body?.content?.find(b => b.type === "text")?.text || "";

      if (!htmlReport) {
        console.error("Claude returned no content:", claudeResult.body);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Report generation failed" }) };
      }

      // Send to client
      await postJSON("api.resend.com", "/emails", {
        "Authorization": `Bearer ${RESEND_KEY}`,
      }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: [form.email],
        subject: `Your Brand Gap Audit — ${gap.label}${form.brand ? " · " + form.brand : ""}`,
        html: htmlReport,
      });

      // BCC to studio
      await postJSON("api.resend.com", "/emails", {
        "Authorization": `Bearer ${RESEND_KEY}`,
      }, {
        from: "White and Salt <hello@whiteandsalt.com>",
        to: ["hello@whiteandsalt.com"],
        reply_to: form.email,
        subject: `[Audit Sent] ${form.name} — ${gap.label}`,
        html: htmlReport,
      });

      console.log("Audit report sent to", form.email);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
