import { Router } from "express";
const router = Router();
const B = "crm-contracts";
const base = () => `${process.env.SUPABASE_URL}/storage/v1`;
const h = () => ({ Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: String(process.env.SUPABASE_SERVICE_ROLE_KEY), "Content-Type": "application/json" });
const cid = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error("bad id"); return n; };

router.get("/investors/:id/contract", async (req, res): Promise<any> => {
  try {
    const id = cid(req.params.id);
    const r = await fetch(`${base()}/object/list/${B}`, { method: "POST", headers: h(), body: JSON.stringify({ prefix: `${id}/`, limit: 20, sortBy: { column: "created_at", order: "desc" } }) });
    const files = ((await r.json()) as any[]).filter(f => f?.name && f.id);
    if (!files.length) return res.json({ contract: null });
    const f = files[0];
    const s = await fetch(`${base()}/object/sign/${B}/${id}/${encodeURIComponent(f.name)}`, { method: "POST", headers: h(), body: JSON.stringify({ expiresIn: 3600 }) });
    const sj: any = await s.json();
    res.json({ contract: { name: f.name.replace(/^\d+-/, ""), url: `${base()}${sj.signedURL}` } });
  } catch (e) { res.status(500).json({ error: "Contract lookup failed" }); }
});

router.post("/investors/:id/contract/upload-url", async (req, res): Promise<any> => {
  try {
    const id = cid(req.params.id);
    const name = String(req.body?.filename || "contract.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
    const path = `${id}/${Date.now()}-${name}`;
    const r = await fetch(`${base()}/object/upload/sign/${B}/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", headers: h(), body: "{}" });
    const j: any = await r.json();
    if (!j.url) return res.status(500).json({ error: "Could not create upload URL" });
    res.json({ uploadUrl: `${base()}${j.url}` });
  } catch { res.status(500).json({ error: "Upload URL failed" }); }
});
export default router;
