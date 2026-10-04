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
    ritiri: [],      // {id, numero, anno, data, fornitoreId, fornitoreSnap, righe:{merceId:{nome,prezzo}}, pesate:[{id,merceId,peso,ora}], note, chiuso, pdfSalvato, creato}
    contatori: {},   // {anno: ultimoNumero}
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
function fornitoreDi(r) {
  return S.fornitori.find(f => f.id === r.fornitoreId) || r.fornitoreSnap || { nome: '(fornitore eliminato)' };
}

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

const nav = { tab: 'ritiri', ritiroId: null, filtroForn: '' };
let selMerce = null;

function setTitle(t) { $('#title').textContent = t; }

function apriRitiro(id) {
  nav.ritiroId = id;
  const r = getRitiro(id);
  const last = r.pesate[r.pesate.length - 1];
  selMerce = last ? last.merceId : (S.merci[0]?.id || null);
  history.pushState({ ritiro: id }, '');
  render();
  window.scrollTo(0, 0);
}

function chiudiDettaglio() {
  nav.ritiroId = null;
  render();
}

window.addEventListener('popstate', () => { if (nav.ritiroId) chiudiDettaglio(); });
$('#btnBack').addEventListener('click', () => history.back());

$$('.tabbar button').forEach(b => b.addEventListener('click', () => {
  if (nav.ritiroId) { nav.ritiroId = null; history.back(); }
  nav.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
}));

