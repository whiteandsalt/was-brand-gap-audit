
Copy

// Netlify serverless function — handles all email sending AND audit report generation
// Runs server-side so Resend and Anthropic API calls work correctly
 
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }
 
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
 
  const RESEND_KEY = "re_jfRWDZ2n_8FT7b9YmbEXwZjwFyi18eovv";
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
 
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
 
  try {
    const payload = JSON.parse(event.body);
    const { action } = payload;
 
    // ── ACTION: generate-and-send-audit ───────────────────────────────────────
    // Generates the full audit report via Claude then emails it to the client
    if (action === "generate-and-send-audit") {
      const { form, gap, secondary, answers, siteCtx, aiText, questions } = payload;
 
      const auditLog = answers.map((a, i) =>
        `${questions[i]}: ${a || "skipped"}`
      ).join("\n");
 
      const siteNote = siteCtx
        ? `Website: ${form.url}. Industry: ${siteCtx.industry}. Type: ${siteCtx.businessType}. Offering: ${siteCtx.keyOffering}. Maturity: ${siteCtx.brandMaturity}.`
        : "No website provided.";
 
      const secGapsList = secondary.map(g => `${g.label}: ${g.tagline}`).join("\n");
 
      // Generate report via Claude
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: `You are a senior brand strategist at White and Salt, a boutique branding agency. You are writing a premium brand audit report delivered via email. It should feel like a real agency deliverable — specific, insightful, beautifully formatted. Use HTML with inline styles only. No external resources.`,
          messages: [{
            role: "user",
            content: `Generate a complete HTML brand audit report for ${form.name} at ${form.brand || "their brand"}.
 
Primary gap: ${gap.label}
Tagline: ${gap.tagline}
What the gap is: ${gap.what}
Business impact: ${gap.business}
How it shows up: ${gap.shows_up}
How WAS solves it: ${gap.solve}
Secondary gaps: ${secGapsList || "None"}
Personalized insight: ${aiText}
${siteNote}
 
Quiz answers:
${auditLog}
 
Create a complete HTML email. Requirements:
 
STRUCTURE:
1. Header: large "W&S" text (Georgia serif, 56px, font-weight 900, color #181818), "FREE BRAND GAP AUDIT" below in small caps, thin divider
2. Greeting: "Hi ${form.name}," then the personalized insight in larger italic Georgia text
3. Primary result: dark block (#181818 background, white text), gap label in large Georgia serif (52px, weight 300), tagline below
4. Four sections on #F7F7F7: "WHAT THIS GAP IS", "WHAT IT'S COSTING YOU", "WHERE YOU'RE FEELING IT", "HOW WHITE AND SALT CLOSES THIS GAP" — each with full copy
5. If secondary gaps exist, brief section for each
6. Process: three phases (Catch the Bug / Map the Gap / Design the Movement) with gap mapped to phase
7. CTA block: dark background, "Ready to close it?" heading, link button to https://www.whiteandsalt.com/contact styled as pill button
8. Footer: small gray text — White and Salt · whiteandsalt.com · hello@whiteandsalt.com · San Diego, CA
 
DESIGN (inline styles only, max-width 680px centered):
- Georgia serif for all headings, Arial sans-serif for body
- Body text: 15px, line-height 1.8, color #626161
- Section labels: 10px, uppercase, letter-spacing 2px, color #626161
- Dark sections: background #181818, all text white or rgba(255,255,255,0.75)
- CTA button: background #181818, color white, padding 14px 40px, border-radius 100px, no underline, 12px uppercase
- Generous padding 40px-60px per section
- Dividers: 1px solid #E8E8E8
 
Return only complete HTML starting with <!DOCTYPE html>. No explanation.`,
          }],
        }),
      });
 
      const claudeData = await claudeRes.json();
      const htmlReport = claudeData.content?.find(b => b.type === "text")?.text || "";
 
      if (!htmlReport) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Report generation failed" }) };
      }
 
      // Send to client
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "White and Salt <hello@whiteandsalt.com>",
          to: [form.email],
          subject: `Your Brand Gap Audit — ${gap.label}${form.brand ? " · " + form.brand : ""}`,
          html: htmlReport,
        }),
      });
 
      // BCC copy to studio
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "White and Salt <hello@whiteandsalt.com>",
          to: ["hello@whiteandsalt.com"],
          reply_to: form.email,
          subject: `[Audit Sent] ${form.name} — ${gap.label}`,
          html: htmlReport,
        }),
      });
 
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
 
    // ── ACTION: send-email (inquiry + discovery form) ─────────────────────────
    if (action === "send-email") {
      const { to, subject, html, replyTo } = payload;
 
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "White and Salt <hello@whiteandsalt.com>",
          to: Array.isArray(to) ? to : [to],
          reply_to: replyTo || undefined,
          subject,
          html,
        }),
      });
 
      const data = await res.json();
      if (!res.ok) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: data }) };
      }
 
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
 
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };
 
  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
