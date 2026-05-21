import fetch from "node-fetch";

const FOOTBALL_API_KEY = "ab7e687d7ff24053837db64af9b56453";
const SUPABASE_URL     = "https://odexmyskaespjusivjua.supabase.co";
const SUPABASE_KEY     = "sb_publishable_s9oIKQj9UXCPucjw1cmzlw_N3HqxH-Y";
const SPORTSDB_KEY     = "123";
const DAYS_AHEAD       = 14;

const LIGAS_FUTEBOL = [
  { code: "BSA", nome: "Brasileirao A"    },
  { code: "BSB", nome: "Brasileirao B"    },
  { code: "CLI", nome: "Libertadores"     },
  { code: "CL",  nome: "Champions League" },
  { code: "PL",  nome: "Premier League"   },
  { code: "PD",  nome: "La Liga"          },
  { code: "SA",  nome: "Serie A"          },
  { code: "BL1", nome: "Bundesliga"       },
  { code: "FL1", nome: "Ligue 1"          },
];

const OUTROS_ESPORTES = [
  { name: "Basketball", label: "Basquete",     category: "basquete" },
  { name: "Fighting",   label: "Boxe/MMA/UFC", category: "luta"     },
  { name: "Tennis",     label: "Tenis",        category: "tenis"    },
  { name: "Volleyball", label: "Volei",        category: "volei"    },
];

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
      console.warn("  Rate limit. Aguardando 61s...");
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

// ── FUTEBOL ──────────────────────────────────────────────────────────────────

async function fetchLiga(liga) {
  process.stdout.write("  Buscando " + liga.nome + "... ");
  try {
    const data = await fetchJSON(
      "https://api.football-data.org/v4/competitions/" + liga.code + "/matches?status=SCHEDULED",
      { "X-Auth-Token": FOOTBALL_API_KEY }
    );
    if (data.errorCode) { console.log("Sem acesso."); return []; }
    const jogos = (data.matches || []).map(m => ({
      id:              "jogo_fd_" + m.id,
      nome:            m.homeTeam.name + " X " + m.awayTeam.name,
      category:        "esportes",
      status:          "active",
      end_date:        m.utcDate,
      image_url:       m.homeTeam.crest || null,
      resolution_rule: "Resultado final de " + m.homeTeam.name + " x " + m.awayTeam.name + ".",
    }));
    console.log(jogos.length + " jogos.");
    return jogos;
  } catch (e) {
    console.log("Erro: " + e.message);
    return [];
  }
}

// ── OUTROS ESPORTES ───────────────────────────────────────────────────────────

async function fetchEsporte(sport) {
  process.stdout.write("  Buscando " + sport.label + "... ");
  const base    = "https://www.thesportsdb.com/api/v1/json/" + SPORTSDB_KEY;
  const dates   = nextDates(DAYS_AHEAD);
  const vistos  = new Set();
  const eventos = [];

  for (const date of dates) {
    try {
      const data = await fetchJSON(base + "/eventsday.php?d=" + date + "&s=" + encodeURIComponent(sport.name));
      for (const ev of (data?.events || [])) {
        if (vistos.has(ev.idEvent)) continue;
        vistos.add(ev.idEvent);
        const iso = ev.strTime
          ? ev.dateEvent + "T" + ev.strTime + ":00Z"
          : ev.dateEvent + "T00:00:00Z";
        eventos.push({
          id:              "sdb_" + ev.idEvent,
          nome:            ev.strEvent,
          category:        sport.category,
          status:          "active",
          end_date:        iso,
          image_url:       ev.strThumb || null,
          resolution_rule: "Resultado final de " + ev.strEvent + ".",
        });
      }
    } catch (_) {}
    await sleep(2200);
  }

  console.log(eventos.length + " eventos.");
  return eventos;
}

// ── SALVAR NO SUPABASE ────────────────────────────────────────────────────────

async function criarPosicoes(ids) {
  if (ids.length === 0) return;

  // Busca os registros inseridos pelo id texto
  const idList = ids.map(id => '"' + id + '"').join(",");
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/markets?id=in.(" + idList + ")&select=id",
    { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
  );
  const db = await res.json();
  if (!Array.isArray(db) || db.length === 0) { console.log("  Nenhum market encontrado para posicoes."); return; }

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

  for (let i = 0; i < pos.length; i += 50) {
    await fetch(SUPABASE_URL + "/rest/v1/posicoes", {
      method: "POST",
      headers: {
        apikey:           SUPABASE_KEY,
        Authorization:    "Bearer " + SUPABASE_KEY,
        "Content-Type":   "application/json",
        Prefer:           "resolution=ignore-duplicates",
      },
      body: JSON.stringify(pos.slice(i, i + 50)),
    });
  }
  console.log("  " + pos.length + " posicoes criadas.");
}

async function salvar(markets) {
  if (markets.length === 0) { console.log("Nenhum market."); return; }
  console.log("\nSalvando " + markets.length + " markets...");

  const ids = [];
  for (let i = 0; i < markets.length; i += 50) {
    const lote = markets.slice(i, i + 50);
    const res = await fetch(SUPABASE_URL + "/rest/v1/markets", {
      method: "POST",
      headers: {
        apikey:           SUPABASE_KEY,
        Authorization:    "Bearer " + SUPABASE_KEY,
        "Content-Type":   "application/json",
        Prefer:           "resolution=merge-duplicates",
      },
      body: JSON.stringify(lote),
    });
    if (!res.ok) { console.error(await res.text()); } else { lote.forEach(m => ids.push(m.id)); }
  }

  await criarPosicoes(ids);
  console.log("Salvo!");
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log("=== Importador Unificado de Esportes ===");
  const todos = [];

  console.log("\n[Futebol — football-data.org]");
  for (const liga of LIGAS_FUTEBOL) {
    todos.push(...await fetchLiga(liga));
    await sleep(500);
  }

  console.log("\n[Outros Esportes — TheSportsDB]");
  for (const sport of OUTROS_ESPORTES) {
    todos.push(...await fetchEsporte(sport));
  }

  console.log("\nTotal: " + todos.length + " eventos.");
  await salvar(todos);
  console.log("Feito!");
})();