function render() {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === nav.tab));
  $('#btnBack').classList.toggle('hidden', !nav.ritiroId);
  const v = $('#view');
  if (nav.ritiroId) {
    const r = getRitiro(nav.ritiroId);
    if (r) return viewRitiro(v, r);
    nav.ritiroId = null;
  }
  ({ ritiri: viewRitiri, merci: viewMerci, fornitori: viewFornitori, impostazioni: viewImpostazioni })[nav.tab](v);
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
      return `<div class="list-item" data-id="${r.id}">
        <div class="main">
          <div class="title">${esc(fornitoreDi(r).nome)}
            <span class="badge ${r.chiuso ? 'closed' : 'open'}">${r.chiuso ? 'chiuso' : 'aperto'}</span>
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
  setTitle(`Pro forma ${r.numero}/${r.anno}`);
  if (!getMerce(selMerce)) selMerce = S.merci[0]?.id || null;

  let h = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
      <div><h2>${esc(f.nome)}</h2>
        <div class="muted">N. ${r.numero}/${r.anno} · ${fmtDate(r.data)}</div>
        ${r.pdfSalvato ? `<div class="muted">PDF salvato il ${new Date(r.pdfSalvato).toLocaleString('it-IT')}</div>` : ''}
      </div>
      <div>
        <span class="badge ${r.chiuso ? 'closed' : 'open'}">${r.chiuso ? 'chiuso' : 'aperto'}</span>
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
    <div class="btn-row">
      <button class="btn" id="toggleChiuso">${r.chiuso ? '&#128275; Riapri ritiro' : '&#10004; Chiudi ritiro'}</button>
      <button class="btn danger" id="elimina">Elimina</button>
    </div>
  </div>`;

  v.innerHTML = h;

  // --- eventi ---
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

  $('#toggleChiuso').addEventListener('click', () => {
    r.chiuso = !r.chiuso;
    save(); render();
    toast(r.chiuso ? 'Ritiro chiuso: pesate bloccate' : 'Ritiro riaperto');
  });

  $('#elimina').addEventListener('click', () => {
    if (!confirm(`Eliminare definitivamente il ritiro N. ${r.numero}/${r.anno} con ${r.pesate.length} pesate?`)) return;
    S.ritiri = S.ritiri.filter(x => x !== r);
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
      r.fornitoreId = d.fornitoreId;
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
      } else {
        S.fornitori.push({ id: uid(), ...dati });
      }
      save(); render();
    }, {
      onDelete: f ? () => {
        if (!confirm(`Eliminare il fornitore "${f.nome}"? I ritiri già fatti restano nell'archivio.`)) return false;
        S.ritiri.filter(r => r.fornitoreId === f.id).forEach(r => { r.fornitoreSnap = { ...f }; });
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

function creaPdf(r) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const A = S.azienda;
  const f = fornitoreDi(r);
  const c = calcola(r);
  const M = 15, W = 210;
  const ORO = [183, 121, 31], CREMA = [245, 239, 226];
  const eur = n => pdfTxt(fmtEur(n));

  // Intestazione: dati azienda
  let y = 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(pdfTxt(A.ragioneSociale), M, y, { maxWidth: 100 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  y += 6;
  const aLines = [...(A.indirizzo || '').split('\n'), A.piva && 'P.IVA ' + A.piva, A.cf && 'C.F. ' + A.cf,
    A.telefono && 'Tel. ' + A.telefono, A.email].filter(Boolean);
  aLines.forEach(l => { doc.text(pdfTxt(l), M, y); y += 4.2; });

  // Titolo documento
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ORO);
  doc.text('FATTURA PRO FORMA', W - M, 18, { align: 'right' });
  doc.setTextColor(0); doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  doc.text(`N. ${r.numero}/${r.anno}`, W - M, 25, { align: 'right' });
  doc.text(`Data: ${fmtDate(r.data)}`, W - M, 30, { align: 'right' });

  // Riquadro fornitore
  y = Math.max(y, 36) + 4;
  const fLines = [...(f.indirizzo || '').split('\n'), f.piva && 'P.IVA ' + f.piva,
    f.telefono && 'Tel. ' + f.telefono, f.email].filter(Boolean);
  const boxH = 13 + fLines.length * 4.2;
  doc.setDrawColor(210); doc.roundedRect(110, y, W - M - 110, boxH, 2, 2);
  doc.setFontSize(8); doc.setTextColor(120); doc.text('FORNITORE', 114, y + 5);
  doc.setTextColor(0); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.text(pdfTxt(f.nome), 114, y + 10, { maxWidth: W - M - 118 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  fLines.forEach((l, i) => doc.text(pdfTxt(l), 114, y + 14.5 + i * 4.2));
  y += boxH + 8;

  // Riepilogo per merce
  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Merce', 'Colli', 'Peso totale (kg)', 'Prezzo (€/kg)', 'Importo']],
    body: c.righe.map(riga => [pdfTxt(riga.nome), riga.pesate.length, fmtKg(riga.kg), eur(riga.prezzo), eur(riga.importo)]),
    foot: [['Totale', c.colli, fmtKg(c.kg), '', eur(c.totale)]],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 2.5 },
    headStyles: { fillColor: ORO, textColor: 255 },
    footStyles: { fillColor: CREMA, textColor: 0, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    didParseCell: d => { if (d.section !== 'body' && d.column.index > 0) d.cell.styles.halign = 'right'; }
  });
  y = doc.lastAutoTable.finalY + 8;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(`TOTALE DOCUMENTO: ${eur(c.totale)}`, W - M, y, { align: 'right' });
  y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
  doc.text('Importi senza IVA.', W - M, y, { align: 'right' });
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

  // Piè di pagina su ogni pagina
  const pagine = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pagine; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(120); doc.setFont('helvetica', 'normal');
    let fy = 287;
    if (A.notaPdf) {
      const nl = doc.splitTextToSize(pdfTxt(A.notaPdf), W - 2 * M);
      doc.text(nl, M, fy - nl.length * 3.5);
    }
    doc.text('Documento pro forma privo di valore fiscale', M, fy);
    doc.text(`Pagina ${i} di ${pagine}`, W - M, fy, { align: 'right' });
  }

  const pulito = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const nome = `ProForma_${r.anno}-${String(r.numero).padStart(3, '0')}_${pulito(f.nome)}_${r.data}.pdf`;
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

async function cartellaDestinazione(r) {
  let parent = await trovaOCreaCartella(S.drive.cartella || 'Fatti Conti - Pro Forma');
  if (S.drive.perFornitore) parent = await trovaOCreaCartella(fornitoreDi(r).nome, parent);
  return parent;
}

async function salvaSuDrive(r) {
  if (!S.drive.clientId) {
    if (confirm('Il collegamento diretto a Google Drive non è ancora configurato.\n\nOK = vai alle Impostazioni per configurarlo\nAnnulla = usa la condivisione del telefono')) {
      nav.tab = 'impostazioni';
      history.back();
    } else {
      const { doc, nome } = creaPdf(r);
      condividiFile(doc.output('blob'), nome, 'application/pdf');
    }
    return;
  }
  if (!navigator.onLine) return alert('Sei offline. Il ritiro resta salvato: potrai inviare il PDF a Drive quando torni connesso.');

  try { await ottieniToken(); } catch (e) { return alert(e.message); }

  const btn = $('#drive');
  if (btn) { btn.disabled = true; btn.textContent = 'Caricamento su Google Drive…'; }
  try {
    const { doc, nome } = creaPdf(r);
    const parent = await cartellaDestinazione(r);
    let esistente = null;
    if (r.driveFileId) {
      try {
        const f = await driveFetch(`${DRIVE_API}/${r.driveFileId}?fields=id,trashed,parents`);
        if (!f.trashed && f.parents?.includes(parent)) esistente = f.id;
      } catch (e) { if (e.status !== 404) throw e; }
    }
    const res = await caricaFile(doc.output('blob'), nome, parent, esistente);
    r.driveFileId = res.id;
    r.driveLink = res.webViewLink;
    r.pdfSalvato = Date.now();
    save();
    toast(esistente ? 'PDF aggiornato su Google Drive ✔' : 'PDF salvato su Google Drive ✔');
  } catch (e) {
    console.error(e);
    alert(e.message);
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
