'use strict';

/* =========================================================
   Fatti Conti – Pesate e Pro Forma
   Tutti i dati sono salvati nel browser (localStorage).
   ========================================================= */

const KEY = 'fatticonti_v1';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = n => Math.round((n + Number.EPSILON) * 1000) / 1000;
const fmtKg = n => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const fmtEur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const pdfTxt = s => String(s ?? '').replace(/[\u00a0\u202f]/g, ' ');
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const nowTime = () => new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

/** Accetta "12,5", "12.5", "1.250,5" */
function parseNum(s) {
  s = String(s ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* ---------------- Stato ---------------- */

function defaultState() {
  return {
    azienda: { ragioneSociale: '', indirizzo: '', piva: '', cf: '', telefono: '', email: '', notaPdf: '' },
    fornitori: [],   // {id, nome, indirizzo, piva, telefono, email}
    merci: [],       // {id, nome, prezzo, storico:[{dal, prezzo}]}
    ritiri: [],      // {id, numero, anno, data, fornitoreId, fornitoreSnap, righe:{merceId:{nome,prezzo}}, pesate:[{id,merceId,peso,ora}], note, chiuso, generaleId, pdfSalvato, creato}
    generali: [],    // {id, numero, anno, fornitoreId, fornitoreSnap, creata, acconti:[{id,data,importo,note}], saldo:{data,importo,note}|null, chiusa, pdfSalvato, driveFileId, driveLink}
    contatori: {},   // {anno: ultimoNumero} pro forma
    contatoriGen: {},// {anno: ultimoNumero} fatture generali
    ultimoFornitore: null,
    drive: { clientId: '', cartella: 'Fatti Conti - Pro Forma', perFornitore: true }
  };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return Object.assign(defaultState(), s);
  } catch (e) { console.error(e); }
  return defaultState();
}

let S = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { alert('Errore nel salvataggio dei dati: ' + e.message); }
}

const getMerce = id => S.merci.find(m => m.id === id);
const getRitiro = id => S.ritiri.find(r => r.id === id);
const getGenerale = id => S.generali.find(g => g.id === id);
function fornitoreDi(r) {
  return S.fornitori.find(f => f.id === r.fornitoreId) || r.fornitoreSnap || { nome: '(fornitore eliminato)' };
}

/* ---------------- Fatture generali ---------------- */

const numGen = g => `G${g.numero}/${g.anno}`;

/** Restituisce la fattura generale aperta del fornitore (se crea=true la crea se manca) */
function generaleAperta(fornitoreId, crea = false) {
  let g = S.generali.find(x => x.fornitoreId === fornitoreId && !x.chiusa);
  if (!g && crea) {
    const anno = today().slice(0, 4);
    S.contatoriGen[anno] = (S.contatoriGen[anno] || 0) + 1;
    const f = S.fornitori.find(x => x.id === fornitoreId);
    g = {
      id: uid(), numero: S.contatoriGen[anno], anno, fornitoreId, fornitoreSnap: f ? { ...f } : null,
      creata: today(), acconti: [], saldo: null, chiusa: false, pdfSalvato: null, driveFileId: null, driveLink: null
    };
    S.generali.push(g);
  }
  return g || null;
}

const ritiriDi = g => S.ritiri.filter(r => r.generaleId === g.id)
  .sort((a, b) => a.data.localeCompare(b.data) || a.numero - b.numero);

/** Ritiro saldato = appartiene a una generale chiusa (bloccato) */
function generaleSaldata(r) {
  const g = r.generaleId && getGenerale(r.generaleId);
  return g && g.chiusa ? g : null;
}

/** Elimina una generale aperta vuota (senza pro forma né acconti) */
function rimuoviSeVuota(g) {
  if (g && !g.chiusa && !ritiriDi(g).length && !g.acconti.length) S.generali = S.generali.filter(x => x !== g);
}

function calcolaGenerale(g) {
  const ritiri = ritiriDi(g).map(r => ({ r, c: calcola(r) }));
  const perMerce = new Map();
  let totale = 0, colli = 0, kg = 0;
  for (const { c } of ritiri) {
    totale += c.totale; colli += c.colli; kg += c.kg;
    for (const riga of c.righe) {
      const k = riga.nome + '|' + riga.prezzo;
      const m = perMerce.get(k) || { nome: riga.nome, prezzo: riga.prezzo, colli: 0, kg: 0 };
      m.colli += riga.pesate.length; m.kg += riga.kg;
      perMerce.set(k, m);
    }
  }
  const merci = [...perMerce.values()].sort((a, b) => a.nome.localeCompare(b.nome) || a.prezzo - b.prezzo);
  merci.forEach(m => { m.kg = round3(m.kg); m.importo = round2(m.kg * m.prezzo); });
  const acconti = [...g.acconti].sort((a, b) => a.data.localeCompare(b.data));
  const totAcconti = round2(acconti.reduce((s, a) => s + a.importo, 0));
  totale = round2(totale);
  const saldo = g.saldo ? round2(g.saldo.importo) : 0;
  return { ritiri, merci, acconti, totale, colli, kg: round3(kg), totAcconti, saldo, residuo: round2(totale - totAcconti - saldo) };
}

/** Collega alla generale aperta tutte le pro forma che non ne hanno una (dati vecchi / import) */
function migra() {
  S.generali = S.generali || [];
  S.contatoriGen = S.contatoriGen || {};
  let cambiato = false;
  for (const r of [...S.ritiri].sort((a, b) => a.data.localeCompare(b.data))) {
    if (!r.generaleId || !getGenerale(r.generaleId)) {
      r.generaleId = generaleAperta(r.fornitoreId, true).id;
      cambiato = true;
    }
  }
  if (cambiato) save();
}
migra();

/** Calcola righe (per merce), totali e colli di un ritiro */
function calcola(r) {
  const map = new Map();
  for (const p of r.pesate) {
    if (!map.has(p.merceId)) {
      const info = r.righe[p.merceId] || { nome: getMerce(p.merceId)?.nome || '?', prezzo: 0 };
      map.set(p.merceId, { merceId: p.merceId, nome: info.nome, prezzo: Number(info.prezzo) || 0, pesate: [], kg: 0 });
    }
    const riga = map.get(p.merceId);
    riga.pesate.push(p);
    riga.kg += p.peso;
  }
  const righe = [...map.values()];
  let totale = 0, kg = 0;
  for (const riga of righe) {
    riga.kg = round3(riga.kg);
    riga.importo = round2(riga.kg * riga.prezzo);
    totale += riga.importo;
    kg += riga.kg;
  }
  return { righe, totale: round2(totale), kg: round3(kg), colli: r.pesate.length };
}

/* ---------------- UI helpers ---------------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/**
 * Apre una finestra con un form. onOk(dati) -> ritorna false per non chiudere.
 * opts: { okLabel, onDelete }
 */
