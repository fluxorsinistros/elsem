// Edge Function: recebe o formulário "Quero falar com a ELSEM" e envia o aviso por e-mail via Resend.
// Variáveis de ambiente (definidas como secrets no Supabase):
//   RESEND_API_KEY  - chave da API do Resend
//   CONTACT_TO      - e-mail que recebe os avisos (ex.: elsem.risk@gmail.com)
//   CONTACT_FROM    - remetente verificado no Resend (ex.: "ELSEM Site <contato@mail.elsem.com.br>")

const ALLOWED_ORIGINS = ["https://www.elsem.com.br", "https://elsem.com.br", "http://localhost:8080"];
const MAX = { nome: 120, email: 160, empresa: 120, telefone: 30, cargo: 120, interesse: 40, mensagem: 2000 };

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});

const json = (status: number, body: unknown, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Limite por IP: no máximo 3 envios a cada 10 minutos (memória desta instância).
const hits = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 3;
const clientIp = (req: Request) =>
  (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
const overLimit = (ip: string) => {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > LIMIT;
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);
  if (overLimit(clientIp(req))) return json(429, { error: "too_many_requests" }, origin);

  let data: Record<string, unknown>;
  try { data = await req.json(); } catch { return json(400, { error: "invalid_json" }, origin); }

  // Campo "website" é oculto no formulário: se vier preenchido, é robô. Finge sucesso e não envia.
  if (String(data.website ?? "").trim()) return json(200, { ok: true }, origin);

  // hCaptcha: o token do widget é validado no servidor antes de qualquer envio.
  const hcSecret = Deno.env.get("HCAPTCHA_SECRET_KEY");
  if (!hcSecret) return json(500, { error: "not_configured" }, origin);
  const token = String(data["h-captcha-response"] ?? "");
  if (!token) return json(422, { error: "captcha_required" }, origin);
  const hc = await fetch("https://api.hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: hcSecret, response: token, remoteip: clientIp(req) }),
  });
  const hcResult = await hc.json().catch(() => ({ success: false }));
  if (!hcResult.success) return json(422, { error: "captcha_failed" }, origin);

  const f: Record<string, string> = {};
  for (const [key, max] of Object.entries(MAX)) {
    const v = String(data[key] ?? "").trim();
    if (key !== "mensagem" && key !== "telefone" && key !== "cargo" && key !== "empresa" && !v) {
      return json(422, { error: "missing_field", field: key }, origin);
    }
    if (v.length > max) return json(422, { error: "too_long", field: key }, origin);
    f[key] = v;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return json(422, { error: "invalid_email" }, origin);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("CONTACT_TO");
  const from = Deno.env.get("CONTACT_FROM");
  if (!apiKey || !to || !from) return json(500, { error: "not_configured" }, origin);

  const rows: [string, string][] = [
    ["Nome", f.nome], ["E-mail", f.email], ["Empresa", f.empresa], ["Telefone", f.telefone],
    ["Cargo", f.cargo], ["Interesse", f.interesse], ["Mensagem", f.mensagem || "—"],
  ];
  const html = `<div style="font-family:Arial,sans-serif;color:#0B1220">
    <h2 style="margin:0 0 12px">Novo contato pelo site ELSEM</h2>
    <table cellpadding="6" style="border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="color:#5B6B82;vertical-align:top">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
    </table></div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: f.email,
      subject: `Novo contato: ${f.nome}${f.empresa ? " · " + f.empresa : ""} (${f.interesse})`,
      html,
    }),
  });
  if (!res.ok) return json(502, { error: "mail_failed" }, origin);

  return json(200, { ok: true }, origin);
});
