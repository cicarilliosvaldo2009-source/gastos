// supabase/functions/sync-mercadopago/index.ts
//
// Se ejecuta una vez por día (programado con pg_cron, ver supabase/schema.sql).
// 1. Busca el último reporte "Todas las transacciones" generado por Mercado Pago.
// 2. Si ya lo procesamos antes, no hace nada.
// 3. Si es nuevo, lo descarga, se queda solo con los movimientos negativos
//    (= plata que salió de la cuenta, es decir gastos), los categoriza según
//    tus reglas (tabla `category_rules`, editables desde la app) y los que no
//    matchean ninguna van a "Sin categorizar". Todo lo inserta en
//    `transactions` con source = 'mercadopago'.
//
// Antes de confiar en esto: generá un reporte de prueba desde el panel de
// Mercado Pago (Tu negocio > Reportes) y revisá los nombres reales de columnas
// contra el Glosario de "Todas las transacciones". Si difieren de las
// constantes de abajo, ajustalas.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Tu propio user id de Supabase Auth (Authentication > Users, columna "UID").
// Hace falta porque esta función corre con la service role key, sin sesión
// de usuario, así que no hay auth.uid() automático.
const SYNC_USER_ID = Deno.env.get("MP_SYNC_USER_ID")!;

// Ajustá estos tres nombres según el CSV real que te entregue Mercado Pago.
const AMOUNT_COLUMN = "TRANSACTION_AMOUNT";
const DATE_COLUMN = "TRANSACTION_DATE";
const DESCRIPTION_COLUMN = "DESCRIPTION";

function parseCsv(text: string) {
  const delimiter = text.split("\n")[0].includes(";") ? ";" : ",";
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(delimiter).map((h) => h.trim().replace(/"/g, ""));
  const rows = lines
    .filter(Boolean)
    .map((line) => line.split(delimiter).map((c) => c.trim().replace(/"/g, "")));
  return { headers, rows };
}

Deno.serve(async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. Listar reportes generados y quedarnos con el más nuevo
    const listRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report/list", {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!listRes.ok) {
      return new Response(`Error al listar reportes: ${listRes.status}`, { status: 500 });
    }
    const reports = await listRes.json();
    if (!Array.isArray(reports) || reports.length === 0) {
      return new Response("Todavía no hay reportes generados.", { status: 200 });
    }
    const latest = [...reports].sort(
      (a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime()
    )[0];

    // 2. No reprocesar el mismo archivo dos veces
    const { data: state } = await supabase
      .from("sync_state")
      .select("*")
      .eq("id", "mercadopago")
      .maybeSingle();
    if (state?.last_file_name === latest.file_name) {
      return new Response("Nada nuevo para sincronizar.", { status: 200 });
    }

    // 3. Descargar y parsear el CSV
    const fileRes = await fetch(
      `https://api.mercadopago.com/v1/account/settlement_report/${latest.file_name}`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );
    if (!fileRes.ok) {
      return new Response(`Error al descargar el reporte: ${fileRes.status}`, { status: 500 });
    }
    const csvText = await fileRes.text();
    const { headers, rows } = parseCsv(csvText);

    const amountIdx = headers.indexOf(AMOUNT_COLUMN);
    const dateIdx = headers.indexOf(DATE_COLUMN);
    const descIdx = headers.indexOf(DESCRIPTION_COLUMN);

    if (amountIdx === -1) {
      return new Response(
        `No encontré la columna "${AMOUNT_COLUMN}" en el reporte. Columnas disponibles: ${headers.join(", ")}`,
        { status: 500 }
      );
    }

    const gastos = rows.filter((cols) => parseFloat(cols[amountIdx]) < 0);

    // 4. Reglas de categorización + categoría de respaldo para lo que no matchea
    const { data: userRules } = await supabase
      .from("category_rules")
      .select("keyword, category_id")
      .eq("user_id", SYNC_USER_ID);

    let { data: fallbackCat } = await supabase
      .from("categories")
      .select("id")
      .eq("user_id", SYNC_USER_ID)
      .eq("name", "Sin categorizar")
      .maybeSingle();

    if (!fallbackCat) {
      const { data: created } = await supabase
        .from("categories")
        .insert({ user_id: SYNC_USER_ID, name: "Sin categorizar", icon: "", color: "#9B9B94", budget: 0 })
        .select()
        .single();
      fallbackCat = created;
    }

    function matchCategory(description: string) {
      const desc = description.toLowerCase();
      const found = (userRules || []).find((r) => desc.includes(r.keyword.toLowerCase()));
      return found ? found.category_id : fallbackCat!.id;
    }

    const inserts = gastos.map((cols) => {
      const description = descIdx >= 0 ? cols[descIdx] : "Movimiento Mercado Pago";
      return {
        user_id: SYNC_USER_ID,
        category_id: matchCategory(description),
        description,
        amount: Math.abs(parseFloat(cols[amountIdx])),
        date: dateIdx >= 0 ? cols[dateIdx].slice(0, 10) : new Date().toISOString().slice(0, 10),
        source: "mercadopago",
      };
    });

    if (inserts.length > 0) {
      const { error } = await supabase.from("transactions").insert(inserts);
      if (error) {
        return new Response(`Error al insertar gastos: ${error.message}`, { status: 500 });
      }
    }

    await supabase.from("sync_state").upsert({
      id: "mercadopago",
      last_file_name: latest.file_name,
      synced_at: new Date().toISOString(),
    });

    return new Response(`Listo: se sincronizaron ${inserts.length} gastos.`, { status: 200 });
  } catch (err) {
    return new Response(`Error inesperado: ${err}`, { status: 500 });
  }
});