function dialogForm(inner, onOk, opts = {}) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog">${inner}
    <div class="btn-row">
      ${opts.onDelete ? '<button value="delete" class="btn danger" formnovalidate>Elimina</button>' : ''}
      <button value="cancel" class="btn" formnovalidate>Annulla</button>
      <button value="ok" class="btn primary">${esc(opts.okLabel || 'Salva')}</button>
    </div></form>`;
  const form = $('form', dlg);
  form.addEventListener('submit', e => {
    const v = e.submitter?.value;
    if (v === 'delete') { if (opts.onDelete() === false) e.preventDefault(); return; }
    if (v !== 'ok') return;
    const data = Object.fromEntries(new FormData(form));
    if (onOk(data) === false) e.preventDefault();
  });
  dlg.showModal();
  const first = $('input:not([type=hidden]), select, textarea', dlg);
  if (first && !opts.noFocus) setTimeout(() => first.focus(), 50);
  return dlg;
}

function scarica(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Condivide un file (es. verso Google Drive). Ritorna true se condiviso. */
async function condividiFile(blob, nome, tipo) {
  const file = new File([blob], nome, { type: tipo });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: nome });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      console.warn(e);
    }
  }
  scarica(blob, nome);
  toast('File scaricato: caricalo su Google Drive');
  return 'download';
}

/* ---------------- Navigazione ---------------- */

const nav = { tab: 'ritiri', stack: [], filtroForn: '' };
let selMerce = null;

function setTitle(t) { $('#title').textContent = t; }

function apri(tipo, id) {
  nav.stack.push({ tipo, id });
  history.pushState({ livello: nav.stack.length }, '');
  render();
  window.scrollTo(0, 0);
}

function apriRitiro(id) {
  const r = getRitiro(id);
  const last = r.pesate[r.pesate.length - 1];
  selMerce = last ? last.merceId : (S.merci[0]?.id || null);
  apri('ritiro', id);
}

const apriGenerale = id => apri('generale', id);

/** Cambia scheda chiudendo eventuali dettagli aperti */
function vaiTab(tab) {
  const n = nav.stack.length;
  nav.stack = [];
  nav.tab = tab;
  if (n) history.go(-n);
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => { if (nav.stack.length) { nav.stack.pop(); render(); } });
$('#btnBack').addEventListener('click', () => history.back());

$$('.tabbar button').forEach(b => b.addEventListener('click', () => vaiTab(b.dataset.tab)));

function render() {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === nav.tab));
  $('#btnBack').classList.toggle('hidden', !nav.stack.length);
  const v = $('#view');
  while (nav.stack.length) {
    const top = nav.stack[nav.stack.length - 1];
    if (top.tipo === 'ritiro') { const r = getRitiro(top.id); if (r) return viewRitiro(v, r); }
    if (top.tipo === 'generale') { const g = getGenerale(top.id); if (g) return viewGenerale(v, g); }
    nav.stack.pop();
  }
  ({ ritiri: viewRitiri, conti: viewConti, merci: viewMerci, fornitori: viewFornitori, impostazioni: viewImpostazioni })[nav.tab](v);
}

/* ---------------- Vista: elenco ritiri ---------------- */

function viewRitiri(v) {
  setTitle('Ritiri');
  let list = [...S.ritiri].sort((a, b) => b.data.localeCompare(a.data) || b.creato - a.creato);
  if (nav.filtroForn) list = list.filter(r => r.fornitoreId === nav.filtroForn);

  let h = '';
  if (!S.azienda.ragioneSociale) {
    h += `<div class="card"><b>Benvenuto!</b><p class="muted">Per iniziare:<br>1. imposta la tua <b>ragione sociale</b> in Impostazioni<br>2. aggiungi i tuoi <b>fornitori</b><br>3. aggiungi le <b>merci</b> con il prezzo al kg<br>4. crea un nuovo ritiro con il tasto <b>+</b></p></div>`;
  }
  if (S.fornitori.length > 1) {
    h += `<select id="filtro" style="margin-bottom:.75rem">
      <option value="">Tutti i fornitori</option>
      ${S.fornitori.map(f => `<option value="${f.id}" ${f.id === nav.filtroForn ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}
    </select>`;
  }
  if (!list.length) {
    h += `<div class="empty">Nessun ritiro.<br>Tocca <b>+</b> per iniziare a pesare.</div>`;
  } else {
    let totLista = 0;
    h += list.map(r => {
      const c = calcola(r);
      totLista += c.totale;
      const gs = generaleSaldata(r);
      return `<div class="list-item" data-id="${r.id}">
        <div class="main">
          <div class="title">${esc(fornitoreDi(r).nome)}
            ${gs ? `<span class="badge closed">&#128274; saldata</span>`
              : `<span class="badge ${r.chiuso ? 'closed' : 'open'}">${r.chiuso ? 'chiuso' : 'aperto'}</span>`}
            ${r.pdfSalvato ? '<span class="badge">PDF</span>' : ''}</div>
          <div class="sub">N. ${r.numero}/${r.anno} · ${fmtDate(r.data)} · ${c.colli} colli · ${fmtKg(c.kg)} kg</div>
        </div>
        <div class="right">${fmtEur(c.totale)}</div>
      </div>`;
    }).join('');
    h += `<p class="muted" style="text-align:right">${list.length} ritiri · totale ${fmtEur(round2(totLista))}</p>`;
  }
  h += `<button class="fab" id="nuovo" aria-label="Nuovo ritiro">+</button>`;
  v.innerHTML = h;

  $('#filtro')?.addEventListener('change', e => { nav.filtroForn = e.target.value; render(); });
  $$('.list-item', v).forEach(el => el.addEventListener('click', () => apriRitiro(el.dataset.id)));
  $('#nuovo').addEventListener('click', nuovoRitiro);
}

function nuovoRitiro() {
  if (!S.fornitori.length) { toast('Prima aggiungi almeno un fornitore'); nav.tab = 'fornitori'; return render(); }
  if (!S.merci.length) { toast('Prima aggiungi almeno una merce'); nav.tab = 'merci'; return render(); }
  const def = S.ultimoFornitore && S.fornitori.some(f => f.id === S.ultimoFornitore) ? S.ultimoFornitore : S.fornitori[0].id;
  dialogForm(`<h2>Nuovo ritiro</h2>
    <label>Fornitore</label>
    <select name="fornitoreId" required>
      ${S.fornitori.map(f => `<option value="${f.id}" ${f.id === def ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}
    </select>
    <label>Data</label>
    <input type="date" name="data" value="${today()}" required>`,
    d => {
      const anno = d.data.slice(0, 4);
      S.contatori[anno] = (S.contatori[anno] || 0) + 1;
      const f = S.fornitori.find(x => x.id === d.fornitoreId);
      const r = {
        id: uid(), numero: S.contatori[anno], anno, data: d.data,
        fornitoreId: d.fornitoreId, fornitoreSnap: { ...f },
        righe: {}, pesate: [], note: '', chiuso: false, pdfSalvato: null, creato: Date.now()
      };
      r.generaleId = generaleAperta(d.fornitoreId, true).id;
      S.ritiri.push(r);
      S.ultimoFornitore = d.fornitoreId;
      save();
      setTimeout(() => apriRitiro(r.id), 0);
    }, { okLabel: 'Crea', noFocus: true });
}

/* ---------------- Vista: dettaglio ritiro ---------------- */

function viewRitiro(v, r) {
  const f = fornitoreDi(r);
  const c = calcola(r);
  const g = r.generaleId ? getGenerale(r.generaleId) : null;
  const saldata = g && g.chiusa;
  setTitle(`Pro forma ${r.numero}/${r.anno}`);
  if (!getMerce(selMerce)) selMerce = S.merci[0]?.id || null;

  let h = '';
  if (g) {
    h += saldata
      ? `<div class="card banner-ok" id="vaiGen">&#128274; <b>Saldata</b> con la fattura generale <b>n. ${numGen(g)}</b> del <b>${fmtDate(g.saldo.data)}</b> &rsaquo;</div>`
      : `<div class="card banner-open" id="vaiGen">&#128203; Inclusa nella fattura generale <b>n. ${numGen(g)}</b> (aperta) &rsaquo;</div>`;
  }
  h += `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
      <div><h2>${esc(f.nome)}</h2>
        <div class="muted">N. ${r.numero}/${r.anno} · ${fmtDate(r.data)}</div>
        ${r.pdfSalvato ? `<div class="muted">PDF salvato il ${new Date(r.pdfSalvato).toLocaleString('it-IT')}</div>` : ''}
      </div>
      <div>
        ${saldata ? '<span class="badge closed">&#128274; saldata</span>'
          : `<span class="badge ${r.chiuso ? 'closed' : 'open'}">${r.chiuso ? 'chiuso' : 'aperto'}</span>`}
        ${!r.chiuso ? '<button class="btn small" id="modTest" style="margin-top:.4rem;display:block">Modifica</button>' : ''}
      </div>
    </div>
  </div>`;

  if (!r.chiuso) {
    h += `<div class="card">
      <h3>Aggiungi collo</h3>
      <div class="chips">
        ${S.merci.map(m => `<button class="chip ${m.id === selMerce ? 'active' : ''}" data-merce="${m.id}">${esc(m.nome)}</button>`).join('')}
      </div>
      <form id="fPeso" class="weigh-row" autocomplete="off">
        <input id="peso" inputmode="decimal" placeholder="0,00" aria-label="Peso in kg">
        <span class="unit">kg</span>
        <button class="btn primary" type="submit">Aggiungi</button>
      </form>
      ${r.pesate.length ? '<div class="btn-row"><button class="btn small" id="undo">&#8630; Annulla ultima pesata</button></div>' : ''}
    </div>`;
  }

  // Dettaglio pesate
  h += `<div class="card"><h3>Pesate</h3>`;
  if (!c.righe.length) h += `<div class="muted">Nessuna pesata inserita.</div>`;
  for (const riga of c.righe) {
    h += `<div style="margin:.6rem 0 .3rem"><b>${esc(riga.nome)}</b>
      <span class="muted">· ${riga.pesate.length} colli · ${fmtKg(riga.kg)} kg</span></div>
      <div class="weights">
        ${riga.pesate.map((p, i) => `<span class="weight" data-p="${p.id}"><small>${i + 1})</small>${fmtKg(p.peso)}</span>`).join('')}
      </div>`;
  }
  if (c.righe.length && !r.chiuso) h += `<p class="muted">Tocca una pesata per correggerla o eliminarla.</p>`;
  h += `</div>`;

  // Riepilogo
  h += `<div class="card"><h3>Riepilogo</h3>`;
  if (c.righe.length) {
    h += `<table class="summary">
      <thead><tr><th>Merce</th><th>Colli</th><th>Kg</th><th>€/kg</th><th>Importo</th></tr></thead>
      <tbody>
        ${c.righe.map(riga => `<tr>
          <td>${esc(riga.nome)}</td>
          <td>${riga.pesate.length}</td>
          <td>${fmtKg(riga.kg)}</td>
          <td>${r.chiuso ? fmtEur(riga.prezzo)
            : `<input class="price-input" inputmode="decimal" data-prezzo="${riga.merceId}" value="${riga.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 })}">`}</td>
          <td>${fmtEur(riga.importo)}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr><td>Totale</td><td>${c.colli}</td><td>${fmtKg(c.kg)}</td><td></td><td></td></tr></tfoot>
    </table>
    <div class="total-big" style="margin-top:.5rem">${fmtEur(c.totale)}</div>`;
  } else {
    h += `<div class="muted">Il riepilogo apparirà dopo la prima pesata.</div>`;
  }
  h += `</div>`;

  // Note
  h += `<div class="card"><h3>Note (compaiono sul PDF)</h3>
    <textarea id="note" ${r.chiuso ? 'disabled' : ''} placeholder="Facoltative">${esc(r.note)}</textarea></div>`;

  // Azioni
  h += `<div class="card">
    <button class="btn primary block" id="drive">&#9729; Salva PDF su Google Drive</button>
    ${r.driveLink ? `<p class="muted" style="text-align:center">Su Drive dal ${new Date(r.pdfSalvato).toLocaleString('it-IT')} · <a href="${esc(r.driveLink)}" target="_blank" rel="noopener">Apri su Drive</a></p>` : ''}
    <div class="btn-row">
      <button class="btn" id="pdfShare">&#128228; Condividi</button>
      <button class="btn" id="pdfDown">&#11015; Scarica</button>
      <button class="btn" id="pdfView">&#128065; Anteprima</button>
    </div>
    ${saldata ? '' : `<div class="btn-row">
      <button class="btn" id="toggleChiuso">${r.chiuso ? '&#128275; Riapri ritiro' : '&#10004; Chiudi ritiro'}</button>
      <button class="btn danger" id="elimina">Elimina</button>
    </div>`}
  </div>`;

  v.innerHTML = h;

  // --- eventi ---
  $('#vaiGen')?.addEventListener('click', () => {
    const prev = nav.stack[nav.stack.length - 2];
    if (prev && prev.tipo === 'generale' && prev.id === g.id) history.back();
    else apriGenerale(g.id);
  });
  $('#modTest')?.addEventListener('click', () => modificaTestata(r));

  $$('.chip', v).forEach(ch => ch.addEventListener('click', () => {
    selMerce = ch.dataset.merce;
    $$('.chip', v).forEach(x => x.classList.toggle('active', x === ch));
    $('#peso').focus();
  }));

  $('#fPeso')?.addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#peso');
    const peso = parseNum(inp.value);
    if (!selMerce) return toast('Seleziona una merce');
    if (!(peso > 0)) { toast('Peso non valido'); inp.select(); return; }
    if (peso > 1000 && !confirm(`Confermi un collo da ${fmtKg(peso)} kg?`)) return;
    const m = getMerce(selMerce);
    if (!r.righe[selMerce]) r.righe[selMerce] = { nome: m.nome, prezzo: m.prezzo };
    r.pesate.push({ id: uid(), merceId: selMerce, peso: round3(peso), ora: nowTime() });
    save();
    const n = r.pesate.filter(p => p.merceId === selMerce).length;
    render();
    $('#peso')?.focus();
    toast(`${m.nome} – collo ${n}: ${fmtKg(peso)} kg`);
  });

  $('#undo')?.addEventListener('click', () => {
    const p = r.pesate[r.pesate.length - 1];
    if (!p) return;
    if (!confirm(`Eliminare l'ultima pesata (${r.righe[p.merceId]?.nome} ${fmtKg(p.peso)} kg)?`)) return;
    r.pesate.pop();
    pulisciRighe(r);
    save(); render();
  });

  if (!r.chiuso) $$('.weight', v).forEach(el => el.addEventListener('click', () => modificaPesata(r, el.dataset.p)));

  $$('[data-prezzo]', v).forEach(inp => inp.addEventListener('change', () => {
    const id = inp.dataset.prezzo;
    const prezzo = parseNum(inp.value);
    if (!(prezzo >= 0)) { toast('Prezzo non valido'); return render(); }
    r.righe[id].prezzo = round2(prezzo) === prezzo ? prezzo : Math.round(prezzo * 10000) / 10000;
    const m = getMerce(id);
    if (m && m.prezzo !== r.righe[id].prezzo &&
        confirm(`Aggiornare anche il prezzo di listino di "${m.nome}" a ${fmtEur(r.righe[id].prezzo)}/kg?`)) {
      cambiaPrezzoListino(m, r.righe[id].prezzo);
    }
    save(); render();
  }));

  $('#note').addEventListener('change', e => { r.note = e.target.value; save(); });

  $('#drive').addEventListener('click', () => {
    if (!controllaPerPdf(r)) return;
    salvaSuDrive(r);
  });
  $('#pdfShare').addEventListener('click', async () => {
    if (!controllaPerPdf(r)) return;
    const { doc, nome } = creaPdf(r);
    const ok = await condividiFile(doc.output('blob'), nome, 'application/pdf');
    if (ok === true) toast('PDF condiviso');
  });
  $('#pdfDown').addEventListener('click', () => {
    if (!controllaPerPdf(r)) return;
    const { doc, nome } = creaPdf(r);
    doc.save(nome);
  });
  $('#pdfView').addEventListener('click', () => {
    if (!controllaPerPdf(r)) return;
    const { doc } = creaPdf(r);
    window.open(doc.output('bloburl'), '_blank');
  });

  $('#toggleChiuso')?.addEventListener('click', () => {
    r.chiuso = !r.chiuso;
    save(); render();
    toast(r.chiuso ? 'Ritiro chiuso: pesate bloccate' : 'Ritiro riaperto');
  });

  $('#elimina')?.addEventListener('click', () => {
    if (!confirm(`Eliminare definitivamente il ritiro N. ${r.numero}/${r.anno} con ${r.pesate.length} pesate?`)) return;
    S.ritiri = S.ritiri.filter(x => x !== r);
    rimuoviSeVuota(g);
    save();
    history.back();
  });
}

function pulisciRighe(r) {
  const usate = new Set(r.pesate.map(p => p.merceId));
  for (const k of Object.keys(r.righe)) if (!usate.has(k)) delete r.righe[k];
}

function modificaTestata(r) {
  dialogForm(`<h2>Modifica ritiro</h2>
    <label>Fornitore</label>
    <select name="fornitoreId">
      ${S.fornitori.map(f => `<option value="${f.id}" ${f.id === r.fornitoreId ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}
    </select>
    <label>Data</label>
    <input type="date" name="data" value="${r.data}" required>`,
    d => {
      if (d.fornitoreId !== r.fornitoreId) {
        const vecchia = getGenerale(r.generaleId);
        r.generaleId = generaleAperta(d.fornitoreId, true).id;
        r.fornitoreId = d.fornitoreId;
        rimuoviSeVuota(vecchia);
      }
      r.fornitoreSnap = { ...S.fornitori.find(f => f.id === d.fornitoreId) };
      r.data = d.data;
      save(); render();
    }, { noFocus: true });
}

function modificaPesata(r, pid) {
  const p = r.pesate.find(x => x.id === pid);
  if (!p) return;
  dialogForm(`<h2>Modifica pesata</h2>
    <p class="muted">Inserita alle ${esc(p.ora || '')}</p>
    <label>Merce</label>
    <select name="merceId">
      ${S.merci.map(m => `<option value="${m.id}" ${m.id === p.merceId ? 'selected' : ''}>${esc(m.nome)}</option>`).join('')}
      ${getMerce(p.merceId) ? '' : `<option value="${p.merceId}" selected>${esc(r.righe[p.merceId]?.nome)}</option>`}
    </select>
    <label>Peso (kg)</label>
    <input name="peso" inputmode="decimal" value="${p.peso.toLocaleString('it-IT', { maximumFractionDigits: 3 })}" required>`,
    d => {
      const peso = parseNum(d.peso);
      if (!(peso > 0)) { toast('Peso non valido'); return false; }
      p.peso = round3(peso);
      if (d.merceId !== p.merceId) {
        p.merceId = d.merceId;
        const m = getMerce(d.merceId);
        if (m && !r.righe[d.merceId]) r.righe[d.merceId] = { nome: m.nome, prezzo: m.prezzo };
        pulisciRighe(r);
      }
      save(); render();
    }, {
      onDelete: () => {
        if (!confirm('Eliminare questa pesata?')) return false;
        r.pesate = r.pesate.filter(x => x !== p);
        pulisciRighe(r);
        save(); render();
      }
    });
}

/* ---------------- Vista: conti (fatture generali) ---------------- */

function viewConti(v) {
  setTitle('Conti fornitori');
  const aperte = S.generali.filter(g => !g.chiusa)
    .sort((a, b) => fornitoreDi(a).nome.localeCompare(fornitoreDi(b).nome));
  let chiuse = S.generali.filter(g => g.chiusa)
    .sort((a, b) => b.saldo.data.localeCompare(a.saldo.data) || b.numero - a.numero);
  if (nav.filtroForn) chiuse = chiuse.filter(g => g.fornitoreId === nav.filtroForn);

  let h = `<h3 class="sez">Fatture generali aperte</h3>`;
  if (!aperte.length) {
    h += `<div class="empty">Nessun conto aperto.<br>Si apre da solo quando crei una pro forma.</div>`;
  } else {
    let totRes = 0;
    h += aperte.map(g => {
      const c = calcolaGenerale(g);
      totRes += c.residuo;
      return `<div class="list-item" data-g="${g.id}">
        <div class="main">
          <div class="title">${esc(fornitoreDi(g).nome)} <span class="badge open">aperta</span></div>
          <div class="sub">n. ${numGen(g)} · ${c.ritiri.length} pro forma · merce ${fmtEur(c.totale)} · acconti ${fmtEur(c.totAcconti)}</div>
        </div>
        <div class="right"><div class="muted" style="font-weight:400;font-size:.75rem">da pagare</div>${fmtEur(c.residuo)}</div>
      </div>`;
    }).join('');
    if (aperte.length > 1) h += `<p class="muted" style="text-align:right">Totale da pagare: <b>${fmtEur(round2(totRes))}</b></p>`;
  }

  h += `<h3 class="sez">Fatture generali saldate</h3>`;
  if (S.fornitori.length > 1) {
    h += `<select id="filtro" style="margin-bottom:.75rem">
      <option value="">Tutti i fornitori</option>
      ${S.fornitori.map(f => `<option value="${f.id}" ${f.id === nav.filtroForn ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}
    </select>`;
  }
  if (!chiuse.length) h += `<div class="muted" style="text-align:center">Nessuna fattura generale saldata.</div>`;
  h += chiuse.map(g => {
    const c = calcolaGenerale(g);
    return `<div class="list-item" data-g="${g.id}">
      <div class="main">
        <div class="title">${esc(fornitoreDi(g).nome)} <span class="badge closed">&#128274; saldata</span></div>
        <div class="sub">n. ${numGen(g)} del ${fmtDate(g.saldo.data)} · ${c.ritiri.length} pro forma</div>
      </div>
      <div class="right">${fmtEur(c.totale)}</div>
    </div>`;
  }).join('');

  h += `<button class="fab" id="nuovoConto" aria-label="Apri conto fornitore">+</button>`;
  v.innerHTML = h;

  $('#filtro')?.addEventListener('change', e => { nav.filtroForn = e.target.value; render(); });
  $$('[data-g]', v).forEach(el => el.addEventListener('click', () => apriGenerale(el.dataset.g)));
  $('#nuovoConto').addEventListener('click', () => {
    if (!S.fornitori.length) { toast('Prima aggiungi almeno un fornitore'); return vaiTab('fornitori'); }
    dialogForm(`<h2>Conto fornitore</h2>
      <p class="muted">Apre la fattura generale in corso del fornitore (utile per registrare un acconto prima del ritiro).</p>
      <label>Fornitore</label>
      <select name="fornitoreId">${S.fornitori.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('')}</select>`,
      d => {
        const g = generaleAperta(d.fornitoreId, true);
        save();
        setTimeout(() => apriGenerale(g.id), 0);
      }, { okLabel: 'Apri', noFocus: true });
  });
}

function viewGenerale(v, g) {
  const c = calcolaGenerale(g);
  const f = fornitoreDi(g);
  setTitle(`Fattura generale ${numGen(g)}`);

  let h = '';
  if (g.chiusa) {
    h += `<div class="card banner-ok">&#128274; <b>Saldata il ${fmtDate(g.saldo.data)}</b>. La fattura generale e tutte le pro forma incluse sono bloccate.</div>`;
  }
  h += `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
      <div><h2>${esc(f.nome)}</h2>
        <div class="muted">Fattura generale n. ${numGen(g)}${g.chiusa ? ' del ' + fmtDate(g.saldo.data) : ' · aperta dal ' + fmtDate(g.creata)}</div>
        ${g.pdfSalvato ? `<div class="muted">PDF salvato il ${new Date(g.pdfSalvato).toLocaleString('it-IT')}</div>` : ''}
      </div>
      ${g.chiusa ? '<span class="badge closed">&#128274; saldata</span>' : '<span class="badge open">aperta</span>'}
    </div>
  </div>`;

  // Situazione
  h += `<div class="card"><h3>Situazione${g.chiusa ? '' : ' al ' + fmtDate(today())}</h3>
    <table class="summary">
      <tr><td>Totale merce (${c.ritiri.length} pro forma, ${fmtKg(c.kg)} kg)</td><td>${fmtEur(c.totale)}</td></tr>
      <tr><td>Acconti versati (${c.acconti.length})</td><td>&minus; ${fmtEur(c.totAcconti)}</td></tr>
      ${g.chiusa ? `<tr><td>Saldo versato il ${fmtDate(g.saldo.data)}</td><td>&minus; ${fmtEur(c.saldo)}</td></tr>` : ''}
    </table>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:.5rem">
      <span class="muted">${g.chiusa ? (c.residuo ? 'Differenza non pagata' : 'Tutto saldato') : 'Residuo da pagare'}</span>
      <span class="total-big">${fmtEur(c.residuo)}</span>
    </div>
  </div>`;

  // Acconti
  h += `<div class="card"><h3>Acconti</h3>`;
  if (!c.acconti.length) h += `<div class="muted">Nessun acconto registrato.</div>`;
  h += c.acconti.map(a => `<div class="list-item" data-acc="${a.id}" style="padding:.6rem .8rem">
      <div class="main"><div class="title">${fmtDate(a.data)}</div><div class="sub">${esc(a.note || '')}</div></div>
      <div class="right">${fmtEur(a.importo)}</div>
    </div>`).join('');
  if (!g.chiusa) h += `<button class="btn block" id="nuovoAcc" style="margin-top:.5rem">+ Aggiungi acconto</button>`;
  h += `</div>`;

  if (g.chiusa) {
    h += `<div class="card"><h3>Saldo</h3>
      <div>Pagato il <b>${fmtDate(g.saldo.data)}</b>: <b>${fmtEur(g.saldo.importo)}</b></div>
      ${g.saldo.note ? `<div class="muted">${esc(g.saldo.note)}</div>` : ''}
    </div>`;
  }

  // Pro forma incluse
  h += `<div class="card"><h3>Pro forma incluse</h3>`;
  if (!c.ritiri.length) h += `<div class="muted">Nessuna pro forma: le nuove pro forma di questo fornitore entreranno qui automaticamente.</div>`;
  h += c.ritiri.map(({ r, c: rc }) => `<div class="list-item" data-r="${r.id}" style="padding:.6rem .8rem">
      <div class="main">
        <div class="title">N. ${r.numero}/${r.anno} · ${fmtDate(r.data)}
          ${g.chiusa ? '' : `<span class="badge ${r.chiuso ? 'closed' : 'open'}">${r.chiuso ? 'chiusa' : 'in corso'}</span>`}</div>
        <div class="sub">${rc.colli} colli · ${fmtKg(rc.kg)} kg</div>
      </div>
      <div class="right">${fmtEur(rc.totale)}</div>
    </div>`).join('');
  h += `</div>`;

  // Riepilogo per merce
  if (c.merci.length) {
    h += `<div class="card"><h3>Riepilogo per merce</h3>
      <table class="summary">
        <thead><tr><th>Merce</th><th>Colli</th><th>Kg</th><th>€/kg</th><th>Importo</th></tr></thead>
        <tbody>${c.merci.map(m => `<tr><td>${esc(m.nome)}</td><td>${m.colli}</td><td>${fmtKg(m.kg)}</td><td>${fmtEur(m.prezzo)}</td><td>${fmtEur(m.importo)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Totale</td><td>${c.colli}</td><td>${fmtKg(c.kg)}</td><td></td><td>${fmtEur(c.totale)}</td></tr></tfoot>
      </table>
      ${round2(c.merci.reduce((s, m) => s + m.importo, 0)) !== c.totale ? '<p class="muted">Piccole differenze di centesimi sono dovute agli arrotondamenti delle singole pro forma; fa fede il totale delle pro forma.</p>' : ''}
    </div>`;
  }

  // Dettaglio pesate di tutti i ritiri
  if (c.ritiri.some(({ r }) => r.pesate.length)) {
    h += `<div class="card"><h3>Dettaglio pesate dei ritiri</h3>`;
    for (const { r, c: rc } of c.ritiri) {
      if (!rc.righe.length) continue;
      h += `<div style="margin:.8rem 0 .3rem;padding-top:.4rem;border-top:1px solid var(--border)">
        <b>N. ${r.numero}/${r.anno} del ${fmtDate(r.data)}</b>
        <span class="muted">· ${rc.colli} colli · ${fmtKg(rc.kg)} kg · ${fmtEur(rc.totale)}</span>
      </div>`;
      for (const riga of rc.righe) {
        h += `<div style="margin:.4rem 0 .2rem;font-size:.9rem"><b>${esc(riga.nome)}</b>
          <span class="muted">· ${riga.pesate.length} colli · ${fmtKg(riga.kg)} kg</span></div>
          <div class="weights">
            ${riga.pesate.map((p, i) => `<span class="weight"><small>${i + 1})</small>${fmtKg(p.peso)}</span>`).join('')}
          </div>`;
      }
    }
    h += `</div>`;
  }

  // Azioni
  h += `<div class="card">
    <button class="btn primary block" id="gDrive">&#9729; Salva PDF su Google Drive</button>
    ${g.driveLink ? `<p class="muted" style="text-align:center"><a href="${esc(g.driveLink)}" target="_blank" rel="noopener">Apri su Drive</a></p>` : ''}
    <div class="btn-row">
      <button class="btn" id="gShare">&#128228; Condividi</button>
      <button class="btn" id="gDown">&#11015; Scarica</button>
      <button class="btn" id="gView">&#128065; Anteprima</button>
    </div>
    ${g.chiusa
      ? `<div class="btn-row"><button class="btn" id="gDriveTutti">&#9729; Aggiorna su Drive anche tutte le pro forma</button></div>
         <div class="btn-row"><button class="btn danger" id="gAnnulla">Annulla saldo</button></div>`
      : `<div class="btn-row"><button class="btn primary" id="gSaldo" style="background:var(--ok);border-color:var(--ok)">&#10004; Registra saldo e chiudi</button></div>`}
  </div>`;

  v.innerHTML = h;

  $$('[data-r]', v).forEach(el => el.addEventListener('click', () => apriRitiro(el.dataset.r)));
  if (!g.chiusa) $$('[data-acc]', v).forEach(el => el.addEventListener('click', () => formAcconto(g, g.acconti.find(a => a.id === el.dataset.acc))));
  $('#nuovoAcc')?.addEventListener('click', () => formAcconto(g, null));
  $('#gSaldo')?.addEventListener('click', () => formSaldo(g));
  $('#gAnnulla')?.addEventListener('click', () => annullaSaldo(g));

  const okPdf = () => {
    if (!S.azienda.ragioneSociale) { alert('Imposta prima la tua ragione sociale in Impostazioni.'); return false; }
    return true;
  };
  $('#gDrive').addEventListener('click', () => {
    if (!okPdf()) return;
    salvaSuDrive(g, () => creaPdfGenerale(g), $('#gDrive'));
  });
  $('#gShare').addEventListener('click', () => {
    if (!okPdf()) return;
    const { doc, nome } = creaPdfGenerale(g);
    condividiFile(doc.output('blob'), nome, 'application/pdf');
  });
  $('#gDown').addEventListener('click', () => { if (okPdf()) { const { doc, nome } = creaPdfGenerale(g); doc.save(nome); } });
  $('#gView').addEventListener('click', () => { if (okPdf()) window.open(creaPdfGenerale(g).doc.output('bloburl'), '_blank'); });
  $('#gDriveTutti')?.addEventListener('click', () => { if (okPdf()) salvaTuttiSuDrive(g, $('#gDriveTutti')); });
}

function formAcconto(g, a) {
  dialogForm(`<h2>${a ? 'Modifica acconto' : 'Nuovo acconto'}</h2>
    <p class="muted">${esc(fornitoreDi(g).nome)} · fattura generale ${numGen(g)}</p>
    <label>Data</label>
    <input type="date" name="data" value="${a ? a.data : today()}" required>
    <label>Importo (€)</label>
    <input name="importo" inputmode="decimal" value="${a ? a.importo.toLocaleString('it-IT', { minimumFractionDigits: 2 }) : ''}" placeholder="0,00" required>
    <label>Note</label>
    <input name="note" value="${esc(a?.note)}" placeholder="es. contanti, bonifico, assegno">`,
    d => {
      const importo = parseNum(d.importo);
      if (!(importo > 0)) { toast('Importo non valido'); return false; }
      const dati = { data: d.data, importo: round2(importo), note: d.note.trim() };
      if (a) Object.assign(a, dati);
      else g.acconti.push({ id: uid(), ...dati });
      save(); render();
      toast(a ? 'Acconto modificato' : 'Acconto registrato');
    }, {
      noFocus: true,
      onDelete: a ? () => {
        if (!confirm(`Eliminare l'acconto del ${fmtDate(a.data)} di ${fmtEur(a.importo)}?`)) return false;
        g.acconti = g.acconti.filter(x => x !== a);
        save(); render();
      } : null
    });
}

function formSaldo(g) {
  const rit = ritiriDi(g);
  if (!rit.length) return alert('Questa fattura generale non contiene pro forma da saldare.');
  const ultima = rit[rit.length - 1].data;
  dialogForm(`<h2>Registra saldo</h2>
    <p class="muted">${esc(fornitoreDi(g).nome)} · fattura generale ${numGen(g)}</p>
    <label>Data del saldo *</label>
    <input type="date" name="data" value="${today()}" required>
    <label>Includi le pro forma fino al</label>
    <input type="date" name="fino" value="${ultima}" required>
    <label>Importo pagato a saldo (€)</label>
    <input name="importo" inputmode="decimal" placeholder="vuoto = tutto il residuo">
    <label>Note</label>
    <input name="note" placeholder="es. bonifico, assegno n. ...">
    <p class="muted">Le pro forma con data successiva passeranno automaticamente alla nuova fattura generale.</p>`,
    d => {
      const incl = rit.filter(r => r.data <= d.fino);
      const escl = rit.filter(r => r.data > d.fino);
      if (!incl.length) { alert('Nessuna pro forma fino a quella data.'); return false; }
      const tot = round2(incl.reduce((s, r) => s + calcola(r).totale, 0));
      const acc = round2(g.acconti.reduce((s, a) => s + a.importo, 0));
      const residuo = round2(tot - acc);
      const importo = d.importo.trim() ? parseNum(d.importo) : residuo;
      if (!Number.isFinite(importo)) { toast('Importo non valido'); return false; }
      const diff = round2(residuo - importo);
      const aperte = incl.filter(r => !r.chiuso).length;
      let msg = `SALDO fattura generale ${numGen(g)}\n${fornitoreDi(g).nome}\n\n` +
        `${incl.length} pro forma: ${fmtEur(tot)}\nAcconti: − ${fmtEur(acc)}\nSaldo del ${fmtDate(d.data)}: − ${fmtEur(importo)}`;
      if (diff) msg += `\n\n⚠ Differenza non pagata: ${fmtEur(diff)}`;
      if (aperte) msg += `\n\n${aperte} pro forma ancora aperte verranno chiuse.`;
      if (escl.length) msg += `\n\n${escl.length} pro forma successive al ${fmtDate(d.fino)} passeranno alla nuova fattura generale.`;
      msg += '\n\nDopo il saldo la fattura generale e tutte le pro forma incluse saranno BLOCCATE. Confermi?';
      if (!confirm(msg)) return false;

      g.saldo = { data: d.data, importo: round2(importo), note: d.note.trim(), fino: d.fino };
      g.chiusa = true;
      g.fornitoreSnap = { ...fornitoreDi(g) };
      incl.forEach(r => { r.chiuso = true; r.fornitoreSnap = { ...fornitoreDi(r) }; });
      if (escl.length) {
        const nuova = generaleAperta(g.fornitoreId, true);
        escl.forEach(r => { r.generaleId = nuova.id; });
      }
      save(); render();
      toast('Saldo registrato ✔');
    }, { okLabel: 'Registra saldo', noFocus: true });
}

function annullaSaldo(g) {
  const ultima = S.generali.filter(x => x.fornitoreId === g.fornitoreId && x.chiusa)
    .sort((a, b) => b.saldo.data.localeCompare(a.saldo.data) || b.numero - a.numero)[0];
  if (ultima !== g) return alert(`Si può annullare solo l'ultimo saldo di questo fornitore (fattura generale ${numGen(ultima)}).`);
  const aperta = generaleAperta(g.fornitoreId);
  let msg = `Annullare il saldo della fattura generale ${numGen(g)}?\nLa fattura generale e le sue pro forma torneranno modificabili.`;
  if (aperta) msg += `\n\nLa fattura generale aperta ${numGen(aperta)} (${ritiriDi(aperta).length} pro forma, ${aperta.acconti.length} acconti) verrà unita a questa.`;
  if (!confirm(msg)) return;
  if (aperta) {
    ritiriDi(aperta).forEach(r => { r.generaleId = g.id; });
    g.acconti.push(...aperta.acconti);
    S.generali = S.generali.filter(x => x !== aperta);
  }
  g.chiusa = false;
  g.saldo = null;
  save(); render();
  toast('Saldo annullato');
}

/* ---------------- Vista: merci ---------------- */

function cambiaPrezzoListino(m, prezzo) {
  m.prezzo = prezzo;
  m.storico = m.storico || [];
  const t = today();
  const ultimo = m.storico[m.storico.length - 1];
  if (ultimo && ultimo.dal === t) ultimo.prezzo = prezzo;
  else m.storico.push({ dal: t, prezzo });
}

function viewMerci(v) {
  setTitle('Merci e prezzi');
  let h = '';
  if (!S.merci.length) h += `<div class="empty">Nessuna merce.<br>Tocca <b>+</b> per aggiungere un formaggio con il suo prezzo al kg.</div>`;
  h += [...S.merci].sort((a, b) => a.nome.localeCompare(b.nome)).map(m => {
    const prec = (m.storico || []).length > 1 ? m.storico[m.storico.length - 2] : null;
    return `<div class="list-item" data-id="${m.id}">
      <div class="main"><div class="title">${esc(m.nome)}</div>
        <div class="sub">${m.storico?.length ? 'dal ' + fmtDate(m.storico[m.storico.length - 1].dal) : ''}
        ${prec ? ` · prima ${fmtEur(prec.prezzo)}` : ''}</div></div>
      <div class="right">${fmtEur(m.prezzo)}/kg</div>
    </div>`;
  }).join('');
  h += `<button class="fab" id="nuova" aria-label="Nuova merce">+</button>`;
  v.innerHTML = h;
  $$('.list-item', v).forEach(el => el.addEventListener('click', () => formMerce(getMerce(el.dataset.id))));
  $('#nuova').addEventListener('click', () => formMerce(null));
}

function formMerce(m) {
  const storico = (m?.storico || []).slice().reverse();
  dialogForm(`<h2>${m ? 'Modifica merce' : 'Nuova merce'}</h2>
    <label>Nome</label>
    <input name="nome" value="${esc(m?.nome)}" required placeholder="es. Pecorino Romano">
    <label>Prezzo al kg (€)</label>
    <input name="prezzo" inputmode="decimal" value="${m ? m.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2 }) : ''}" required placeholder="0,00">
    ${storico.length ? `<label>Storico prezzi</label><div class="muted">${storico.map(s => `${fmtDate(s.dal)}: ${fmtEur(s.prezzo)}`).join('<br>')}</div>` : ''}`,
    d => {
      const prezzo = parseNum(d.prezzo);
      const nome = d.nome.trim();
      if (!nome) return false;
      if (!(prezzo >= 0)) { toast('Prezzo non valido'); return false; }
      if (!m) {
        S.merci.push({ id: uid(), nome, prezzo, storico: [{ dal: today(), prezzo }] });
      } else {
        m.nome = nome;
        if (prezzo !== m.prezzo) {
          cambiaPrezzoListino(m, prezzo);
          const aperti = S.ritiri.filter(r => !r.chiuso && r.righe[m.id] && r.righe[m.id].prezzo !== prezzo);
          if (aperti.length && confirm(`Applicare il nuovo prezzo anche a ${aperti.length} ritiro/i ancora aperto/i?`)) {
            aperti.forEach(r => { r.righe[m.id].prezzo = prezzo; });
          }
        }
        // aggiorna il nome nei ritiri aperti
        S.ritiri.filter(r => !r.chiuso && r.righe[m.id]).forEach(r => { r.righe[m.id].nome = nome; });
      }
      save(); render();
    }, {
      onDelete: m ? () => {
        if (!confirm(`Eliminare "${m.nome}"? I ritiri già fatti restano invariati.`)) return false;
        S.merci = S.merci.filter(x => x !== m);
        save(); render();
      } : null
    });
}

/* ---------------- Vista: fornitori ---------------- */

function viewFornitori(v) {
  setTitle('Fornitori');
  let h = '';
  if (!S.fornitori.length) h += `<div class="empty">Nessun fornitore.<br>Tocca <b>+</b> per aggiungerne uno.</div>`;
  h += [...S.fornitori].sort((a, b) => a.nome.localeCompare(b.nome)).map(f => {
    const n = S.ritiri.filter(r => r.fornitoreId === f.id).length;
    return `<div class="list-item" data-id="${f.id}">
      <div class="main"><div class="title">${esc(f.nome)}</div>
        <div class="sub">${esc([f.indirizzo?.split('\n')[0], f.piva && 'P.IVA ' + f.piva].filter(Boolean).join(' · '))}</div></div>
      <div class="right muted">${n} ritiri</div>
    </div>`;
  }).join('');
  h += `<button class="fab" id="nuovo" aria-label="Nuovo fornitore">+</button>`;
  v.innerHTML = h;
  $$('.list-item', v).forEach(el => el.addEventListener('click', () => formFornitore(S.fornitori.find(f => f.id === el.dataset.id))));
  $('#nuovo').addEventListener('click', () => formFornitore(null));
}

function formFornitore(f) {
  dialogForm(`<h2>${f ? 'Modifica fornitore' : 'Nuovo fornitore'}</h2>
    <label>Ragione sociale / Nome</label>
    <input name="nome" value="${esc(f?.nome)}" required>
    <label>Indirizzo</label>
    <textarea name="indirizzo" placeholder="Via, CAP, Città">${esc(f?.indirizzo)}</textarea>
    <label>Partita IVA</label>
    <input name="piva" value="${esc(f?.piva)}">
    <label>Telefono</label>
    <input name="telefono" type="tel" value="${esc(f?.telefono)}">
    <label>Email</label>
    <input name="email" type="email" value="${esc(f?.email)}">`,
    d => {
      const dati = { nome: d.nome.trim(), indirizzo: d.indirizzo.trim(), piva: d.piva.trim(), telefono: d.telefono.trim(), email: d.email.trim() };
      if (!dati.nome) return false;
      if (f) {
        Object.assign(f, dati);
        S.ritiri.filter(r => r.fornitoreId === f.id && !r.chiuso).forEach(r => { r.fornitoreSnap = { ...f }; });
        S.generali.filter(g => g.fornitoreId === f.id && !g.chiusa).forEach(g => { g.fornitoreSnap = { ...f }; });
      } else {
        S.fornitori.push({ id: uid(), ...dati });
      }
      save(); render();
    }, {
      onDelete: f ? () => {
        if (!confirm(`Eliminare il fornitore "${f.nome}"? I ritiri già fatti restano nell'archivio.`)) return false;
        S.ritiri.filter(r => r.fornitoreId === f.id).forEach(r => { r.fornitoreSnap = { ...f }; });
        S.generali.filter(g => g.fornitoreId === f.id).forEach(g => { g.fornitoreSnap = { ...f }; });
        S.fornitori = S.fornitori.filter(x => x !== f);
        save(); render();
      } : null
    });
}

/* ---------------- Vista: impostazioni ---------------- */

function viewImpostazioni(v) {
  setTitle('Impostazioni');
  const A = S.azienda;
  const nPesate = S.ritiri.reduce((s, r) => s + r.pesate.length, 0);
  v.innerHTML = `
    <form class="card" id="fAzienda">
      <h2>I tuoi dati (intestazione PDF)</h2>
      <label>Ragione sociale</label>
      <input name="ragioneSociale" value="${esc(A.ragioneSociale)}" required>
      <label>Indirizzo</label>
      <textarea name="indirizzo" placeholder="Via, CAP, Città">${esc(A.indirizzo)}</textarea>
      <label>Partita IVA</label>
      <input name="piva" value="${esc(A.piva)}">
      <label>Codice fiscale</label>
      <input name="cf" value="${esc(A.cf)}">
      <label>Telefono</label>
      <input name="telefono" type="tel" value="${esc(A.telefono)}">
      <label>Email</label>
      <input name="email" type="email" value="${esc(A.email)}">
      <label>Nota a piè di pagina (facoltativa)</label>
      <textarea name="notaPdf" placeholder="es. IBAN, condizioni di pagamento...">${esc(A.notaPdf)}</textarea>
      <button class="btn primary block" style="margin-top:1rem">Salva dati</button>
    </form>

    <form class="card" id="fDrive">
      <h2>&#9729; Google Drive</h2>
      <p class="muted">${S.drive.clientId ? '&#9989; Configurato.' : '&#9888;&#65039; Non configurato: serve un "ID client" Google (gratuito, da creare una sola volta).'}</p>
      <label>ID client OAuth Google</label>
      <input name="clientId" value="${esc(S.drive.clientId)}" placeholder="123456-abc.apps.googleusercontent.com" autocomplete="off">
      <label>Nome cartella su Drive</label>
      <input name="cartella" value="${esc(S.drive.cartella)}" required>
      <label style="display:flex;gap:.5rem;align-items:center;color:var(--text)">
        <input type="checkbox" name="perFornitore" style="width:auto" ${S.drive.perFornitore ? 'checked' : ''}>
        Una sottocartella per ogni fornitore
      </label>
      <div class="btn-row">
        <button class="btn primary" type="submit">Salva</button>
        <button class="btn" type="button" id="provaDrive">Prova collegamento</button>
      </div>
      <details style="margin-top:1rem">
        <summary><b>Come ottenere l'ID client (5 minuti, una volta sola)</b></summary>
        <ol class="muted" style="padding-left:1.2rem">
          <li>Apri <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> con il tuo account Google e crea un progetto (es. "Fatti Conti").</li>
          <li>Vai su <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">API Google Drive</a> e premi <b>Abilita</b>.</li>
          <li>Vai su <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a> &rarr; <b>Inizia</b>: nome app "Fatti Conti", la tua email, tipo <b>Esterno</b>.</li>
          <li>In <b>Pubblico / Audience</b> aggiungi la tua email come <b>utente di test</b> (oppure premi "Pubblica app").</li>
          <li>In <b>Client</b> &rarr; <b>Crea client</b> &rarr; tipo <b>Applicazione web</b>. In <b>Origini JavaScript autorizzate</b> aggiungi:<br>
            <code style="user-select:all">${esc(location.origin)}</code><br>
            (e anche l'indirizzo GitHub Pages, es. <code>https://tuonome.github.io</code>, quando la pubblichi).</li>
          <li>Copia l'<b>ID client</b> e incollalo qui sopra.</li>
        </ol>
        <p class="muted">L'app può vedere su Drive <b>solo i file che crea lei</b>, non il resto del tuo Drive.</p>
      </details>
    </form>

    <div class="card">
      <h2>Backup dei dati</h2>
      <p class="muted">I dati (${S.ritiri.length} ritiri, ${nPesate} pesate) sono salvati solo su questo dispositivo.
      Fai periodicamente un backup e salvalo su Google Drive.</p>
      ${S.drive.clientId ? '<button class="btn primary block" id="expDrive">&#9729; Backup su Google Drive</button>' : ''}
      <div class="btn-row">
        <button class="btn" id="exp">&#128228; Esporta backup</button>
        <button class="btn" id="imp">&#128229; Importa backup</button>
      </div>
      <input type="file" id="impFile" accept="application/json,.json" class="hidden">
    </div>

    <div class="card">
      <h2>Uso senza internet</h2>
      <p class="muted" id="statoOffline">Verifica in corso…</p>
    </div>

    <div class="card">
      <h2>Installa sul telefono</h2>
      <p class="muted">Su Android (Chrome): menu &#8942; &rarr; <b>Installa app</b> / <b>Aggiungi a schermata Home</b>.<br>
      Su iPhone (Safari): tasto Condividi &rarr; <b>Aggiungi alla schermata Home</b>.</p>
    </div>`;

  $('#fAzienda').addEventListener('submit', e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    for (const k in d) d[k] = d[k].trim();
    S.azienda = { ...S.azienda, ...d };
    save();
    toast('Dati salvati');
  });

  const leggiDrive = () => {
    const fd = new FormData($('#fDrive'));
    const nuovoId = String(fd.get('clientId') || '').trim();
    if (nuovoId !== S.drive.clientId) dimenticaToken();
    S.drive = { ...S.drive, clientId: nuovoId, cartella: String(fd.get('cartella') || '').trim() || 'Fatti Conti - Pro Forma', perFornitore: fd.get('perFornitore') === 'on' };
    save();
  };
  $('#fDrive').addEventListener('submit', e => {
    e.preventDefault();
    leggiDrive();
    toast('Impostazioni Drive salvate');
    render();
  });
  $('#provaDrive').addEventListener('click', async () => {
    leggiDrive();
    if (!S.drive.clientId) return alert('Inserisci prima l\'ID client.');
    try {
      await ottieniToken();
      await trovaOCreaCartella(S.drive.cartella);
      alert(`Collegamento riuscito! ✔\nI PDF verranno salvati nella cartella "${S.drive.cartella}" del tuo Google Drive.`);
      render();
    } catch (err) {
      alert(err.message + (/idpiframe|origin|invalid_client|redirect_uri/i.test(err.message)
        ? `\n\nControlla di aver aggiunto ${location.origin} tra le "Origini JavaScript autorizzate".` : ''));
    }
  });

  $('#expDrive')?.addEventListener('click', async () => {
    try {
      await ottieniToken();
      const btn = $('#expDrive');
      btn.disabled = true; btn.textContent = 'Caricamento…';
      const parent = await trovaOCreaCartella(S.drive.cartella || 'Fatti Conti - Pro Forma');
      const nome = `fatticonti_backup_${today()}.json`;
      const q = `name='${qEsc(nome)}' and trashed=false and '${parent}' in parents`;
      const j = await driveFetch(`${DRIVE_API}?fields=files(id)&q=${encodeURIComponent(q)}`);
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(j.files?.length ? { name: nome } : { name: nome, parents: [parent] })], { type: 'application/json' }));
      form.append('file', new Blob([JSON.stringify(S)], { type: 'application/json' }));
      const url = j.files?.length ? `${DRIVE_UPLOAD}/${j.files[0].id}?uploadType=multipart` : `${DRIVE_UPLOAD}?uploadType=multipart`;
      await driveFetch(url, { method: j.files?.length ? 'PATCH' : 'POST', body: form });
      toast('Backup salvato su Google Drive ✔');
    } catch (err) { alert(err.message); }
    render();
  });

  $('#exp').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    await condividiFile(blob, `fatticonti_backup_${today()}.json`, 'application/json');
  });
  $('#imp').addEventListener('click', () => $('#impFile').click());
  $('#impFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dati = JSON.parse(await file.text());
      if (!dati || !Array.isArray(dati.ritiri) || !Array.isArray(dati.merci)) throw new Error('File non valido');
      if (!confirm(`Il backup contiene ${dati.ritiri.length} ritiri. Sostituire TUTTI i dati attuali?`)) return;
      S = Object.assign(defaultState(), dati);
      save(); render();
      toast('Backup importato');
    } catch (err) {
      alert('Impossibile importare: ' + err.message);
    }
  });
  verificaOffline();
}

