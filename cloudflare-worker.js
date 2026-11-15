/*
 * Cloudflare Worker: secure Gemini proxy for the EPUB reader.
 *
 * Required Worker settings:
 *   Secret: GEMINI_API_KEY = your Google AI Studio API key
 *   Secret: OPENAI_API_KEY = your OpenAI project API key (fallback)
 *   Variable: ALLOWED_ORIGIN = https://peeratsss.github.io
 *
 * Deploy this file as the Worker entry point. Do not put the Gemini key in
 * this file, GitHub, or the browser. Add a Cloudflare rate-limiting rule to
 * this Worker route before sharing the site publicly.
 */
const MODEL = "gemini-3.8-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin"
    }
  });
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://peeratsss.github.io";
    const origin = request.headers.get("Origin") || "";
    if (origin !== allowedOrigin) return new Response("Forbidden", { status: 403 });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, allowedOrigin);
    if (!env.GEMINI_API_KEY) return json({ error: "Worker secret GEMINI_API_KEY is not configured." }, 500, allowedOrigin);

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 5000) return json({ error: "Request is too large." }, 413, allowedOrigin);

    let input;
    try { input = await request.json(); }
    catch { return json({ error: "Invalid JSON request." }, 400, allowedOrigin); }

    const word = typeof input.word === "string" ? input.word.trim() : "";
    const context = typeof input.context === "string" ? input.context.trim() : word;
    if (!word || word.length > 100 || context.length > 1000) {
      return json({ error: "A term (up to 100 characters) and context (up to 1,000 characters) are required." }, 400, allowedOrigin);
    }

    const prompt = `Analyze the term "${word}" in the context: "${context || word}".

Use Google Search to verify etymological and medical claims. Focus on etymology as the AI-generated part, and distinguish historically attested origins from modern textbook word-part analysis. Never invent roots or claim certainty where the origin is disputed. If no reliable etymology can be verified, say so clearly.

If this is a medical, anatomical, biological, pharmacological, or medico-legal term, use exactly these six sections:
1. ROOTS — exact prefixes, roots, suffixes; source language (Greek, Latin, Old English, etc.); original meanings. Distinguish true historical etymology from educational word-part segmentation.
2. LITERAL MEANING — direct word-for-word meaning of the components, noting when a literal translation is approximate.
3. ROOT USES — high-yield clinical cognates using the same roots or affixes, with brief meanings.
4. FULL WORD — accurate clinical definition, anatomy/pathophysiology or medico-legal significance at PNLE/NCLEX level.
5. DIFFERENTIAL COMPARISON — compare with closely related concepts; use a compact table when useful.
6. DISTINGUISHED FROM — commonly confused look-alike or sound-alike terms and their differences.

If this is not a medical term, use a concise equivalent: ROOTS & ORIGIN, ORIGINAL/LITERAL MEANING, HISTORICAL DEVELOPMENT, MODERN MEANING, and RELATED WORDS. Do not force medical sections onto ordinary words.

Be rigorous and concise. Do not blindly agree with a presumed root breakdown. Include source URLs or source names at the end when available. This is educational information, not a diagnosis or substitute for clinical references.`;

    try {
      const upstream = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: MODEL,
          input: prompt,
          tools: [{ type: "google_search" }],
          store: false
        })
      });
      const geminiData = await upstream.json().catch(() => ({}));

      // Only switch providers for quota/rate-limit or temporary Gemini capacity errors.
      const geminiErrorText = JSON.stringify(geminiData.error || geminiData).toLowerCase();
      const useFallback = [429, 503, 529].includes(upstream.status) ||
        /resource_exhausted|quota|rate.?limit|too many requests|overloaded|capacity/.test(geminiErrorText);

      if (!useFallback) return json(geminiData, upstream.status, allowedOrigin);

      if (!env.OPENAI_API_KEY) {
        return json({
          error: {
            message: "Gemini has reached its quota or temporary capacity limit. Add the OPENAI_API_KEY secret to this Worker to enable automatic fallback.",
            provider: "Gemini",
            fallbackConfigured: false
          }
        }, 503, allowedOrigin);
      }

      const fallback = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: "gpt-6-astra",
          tools: [{ type: "web_search" }],
          input: prompt
        })
      });
      const fallbackData = await fallback.json().catch(() => ({}));
      if (!fallback.ok) {
        const message = fallbackData.error?.message || "OpenAI fallback request failed (" + fallback.status + ").";
        return json({
          error: {
            message: "Gemini is unavailable (" + upstream.status + ") and OpenAI fallback failed: " + message,
            provider: "OpenAI",
            fallbackConfigured: true
          }
        }, fallback.status, allowedOrigin);
      }

      const output = Array.isArray(fallbackData.output) ? fallbackData.output : [];
      const messages = output.filter(item => item.type === "message");
      const content = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
      const text = content.filter(item => item.type === "output_text" && item.text)
        .map(item => item.text).join("\\n");
      if (!text) {
        return json({
          error: { message: "OpenAI fallback returned no text. Please try again.", provider: "OpenAI" }
        }, 502, allowedOrigin);
      }
      const annotations = content.flatMap(item => Array.isArray(item.annotations) ? item.annotations : [])
        .filter(item => item.url)
        .map(item => ({ title: item.title || "Source", url: item.url }));

      return json({
        output_text: text,
        outputs: [{ type: "text", text, annotations }],
        provider: "OpenAI",
        fallback: true
      }, 200, allowedOrigin);
    } catch (error) {
      return json({ error: { message: "Could not reach the AI providers. Please try again." } }, 502, allowedOrigin);
    }
  }
};
