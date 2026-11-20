import { getStore } from "@netlify/blobs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-key",
  "access-control-max-age": "86400",
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const S = (v, n) => String(v == null ? "" : v).slice(0, n);
const STATUSES = ["አዲስ", "በሂደት", "ተልኳል", "ተጠናቋል", "ተሰርዟል"];
const ID = /^[A-Za-z0-9]{3,24}$/;

function cleanGeo(g) {
  return g && isFinite(+g.la) && isFinite(+g.lo) ? { la: +g.la, lo: +g.lo } : null;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const store = getStore({ name: "shop", consistency: "strong" });

  async function admin(claim) {
    const k = req.headers.get("x-admin-key") || "";
    if (k.length < 12) return false;
    if (process.env.ADMIN_KEY) return k === process.env.ADMIN_KEY;
    const saved = await store.get("adminkey");
    if (!saved) {
      if (!claim) return false;
      await store.set("adminkey", k);
      return true;
    }
    return saved === k;
  }

  try {
    if (path === "/ping" && req.method === "GET") {
      return J({ ok: true, claimed: !!(process.env.ADMIN_KEY || (await store.get("adminkey"))) });
    }

    if (path === "/catalog" && req.method === "GET") {
      const c = await store.get("catalog", { type: "json" });
      return J(c || { v: 1, cfg: {}, products: [] });
    }

    if (path === "/catalog" && req.method === "PUT") {
      if (!(await admin(true))) return J({ error: "forbidden" }, 403);
      const text = await req.text();
      if (text.length > 5000000) return J({ error: "too large" }, 413);
      let b;
      try { b = JSON.parse(text); } catch { return J({ error: "bad json" }, 400); }
      if (!b || !Array.isArray(b.products) || b.products.length > 500) return J({ error: "bad catalog" }, 400);
      await store.setJSON("catalog", { v: 1, t: Date.now(), cfg: b.cfg && typeof b.cfg === "object" ? b.cfg : {}, products: b.products });
      return J({ ok: true, count: b.products.length });
    }

    if (path === "/orders" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 30000) return J({ error: "too large" }, 413);
      let b;
      try { b = JSON.parse(text); } catch { return J({ error: "bad json" }, 400); }
      if (!b || typeof b !== "object") return J({ error: "bad order" }, 400);
      const id = ID.test(b.id || "") ? b.id.toUpperCase() : Date.now().toString(36).toUpperCase();
      const o = { id, d: new Date().toISOString(), s: STATUSES[0], kind: b.kind === "delivery" ? "delivery" : "order", n: S(b.n, 80), e: S(b.e, 100), ph: S(b.ph, 30) };
      if (o.kind === "delivery") {
        o.from = { a: S(b.from && b.from.a, 200), g: cleanGeo(b.from && b.from.g) };
        o.to = { a: S(b.to && b.to.a, 200), g: cleanGeo(b.to && b.to.g) };
        o.rcv = S(b.rcv, 80);
        o.item = S(b.item, 200);
      } else {
        o.its = (Array.isArray(b.its) ? b.its : []).slice(0, 40).map((i) => ({ n: S(i && i.n, 120), c: Math.max(0, Math.min(999, +(i && i.c) || 0)), p: +(i && i.p) || 0 }));
        o.tot = +b.tot || 0;
        o.m = S(b.m, 40);
        o.r = S(b.r, 60);
        o.dl = b.dl && typeof b.dl === "object" ? { a: S(b.dl.a, 200), g: cleanGeo(b.dl.g), f: +b.dl.f || 0 } : null;
      }
      await store.setJSON("orders/" + id, o);
      return J({ ok: true, id });
    }

    if (path === "/orders" && req.method === "GET") {
      if (!(await admin(false))) return J({ error: "forbidden" }, 403);
      const { blobs } = await store.list({ prefix: "orders/" });
      const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
      const orders = all.filter(Boolean).sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 200);
      return J({ orders });
    }

    const m = path.match(/^\/orders\/([A-Za-z0-9]{3,24})$/);
    if (m && req.method === "PATCH") {
      if (!(await admin(false))) return J({ error: "forbidden" }, 403);
      const key = "orders/" + m[1].toUpperCase();
      const o = await store.get(key, { type: "json" });
      if (!o) return J({ error: "not found" }, 404);
      let b;
      try { b = await req.json(); } catch { return J({ error: "bad json" }, 400); }
      if (!STATUSES.includes(b && b.s)) return J({ error: "bad status" }, 400);
      o.s = b.s;
      await store.setJSON(key, o);
      return J({ ok: true });
    }

    if (path === "/status" && req.method === "GET") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => ID.test(x)).slice(0, 30);
      const out = {};
      await Promise.all(ids.map(async (id) => {
        const o = await store.get("orders/" + id.toUpperCase(), { type: "json" });
        if (o) out[id] = o.s;
      }));
      return J(out);
    }

    return J({ error: "not found" }, 404);
  } catch (e) {
    return J({ error: "server error" }, 500);
  }
};

export const config = { path: "/api/*" };
