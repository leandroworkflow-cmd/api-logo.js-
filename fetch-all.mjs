import fetch from "node-fetch";

const FOOTBALL_API_KEY = "ab7e687d7ff24053837db64af9b56453";
const SUPABASE_URL     = "https://odexmyskaespjusivjua.supabase.co";
const SUPABASE_KEY     = "sb_publishable_s9oIKQj9UXCPucjw1cmzlw_N3HqxH-Y";
const DAYS_AHEAD       = 14;

// ─────────────────────────────────────────────────────────────────────────────
// FUTEBOL — football-data.org
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// OUTROS ESPORTES — TheSportsDB (chave gratuita "123")
//
// IDs verificados na URL: thesportsdb.com/league/{ID}
//
// BASQUETE
//   4387  NBA (National Basketball Association)
//   4388  WNBA
//   4389  NCAA Basketball (March Madness)
//   4966  NBB (Novo Basquete Brasil)
//   4390  EuroLeague Basketball
//
// MMA / LUTA
//   4443  UFC (Ultimate Fighting Championship)
//   4445  Boxing (Boxe internacional)
//   4444  WWE (não é MMA mas fica em "Fighting")
//
// TÊNIS
//   4681  ATP Tour (Grand Slams + Masters 1000)
//   4683  WTA Tour
//
// VÔLEI
//   4927  FIVB Volleyball Nations League (Liga das Nações)
//   4928  FIVB Volleyball World Championship
//   4929  Superliga Masculina (Brasil)
//   4930  Superliga Feminina (Brasil)
// ─────────────────────────────────────────────────────────────────────────────
const OUTROS_ESPORTES = [
  {
    label:    "Basquete",
    category: "basquete",
    ligas: [
      { id: "4387", nome: "NBA"             },
      { id: "4966", nome: "NBB Brasil"      },
      { id: "4390", nome: "EuroLeague"      },
      { id: "4388", nome: "WNBA"            },
    ],
  },
  {
    label:    "MMA / Luta",
    category: "luta",
    ligas: [
      { id: "4443", nome: "UFC"             },
      { id: "4445", nome: "Boxe"            },
    ],
  },
  {
    label:    "Tenis",
    category: "tenis",
    ligas: [
      { id: "4681", nome: "ATP Tour"        },
      { id: "4683", nome: "WTA Tour"        },
    ],
  },
  {
    label:    "Volei",
    category: "volei",
    ligas: [
      { id: "4929", nome: "Superliga Masc." },
      { id: "4930", nome: "Superliga Fem."  },
      { id: "4927", nome: "VNL Masc."       },
      { id: "4928", nome: "VNL Fem."        },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, headers = {}, tentativa = 1) {
  try {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      console.warn("  ⚠ Rate limit. Aguardando 61s...");
      await sleep(61000);
      return fetchJSON(url, headers, tentativa + 1);
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  } catch (err) {
    if (tentativa < 3) {
      await sleep(2500 * tentativa);
      return fetchJSON(url, headers, tentativa + 1);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUTEBOL
// CORREÇÃO: agora salvamos home_crest E away_crest separados.
// image_url  → escudo do time da CASA
// away_image_url → escudo do time VISITANTE  ← coluna nova no Supabase
// description → JSON com detalhes completos dos dois times
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLiga(liga) {
  process.stdout.write("  " + liga.nome + "... ");
  try {
    const data = await fetchJSON(
      "https://api.football-data.org/v4/competitions/" + liga.code + "/matches?status=SCHEDULED",
      { "X-Auth-Token": FOOTBALL_API_KEY }
    );
    if (data.errorCode) { console.log("sem acesso."); return []; }

    const jogos = (data.matches || []).map(m => ({
      id:             "jogo_fd_" + m.id,
      nome:           (m.homeTeam.shortName || m.homeTeam.name) + " X " +
                      (m.awayTeam.shortName || m.awayTeam.name),
      description:    JSON.stringify({
        home:  { name: m.homeTeam.name, crest: m.homeTeam.crest  || null },
        away:  { name: m.awayTeam.name, crest: m.awayTeam.crest  || null },
        liga:  liga.nome,
        round: m.matchday || null,
      }),
      category:       "esportes",
      status:         "active",
      end_date:       m.utcDate,
      image_url:      m.homeTeam.crest  || null,   // escudo do mandante
      away_image_url: m.awayTeam.crest  || null,   // escudo do visitante ← NOVO
    }));

    console.log(jogos.length + " jogos.");
    return jogos;
  } catch (e) {
    console.log("Erro: " + e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTROS ESPORTES
// CORREÇÃO: usa eventsnextleague.php (gratuito) por ID de liga verificado,
// em vez de eventsday.php (exige chave paga).
// Filtra eventos dentro da janela de DAYS_AHEAD dias.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEsporte(esporte) {
  console.log("\n  [" + esporte.label + "]");
  const base   = "https://www.thesportsdb.com/api/v1/json/123";
  const limite = new Date();
  limite.setDate(limite.getDate() + DAYS_AHEAD);

  const vistos  = new Set();
  const eventos = [];

  for (const liga of esporte.ligas) {
    process.stdout.write("    " + liga.nome + "... ");
    try {
      const data = await fetchJSON(base + "/eventsnextleague.php?id=" + liga.id);
      const evs  = data?.events || [];

      let count = 0;
      for (const ev of evs) {
        if (vistos.has(ev.idEvent)) continue;

        // Filtra por janela de datas
        const dataEvento = new Date(
          ev.dateEvent + "T" + (ev.strTime ? ev.strTime : "00:00") + "Z"
        );
        if (dataEvento > limite) continue;

        vistos.add(ev.idEvent);
        count++;

        const iso = ev.strTime
          ? ev.dateEvent + "T" + ev.strTime + ":00Z"
          : ev.dateEvent + "T00:00:00Z";

        eventos.push({
          id:             "sdb_" + ev.idEvent,
          nome:           ev.strEvent,
          description:    JSON.stringify({
            liga:    ev.strLeague    || liga.nome,
            home:    ev.strHomeTeam || null,
            away:    ev.strAwayTeam || null,
            country: ev.strCountry  || null,
          }),
          category:       esporte.category,
          status:         "active",
          end_date:       iso,
          // Prefere thumb do evento; fallback para badge da liga
          image_url:      ev.strThumb          || ev.strLeagueBadge || null,
          away_image_url: ev.strAwayTeamBadge  || null,
        });
      }
      console.log(count + " evento(s) nos próximos " + DAYS_AHEAD + " dias.");
    } catch (e) {
      console.log("Erro: " + e.message);
    }
    await sleep(1200); // respeita rate limit (30 req/min na chave free)
  }

  return eventos;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE — salvar markets + posicoes
// ─────────────────────────────────────────────────────────────────────────────
async function criarPosicoes(ids) {
  if (ids.length === 0) return;
  const idList = ids.map(id => '"' + id + '"').join(",");
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/markets?id=in.(" + idList + ")&select=id",
    { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
  );
  const db = await res.json();
  if (!Array.isArray(db) || db.length === 0) return;

  const pos = [];
  for (const m of db) {
    for (const [tipo, preco] of [
      ["time_casa", 0.65],
      ["empate",    0.20],
      ["time_fora", 0.15],
    ]) {
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
        apikey:         SUPABASE_KEY,
        Authorization:  "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer:         "resolution=ignore-duplicates",
      },
      body: JSON.stringify(pos.slice(i, i + 50)),
    });
  }
  console.log("  " + pos.length + " posicoes criadas/atualizadas.");
}

async function salvar(markets) {
  if (markets.length === 0) { console.log("Nenhum market para salvar."); return; }
  console.log("\nSalvando " + markets.length + " markets...");

  const ids = [];
  for (let i = 0; i < markets.length; i += 50) {
    const lote = markets.slice(i, i + 50);
    const res = await fetch(SUPABASE_URL + "/rest/v1/markets", {
      method: "POST",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer:         "resolution=merge-duplicates",
      },
      body: JSON.stringify(lote),
    });
    if (!res.ok) {
      console.error("  ✗ Erro lote " + i + ":", await res.text());
    } else {
      lote.forEach(m => ids.push(m.id));
    }
  }

  await criarPosicoes(ids);
  console.log("✓ Salvo com sucesso!");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log("=== Importador Unificado de Esportes ===\n");
  const todos = [];

  // ── FUTEBOL ──────────────────────────────────────────────────────────────
  console.log("[Futebol — football-data.org]");
  for (const liga of LIGAS_FUTEBOL) {
    todos.push(...await fetchLiga(liga));
    await sleep(500);
  }

  // ── OUTROS ESPORTES ──────────────────────────────────────────────────────
  console.log("\n[Outros Esportes — TheSportsDB]");
  for (const esporte of OUTROS_ESPORTES) {
    todos.push(...await fetchEsporte(esporte));
  }

  console.log("\nTotal coletado: " + todos.length + " eventos.");
  await salvar(todos);
  console.log("\nFeito!");
})();