/* ---------------- PDF ---------------- */

function controllaPerPdf(r) {
  if (!S.azienda.ragioneSociale) {
    alert('Imposta prima la tua ragione sociale in Impostazioni.');
    return false;
  }
  if (!r.pesate.length) { toast('Nessuna pesata da stampare'); return false; }
  return true;
}

const PDF = { M: 15, W: 210, ORO: [183, 121, 31], CREMA: [245, 239, 226], VERDE: [47, 133, 90] };
const eurPdf = n => pdfTxt(fmtEur(n));
const nomeFilePulito = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

/** Intestazione comune: dati azienda, titolo, numero/data, riquadro fornitore. Ritorna la y di partenza. */
function pdfIntestazione(doc, titolo, righeDx, f) {
  const { M, W, ORO } = PDF;
  const A = S.azienda;
  let y = 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(pdfTxt(A.ragioneSociale), M, y, { maxWidth: 100 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  y += 6;
  const aLines = [...(A.indirizzo || '').split('\n'), A.piva && 'P.IVA ' + A.piva, A.cf && 'C.F. ' + A.cf,
    A.telefono && 'Tel. ' + A.telefono, A.email].filter(Boolean);
  aLines.forEach(l => { doc.text(pdfTxt(l), M, y); y += 4.2; });

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ORO);
  doc.text(titolo, W - M, 18, { align: 'right' });
  doc.setTextColor(0); doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  righeDx.forEach((t, i) => doc.text(pdfTxt(t), W - M, 25 + i * 5, { align: 'right' }));

  y = Math.max(y, 26 + righeDx.length * 5) + 4;
  const fLines = [...(f.indirizzo || '').split('\n'), f.piva && 'P.IVA ' + f.piva,
    f.telefono && 'Tel. ' + f.telefono, f.email].filter(Boolean);
  const boxH = 13 + fLines.length * 4.2;
  doc.setDrawColor(210); doc.roundedRect(110, y, W - M - 110, boxH, 2, 2);
  doc.setFontSize(8); doc.setTextColor(120); doc.text('FORNITORE', 114, y + 5);
  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.text(pdfTxt(f.nome), 114, y + 10, { maxWidth: W - M - 118 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  fLines.forEach((l, i) => doc.text(pdfTxt(l), 114, y + 14.5 + i * 4.2));
  return y + boxH + 8;
}

function pdfPiePagina(doc, testo) {
  const { M, W } = PDF;
  const A = S.azienda;
  const pagine = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pagine; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(120); doc.setFont('helvetica', 'normal');
    const fy = 287;
    if (A.notaPdf) {
      const nl = doc.splitTextToSize(pdfTxt(A.notaPdf), W - 2 * M);
      doc.text(nl, M, fy - nl.length * 3.5);
    }
    doc.text(testo, M, fy);
    doc.text(`Pagina ${i} di ${pagine}`, W - M, fy, { align: 'right' });
  }
}

/** Riquadro colorato (es. timbro SALDATA) */
function pdfRiquadro(doc, y, testo, colore) {
  const { M, W } = PDF;
  doc.setDrawColor(...colore); doc.setFillColor(255, 255, 255); doc.setLineWidth(0.6);
  doc.roundedRect(M, y, W - 2 * M, 10, 2, 2, 'S');
  doc.setLineWidth(0.2);
  doc.setTextColor(...colore); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(pdfTxt(testo), W / 2, y + 6.6, { align: 'center' });
  doc.setTextColor(0); doc.setFont('helvetica', 'normal');
  return y + 15;
}

function creaPdf(r) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const { M, W, ORO, CREMA, VERDE } = PDF;
  const f = fornitoreDi(r);
  const c = calcola(r);
  const g = r.generaleId ? getGenerale(r.generaleId) : null;

  let y = pdfIntestazione(doc, 'FATTURA PRO FORMA', [`N. ${r.numero}/${r.anno}`, `Data: ${fmtDate(r.data)}`], f);

  if (g && g.chiusa) {
    y = pdfRiquadro(doc, y - 3, `SALDATA con fattura generale n. ${numGen(g)} del ${fmtDate(g.saldo.data)}`, VERDE);
  }

  // Riepilogo per merce
  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Merce', 'Colli', 'Peso totale (kg)', 'Prezzo (€/kg)', 'Importo']],
    body: c.righe.map(riga => [pdfTxt(riga.nome), riga.pesate.length, fmtKg(riga.kg), eurPdf(riga.prezzo), eurPdf(riga.importo)]),
    foot: [['Totale', c.colli, fmtKg(c.kg), '', eurPdf(c.totale)]],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 2.5 },
    headStyles: { fillColor: ORO, textColor: 255 },
    footStyles: { fillColor: CREMA, textColor: 0, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    didParseCell: d => { if (d.section !== 'body' && d.column.index > 0) d.cell.styles.halign = 'right'; }
  });
  y = doc.lastAutoTable.finalY + 8;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(`TOTALE DOCUMENTO: ${eurPdf(c.totale)}`, W - M, y, { align: 'right' });
  y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
  doc.text('Importi senza IVA.', W - M, y, { align: 'right' });
  if (g && !g.chiusa) doc.text(`Inclusa nella fattura generale n. ${numGen(g)}.`, M, y);
  doc.setTextColor(0);
  y += 6;

  if (r.note) {
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text('Note:', M, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(pdfTxt(r.note), W - 2 * M - 12);
    doc.text(lines, M + 12, y);
    y += lines.length * 4.2 + 4;
  }

  // Dettaglio pesate
  if (y > 250) { doc.addPage(); y = 20; }
  y += 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.text('Dettaglio pesate', M, y);
  y += 3;
  const COLS = 6;
  for (const riga of c.righe) {
    const celle = riga.pesate.map((p, i) => `${i + 1})  ${fmtKg(p.peso)}`);
    const body = [];
    for (let i = 0; i < celle.length; i += COLS) {
      const row = celle.slice(i, i + COLS);
      while (row.length < COLS) row.push('');
      body.push(row);
    }
    doc.autoTable({
      startY: y + 2,
      margin: { left: M, right: M },
      head: [[{ content: pdfTxt(`${riga.nome}  –  ${riga.pesate.length} colli  –  ${fmtKg(riga.kg)} kg  x  ${fmtEur(riga.prezzo)}/kg  =  ${fmtEur(riga.importo)}`), colSpan: COLS }]],
      body,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 1.8 },
      headStyles: { fillColor: CREMA, textColor: 0, fontStyle: 'bold' },
      rowPageBreak: 'avoid'
    });
    y = doc.lastAutoTable.finalY + 4;
  }
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text('Pesi espressi in kg.', M, y + 2);

  pdfPiePagina(doc, 'Documento pro forma privo di valore fiscale');

  const nome = `ProForma_${r.anno}-${String(r.numero).padStart(3, '0')}_${nomeFilePulito(f.nome)}_${r.data}.pdf`;
  return { doc, nome };
}

