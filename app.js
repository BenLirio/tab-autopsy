// Tab Autopsy — enter 6 open browser tabs, receive a coroner's report.
//
// Pipeline (decoder-shape, per KB/llm-proxy-usage):
//   1) User submits 6 free-typed tab titles.
//   2) Hash input; check localStorage cache. If hit → render immediately.
//   3) Call ef-ai-proxy (gpt-5.4-mini, temp=0, json_object, max_tokens=400) with
//      a system prompt locking the voice (dead-pan forensic coroner) and the
//      full 24-archetype catalog, permitting LLM-invented 25th if none fit.
//   4) Parse JSON strictly; on any failure, deterministic local fallback.
//   5) Encode 6 tab titles into #fragment (base64url JSON) via history.replaceState
//      so a friend opening the link re-runs the exact same autopsy.
//
// No retry loops. No chat affordances. No gradients. No generic 3-column grid.

const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
const SLUG = 'tab-autopsy';
const NUM_TABS = 6;
const CACHE_PREFIX = 'ta:v1:';

// ---------- 24-archetype catalog (the LLM may invent a 25th if none fits) ----------

const ARCHETYPES = [
  { name: "The 3AM Deep-Research Spiraler",         tag: "went looking for a dinner recipe, found the Byzantine Empire." },
  { name: "The Perpetual Recipe Bookmarker",        tag: "pinned 200 recipes, cooks the same three." },
  { name: "The Tab-Hoarding Academic",              tag: "22 PDFs open, unread, each one 'essential reading'." },
  { name: "The Parallel-Life Shopper",              tag: "window-shopping five realities simultaneously, buying none." },
  { name: "The Dormant Wikipedia Sage",             tag: "opened this article in 2024. forgot why. keeps it open anyway." },
  { name: "The Half-Watched-YouTube Archeologist",  tag: "leaves videos paused at 14:37 as bookmarks for future-self." },
  { name: "The Gmail Refresher-in-Chief",           tag: "unread count as emotional weather report." },
  { name: "The Doomscroll Forensic",                tag: "reading the news like it's a crime scene they can't leave." },
  { name: "The Real-Estate Dreamer",                tag: "touring houses in cities they will never move to." },
  { name: "The Productivity-App Window-Shopper",    tag: "every tab is a tool that will Finally Fix Things next Monday." },
  { name: "The Lore Completionist",                 tag: "watching a 3-hour recap to understand a 6-hour show." },
  { name: "The Comparison-Shopper Perfectionist",   tag: "12 price tabs for one $19 item." },
  { name: "The Emotional-Support Reddit Reader",    tag: "outsourcing every life decision to strangers with usernames." },
  { name: "The Multi-Tab Procrastinator",           tag: "every tab is a different way to avoid the one on the left." },
  { name: "The Fan-Wiki Cartographer",              tag: "three lore wikis, cross-referencing canon like a detective." },
  { name: "The Side-Hustle Reincarnator",           tag: "tonight: a new identity as an Etsy shop owner. by morning: gone." },
  { name: "The Grief-Adjacent Lurker",              tag: "reading the obituaries, the subreddit, the 2012 forum thread." },
  { name: "The Job-Board Fantasist",                tag: "applying in their head, never in the form." },
  { name: "The Forgotten-Cart Ghost",               tag: "three checkouts abandoned mid-shipping-address. the universe took note." },
  { name: "The LinkedIn Over-Reader",               tag: "studying strangers' career arcs like scripture." },
  { name: "The Niche-Forum Lurker",                 tag: "deep in a 2009 thread, reading the fifth reply from user 'flange42'." },
  { name: "The Nostalgia Archivist",                tag: "opened a thing from their past. cannot close it. will not close it." },
  { name: "The Self-Diagnosis Spiraler",            tag: "entered one symptom. emerged with six conditions and a new personality." },
  { name: "The Chaotic Browser Nomad",              tag: "six tabs, six unrelated rabbit holes, no through-line. the through-line is them." },
];

// A tiny set of genuinely-neutral fallbacks for the deterministic picker when
// nothing above scores well on the heuristic.
const DORMANT_FALLBACKS = [
  { name: "The Ambient Tab Parker",         tag: "opens tabs like leaving notes on a fridge. means to come back. sometimes does." },
  { name: "The Unfocused Polymath",         tag: "interested in everything at once, and therefore in nothing at once." },
  { name: "The Background-Noise Browser",   tag: "treats tabs like a radio left on — warmth, not attention." },
];

