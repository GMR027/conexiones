// Vista de Conexiones. Todo el texto se inserta con textContent / nodos DOM: nunca como HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const SVG = "http://www.w3.org/2000/svg";
  let state;
  const saved = vscode.getState() || {};
  let tab = saved.tab || "assistant";
  let resTab = saved.resTab || "icons";
  /** Lo escrito en los campos, para no perderlo al repintar. */
  const ui = { question: "", url: "", name: "", tags: "", key: "", header: "", libQuery: "", pkgQuery: "", iconQuery: "", iconStyle: "", photoQuery: "", photoProvider: "", imgFilters: {}, fontQuery: "", fontCategory: "", fontPick: null, picked: null, openSource: null, ...(saved.ui || {}) };
  const persist = () => vscode.setState({ tab, resTab, ui: { question: ui.question, url: ui.url, libQuery: ui.libQuery, pkgQuery: ui.pkgQuery, iconQuery: ui.iconQuery, photoQuery: ui.photoQuery, photoProvider: ui.photoProvider, imgFilters: ui.imgFilters, fontQuery: ui.fontQuery, fontCategory: ui.fontCategory } });

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === false || v === null) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : String(kid));
    return node;
  }
  const send = (msg) => vscode.postMessage(msg);
  const btn = (label, onclick, cls, extra) => h("button", { class: cls || "link", type: "button", onclick, ...(extra || {}) }, label);
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const ago = (t) => {
    if (!t) return "nunca";
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "ahora" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
  };
  const KIND = { docs: "Documentación", registry: "Paquetes", icons: "Iconos", fonts: "Fuentes", images: "Imágenes", mcp: "MCP" };

  function field(id, label, value, onInput, attrs) {
    const input = h(attrs && attrs.rows ? "textarea" : "input", { id, type: "text", autocomplete: "off", spellcheck: "false", ...(attrs || {}) });
    input.value = value || "";
    input.addEventListener("input", (e) => onInput(e.target.value));
    return h("label", { class: "field", for: id }, h("span", {}, label), input);
  }

  // --- Mini Markdown seguro (respuestas de la IA) ------------------------------------------------
  function inline(text) {
    const out = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[(\d{1,2})\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] !== undefined) out.push(h("code", {}, m[1]));
      else if (m[2] !== undefined) out.push(h("strong", {}, m[2]));
      else out.push(h("sup", { class: "cite" }, `[${m[3]}]`));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function codeBlock(code) {
    return h("div", { class: "code" }, h("pre", {}, code), h("div", { class: "row" }, btn("Copiar", () => send({ type: "copy", text: code })), h("button", { class: "preview-btn", type: "button", title: "Ver qué hace el código y dónde se insertaría, antes de tocar tu archivo", onclick: () => send({ type: "previewCode", code }) }, "Preview")));
  }
  function markdown(md) {
    const nodes = [];
    const parts = md.split(/^```.*$/m);
    // split con la cerca deja los trozos alternados: texto, código, texto…
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        if (part.trim()) nodes.push(codeBlock(part.replace(/^\n+|\n+$/g, "")));
        return;
      }
      let list = null;
      for (const line of part.split("\n")) {
        const hd = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
        if (li) {
          if (!list) nodes.push((list = h("ul", {})));
          list.append(h("li", {}, inline(li[1])));
          continue;
        }
        list = null;
        if (hd) nodes.push(h("h4", {}, inline(hd[2])));
        else if (line.trim()) nodes.push(h("p", {}, inline(line)));
      }
    });
    return h("div", { class: "md" }, nodes);
  }

  /** Logo de Conexiones: un nodo central unido a tres fuentes (el mismo dibujo de la barra lateral). */
  function logo() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "logo");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const add = (tag, attrs) => {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    };
    add("path", { d: "M9.45 9.45 6.7 6.7M14.55 9.45 17.3 6.7M12 15.6v2.2" });
    add("circle", { cx: 12, cy: 12, r: 3.6 });
    add("circle", { cx: 12, cy: 12, r: 1.3, fill: "currentColor", stroke: "none" });
    for (const [cx, cy] of [[5, 5], [19, 5], [12, 20.2]]) add("circle", { cx, cy, r: 2.4, fill: "currentColor", stroke: "none" });
    return svg;
  }

  // --- Paginador -----------------------------------------------------------------------------------
  /** Paginador: « ‹ 1 … 4 5 6 … 20 › ». */
  function pager(page, pages, go) {
    if (!pages || pages <= 1) return null;
    const nums = [];
    for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
    const items = [];
    nums.forEach((n, i) => {
      if (i > 0 && n - nums[i - 1] > 1) items.push(h("span", { class: "muted", "aria-hidden": "true" }, "…"));
      items.push(h("button", { class: "page-btn" + (n === page ? " on" : ""), type: "button", "aria-label": `Página ${n}`, "aria-current": n === page ? "page" : undefined, onclick: () => n !== page && go(n) }, String(n)));
    });
    return h("nav", { class: "pager", "aria-label": "Paginación" }, h("button", { class: "page-btn", type: "button", "aria-label": "Página anterior", disabled: page <= 1, onclick: () => go(page - 1) }, "‹"), items, h("button", { class: "page-btn", type: "button", "aria-label": "Página siguiente", disabled: page >= pages, onclick: () => go(page + 1) }, "›"), h("span", { class: "muted pager-info" }, `Página ${page} de ${pages}`));
  }

  // --- Modo Kraken -----------------------------------------------------------------------------------
  // Icono del Kraken: la silueta (kraken-mask.webp) hace de máscara sobre un degradado vivo que se desplaza, con un destello que la recorre,
  // un aura que late, ondas de sonar y los ojos encendidos. Todo es decoración: no recibe clics ni se anuncia.
  const mediaUrl = (f) => {
    const base = (document.body && document.body.dataset && document.body.dataset.media) || "";
    return base ? base.replace(/\/$/, "") + "/" + f : f;
  };
  function krakenIcon(cls) {
    const box = h("span", { class: "kraken-art " + (cls || ""), "aria-hidden": "true" },
      h("span", { class: "kk-aura" }), h("span", { class: "kk-sonar s1" }), h("span", { class: "kk-sonar s2" }),
      [1, 2, 3, 4, 5].map((n) => h("span", { class: "kk-bub u" + n })),
      h("span", { class: "kk-body" }), h("span", { class: "kk-eye l" }), h("span", { class: "kk-eye r" }));
    box.style.setProperty("--k-mask", `url("${mediaUrl("kraken-mask.webp")}")`);
    return box;
  }
  // Tentáculos del Kraken: recortes de tentaculos.webp que emergen de los bordes con rebote, se mecen y laten con luz neón.
  // [imagen, borde, desplazamiento en el borde (px), alto (px), vaivén (s), retraso (s), aparición (s)]
  const TENTACLES = [
    [4, "b", -6, 150, 9, 0, 0.0],
    [9, "b", 62, 118, 11, -3, 0.25],
    [2, "b", 128, 96, 8, -5, 0.5],
    [11, "b", 196, 138, 12, -2, 0.15],
    [6, "b", 262, 104, 10, -6, 0.4],
    [7, "r", 40, 128, 11, -4, 0.7],
    [13, "r", 190, 100, 9, -1, 0.9],
    [3, "l", 70, 124, 12, -3, 0.8],
    [10, "l", 230, 96, 10, -7, 1.0],
    [1, "t", 24, 84, 13, -2, 1.2],
    [5, "t", 220, 78, 12, -5, 1.4],
  ];
  function krakenTentacles() {
    const box = document.createElement("div");
    box.id = "kraken-tentacles";
    box.setAttribute("aria-hidden", "true");
    for (const [img, side, off, size, dur, delay, appear] of TENTACLES) {
      const arm = h("span", { class: "kt-arm kt-" + side });
      arm.style.setProperty("--kd", dur + "s");
      arm.style.setProperty("--kdelay", delay + "s");
      arm.style.setProperty("--kin", appear + "s");
      arm.style.setProperty("--ks", size + "px");
      arm.style.setProperty("--ko", off + "px");
      const pic = document.createElement("img");
      pic.className = "kt-img";
      pic.alt = "";
      pic.decoding = "async";
      pic.draggable = false;
      pic.src = mediaUrl(`tentaculo-${img}.webp`);
      arm.append(pic);
      box.append(arm);
    }
    return box;
  }
  function syncTentacles(on) {
    const cur = document.getElementById("kraken-tentacles");
    if (on && !cur) document.body.append(krakenTentacles());
    else if (!on && cur) cur.remove();
  }
  function krakenButton() {
    const on = !!(state.kraken && state.kraken.on);
    return h("button", { class: "kraken-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), title: on ? "Apagar el Modo Kraken" : "Dejar que la IA revise tu proyecto y se conecte sola a lo que te sirve", onclick: () => send({ type: "krakenToggle", on: !on }) }, h("span", { class: "kraken-label" }, "Modo Kraken"), h("span", { class: "kraken-switch", "aria-hidden": "true" }, h("span", { class: "kraken-knob" })));
  }
  const STEP_MARK = { todo: "○", doing: "◉", done: "✓", skipped: "–", error: "✕" };
  function krakenScreen(k) {
    const mode = state.ai.mode === "api" ? "la API" : "la IA local";
    const fx = h("div", { class: "kraken-fx", "aria-hidden": "true" }, h("span", { class: "k-aurora" }), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h("span", { class: "k-bubble b" + n })), h("span", { class: "k-wave w1" }), h("span", { class: "k-wave w2" }));
    return h(
      "div",
      { class: "kraken-screen" + (k.running ? " running" : "") },
      fx,
      h("div", { class: "k-body" },
        h("div", { class: "row between" }, h("h2", { class: "k-title" }, "El Kraken despertó"), h("span", { class: "k-chip" + (k.running ? " run" : "") }, k.running ? "Revisando…" : "En guardia")),
        h("p", {}, `Con ${mode} que tienes activa, el Kraken revisará tu proyecto por completo y buscará qué sitios web y enlaces te pueden ayudar a desarrollarlo: documentación de tus frameworks, librerías, paquetes, iconos, fuentes e imágenes. Los conectará por ti, sin que tengas que hacerlo a mano.`),
        h("p", {}, "Además compara tu código con lo que leyó en tus conexiones y te propone refactorizaciones mejores. Tú apruebas cada una, una por una: nada se cambia sin tu clic."),
        k.resources && k.resources.label ? h("p", { class: "k-res" }, h("strong", {}, "⚡ " + k.resources.label), h("span", { class: "muted" }, " — " + k.resources.detail)) : null,
        h("ol", { class: "k-steps" }, k.steps.map((st) => h("li", { class: "k-step " + st.state }, h("span", { class: "k-mark", "aria-hidden": "true" }, STEP_MARK[st.state] || "○"), h("span", {}, st.label, st.detail ? h("small", { class: "muted" }, " · " + st.detail) : null)))),
        k.error ? h("p", { class: "notice error" }, k.error) : null,
        k.notes.map((n) => h("p", { class: "notice info" }, n)),
        h("div", { class: "row wrap" }, k.running ? btn("Detener", () => send({ type: "krakenStop" }), "k-btn") : btn("Revisar de nuevo", () => send({ type: "krakenScan" }), "k-btn primary-k")),
        k.connections.length ? h("div", { class: "k-block" }, h("h3", {}, `Conexiones que hizo el Kraken (${k.connections.length})`), k.connections.map(krakenConnection)) : null,
        k.proposals.length ? h("div", { class: "k-block" }, h("h3", {}, `Refactorizaciones para tu aprobación (${k.proposals.filter((p) => p.status === "pending").length})`), k.proposals.map(krakenProposal)) : null,
        h("p", { class: "muted" }, state.ai.mode === "api" ? "Se envía a tu proveedor un resumen del proyecto (sin claves ni archivos secretos). " : "Todo se procesa en tu equipo. ", "Las conexiones nuevas aparecen en «Conexiones» y puedes quitarlas cuando quieras."),
      ),
    );
  }
  function krakenConnection(c) {
    return h("div", { class: "k-conn" }, h("div", { class: "row between" }, h("span", {}, h("span", { class: "dot " + (c.status === "ok" ? "ok" : c.status === "error" ? "bad" : "busy") }), btn(c.name, () => send({ type: "openUrl", url: c.url }))), h("span", { class: "badge" }, c.origin)), h("p", { class: "muted" }, c.why || c.url), c.error ? h("p", { class: "notice warn" }, c.error) : null, c.sourceId ? btn("Quitar…", () => send({ type: "remove", id: c.sourceId }), "link danger") : null);
  }
  function krakenProposal(p) {
    const pending = p.status === "pending";
    return h(
      "div",
      { class: "k-prop " + p.status },
      h("div", { class: "row between" }, h("h4", {}, p.title), p.status === "applied" ? h("span", { class: "badge ok" }, "Aplicada") : p.status === "stale" ? h("span", { class: "badge warn" }, "Desactualizada") : null),
      h("p", { class: "muted ellipsis", title: p.file }, p.file),
      p.reason ? h("p", {}, p.reason) : null,
      p.source ? h("p", { class: "muted" }, "Fuente: ", btn(p.source.title, () => send({ type: "openUrl", url: p.source.url }))) : null,
      h("pre", { class: "k-diff del" }, p.original),
      h("pre", { class: "k-diff add" }, p.replacement),
      pending ? h("div", { class: "row wrap" }, h("button", { class: "primary small", type: "button", onclick: () => send({ type: "krakenApprove", id: p.id }) }, "Aprobar y aplicar"), btn("Ver diff", () => send({ type: "krakenDiff", id: p.id })), btn("Rechazar", () => send({ type: "krakenReject", id: p.id }), "link danger")) : p.status === "stale" ? btn("Descartar", () => send({ type: "krakenReject", id: p.id })) : null,
    );
  }

  // --- Cabecera y pestañas -------------------------------------------------------------------------
  /** El logo hace de indicador: gris en reposo, naranja mientras busca y verde neón cuando la respuesta está lista. */
  function logoState() {
    const k = state.kraken;
    if (state.asking || (k && k.running)) return ["busy", state.askPhase || "Buscando…"];
    if (state.answer) return ["ready", "Respuesta lista"];
    return ["idle", ""];
  }
  function header() {
    const ai = state.ai;
    const [mode, label] = logoState();
    const kon = !!(state.kraken && state.kraken.on);
    return h(
      "section",
      { class: "hero" + (kon ? " kraken-hero" : "") },
      h("div", { class: "brand" }, h("span", { class: "logo-tile " + mode + (kon ? " kraken-tile" : ""), role: "img", "aria-label": kon ? "Modo Kraken" : mode === "busy" ? "Buscando" : mode === "ready" ? "Respuesta lista" : "Conexiones" }, kon ? krakenIcon("tile") : logo()), h("div", { class: "grow" }, h("h1", {}, "Conexiones"), h("p", { class: "muted" }, `v${state.version} · proyecto: ${state.project}`), h("p", { class: "state-label " + mode, role: "status", "aria-live": "polite" }, label))),
      h("div", { class: "segs", role: "group", "aria-label": "Origen de la IA" }, ["local", "api"].map((m) => h("button", { class: "seg" + (ai.mode === m ? " on" : ""), type: "button", "aria-pressed": String(ai.mode === m), onclick: () => send({ type: "mode", mode: m }) }, m === "local" ? "IA local" : "API"))),
      h("p", { class: "status " + (ai.ready ? "ok" : "warn") }, ai.label, ai.problem ? h("span", { class: "muted" }, " — " + ai.problem) : null),
      ai.mode === "api" ? btn("Configurar proveedor API", () => send({ type: "configureApi" })) : null,
      ai.notice ? h("p", { class: "notice " + ai.notice.level }, ai.notice.text) : null,
      krakenButton(),
      state.kraken && state.kraken.on ? krakenScreen(state.kraken) : null,
    );
  }
  function tabs() {
    return h("nav", { class: "tabs", role: "tablist" }, state.tabs.map((t) => h("button", { class: "tab" + (tab === t.id ? " on" : ""), role: "tab", type: "button", "aria-selected": String(tab === t.id), onclick: () => setTab(t.id) }, t.label)));
  }
  function setTab(id) {
    tab = id;
    send({ type: "tab", tab: id });
    persist();
    render();
  }

  // --- Asistente ---------------------------------------------------------------------------------
  const EXAMPLES = ["¿Cómo envío correos desde PHP?", "¿Qué librería me sirve para validar formularios?", "¿Cómo cambio el color de fondo con CSS?"];
  function assistant() {
    const none = !state.sources.some((s) => (s.kind === "docs" || s.kind === "registry") && s.enabled);
        const ask = () => ui.question.trim() && send({ type: "ask", question: ui.question.trim() });
    const box = field("q", "Tu pregunta", ui.question, (v) => ((ui.question = v), persist()), { rows: 3, placeholder: "¿Existe una herramienta para enviar correos?" });
    box.querySelector("textarea").addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), ask()));
    const a = state.answer;
    return [
      none ? h("div", { class: "card" }, h("p", {}, "Aún no hay nada que consultar."), h("p", { class: "muted" }, "Conecta una web de ayuda (W3Schools, la documentación de un framework) o un registro de paquetes (Packagist, npm)."), btn("Ir a Conexiones", () => setTab("connections"), "primary")) : null,
      h("div", { class: "card" }, box, h("div", { class: "row" }, h("button", { class: "primary", type: "button", disabled: state.asking, onclick: ask }, state.asking ? "Buscando…" : "Preguntar"), h("span", { class: "muted" }, "Ctrl+Enter"))),
      !a && !state.asking && !ui.question.trim() ? h("div", { class: "chips" }, EXAMPLES.map((e) => btn(e, () => ((ui.question = e), persist(), render()), "chip"))) : null,
      a ? answerView(a) : null,
    ];
  }
  function answerView(a) {
    return h(
      "div",
      { class: "result" },
      a.answer ? markdown(a.answer) : null,
      a.notes.map((n) => h("p", { class: "notice warn" }, n)),
      a.packages.length ? h("details", { open: !a.answer }, h("summary", {}, `Paquetes encontrados (${a.packages.length})`), a.packages.map(pkgCard)) : null,
      a.sources.length ? h("div", { class: "sources" }, h("h4", {}, "Fuentes"), a.sources.map((s) => h("p", {}, h("span", { class: "cite" }, `[${s.n}] `), btn(s.title, () => send({ type: "openUrl", url: s.url })), h("span", { class: "muted" }, ` — ${s.source}`)))) : null,
      !a.answer && a.fragments.length ? h("details", { open: true }, h("summary", {}, `Fragmentos (${a.fragments.length})`), a.fragments.map(fragment)) : null,
      a.answer && a.fragments.length ? h("details", {}, h("summary", {}, "Ver los fragmentos usados"), a.fragments.map(fragment)) : null,
    );
  }
  function fragment(f) {
    return h("div", { class: "frag" }, h("p", { class: "frag-title" }, btn(f.title, () => send({ type: "openUrl", url: f.url })), f.heading ? h("span", { class: "muted" }, ` › ${f.heading}`) : null), h("pre", {}, f.text), h("p", { class: "muted" }, f.source));
  }
  function pkgCard(p, save) {
    const pkg = p.pkg || p;
    return h(
      "div",
      { class: "frag" },
      h("p", { class: "frag-title" }, btn(pkg.name, () => send({ type: "openUrl", url: pkg.url })), pkg.version ? h("span", { class: "muted" }, ` ${pkg.version}`) : null, pkg.abandoned ? h("span", { class: "badge warn" }, "abandonado") : null),
      h("p", { class: "muted" }, pkg.description),
      h("div", { class: "code" }, h("pre", {}, pkg.install), h("div", { class: "row" }, btn("Copiar comando", () => send({ type: "copy", text: pkg.install })), save ? btn(state.working.includes(`save:${pkg.name}`) ? "Guardando…" : "Guardar en mi biblioteca", () => send({ type: "pkgSave", sourceId: p.sourceId, name: pkg.name })) : null)),
    );
  }

  // --- Conexiones --------------------------------------------------------------------------------
  function connections() {
    const analyze = () => ui.url.trim() && send({ type: "analyze", url: ui.url.trim() });
    const urlField = field("url", "Dirección web", ui.url, (v) => ((ui.url = v), persist()), { placeholder: "https://packagist.org/" });
    urlField.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), analyze()));
    return [
      h("div", { class: "card" }, h("h2", {}, "Añadir una conexión"), h("p", { class: "muted" }, "Pega el enlace de una web de ayuda, de una librería o framework, de un registro de paquetes, de iconos, de fuentes (Google Fonts), de imágenes (Unsplash, Pexels, Openverse) o de un servidor MCP."), urlField, h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: analyze }, "Analizar")), state.analysisError ? h("p", { class: "notice error" }, state.analysisError) : null),
      state.analysis ? analysisCard(state.analysis) : null,
      state.syncing ? syncBar() : null,
      h("h3", {}, `Mis conexiones (${state.sources.length})`),
      state.sources.length ? state.sources.map(sourceCard) : h("p", { class: "empty" }, "Todavía no hay conexiones."),
      state.sources.length ? h("div", { class: "row" }, btn("Actualizar todas", () => send({ type: "syncAll" })), btn("Borrar todo…", () => send({ type: "clearAll" }), "link danger")) : null,
    ];
  }
  function analysisCard(a) {
    const needsKey = !!a.key;
    return h(
      "div",
      { class: "card accent" },
      h("h2", {}, a.name, h("span", { class: "badge" }, KIND[a.kind])),
      h("p", {}, a.summary),
      a.kind === "mcp" && a.url ? h("p", { class: "muted" }, a.url) : null,
      a.probe ? h("p", { class: "notice info" }, `${a.probe.title} — ${a.probe.note}`) : null,
      a.problem ? h("p", { class: "notice error" }, a.problem) : null,
      a.warnings.map((w) => h("p", { class: "notice warn" }, w)),
      h("details", {}, h("summary", {}, "Opciones"), field("cname", "Nombre", ui.name, (v) => (ui.name = v), { placeholder: a.name }), field("ctags", "Etiquetas (lenguajes o tecnologías)", ui.tags, (v) => (ui.tags = v), { placeholder: a.tags.join(", ") || "php, css…" }), a.kind === "mcp" ? field("cheader", "Encabezado de la clave", ui.header, (v) => (ui.header = v), { placeholder: (a.key && a.key.header) || "Authorization" }) : null),
      needsKey ? field("ckey", a.key.label + (a.key.optional ? " (opcional)" : ""), ui.key, (v) => (ui.key = v), { type: "password", autocomplete: "off" }) : null,
      needsKey ? h("p", { class: "muted" }, "La clave se guarda cifrada en el llavero del sistema, nunca en archivos del proyecto.") : null,
      h("div", { class: "row" }, h("button", { class: "primary", type: "button", disabled: !!a.problem, onclick: () => {
        if (needsKey && !a.key.optional && !ui.key.trim()) return void document.getElementById("ckey")?.focus();
        send({ type: "connect", url: a.url, name: ui.name, tags: ui.tags, key: ui.key, header: ui.header });
        ui.url = ui.name = ui.tags = ui.key = ui.header = "";
        persist();
      } }, "Conectar"), btn("Cancelar", () => send({ type: "cancelAnalysis" }))),
    );
  }
  function syncBar() {
    const p = state.syncing;
    const s = state.sources.find((x) => x.id === p.id);
    return h("div", { class: "card" }, h("p", {}, `Leyendo ${s ? s.name : "…"}`), h("progress", { max: p.total || 1, value: p.done || 0 }), h("p", { class: "muted ellipsis" }, p.message), btn("Cancelar", () => send({ type: "cancelSync" })));
  }
  function statusDot(s) {
    if (s.status === "syncing") return ["busy", "Sincronizando"];
    if (s.status === "error") return ["bad", s.error || "Con error"];
    if (!s.enabled) return ["off", "Pausada"];
    if (s.status === "pending") return ["warn", "Pendiente de sincronizar"];
    if (s.stale) return ["warn", "Desactualizada"];
    return ["ok", "Al día"];
  }
  function sourceCard(s) {
    const [cls, label] = statusDot(s);
    const syncable = ["docs", "icons", "fonts", "mcp", "images"].includes(s.kind) || s.kind === "registry";
    return h(
      "div",
      { class: "card source" },
      h("div", { class: "row between" }, h("h2", {}, h("span", { class: "dot " + cls, title: label }), s.name), h("span", { class: "badge" }, KIND[s.kind])),
      h("p", { class: "muted ellipsis" }, s.url),
      h("p", { class: "muted" }, label + (s.status !== "error" ? "" : ""), s.lastSync ? ` · ${ago(s.lastSync)}` : "", s.bytes ? ` · ${fmtBytes(s.bytes)}` : ""),
      s.kind === "docs" || s.kind === "registry" ? h("p", { class: "muted" }, `${s.pages} página(s) · ${s.chunks} fragmento(s)`) : s.kind === "icons" && s.chunks ? h("p", { class: "muted" }, `${s.chunks} iconos`) : s.kind === "fonts" && s.chunks ? h("p", { class: "muted" }, `${s.chunks} fuentes`) : null,
      s.tags.length ? h("p", {}, s.tags.map((t) => h("span", { class: "tag" }, t))) : null,
      h("div", { class: "row wrap" }, syncable ? btn(s.kind === "registry" || s.kind === "mcp" || s.kind === "images" ? "Comprobar" : "Actualizar", () => send({ type: "sync", id: s.id })) : null, btn(s.enabled ? "Pausar" : "Reanudar", () => send({ type: "toggle", id: s.id })), s.bytes ? btn("Vaciar datos", () => send({ type: "clearData", id: s.id })) : null, btn("Quitar…", () => send({ type: "remove", id: s.id }), "link danger")),
    );
  }

  // --- Biblioteca --------------------------------------------------------------------------------
  function library() {
    const go = () => send({ type: "libSearch", query: ui.libQuery.trim() });
    const f = field("lq", "Buscar en lo guardado", ui.libQuery, (v) => ((ui.libQuery = v), persist()), { placeholder: "enviar correo, flexbox, validar…" });
    f.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), go()));
    const pk = field("pq", "Buscar un paquete en los registros conectados", ui.pkgQuery, (v) => ((ui.pkgQuery = v), persist()), { placeholder: "mailer, datepicker…" });
    pk.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), ui.pkgQuery.trim() && send({ type: "pkgSearch", query: ui.pkgQuery.trim() })));
    const bySource = new Map();
    for (const p of state.pages) bySource.set(p.source, [...(bySource.get(p.source) || []), p]);
    return [
      h("div", { class: "card" }, f, h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: go }, "Buscar"), state.libSearch ? btn("Limpiar", () => ((ui.libQuery = ""), send({ type: "libSearch", query: "" }))) : null)),
      state.libSearch ? h("div", { class: "result" }, h("h4", {}, `Resultados para «${state.libSearch.query}»`), state.libSearch.fragments.length ? state.libSearch.fragments.map(fragment) : h("p", { class: "empty" }, "Sin resultados en lo guardado.")) : null,
      state.hasRegistries ? h("div", { class: "card" }, pk, h("div", { class: "row" }, h("button", { class: "primary", type: "button", disabled: state.working.includes("pkg"), onclick: () => ui.pkgQuery.trim() && send({ type: "pkgSearch", query: ui.pkgQuery.trim() }) }, state.working.includes("pkg") ? "Buscando…" : "Buscar paquetes"))) : null,
      state.pkgSearch ? h("div", { class: "result" }, h("h4", {}, `Paquetes para «${state.pkgSearch.query}»`), state.pkgSearch.error ? h("p", { class: "notice error" }, state.pkgSearch.error) : null, state.pkgSearch.items.map((i) => pkgCard(i, true)), !state.pkgSearch.items.length && !state.working.includes("pkg") ? h("p", { class: "empty" }, "Sin resultados.") : null) : null,
      h("h3", {}, `Guardado en tu equipo (${state.pages.length} páginas)`),
      state.pages.length
        ? [...bySource].map(([name, list]) => h("details", { open: ui.openSource === name, ontoggle: (e) => e.target.open && (ui.openSource = name) }, h("summary", {}, `${name} (${list.length})`), list.slice(0, 200).map((p) => h("p", { class: "page" }, btn(p.title || p.url, () => send({ type: "openUrl", url: p.url })), h("span", { class: "muted" }, ` · ${ago(p.fetchedAt)}`)))))
        : h("p", { class: "empty" }, "Aún no hay páginas guardadas. Conecta un sitio en «Conexiones»."),
    ];
  }

  // --- Recursos ----------------------------------------------------------------------------------
  function iconSvg(paths, style) {
    const p = paths[style];
    const svg = document.createElementNS(SVG, "svg");
    if (!p || !Array.isArray(p.v) || p.v.length !== 4 || !p.v.every((n) => typeof n === "number") || !/^[0-9a-zA-Z\s.,\-+]+$/.test(p.d)) return svg;
    svg.setAttribute("viewBox", p.v.join(" "));
    svg.setAttribute("class", "fa-svg");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", p.d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }
  function resources() {
    const seg = h("div", { class: "segs" }, [["icons", "Iconos"], ["fonts", "Fuentes"], ["images", "Imágenes"]].map(([id, l]) => h("button", { class: "seg" + (resTab === id ? " on" : ""), type: "button", onclick: () => ((resTab = id), persist(), render()) }, l)));
    return [seg, resTab === "icons" ? icons() : resTab === "fonts" ? fonts() : images()];
  }
  function icons() {
    const st = state.icons;
    if (st.syncing) return h("p", { class: "muted busy" }, "Descargando la lista de iconos…");
    if (!st.available) return h("div", { class: "card" }, h("p", {}, "Conecta Font Awesome para buscar y copiar iconos."), h("p", { class: "muted" }, "En «Conexiones» pega https://fontawesome.com/ (solo iconos gratuitos)."), btn("Ir a Conexiones", () => setTab("connections"), "primary"));
    const go = () => send({ type: "iconSearch", query: ui.iconQuery.trim(), style: ui.iconStyle });
    const f = field("iq", `Buscar entre ${st.count} iconos`, ui.iconQuery, (v) => ((ui.iconQuery = v), persist()), { placeholder: "mail, user, arrow…" });
    f.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), go()));
    const sel = h("select", { id: "ist", onchange: (e) => ((ui.iconStyle = e.target.value), go()) }, [["", "Todos los estilos"], ["solid", "Sólido"], ["regular", "Línea"], ["brands", "Marcas"]].map(([v, l]) => h("option", { value: v, selected: ui.iconStyle === v }, l)));
    const r = st.results;
    const picked = ui.picked && r && r.hits.find((x) => x.name === ui.picked.name);
    return [
      h("div", { class: "card" }, f, h("label", { class: "field", for: "ist" }, h("span", {}, "Estilo"), sel), h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: go }, "Buscar"))),
      r ? h("p", { class: "muted" }, `${r.hits.length} resultado(s)`) : h("p", { class: "muted" }, "Escribe un tema (por ejemplo «correo») o busca sin texto para ver los primeros."),
      r ? h("div", { class: "grid" }, r.hits.map((i) => { const style = (ui.picked && ui.picked.name === i.name && ui.picked.style) || i.styles[0]; return h("button", { class: "icon-cell" + (picked && picked.name === i.name ? " on" : ""), type: "button", title: `${i.label} (${i.name})`, onclick: () => ((ui.picked = { name: i.name, style: i.styles[0] }), render()) }, iconSvg(i.paths, style), h("span", {}, i.name)); })) : null,
      picked ? pickedIcon(picked) : null,
      h("p", { class: "muted" }, "Iconos de Font Awesome Free (licencia CC BY 4.0). Las clases necesitan el CSS de Font Awesome en tu proyecto; el SVG funciona solo."),
    ];
  }
  function pickedIcon(i) {
    const style = ui.picked.style;
    return h(
      "div",
      { class: "card accent" },
      h("div", { class: "row between" }, h("h2", {}, i.label), h("span", { class: "big-icon" }, iconSvg(i.paths, style))),
      h("div", { class: "segs" }, i.styles.map((s) => h("button", { class: "seg" + (s === style ? " on" : ""), type: "button", onclick: () => ((ui.picked = { name: i.name, style: s }), render()) }, { solid: "Sólido", regular: "Línea", brands: "Marca" }[s]))),
      h("div", { class: "row wrap" }, [["html", "Copiar <i>"], ["class", "Copiar clases"], ["svg", "Copiar SVG"], ["name", "Copiar nombre"]].map(([w, l]) => btn(l, () => send({ type: "iconCopy", name: i.name, style, what: w })))),
    );
  }
  // --- Fuentes -----------------------------------------------------------------------------------
  const CATEGORY = { "sans-serif": "Sans serif", serif: "Serif", display: "Display", handwriting: "Manuscrita", monospace: "Monoespaciada" };
  function fonts() {
    const st = state.fonts;
    if (st.syncing) return h("p", { class: "muted busy" }, "Descargando la lista de fuentes…");
    if (!st.available) return h("div", { class: "card" }, h("p", {}, "Conecta Google Fonts para buscar fuentes y copiar su código."), h("p", { class: "muted" }, "Es gratis y no necesita clave: se descarga la lista (unas 1 900 fuentes) una sola vez."), h("div", { class: "row wrap" }, h("button", { class: "primary", type: "button", onclick: () => send({ type: "quickConnect", what: "googlefonts" }) }, "Conectar Google Fonts"), btn("Usar otro enlace", () => setTab("connections"))));
    const go = (page) => send({ type: "fontSearch", query: ui.fontQuery.trim(), category: ui.fontCategory, page: page || 1 });
    const f = field("fq", `Nombre de la fuente (${st.count} disponibles en tus conexiones)`, ui.fontQuery, (v) => ((ui.fontQuery = v), persist()), { placeholder: "roboto, poppins, mono…" });
    f.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), go(1)));
    const sel = h("select", { id: "fcat", onchange: (e) => ((ui.fontCategory = e.target.value), go(1)) }, [["", "Todas las categorías"], ...st.categories.map((c) => [c, CATEGORY[c] || c])].map(([v, l]) => h("option", { value: v, selected: ui.fontCategory === v }, l)));
    const r = st.results;
    const picked = ui.fontPick && r && r.hits.find((x) => x.id === ui.fontPick.id);
    return [
      h("div", { class: "card" }, f, h("label", { class: "field", for: "fcat" }, h("span", {}, "Categoría"), sel), h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: () => go(1) }, "Buscar"))),
      r ? h("p", { class: "muted" }, r.total ? `${r.total} fuente(s) · mostrando ${r.hits.length} en la página ${r.page} de ${r.pages}` : "Ninguna fuente coincide. Prueba con otro nombre.") : h("p", { class: "muted" }, "Escribe un nombre y pulsa «Buscar» (o busca sin texto para ver todas), y elige una de la lista."),
      r ? h("div", { class: "fonts" }, r.hits.map((x) => h("button", { class: "font-row" + (picked && picked.id === x.id ? " on" : ""), type: "button", "aria-pressed": String(!!(picked && picked.id === x.id)), onclick: () => ((ui.fontPick = { id: x.id, weights: [], italic: false }), render()) }, h("span", { class: "font-name" }, x.family), h("span", { class: "muted" }, `${CATEGORY[x.category] || x.category} · ${x.weights.length} peso${x.weights.length === 1 ? "" : "s"}${x.variable ? " · variable" : ""}`)))) : null,
      r ? pager(r.page, r.pages, go) : null,
      picked ? pickedFont(picked) : null,
      h("p", { class: "muted" }, "Fuentes de Google Fonts (licencias abiertas, casi todas OFL). El código enlaza con los servidores de Google; con «npm» las instalas en tu proyecto sin depender de ellos."),
    ];
  }
  function pickedFont(x) {
    const pick = ui.fontPick;
    const chosen = pick.weights.filter((w) => x.weights.includes(w));
    const payload = (what) => ({ id: x.id, what, weights: chosen, italic: pick.italic && x.italic });
    return h(
      "div",
      { class: "card accent" },
      h("div", { class: "row between" }, h("h2", {}, x.family), h("span", { class: "badge" }, CATEGORY[x.category] || x.category)),
      h("p", { class: "muted" }, chosen.length ? "Pesos elegidos:" : "Pesos (sin elegir se usan 400 y 700):"),
      h("div", { class: "row wrap" }, x.weights.map((w) => h("button", { class: "chip" + (chosen.includes(w) ? " on" : ""), type: "button", "aria-pressed": String(chosen.includes(w)), onclick: () => ((pick.weights = chosen.includes(w) ? chosen.filter((n) => n !== w) : [...chosen, w]), render()) }, String(w)))),
      x.italic ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: pick.italic ? true : false, onchange: (e) => ((pick.italic = e.target.checked), render()) }), h("span", {}, "Incluir cursiva")) : null,
      h("h4", {}, "Código de cabecera"),
      h("div", { class: "font-actions" }, [["link", "<link> (HTML)"], ["import", "@import (CSS)"], ["css", "font-family"], ["npm", "npm"]].map(([w, l]) => h("div", { class: "row wrap font-act" }, h("span", { class: "font-act-name" }, l), btn("Copiar", () => send({ type: "fontCopy", ...payload(w) })), w === "npm" ? null : btn("Insertar…", () => send({ type: "fontInsert", ...payload(w) }))))),
      h("p", { class: "muted" }, "«Insertar…» abre el Preview: ves el código y dónde quedará antes de tocar tu archivo."),
    );
  }

  // --- Imágenes ----------------------------------------------------------------------------------
  function addService(url) {
    ui.url = url;
    persist();
    setTab("connections");
    send({ type: "analyze", url });
  }
  const SELECTS = {
    orientation: ["Orientación", [["", "Cualquiera"], ["landscape", "Horizontal"], ["portrait", "Vertical"], ["square", "Cuadrada"]]],
    color: ["Color", [["", "Cualquiera"], ["red", "Rojo"], ["orange", "Naranja"], ["yellow", "Amarillo"], ["green", "Verde"], ["teal", "Turquesa"], ["blue", "Azul"], ["purple", "Morado"], ["pink", "Rosa"], ["black", "Negro"], ["white", "Blanco"], ["gray", "Gris / B&N"]]],
    order: ["Orden", [["", "Más relevantes"], ["latest", "Más recientes"]]],
    category: ["Tipo", [["", "Cualquiera"], ["photograph", "Fotografía"], ["illustration", "Ilustración"], ["digital_artwork", "Arte digital"]]],
  };
  /** Filtros que entiende cada servicio. */
  const FILTERS = { unsplash: ["orientation", "color", "order"], pexels: ["orientation", "color"], openverse: ["orientation", "category"] };
  function images() {
    const st = state.photos;
    if (!st.available) {
      return h(
        "div",
        { class: "card" },
        h("p", {}, "Conecta un servicio de imágenes para buscar y guardar fotos."),
        h("p", { class: "muted" }, "Openverse no pide clave (millones de imágenes con licencia abierta). Unsplash y Pexels sí: es gratis y se obtiene en un minuto."),
        h("div", { class: "row wrap" }, h("button", { class: "primary", type: "button", onclick: () => send({ type: "quickConnect", what: "openverse" }) }, "Conectar Openverse"), btn("Añadir Unsplash", () => addService("https://unsplash.com/")), btn("Añadir Pexels", () => addService("https://www.pexels.com/"))),
        h("p", { class: "muted" }, "Unsplash: unsplash.com/developers → «Your apps» → «New Application» → copia la «Access Key». Pexels: pexels.com/api → «Get Started»."),
      );
    }
    const providers = st.providers || [];
    const current = (providers.find((p) => p.id === ui.photoProvider) || providers[0] || {}).id;
    const filters = ui.imgFilters;
    const search = (page, f, q) => (q || ui.photoQuery).trim() && send({ type: "photoSearch", query: (q || ui.photoQuery).trim(), provider: current, page: page || 1, filters: f || filters });
    const f = field("phq", "Buscar imágenes", ui.photoQuery, (v) => ((ui.photoQuery = v), persist()), { placeholder: "oficina, montañas, café…" });
    f.querySelector("input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), search(1)));
    const r = st.results;
    const busy = state.working.includes("photos");
    const names = Object.fromEntries(providers.map((p) => [p.id, p.label]));
    const selects = (FILTERS[current] || []).map((key) => {
      const [label, opts] = SELECTS[key];
      return h("label", { class: "field", for: "fl-" + key }, h("span", {}, label), h("select", { id: "fl-" + key, onchange: (e) => ((filters[key] = e.target.value || undefined), persist(), search(1)) }, opts.map(([v, l]) => h("option", { value: v, selected: (filters[key] || "") === v }, l))));
    });
    return [
      providers.length > 1 ? h("div", { class: "segs", role: "group", "aria-label": "Servicio de imágenes" }, providers.map((p) => h("button", { class: "seg" + (p.id === current ? " on" : ""), type: "button", "aria-pressed": String(p.id === current), onclick: () => ((ui.photoProvider = p.id), render()) }, p.label))) : null,
      h("div", { class: "card" }, f, h("div", { class: "filters" }, selects, current === "openverse" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: filters.commercial ? true : false, onchange: (e) => ((filters.commercial = e.target.checked || undefined), persist(), search(1)) }), h("span", {}, "Solo uso comercial")) : null), h("div", { class: "row" }, h("button", { class: "primary", type: "button", disabled: busy, onclick: () => search(1) }, busy ? "Buscando…" : "Buscar"))),
      r && r.error ? h("p", { class: "notice error" }, r.error) : null,
      r && !r.error ? h("p", { class: "muted" }, `${r.total} imagen(es) en ${names[r.provider] || "el servicio"} · página ${r.page || 1} de ${r.pages || 1}` + (r.remaining !== undefined ? ` · te quedan ${r.remaining} búsquedas` : "")) : null,
      r && r.pages > 1 ? pager(r.page, r.pages, (n) => search(n, r.filters || filters, r.query)) : null,
      r ? h("div", { class: "photos" }, r.items.map((p) => photoCard(p))) : null,
      r && r.pages > 1 ? pager(r.page, r.pages, (n) => search(n, r.filters || filters, r.query)) : null,
      h("p", { class: "muted" }, `«Guardar» descarga la imagen en la carpeta «${st.folder || "assets/images"}» de tu proyecto (puedes cambiarla en Ajustes). Respeta la licencia: copia el crédito del autor cuando haga falta.`),
    ];
  }
  function photoCard(p) {
    const saving = state.working.includes("save:" + p.id);
    const label = (p.title || p.alt || "Imagen").slice(0, 80);
    return h(
      "figure",
      { class: "photo" },
      p.thumb ? h("img", { src: p.thumb, alt: p.alt || "Imagen", loading: "lazy" }) : h("div", { class: "nothumb", style: `background:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#ccc"}` }),
      h(
        "figcaption",
        {},
        h("span", { class: "muted ellipsis", title: label }, p.author),
        p.license ? h("span", { class: "badge" }, p.license) : null,
        h("div", { class: "row wrap" }, h("button", { class: "primary small", type: "button", disabled: saving, onclick: () => send({ type: "photoSave", id: p.id, size: "web" }) }, saving ? "Guardando…" : "Guardar en el proyecto"), p.original && p.original !== p.regular ? btn("Original", () => send({ type: "photoSave", id: p.id, size: "original" })) : null),
        h("div", { class: "row wrap" }, [["url", "URL"], ["img", "<img>"], ["css", "CSS"], ["credit", "Crédito"], ["open", "Ver"]].map(([w, l]) => btn(l, () => send({ type: "photoCopy", id: p.id, what: w })))),
      ),
    );
  }

  // --- Estado -------------------------------------------------------------------------------------
  const MCP_LABEL = { active: ["ok", "Activo"], ready: ["ok", "Listo"], auth: ["warn", "Falta la clave"], missing: ["warn", "Falta configurar"], inactive: ["bad", "Inactivo"], "not-mcp": ["bad", "No parece MCP"], blocked: ["bad", "Bloqueado"] };
  function mcpRow(name, sub, status, onCheck, busy) {
    const [cls, label] = status ? MCP_LABEL[status.state] || ["off", status.state] : ["off", "Sin comprobar"];
    return h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", {}, h("span", { class: "dot " + cls }), name), h("span", { class: "badge" }, label)), h("p", { class: "muted ellipsis" }, sub), status ? h("p", { class: "muted" }, status.detail + (status.ms ? ` (${status.ms} ms)` : "")) : null, btn(busy ? "Comprobando…" : "Comprobar", onCheck));
  }
  function status() {
    const total = state.sources.length;
    const stale = state.sources.filter((s) => s.stale).length;
    const errors = state.sources.filter((s) => s.status === "error").length;
    const pct = Math.min(100, Math.round((state.storage.total / (state.storage.maxMb * 1048576)) * 100));
    return [
      h("div", { class: "card" }, h("h2", {}, "Resumen"), h("p", {}, `${total} conexión(es)` + (errors ? ` · ${errors} con error` : "") + (stale ? ` · ${stale} desactualizada(s)` : "")), h("progress", { max: 100, value: pct }), h("p", { class: "muted" }, `Almacenamiento: ${fmtBytes(state.storage.total)} de ${state.storage.maxMb} MB (${pct} %)`), h("div", { class: "row" }, btn("Actualizar desactualizadas", () => send({ type: "syncAll" })), btn("Abrir carpeta", () => send({ type: "openStorage" })))),
      h("h3", {}, "Conexiones"),
      state.sources.filter((s) => s.kind !== "mcp").map((s) => { const [cls, label] = statusDot(s); return h("div", { class: "row between line" }, h("span", {}, h("span", { class: "dot " + cls }), s.name), h("span", { class: "muted" }, label)); }),
      !total ? h("p", { class: "empty" }, "Sin conexiones.") : null,
      h("div", { class: "row between" }, h("h3", {}, "Servidores MCP"), btn("Comprobar todos", () => send({ type: "mcpCheckAll" }))),
      h("p", { class: "muted" }, "Solo se comprueba si responden. Nunca se ejecuta el programa de un servidor MCP desde aquí."),
      state.mcp.manual.map((m) => mcpRow(m.name, m.url, m.status, () => send({ type: "mcpCheck", key: m.id }), false)),
      state.mcp.configured.length ? h("h4", {}, "Configurados en tu editor") : null,
      state.mcp.configured.map((m) => mcpRow(m.name, `${m.type} · ${m.target} · ${m.origin}`, m.status, () => send({ type: "mcpCheck", key: m.key }), state.working.includes(m.key))),
      !state.mcp.manual.length && !state.mcp.configured.length ? h("p", { class: "empty" }, "No hay servidores MCP. Añade uno en «Conexiones» o configúralo en tu editor (mcp.json).") : null,
    ];
  }

  // --- Ajustes ------------------------------------------------------------------------------------
  function toggle(key, label, hint, value) {
    return h("label", { class: "check" }, h("input", { type: "checkbox", checked: value ? true : false, onchange: (e) => send({ type: "setSetting", key, value: e.target.checked }) }), h("span", {}, label, hint ? h("small", { class: "muted" }, hint) : null));
  }
  function number(key, label, value, unit) {
    const i = h("input", { type: "number", value: String(value), onchange: (e) => send({ type: "setSetting", key, value: Number(e.target.value) }) });
    return h("label", { class: "field" }, h("span", {}, `${label}${unit ? ` (${unit})` : ""}`), i);
  }
  /** Compartir lo guardado con GhostCode y MagicTools. */
  /** Triconnect: GhostCode + MagicTools + Conexiones intercambiando información. */
  function triconnectCard() {
    const tc = state.triconnect || { enabled: false };
    const peers = (state.share && state.share.peers) || [];
    const on = !!tc.enabled;
    const statusOf = (p) => (!p.installed ? "No instalada" : !on ? "Desconectada" : p.speaks ? "Conectada · intercambio en ambos sentidos" : p.linked ? "Conectada · consulta tus conexiones" : "Instalada · sin enlazar");
    return h(
      "div",
      { class: "card tri" + (on ? " on" : "") },
      h("button", { class: "tri-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), onclick: () => send({ type: "setSetting", key: "triconnect.enabled", value: !on }) }, h("span", { class: "tri-label" }, "Triconnect"), h("span", { class: "kraken-switch", "aria-hidden": "true" }, h("span", { class: "kraken-knob" }))),
      h("p", { class: "muted" }, "Conecta GhostCode, MagicTools y Conexiones para que trabajen como una sola herramienta: lo que guardas en Conexiones llega a las otras dos para mejorar sus respuestas, y lo que ellas aportan llega al asistente de Conexiones. Al activarlo se enciende también «compartir» y el uso de Conexiones en cada herramienta instalada. Solo viajan fragmentos de texto: sin claves ni red, y siempre como datos, nunca como órdenes."),
      h("div", { class: "row between line" }, h("span", {}, h("span", { class: "dot " + (on ? "ok" : "off") }), "Conexiones"), h("span", { class: "muted" }, on ? "Activa" : "Desconectada")),
      peers.map((p) => h("div", { class: "row between line" }, h("span", {}, h("span", { class: "dot " + (p.installed && on ? "ok" : "off") }), p.name, p.installed && p.version ? h("span", { class: "muted" }, " v" + p.version) : null), h("span", { class: "muted" }, statusOf(p)))),
    );
  }
  function shareCard() {
    const sh = state.share || { enabled: true, peers: [] };
    return h(
      "div",
      { class: "card" },
      h("h2", {}, "Compartir con GhostCode y MagicTools"),
      h("p", { class: "muted" }, "Si las tienes instaladas, pueden consultar lo que ya guardaste en tus conexiones para dar mejores respuestas (por ejemplo, al explicar un error de una librería). Solo leen fragmentos guardados: no usan la red, no ven tus claves ni tus ajustes, y la IA recibe unos pocos fragmentos cuando de verdad vienen al caso."),
      toggle("share.enabled", "Permitir que otras extensiones consulten mis conexiones", "", sh.enabled),
      sh.peers.map((p) => h("div", { class: "row between line" }, h("span", {}, h("span", { class: "dot " + (p.installed ? "ok" : "off") }), p.name, p.installed && p.version ? h("span", { class: "muted" }, " v" + p.version) : null), h("span", { class: "muted" }, !p.installed ? "No instalada" : p.calls ? `${p.calls} consulta(s) · ${p.found} fragmento(s)` : "Sin consultas aún"))),
    );
  }
  function settings() {
    const s = state.settings;
    const blocked = h("textarea", { id: "blocked", rows: "3", placeholder: "dominio-malo.com\notro.net", onchange: (e) => send({ type: "setSetting", key: "security.blockedDomains", value: e.target.value }) });
    blocked.value = s.blockedDomains;
    return [
      h("div", { class: "card" }, h("h2", {}, "Seguridad"), h("p", { class: "muted" }, "Siempre activo: solo https, sin usuario ni contraseña en el enlace, sin IP ni acortadores, sin tu red local, respeta robots.txt, solo lee texto (nunca descarga programas) y nada de lo leído se ejecuta."), toggle("security.allowHttp", "Permitir http:// (sin cifrar)", "No recomendado.", s.allowHttp), toggle("security.allowPrivateNetwork", "Permitir mi red local y mi equipo", "Desactiva la protección contra enlaces que apunten a servicios internos.", s.allowPrivateNetwork), h("label", { class: "field", for: "blocked" }, h("span", {}, "Dominios bloqueados (uno por línea)"), blocked)),
      h("div", { class: "card" }, h("h2", {}, "Sincronización"), number("sync.ttlHours", "Considerar desactualizada tras", s.ttlHours, "horas"), number("sync.maxPages", "Páginas máximas por sitio", s.maxPages), number("sync.delayMs", "Pausa entre páginas", s.delayMs, "ms"), h("p", { class: "muted" }, "Se aplica a las conexiones nuevas. Solo se vuelve a descargar lo que cambió.")),
      h("div", { class: "card" }, h("h2", {}, "Almacenamiento"), h("p", { class: "muted ellipsis" }, state.storage.path), h("p", {}, `${fmtBytes(state.storage.total)} usados`), number("storage.maxMb", "Límite de la biblioteca", s.maxMb, "MB"), h("p", { class: "muted" }, "Al quitar una conexión se borra todo lo guardado de ella. «Vaciar datos» borra lo guardado pero mantiene la conexión."), state.sources.filter((x) => x.bytes).map((x) => h("div", { class: "row between line" }, h("span", {}, `${x.name} · ${fmtBytes(x.bytes)}`), btn("Vaciar", () => send({ type: "clearData", id: x.id })))), h("div", { class: "row" }, btn("Abrir carpeta", () => send({ type: "openStorage" })), btn("Borrar todo…", () => send({ type: "clearAll" }), "link danger"))),
      triconnectCard(),
      shareCard(),
      h("div", { class: "card" }, h("h2", {}, "Imágenes"), h("label", { class: "field", for: "imgfolder" }, h("span", {}, "Carpeta del proyecto para guardar imágenes"), h("input", { id: "imgfolder", type: "text", value: s.imagesFolder || "assets/images", spellcheck: "false", onchange: (e) => send({ type: "setSetting", key: "images.folder", value: e.target.value }) })), h("p", { class: "muted" }, "Ruta relativa a la carpeta del proyecto (por ejemplo assets/images). Se crea si no existe.")),
      h("div", { class: "card" }, h("h2", {}, "Búsqueda"), toggle("search.embeddings", "Búsqueda por significado", "Entiende sinónimos e idiomas. Necesita un modelo de embeddings en Ollama (ollama pull nomic-embed-text).", s.embeddings), state.embed.enabled ? h("p", { class: "muted" }, state.embed.model ? `Modelo: ${state.embed.model}` : "No encuentro un modelo de embeddings en Ollama.") : null, state.embed.enabled && state.embed.model ? h("div", { class: "row" }, btn(state.embed.progress ? `Preparando… ${state.embed.progress.done}/${state.embed.progress.total}` : "Preparar vectores", () => send({ type: "prepareVectors" }))) : null),
      h("div", { class: "card" }, h("h2", {}, "Idioma de las respuestas"), h("select", { onchange: (e) => send({ type: "setSetting", key: "language", value: e.target.value }) }, [["auto", "Automático"], ["es", "Español"], ["en", "English"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"]].map(([v, l]) => h("option", { value: v, selected: s.language === v }, l)))),
    ];
  }

  // --- Preview de inserción -----------------------------------------------------------------------
  function previewModal(pv) {
    const close = () => send({ type: "cancelPreview" });
    const where = !pv.canInsert ? "No hay un archivo abierto: abre uno y coloca el cursor para poder insertarlo." : pv.replaceLines ? `Reemplazará la selección (${pv.replaceLines} línea${pv.replaceLines === 1 ? "" : "s"}) en ${pv.file}, desde la línea ${pv.line}` : `Se insertará en ${pv.file}, línea ${pv.line}, columna ${pv.col}`;
    const ex = pv.explain || { state: "none" };
    const dialog = h(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "pv-title" },
      h("div", { class: "row between" }, h("h2", { id: "pv-title" }, "Preview"), btn("✕", close, "link", { "aria-label": "Cerrar" })),
      h("h4", {}, "Qué hace este código"),
      ex.state === "loading" ? h("p", { class: "muted busy" }, "Analizando el código…") : ex.state === "ready" ? markdown(ex.text) : h("p", { class: "muted" }, "No hay una explicación disponible (activa la IA local o la API para verla). Revisa el código de abajo."),
      pv.risks.map((r) => h("p", { class: "notice warn" }, `Revisa con calma: ${r}`)),
      h("h4", {}, pv.canInsert ? "Cómo quedaría" : "El código"),
      h("p", { class: "muted" }, where),
      pv.stale ? h("p", { class: "notice warn" }, "El archivo cambió desde que abriste esta vista. Actualiza la posición para ver dónde quedaría ahora.") : null,
      h("pre", { class: "pv", tabindex: "0" }, h("span", { class: "ctx" }, pv.before), h("span", { class: "ins" }, pv.code), h("span", { class: "ctx" }, pv.after)),
      h("p", { class: "muted" }, "En verde, lo que se añade. Nada se escribe en el archivo hasta que pulses «Insertar aquí»."),
      h("div", { class: "row wrap" }, pv.stale ? h("button", { id: "pv-ok", class: "primary", type: "button", onclick: () => send({ type: "previewCode", code: pv.code }) }, "Actualizar posición") : h("button", { id: "pv-ok", class: "primary", type: "button", disabled: !pv.canInsert, onclick: () => send({ type: "confirmInsert" }) }, "Insertar aquí"), btn("Copiar", () => send({ type: "copy", text: pv.code })), btn("Cancelar", close)),
    );
    const modal = h("div", { class: "modal", onclick: (e) => e.target === modal && close() }, dialog);
    modal.addEventListener("keydown", (e) => e.key === "Escape" && close());
    return modal;
  }

  // --- Pintado --------------------------------------------------------------------------------------
  function render() {
    if (!state) return;
    const active = document.activeElement;
    const focus = active && active.id && active.id !== "pv-ok" ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    const current = state.tabs.find((t) => t.id === tab) || state.tabs[0];
    const body = { assistant, connections, library, resources, status, settings }[current.id]();
    document.body.classList.toggle("kraken", !!(state.kraken && state.kraken.on));
    syncTentacles(!!(state.kraken && state.kraken.on));
    app.replaceChildren(...[header(), tabs(), h("p", { class: "muted subtitle" }, current.subtitle), body, state.preview ? previewModal(state.preview) : null].flat(Infinity).filter(Boolean));
    if (state.preview && !(document.activeElement && document.activeElement.id === "pv-ok")) document.getElementById("pv-ok")?.focus();
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) {
        el.focus();
        try { el.setSelectionRange(focus.start, focus.end); } catch { /* campos sin selección */ }
      }
    }
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "state") {
      state = m.state;
      render();
    } else if (m.type === "tab" && typeof m.tab === "string") {
      tab = m.tab;
      persist();
      render();
    }
  });
  send({ type: "ready" });
})();