function creaPdfGenerale(g) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const { M, W, ORO, CREMA, VERDE } = PDF;
  const f = fornitoreDi(g);
  const c = calcolaGenerale(g);
  const tabella = (opts) => doc.autoTable({
    margin: { left: M, right: M }, theme: 'grid',
    styles: { fontSize: 9.5, cellPadding: 2.2 },
    headStyles: { fillColor: ORO, textColor: 255 },
    footStyles: { fillColor: CREMA, textColor: 0, fontStyle: 'bold' },
    didParseCell: d => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
    ...opts
  });
  const titoletto = (t, y) => {
    if (y > 255) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.text(pdfTxt(t), M, y);
    doc.setFont('helvetica', 'normal');
    return y + 2;
  };

  const righeDx = g.chiusa
    ? [`N. ${numGen(g)}`, `Data: ${fmtDate(g.saldo.data)}`]
    : [`N. ${numGen(g)}`, `Situazione al ${fmtDate(today())}`];
  let y = pdfIntestazione(doc, 'FATTURA GENERALE', righeDx, f);
  y = g.chiusa
    ? pdfRiquadro(doc, y - 3, `SALDATA il ${fmtDate(g.saldo.data)}`, VERDE)
    : pdfRiquadro(doc, y - 3, `APERTA – situazione provvisoria al ${fmtDate(today())}`, ORO);

  // Pro forma incluse
  y = titoletto('Pro forma incluse', y + 2);
  tabella({
    startY: y,
    head: [['Pro forma', 'Data', 'Colli', 'Peso (kg)', 'Importo']],
    body: c.ritiri.map(({ r, c: rc }) => [`N. ${r.numero}/${r.anno}`, fmtDate(r.data), rc.colli, fmtKg(rc.kg), eurPdf(rc.totale)]),
    foot: [['Totale', '', c.colli, fmtKg(c.kg), eurPdf(c.totale)]]
  });
  y = doc.lastAutoTable.finalY + 8;

  // Riepilogo per merce
  if (c.merci.length) {
    y = titoletto('Riepilogo per merce', y);
    tabella({
      startY: y,
      head: [['Merce', 'Colli', 'Peso (kg)', 'Prezzo (€/kg)', 'Importo']],
      body: c.merci.map(m => [pdfTxt(m.nome), m.colli, fmtKg(m.kg), eurPdf(m.prezzo), eurPdf(m.importo)])
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // Acconti
  y = titoletto('Acconti versati', y);
  tabella({
    startY: y,
    head: [['Data', 'Note', 'Importo']],
    body: c.acconti.length ? c.acconti.map(a => [fmtDate(a.data), pdfTxt(a.note || ''), eurPdf(a.importo)]) : [['–', 'Nessun acconto', eurPdf(0)]],
    foot: [['Totale acconti', '', eurPdf(c.totAcconti)]],
    columnStyles: { 0: { cellWidth: 30 }, 2: { cellWidth: 40 } },
    didParseCell: d => { d.cell.styles.halign = d.column.index === 2 ? 'right' : 'left'; }
  });
  y = doc.lastAutoTable.finalY + 8;

  // Riepilogo finale
  const righe = [
    ['Totale merce', eurPdf(c.totale)],
    ['Acconti versati', '- ' + eurPdf(c.totAcconti)]
  ];
  if (g.chiusa) righe.push([`Saldo versato il ${fmtDate(g.saldo.data)}${g.saldo.note ? ' (' + pdfTxt(g.saldo.note) + ')' : ''}`, '- ' + eurPdf(c.saldo)]);
  righe.push([g.chiusa ? (c.residuo ? 'DIFFERENZA NON PAGATA' : 'RESIDUO') : 'RESIDUO DA PAGARE', eurPdf(c.residuo)]);
  if (y > 240) { doc.addPage(); y = 20; }
  doc.autoTable({
    startY: y,
    margin: { left: 80, right: M },
    theme: 'plain',
    body: righe,
    styles: { fontSize: 10.5, cellPadding: 2 },
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 38 } },
    didParseCell: d => {
      if (d.row.index === righe.length - 1) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fontSize = 12.5; d.cell.styles.fillColor = CREMA; }
    }
  });
  y = doc.lastAutoTable.finalY + 6;
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text('Importi senza IVA.', M, y);
  y += 6;

  // Dettaglio pesate di tutti i ritiri
  if (c.ritiri.some(({ r }) => r.pesate.length)) {
    if (y > 220) { doc.addPage(); y = 20; }
    y += 2;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(0);
    doc.text('Dettaglio pesate di tutti i ritiri', M, y);
    y += 4;
    const COLS = 6;
    for (const { r, c: rc } of c.ritiri) {
      if (!rc.righe.length) continue;
      if (y > 240) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(pdfTxt(`Pro forma N. ${r.numero}/${r.anno} del ${fmtDate(r.data)}  –  Totale: ${fmtKg(rc.kg)} kg, ${eurPdf(rc.totale)}`), M, y);
      doc.setFont('helvetica', 'normal');
      y += 2;
      for (const riga of rc.righe) {
        const celle = riga.pesate.map((p, i) => `${i + 1})  ${fmtKg(p.peso)}`);
        const body = [];
        for (let i = 0; i < celle.length; i += COLS) {
          const row = celle.slice(i, i + COLS);
          while (row.length < COLS) row.push('');
          body.push(row);
        }
        doc.autoTable({
          startY: y + 2,
          margin: { left: M, right: M },
          head: [[{ content: pdfTxt(`${riga.nome}  –  ${riga.pesate.length} colli  –  ${fmtKg(riga.kg)} kg  x  ${fmtEur(riga.prezzo)}/kg  =  ${fmtEur(riga.importo)}`), colSpan: COLS }]],
          body,
          theme: 'grid',
          styles: { fontSize: 8.5, cellPadding: 1.6 },
          headStyles: { fillColor: CREMA, textColor: 0, fontStyle: 'bold' },
          rowPageBreak: 'avoid'
        });
        y = doc.lastAutoTable.finalY + 4;
      }
    }
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text('Pesi espressi in kg.', M, y + 2);
  }

  pdfPiePagina(doc, 'Documento riepilogativo privo di valore fiscale');

  const data = g.chiusa ? g.saldo.data : today();
  const nome = `FatturaGenerale_${g.anno}-G${String(g.numero).padStart(3, '0')}_${nomeFilePulito(f.nome)}_${g.chiusa ? 'saldata_' : 'aperta_'}${data}.pdf`;
  return { doc, nome };
}

