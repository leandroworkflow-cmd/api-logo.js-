/**
 * fetch-all.mjs
 * Importador unificado — Football-data.org + TheSportsDB → Supabase
 */

import fetch from "node-fetch";

// ── CONFIG ────────────────────────────────────────────────────────────────────

const FOOTBALL_API_KEY = "ab7e687d7ff24053837db64af9b56453";
const SUPABASE_URL     = "https://odexmyskaespjusivjua.supabase.co";
const SUPABASE_KEY     = "sb_publishable_s9oIKQj9UXCPucjw1cmzlw_N3HqxH-Y";
const SPORTSDB_KEY     = "123"; // troque se tiver premium
const DAYS_AHEAD       = 14;

const LIGAS_FUTEBOL = [
  { code: "BSA", nome: "Brasileirao A"   },
  { code: "BSB", nome: "Brasileirao B"   },
  { code: "CLI", nome: "Libertadores"    },
  { code: "CL",  nome: "Champions League"},
  { code: "PL",  nome: "Premier League"  },
  { code: "PD",  nome: "La Liga"         },
  { code: "SA",  nome: "Serie A"         },
  { code: "BL1", nome: "Bundesliga"      },
  { code: "FL1", nome: "Ligue 1"         },
];

const OUTROS_ESPORTES = [
  { name: "Basketball", label: "Basquete",    category: "basquete"  },
  { name: "Fighting",   label: "Boxe/MMA/UFC", category: "luta"     },
  { name: "Tennis",     label: "Tenis",        category: "tenis"    },
  { name: "Volleyball", label: "Volei",        category: "volei"    },
];

// ── UTILS ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nextDates(n) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

async function fetchJSON(url, headers = {}, tentativa = 1) {
  try {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      console.warn("  Rate limit (429). Aguardando 61s...");
      await sleep(61000);
      return fetchJSON(url, headers, tentativa + 1);
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  } catch (err) {
    if (tentativa < 3) { await sleep(2500 * tentativa); return fetchJSON(url, headers, tentativa + 1); }
    throw err;
  }
}

// ── BUSCA FUTEBOL (football-data.org) ─────────────────────────────────────────

async function fetchLiga(liga) {
  process.stdout.write("  Buscando " + liga.nome + "... ");
  try {
    const data = await fetchJSON(
      "https://api.football-data.org/v4/competitions/" + liga.code + "/matches?status=SCHEDULED",
      { "X-Auth-Token": FOOTBALL_API_KEY }
    );
    if (data.errorCode) { console.log("Sem acesso."); return []; }
    const jogos = (data.matches || []).map(m => ({
      external_id:     "jogo_fd_" + m.id,
      nome:            m.homeTeam.name + " X " + m.awayTeam.name,
      time_casa:       m.homeTeam.name,
      time_fora:       m.awayTeam.name,
      home_logo:       m.homeTeam.crest || null,
      away_logo:       m.awayTeam.crest || null,
      category:        "esportes",
      status:          "active",
      yes_price:       50,
      no_price:        50,
      volume:          0,
      resolution_rule: "Resultado final de " + m.homeTeam.name + " x " + m.awayTeam.name + ".",
      end_date:        m.utcDate,
      data_evento:     m.utcDate,
    }));
    console.log(jogos.length + " jogos.");
    return jogos;
  } catch (e) {
    console.log("Erro: " + e.message);
    return [];
  }
}

// ── BUSCA OUTROS ESPORTES (TheSportsDB) ───────────────────────────────────────

async function fetchEsporte(sport) {
  process.stdout.write("  Buscando " + sport.label + "... ");
  const base   = "https://www.thesportsdb.com/api/v1/json/" + SPORTSDB_KEY;
  const dates  = nextDates(DAYS_AHEAD);
  const vistos = new Set();
  const eventos = [];

  for (const date of dates) {
    try {
      const data = await fetchJSON(base + "/eventsday.php?d=" + date + "&s=" + encodeURIComponent(sport.name));
      for (const ev of (data?.events || [])) {
        if (vistos.has(ev.idEvent)) continue;
        vistos.add(ev.idEvent);

        // Monta data ISO com horário (se existir)
        const iso = ev.strTime
          ? ev.dateEvent + "T" + ev.strTime + ":00Z"
          : ev.dateEvent + "T00:00:00Z";

        // Para lutas (boxe/MMA) não tem "time_casa/fora" no sentido tradicional
        // usamos os atletas/equipes como home/away
        const homeTeam = ev.strHomeTeam || ev.strEvent || sport.label;
        const awayTeam = ev.strAwayTeam || "";

        eventos.push({
          external_id:     "sdb_" + ev.idEvent,
          nome:            ev.strEvent,
          time_casa:       homeTeam,
          time_fora:       awayTeam,
          home_logo:       ev.strHomeTeamBadge || null,
          away_logo:       ev.strAwayTeamBadge || null,
          category:        sport.category,
          status:          "active",
          yes_price:       50,
          no_price:        50,
          volume:          0,
          resolution_rule: "Resultado final de " + ev.strEvent + ".",
          end_date:        iso,
          data_evento:     iso,
        });
      }
    } catch (_) {}
    await sleep(2200);
  }

  console.log(eventos.length + " eventos.");
  return eventos;
}

// ── SALVAR NO SUPABASE ────────────────────────────────────────────────────────

async function criarPosicoes(mercados) {
  if (mercados.length === 0) return;
  const ids = mercados.map(m => m.external_id).join(",");
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/mercados?external_id=in.(" + ids + ")&select=id,external_id",
    { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
  );
  const db = await res.json();
  const pos = [];
  for (const m of db) {
    for (const [tipo, preco] of [["time_casa", 0.65], ["empate", 0.20], ["time_fora", 0.15]]) {
      pos.push({
        mercado_id:        m.id,
        tipo,
        preco_unitario:    preco,
        volume_total:      1000,
        volume_disponivel: 1000,
        volume_comprado:   0,
      });
    }
  }
  if (pos.length === 0) return;
  for (let i = 0; i < pos.length; i += 50) {
    await fetch(SUPABASE_URL + "/rest/v1/posicoes", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization:  "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer:         "resolution=ignore-duplicates",
      },
      body: JSON.stringify(pos.slice(i, i + 50)),
    });
  }
  console.log("  " + pos.length + " posicoes criadas.");
}

async function salvar(mercados) {
  if (mercados.length === 0) { console.log("Nenhum mercado."); return; }
  console.log("\nSalvando " + mercados.length + " markets...");
  for (let i = 0; i < mercados.length; i += 50) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/mercados", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization:  "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer:         "resolution=merge-duplicates",
      },
      body: JSON.stringify(mercados.slice(i, i + 50)),
    });
    if (!res.ok) console.error(await res.text());
  }
  await criarPosicoes(mercados);
  console.log("Salvo!");
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log("=== Importador Unificado de Esportes ===");

  const todos = [];

  // Futebol
  console.log("\n[Futebol — football-data.org]");
  for (const liga of LIGAS_FUTEBOL) {
    todos.push(...await fetchLiga(liga));
    await sleep(500);
  }

  // Outros esportes
  console.log("\n[Outros Esportes — TheSportsDB]");
  for (const sport of OUTROS_ESPORTES) {
    todos.push(...await fetchEsporte(sport));
  }

  console.log("\nTotal: " + todos.length + " eventos.");
  await salvar(todos);
  console.log("Feito!");
})();
