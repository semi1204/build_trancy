const DEFAULTS = {
  endpoint: "http://127.0.0.1:8787",
  target: "Korean",
  prefer: "en",
  fontSize: 22,
  showOriginal: true,
  showTranslation: true,
  autoStart: true,
  origColor: "#ffffff",
  transColor: "#ffe27a",
};

const TEXT = ["endpoint", "target", "prefer", "origColor", "transColor"];
const NUM = ["fontSize"];
const BOOL = ["showOriginal", "showTranslation", "autoStart"];

async function load() {
  const c = { ...DEFAULTS, ...(await browser.storage.local.get(Object.keys(DEFAULTS))) };
  for (const k of [...TEXT, ...NUM]) document.getElementById(k).value = c[k];
  for (const k of BOOL) document.getElementById(k).checked = c[k];
}

document.getElementById("save").addEventListener("click", async () => {
  const out = {};
  for (const k of TEXT) out[k] = document.getElementById(k).value.trim();
  for (const k of NUM) out[k] = Number(document.getElementById(k).value) || DEFAULTS[k];
  for (const k of BOOL) out[k] = document.getElementById(k).checked;

  out.endpoint = out.endpoint.replace(/\/+$/, "") || DEFAULTS.endpoint;
  out.target = out.target || DEFAULTS.target;

  await browser.storage.local.set(out);
  const tag = document.getElementById("saved");
  tag.classList.add("on");
  setTimeout(() => tag.classList.remove("on"), 1400);
});

load();