/* ---------------- Google Drive ---------------- */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
let gToken = null, gTokenExp = 0, tokenClient = null, tokenClientId = null;
try {
  const t = JSON.parse(sessionStorage.getItem('gtok'));
  if (t && t.exp > Date.now()) { gToken = t.token; gTokenExp = t.exp; }
} catch (e) { /* ignora */ }

function getTokenClient() {
  if (!window.google?.accounts?.oauth2) return null;
  if (!tokenClient || tokenClientId !== S.drive.clientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: S.drive.clientId, scope: DRIVE_SCOPE, callback: () => {} });
    tokenClientId = S.drive.clientId;
  }
  return tokenClient;
}

/** Ottiene un token di accesso. Va chiamata direttamente dal click (apre il popup Google). */
function ottieniToken() {
  return new Promise((resolve, reject) => {
    if (gToken && Date.now() < gTokenExp - 60000) return resolve(gToken);
    const tc = getTokenClient();
    if (!tc) return reject(new Error('Servizi Google non caricati. Controlla la connessione a internet e ricarica la pagina.'));
    tc.callback = resp => {
      if (resp.error) return reject(new Error('Accesso Google non riuscito: ' + (resp.error_description || resp.error)));
      gToken = resp.access_token;
      gTokenExp = Date.now() + resp.expires_in * 1000;
      sessionStorage.setItem('gtok', JSON.stringify({ token: gToken, exp: gTokenExp }));
      resolve(gToken);
    };
    tc.error_callback = err => reject(new Error(err.type === 'popup_closed' ? 'Accesso a Google annullato.'
      : err.type === 'popup_failed_to_open' ? 'Il browser ha bloccato la finestra di accesso Google: consenti i popup per questo sito.'
      : 'Errore accesso Google: ' + (err.message || err.type)));
    tc.requestAccessToken({ prompt: '' });
  });
}