// ---------- utilities ----------

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function caseNumberFromTabs(tabs) {
  const h = hash(tabs.join("|"));
  // 6-digit case number, zero-padded
  return "CC-" + String(h % 1000000).padStart(6, "0");
}

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// base64url encode/decode of a JSON-serializable value. URL-safe, no padding.
function b64urlEncode(obj) {
  const json = JSON.stringify(obj);
  // UTF-8 safe encode
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  try {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

// ---------- deterministic local fallback (when LLM fails) ----------
//
// Picks an archetype by feature-matching the 6 tab titles against the catalog
// using simple keyword heuristics. Not "good"; good enough that no user is
// ever greeted with a blank UI. Same input → same output.

function pickLocalArchetype(tabs) {
  const joined = tabs.join(" | ").toLowerCase();

  const rules = [
    { match: /(recipe|cook|baking|serious eats|bon app|nyt cooking|allrecipes|ingredient)/, name: "The Perpetual Recipe Bookmarker" },
    { match: /(wiki|wikipedia|fandom|lore)/,                                                  name: "The Lore Completionist" },
    { match: /(gmail|inbox|unread|outlook|proton\s*mail)/,                                    name: "The Gmail Refresher-in-Chief" },
    { match: /(zillow|redfin|realtor|rightmove|apartments\.com|trulia|rent)/,                 name: "The Real-Estate Dreamer" },
    { match: /(reddit|r\/|ask(?:men|women|reddit)|aita|forum|thread)/,                        name: "The Emotional-Support Reddit Reader" },
    { match: /(linkedin|indeed|glassdoor|job|hiring|career)/,                                 name: "The Job-Board Fantasist" },
    { match: /(youtube|yt|twitch|vimeo)/,                                                     name: "The Half-Watched-YouTube Archeologist" },
    { match: /(amazon|etsy|ebay|shop|checkout|cart|wayfair|target|walmart)/,                  name: "The Comparison-Shopper Perfectionist" },
    { match: /(symptom|wikipedia.*(disease|disorder)|webmd|mayo\s*clinic|adhd|autism)/,       name: "The Self-Diagnosis Spiraler" },
    { match: /(arxiv|scholar|paper|pdf|\.pdf|dissertation|thesis|research\s+gate)/,           name: "The Tab-Hoarding Academic" },
    { match: /(news|bbc|nyt|times|guardian|politico|reuters|apnews|war|crisis)/,              name: "The Doomscroll Forensic" },
    { match: /(notion|todoist|obsidian|roam|logseq|evernote|productivity|habit)/,             name: "The Productivity-App Window-Shopper" },
    { match: /(etsy\s*shop|side\s*hustle|dropship|print\s*on\s*demand|shopify)/,              name: "The Side-Hustle Reincarnator" },
    { match: /(obituary|memorial|funeral|grief)/,                                             name: "The Grief-Adjacent Lurker" },
    { match: /(myspace|2007|2012|xanga|old\s*forum|geocities|nostalgia)/,                     name: "The Nostalgia Archivist" },
    { match: /(wiki|fandom)/,                                                                 name: "The Fan-Wiki Cartographer" },
  ];

  for (const r of rules) {
    if (r.match.test(joined)) {
      const a = ARCHETYPES.find(x => x.name === r.name);
      if (a) return a;
    }
  }
  // Nothing matched — deterministic chaotic nomad vs dormant fallback.
  const seed = hash(joined);
  const pool = [
    ARCHETYPES.find(x => x.name === "The Chaotic Browser Nomad"),
    ARCHETYPES.find(x => x.name === "The Multi-Tab Procrastinator"),
    ...DORMANT_FALLBACKS,
  ].filter(Boolean);
  return pool[seed % pool.length];
}

function buildLocalReport(tabs) {
  const archetype = pickLocalArchetype(tabs);
  const seed = hash(tabs.join("|"));

  // Generic, still-in-voice roast phrases — locally composed so each tab is
  // echoed verbatim. Deterministic by seed.
  const roastPhrases = [
    (t) => `specimen "${t}" — opened with intent, abandoned with vibes.`,
    (t) => `"${t}" was alive when submitted; barely.`,
    (t) => `"${t}" shows classic signs of being reloaded for comfort.`,
    (t) => `"${t}" has the look of a tab waiting to become a resolution.`,
    (t) => `"${t}" — a fine specimen, kept alive by denial.`,
    (t) => `"${t}" exhibits textbook open-and-ignore pathology.`,
    (t) => `"${t}" was promising, once.`,
    (t) => `"${t}" — filed under "intended to read, eventually."`,
  ];
  const tods = [
    "TIME OF DEATH: last Tuesday",
    "TIME OF DEATH: 14 minutes ago",
    "TIME OF DEATH: three refreshes back",
    "TIME OF DEATH: unknown",
    "TIME OF DEATH: the moment the next tab opened",
    "TIME OF DEATH: during a Slack ping",
    "TIME OF DEATH: never — still twitching",
    "TIME OF DEATH: 3AM, predictably",
  ];

  const tagsOut = tabs.map((t, i) => ({
    title: t,
    time_of_death: tods[(seed + i) % tods.length],
    roast: roastPhrases[(seed + i * 7) % roastPhrases.length](t),
  }));

  const modes = [
    "Dominant cognitive mode: open-loop accumulation without closure.",
    "Dominant cognitive mode: parallel half-lives, none committed.",
    "Dominant cognitive mode: research as avoidance, elegantly disguised.",
    "Dominant cognitive mode: decision deferred, tabs kept as evidence.",
    "Dominant cognitive mode: curiosity untethered from follow-through.",
  ];
  const prescriptions = [
    "Close three tabs. Do not negotiate with the fourth.",
    "Bookmark the guilt. Close the tab. Move on.",
    "Permit yourself to forget. The Wikipedia article will persist without you.",
    "One hour offline. Prognosis: uncomfortable, ultimately survivable.",
    "Schedule a funeral. Six tabs, single grave, no speeches.",
  ];

  return {
    archetype_name: archetype.name,
    dominant_mode: modes[seed % modes.length],
    tabs: tagsOut,
    prescription: prescriptions[seed % prescriptions.length],
    _tag: archetype.tag,
    _source: "local",
  };
}

// ---------- LLM call ----------

function buildMessages(tabs) {
  const catalog = ARCHETYPES.map(a => `  - ${a.name}: ${a.tag}`).join("\n");

  const system =
    `You are Dr. A. Tabsworth, Chief Coroner of the Digital Pathology Division. Voice: dead-pan forensic coroner who secretly judges the deceased's life choices. Clinical. Sparse. Mildly mean in a fond, literary way. Never warm. Never hopeful. Never "you got this." Never chatty. ` +
    `\n\nYou are given SIX open browser tabs submitted by a subject. You will produce a strict JSON autopsy report.\n\n` +
    `HARD RULES:\n` +
    `- Respond with ONLY a single JSON object. No markdown, no code fences, no preamble, no "here is your report:", no trailing questions, no "let me know if…", no "want me to…".\n` +
    `- Do NOT offer to refine, expand, or regenerate. The UI has no chat input.\n` +
    `- Each per-tab roast MUST quote the subject's tab title VERBATIM, character for character, inside double-quotes. No paraphrasing. No truncation. If the title is ugly or misspelled, that is the specimen.\n` +
    `- Pick ONE archetype. Use one of the 24 catalog names verbatim if any reasonably fits. If genuinely none fit, invent a new archetype in the same register (Title Case, 3–6 words, "The ___" form). Do NOT default to a generic catalog pick if the evidence clearly points elsewhere.\n` +
    `- Keep everything short. This is a toe-tag, not an essay.\n\n` +
    `24-ARCHETYPE CATALOG (select one verbatim if it fits; otherwise invent a 25th):\n${catalog}\n\n` +
    `STRICT JSON SCHEMA (return exactly these fields, nothing else):\n` +
    `{\n` +
    `  "archetype_name": string,                 // Title Case, 3–6 words, starts with "The "\n` +
    `  "dominant_mode": string,                  // ONE clinical line, ≤ 16 words, in the coroner's voice\n` +
    `  "tabs": [                                 // exactly 6 entries, in the same order as input\n` +
    `    {\n` +
    `      "title": string,                      // the tab title copied VERBATIM from input\n` +
    `      "time_of_death": string,              // ≤ 8 words, starts with "TIME OF DEATH:"\n` +
    `      "roast": string                       // ONE sentence ≤ 22 words, MUST include the tab title in double-quotes verbatim\n` +
    `    }\n` +
    `  ],\n` +
    `  "prescription": string                    // ONE line ≤ 18 words, imperative voice, no questions\n` +
    `}\n\n` +
    `TONE EXAMPLES (follow this register; do NOT reuse these lines):\n` +
    `- "specimen \\"gmail.com (27)\\" — chronic inbox anxiety, refreshed post-mortem. time of death: 14 minutes ago."\n` +
    `- "\\"Stardew Valley Wiki - Crops\\" displays textbook avoidance escalation."\n` +
    `- "prescription: close three. do not attend the funeral."\n\n` +
    `Do not break character. Do not ask questions. Return the JSON object only.`;

  const numbered = tabs.map((t, i) => `  Tab ${i + 1}: ${JSON.stringify(t)}`).join("\n");

  const user =
    `Subject submitted the following six (6) tabs for post-mortem examination. Examine.\n\n` +
    `${numbered}\n\n` +
    `Return only the JSON object.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function sanitizeAIReport(parsed, tabs) {
  if (!parsed || typeof parsed !== "object") return null;

  const archetype_name = typeof parsed.archetype_name === "string" ? parsed.archetype_name.trim() : "";
  const dominant_mode  = typeof parsed.dominant_mode  === "string" ? parsed.dominant_mode.trim()  : "";
  const prescription   = typeof parsed.prescription   === "string" ? parsed.prescription.trim()   : "";
  let tabsOut = Array.isArray(parsed.tabs) ? parsed.tabs : [];

  if (!archetype_name || !dominant_mode || !prescription) return null;
  if (tabsOut.length !== tabs.length) return null;

  const clean = [];
  for (let i = 0; i < tabs.length; i++) {
    const entry = tabsOut[i];
    if (!entry || typeof entry !== "object") return null;
    const title = typeof entry.title === "string" ? entry.title : "";
    const tod   = typeof entry.time_of_death === "string" ? entry.time_of_death.trim() : "";
    const roast = typeof entry.roast === "string" ? entry.roast.trim() : "";
    if (!tod || !roast) return null;
    // Force the title back to the user's verbatim input regardless of what the
    // LLM returned — this is the "inputs composed into the artifact" contract.
    clean.push({
      title: tabs[i],
      time_of_death: tod,
      roast,
    });
  }
  return {
    archetype_name,
    dominant_mode,
    tabs: clean,
    prescription,
    _source: "ai",
  };
}

async function fetchAIReport(tabs) {
  const messages = buildMessages(tabs);
  const res = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: SLUG,
      messages,
      model: "gpt-5.4-mini",
      max_tokens: 400,
      temperature: 0,
      response_format: "json_object",
    }),
  });
  if (!res.ok) throw new Error("http_" + res.status);
  const data = await res.json();
  const raw = (data && data.content) || "";
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  const clean = sanitizeAIReport(parsed, tabs);
  if (!clean) throw new Error("bad_ai_payload");
  return clean;
}

// ---------- cache (keyed by input hash) ----------

function cacheKey(tabs) {
  return CACHE_PREFIX + hash(tabs.join("|"));
}
function readCache(tabs) {
  try {
    const raw = localStorage.getItem(cacheKey(tabs));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function writeCache(tabs, report) {
  try { localStorage.setItem(cacheKey(tabs), JSON.stringify(report)); } catch (_) {}
}

// ---------- fragment state ----------

function encodeFragment(tabs) {
  return "#r=" + b64urlEncode(tabs);
}
function decodeFragment() {
  const frag = location.hash || "";
  const m = frag.match(/^#r=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const val = b64urlDecode(m[1]);
  if (!Array.isArray(val)) return null;
  if (val.length !== NUM_TABS) return null;
  for (const v of val) { if (typeof v !== "string") return null; }
  return val;
}
function stripFragment() {
  history.replaceState(null, "", location.pathname + location.search);
}

// ---------- DOM / flow ----------

const $ = (id) => document.getElementById(id);

function readTabs() {
  const tabs = [];
  for (let i = 1; i <= NUM_TABS; i++) {
    const el = $("tab-" + i);
    tabs.push((el && el.value ? el.value : "").trim());
  }
  return tabs;
}

function setTabs(tabs) {
  for (let i = 1; i <= NUM_TABS; i++) {
    const el = $("tab-" + i);
    if (el) el.value = tabs[i - 1] || "";
  }
}

function validateTabs(tabs) {
  const filled = tabs.filter(Boolean).length;
  if (filled < NUM_TABS) {
    return `the pathologist requires all six specimens. ${NUM_TABS - filled} still missing.`;
  }
  return null;
}

function showScreen(name) {
  ["intake", "loading", "result"].forEach(n => {
    const el = $(n);
    if (!el) return;
    el.classList.toggle("hidden", n !== name);
  });
  window.scrollTo(0, 0);
}

function renderIntakeCasePreview() {
  const el = $("intake-case");
  if (el) el.textContent = "PENDING";
}

function renderReport(tabs, report) {
  const caseNo = caseNumberFromTabs(tabs);
  $("case-no").textContent = caseNo;
  $("report-date").textContent = todayStr();
  $("archetype-name").textContent = report.archetype_name;
  $("dominant-mode").textContent = report.dominant_mode;
  $("prescription").textContent = report.prescription;

  const list = $("tag-list");
  list.innerHTML = "";
  report.tabs.forEach((t) => {
    const li = document.createElement("li");
    const title = document.createElement("p");
    title.className = "tag-title";
    title.textContent = t.title; // verbatim
    const tod = document.createElement("span");
    tod.className = "tag-tod";
    tod.textContent = t.time_of_death;
    const roast = document.createElement("p");
    roast.className = "tag-roast";
    roast.textContent = t.roast;
    li.appendChild(title);
    li.appendChild(tod);
    li.appendChild(roast);
    list.appendChild(li);
  });

  $("barcode-num").textContent = `// ${caseNo} // ${todayStr()} // filed`;
  showScreen("result");
}

async function runAutopsy(tabs, { updateFragment = true } = {}) {
  // Show loading state within 100ms.
  showScreen("loading");

  // Cache check (same 6 tabs never burn another call on re-open).
  const cached = readCache(tabs);
  if (cached) {
    // Minimum perceptible loading time so the report feels examined.
    await new Promise(r => setTimeout(r, 350));
    if (updateFragment) history.replaceState(null, "", encodeFragment(tabs));
    renderReport(tabs, cached);
    return;
  }

  const minDelay = new Promise(r => setTimeout(r, 900));
  let report;
  try {
    const [ai] = await Promise.all([fetchAIReport(tabs), minDelay]);
    report = ai;
  } catch (_) {
    await minDelay;
    report = buildLocalReport(tabs);
    report._fallback_note = "the pathologist is unavailable — filing manually.";
  }

  writeCache(tabs, report);
  if (updateFragment) history.replaceState(null, "", encodeFragment(tabs));
  renderReport(tabs, report);
}

function onSubmit(e) {
  e.preventDefault();
  const tabs = readTabs();
  const err = validateTabs(tabs);
  const errEl = $("intake-error");
  if (err) {
    errEl.textContent = err;
    errEl.classList.remove("hidden");
    return;
  }
  errEl.classList.add("hidden");
  runAutopsy(tabs);
}

function onReset() {
  stripFragment();
  // Clear inputs and return to intake.
  setTabs(["", "", "", "", "", ""]);
  $("intake-error").classList.add("hidden");
  renderIntakeCasePreview();
  showScreen("intake");
}

// Share: prefer navigator.share with URL containing the #fragment; fallback to clipboard.
function share() {
  const archetype = ($("archetype-name") && $("archetype-name").textContent) || "";
  const url = location.href;
  const text = archetype
    ? `Tab Autopsy diagnosed me as: ${archetype}. what are your six tabs?`
    : `Tab Autopsy — a forensic report on your browser tabs.`;
  if (navigator.share) {
    navigator.share({ title: document.title, text, url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(`${text} ${url}`)
      .then(() => alert("link copied — paste it anywhere."))
      .catch(() => alert(url));
  } else {
    alert(url);
  }
}
window.share = share;

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  renderIntakeCasePreview();

  const form = $("intake-form");
  if (form) form.addEventListener("submit", onSubmit);
  const resetBtn = $("reset-btn");
  if (resetBtn) resetBtn.addEventListener("click", onReset);

  // Deep-link replay: if URL has a valid #r=... fragment, pre-fill and run.
  const fromFragment = decodeFragment();
  if (fromFragment) {
    setTabs(fromFragment);
    // Do not overwrite the incoming fragment — it is already correct.
    runAutopsy(fromFragment, { updateFragment: false });
  }
});
