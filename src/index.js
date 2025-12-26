export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/haremaltin") return handleHaremAltin(ctx);
    if (url.pathname === "/tcmb") return handleTCMB(ctx);

    return new Response(
      JSON.stringify({ ok: false, routes: ["/haremaltin", "/tcmb"] }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
};

async function handleHaremAltin(ctx) {
  const TARGET = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/haremaltin");

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    if (cachedAt && Date.now() - Number(cachedAt) < 10_000) return cached;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4500);

  try {
    const upstream = await fetch(TARGET, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://canlipiyasalar.haremaltin.com/"
      }
    });

    if (!upstream.ok) {
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "Upstream failed", status: upstream.status });
    }

    const res = new Response(upstream.body, upstream);
    res.headers.set("Content-Type", "application/json; charset=utf-8");
    res.headers.set("Cache-Control", "public, max-age=5");
    res.headers.set("X-Cached-At", Date.now().toString());

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "Fetch error", detail: String(e) });
  } finally {
    clearTimeout(t);
  }
}

async function handleTCMB(ctx) {
  const TARGET = "https://www.tcmb.gov.tr/kurlar/today.xml";
  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/tcmb-today");

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedAt = cached.headers.get("X-Cached-At");
    if (cachedAt && Date.now() - Number(cachedAt) < 60_000) return cached;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4500);

  try {
    const upstream = await fetch(TARGET, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.tcmb.gov.tr/"
      }
    });

    if (!upstream.ok) {
      if (cached) return cached;
      return jsonErr(502, { ok: false, error: "TCMB upstream failed", status: upstream.status });
    }

    const xmlText = await upstream.text();
    const data = tcmbXmlToJson(xmlText);

    const res = new Response(JSON.stringify({ ok: true, source: "tcmb", data }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
        "X-Cached-At": Date.now().toString()
      }
    });

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    if (cached) return cached;
    return jsonErr(502, { ok: false, error: "TCMB fetch error", detail: String(e) });
  } finally {
    clearTimeout(t);
  }
}

function tcmbXmlToJson(xmlText) {
  const dateMatch = xmlText.match(/<Tarih_Date[^>]*Tarih="([^"]+)"/i);
  const date = dateMatch ? dateMatch[1] : null;

  const currencies = {};
  const blocks = xmlText.match(/<Currency[\s\S]*?<\/Currency>/gi) || [];

  for (const block of blocks) {
    const code = pickAttr(block, "CurrencyCode") || pickAttr(block, "Kod");
    if (!code) continue;

    currencies[code] = {
      code,
      unit: numOrNull(pickTag(block, "Unit")),
      name_tr: pickTag(block, "Isim") || null,
      name_en: pickTag(block, "CurrencyName") || null,
      forex_buying: numOrNull(pickTag(block, "ForexBuying")),
      forex_selling: numOrNull(pickTag(block, "ForexSelling")),
      banknote_buying: numOrNull(pickTag(block, "BanknoteBuying")),
      banknote_selling: numOrNull(pickTag(block, "BanknoteSelling")),
      cross_usd: numOrNull(pickTag(block, "CrossRateUSD")),
      cross_other: numOrNull(pickTag(block, "CrossRateOther"))
    };
  }

  return { date, currencies };
}

function pickAttr(xml, attrName) {
  const m = xml.match(new RegExp(`${attrName}="([^"]+)"`, "i"));
  return m ? m[1] : null;
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function decodeXmlEntities(s) {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : null;
}

function jsonErr(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