function dimenticaToken() {
  gToken = null; gTokenExp = 0;
  sessionStorage.removeItem('gtok');
}

async function driveFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + gToken } });
  if (res.status === 401) { dimenticaToken(); throw new Error('Sessione Google scaduta: premi di nuovo il pulsante.'); }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch (e) { /* ignora */ }
    const err = new Error('Errore Google Drive: ' + msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const qEsc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function trovaOCreaCartella(nome, parentId = 'root') {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${qEsc(nome)}' and trashed=false and '${parentId}' in parents`;
  const j = await driveFetch(`${DRIVE_API}?fields=files(id)&q=${encodeURIComponent(q)}`);
  if (j.files?.length) return j.files[0].id;
  const c = await driveFetch(`${DRIVE_API}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nome, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  return c.id;
}

async function caricaFile(blob, nome, parentId, esistenteId) {
  const meta = esistenteId ? { name: nome } : { name: nome, parents: [parentId], mimeType: 'application/pdf' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const url = esistenteId
    ? `${DRIVE_UPLOAD}/${esistenteId}?uploadType=multipart&fields=id,webViewLink`
    : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,webViewLink`;
  return driveFetch(url, { method: esistenteId ? 'PATCH' : 'POST', body: form });
}

async function cartellaDestinazione(obj) {
  let parent = await trovaOCreaCartella(S.drive.cartella || 'Fatti Conti - Pro Forma');
  if (S.drive.perFornitore) parent = await trovaOCreaCartella(fornitoreDi(obj).nome, parent);
  return parent;
}

/** Carica (o aggiorna) su Drive il PDF di obj (pro forma o fattura generale). */
async function caricaPdfSuDrive(obj, creaFn, parent) {
  const { doc, nome } = creaFn();
  let esistente = null;
  if (obj.driveFileId) {
    try {
      const f = await driveFetch(`${DRIVE_API}/${obj.driveFileId}?fields=id,trashed,parents`);
      if (!f.trashed && f.parents?.includes(parent)) esistente = f.id;
    } catch (e) { if (e.status !== 404) throw e; }
  }
  const res = await caricaFile(doc.output('blob'), nome, parent, esistente);
  obj.driveFileId = res.id;
  obj.driveLink = res.webViewLink;
  obj.pdfSalvato = Date.now();
  save();
  return esistente;
}

/** Controlli comuni prima di usare Drive. Ritorna true se si può procedere. */
async function prontoPerDrive(fallbackPdf) {
  if (!S.drive.clientId) {
    if (confirm('Il collegamento diretto a Google Drive non è ancora configurato.\n\nOK = vai alle Impostazioni per configurarlo\nAnnulla = usa la condivisione del telefono')) {
      vaiTab('impostazioni');
    } else if (fallbackPdf) {
      const { doc, nome } = fallbackPdf();
      condividiFile(doc.output('blob'), nome, 'application/pdf');
    }
    return false;
  }
  if (!navigator.onLine) { alert('Sei offline. I dati restano salvati: potrai inviare il PDF a Drive quando torni connesso.'); return false; }
  try { await ottieniToken(); } catch (e) { alert(e.message); return false; }
  return true;
}

async function salvaSuDrive(obj, creaFn = () => creaPdf(obj), btn = $('#drive')) {
  if (!(await prontoPerDrive(creaFn))) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Caricamento su Google Drive…'; }
  try {
    const parent = await cartellaDestinazione(obj);
    const esistente = await caricaPdfSuDrive(obj, creaFn, parent);
    toast(esistente ? 'PDF aggiornato su Google Drive ✔' : 'PDF salvato su Google Drive ✔');
  } catch (e) {
    console.error(e);
    alert(e.message);
  }
  render();
}

/** Carica su Drive la fattura generale e tutte le sue pro forma */
async function salvaTuttiSuDrive(g, btn) {
  if (!(await prontoPerDrive(null))) return;
  const ritiri = ritiriDi(g).filter(r => r.pesate.length);
  const tot = ritiri.length + 1;
  let fatti = 0;
  const avanza = () => { if (btn) { btn.disabled = true; btn.textContent = `Caricamento su Drive… ${fatti}/${tot}`; } };
  avanza();
  try {
    const parent = await cartellaDestinazione(g);
    await caricaPdfSuDrive(g, () => creaPdfGenerale(g), parent);
    fatti++; avanza();
    for (const r of ritiri) {
      await caricaPdfSuDrive(r, () => creaPdf(r), parent);
      fatti++; avanza();
    }
    toast(`${fatti} PDF salvati su Google Drive ✔`);
  } catch (e) {
    console.error(e);
    alert(`${e.message}\n\nCaricati ${fatti} PDF su ${tot}. Puoi riprovare: quelli già caricati verranno aggiornati, non duplicati.`);
  }
  render();
}

/* ---------------- Offline ---------------- */

const FILE_ESSENZIALI = ['index.html', 'app.js', 'style.css', 'lib/jspdf.umd.min.js', 'lib/jspdf.plugin.autotable.min.js'];

async function verificaOffline() {
  const el = $('#statoOffline');
  if (!el) return;
  let msg;
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    msg = '&#10060; Questo browser non supporta l\'uso offline.';
  } else if (!location.protocol.startsWith('http')) {
    msg = '&#10060; L\'app è aperta come file: per l\'uso offline va aperta dal suo indirizzo web (es. GitHub Pages).';
  } else {
    const mancanti = [];
    for (const f of FILE_ESSENZIALI) {
      if (!(await caches.match(new URL(f, location.href).href, { ignoreSearch: true }))) mancanti.push(f);
    }
    const attivo = !!navigator.serviceWorker.controller;
    msg = !mancanti.length && attivo
      ? '&#9989; Pronta: l\'app funziona anche senza internet (solo il salvataggio su Google Drive richiede la connessione).'
      : !mancanti.length
        ? '&#9203; Quasi pronta: chiudi e riapri l\'app una volta con internet.'
        : '&#9888;&#65039; Copia offline non ancora completa: apri l\'app con internet e attendi qualche secondo, poi ricontrolla qui.';
  }
  el.innerHTML = msg;
}

function aggiornaBadgeOffline() {
  $('#offline').classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', aggiornaBadgeOffline);
window.addEventListener('offline', aggiornaBadgeOffline);

/* ---------------- Avvio ---------------- */

history.replaceState({}, '');
render();
aggiornaBadgeOffline();

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => { if (navigator.onLine) reg.update().catch(() => {}); })
    .catch(console.warn);
  navigator.serviceWorker.addEventListener('controllerchange', () => verificaOffline());
}
