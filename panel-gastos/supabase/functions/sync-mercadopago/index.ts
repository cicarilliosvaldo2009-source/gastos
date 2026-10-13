// Descarga el último reporte procesado de "Todas las transacciones" y agrega
// a gastos.transactions los movimientos cuyo impacto neto fue una salida.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNC_USER_ID = Deno.env.get("MP_SYNC_USER_ID")!;

function parseCsv(text: string) {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = source.split(/\r?\n/, 1)[0].includes(";") ? ";" : ",";
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, "").trim());
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell.replace(/\r$/, "").trim());
    if (row.some((value) => value !== "")) records.push(row);
  }

  const headerIndex = records.findIndex((record) =>
    record.includes("TRANSACTION_DATE") || record.includes("RELEASE_DATE")
  );
  if (headerIndex < 0) throw new Error("No encontré el encabezado del reporte de Mercado Pago.");
  return { headers: records[headerIndex].map((value) => value.toUpperCase()), rows: records.slice(headerIndex + 1) };
}

function parseAmount(raw: string | undefined) {
  if (raw == null || raw.trim() === "") return null;
  const value = raw.trim().replace(/"/g, "");
  const normalized = value.includes(",")
    ? value.replace(/\./g, "").replace(",", ".")
    : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseDate(raw: string | undefined) {
  if (!raw) return null;
  const value = raw.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = value.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (local) return `${local[3]}-${local[2]}-${local[1]}`;
  return null;
}

function currentArgentinaMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-01`;
}

async function generateAutomaticDebits(supabase: ReturnType<typeof createClient>) {
  const monthStart = currentArgentinaMonth();
  const { data: debits, error: debitError } = await supabase
    .from("recurring_expenses")
    .select("id, user_id, category_id, description, amount, start_month")
    .eq("active", true)
    .lte("start_month", monthStart);
  if (debitError) throw debitError;

  const transactions = (debits || []).map((debit) => ({
    user_id: debit.user_id,
    recurring_expense_id: debit.id,
    category_id: debit.category_id,
    description: debit.description,
    amount: debit.amount,
    date: monthStart,
    source: "automatic_debit",
    external_id: `automatic-debit:${debit.id}:${monthStart.slice(0, 7)}`,
    excluded_from_budget: false,
    needs_review: false,
  }));

  if (transactions.length === 0) return 0;
  const { data, error } = await supabase
    .from("transactions")
    .upsert(transactions, { onConflict: "user_id,external_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return data?.length || 0;
}

Deno.serve(async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      db: { schema: "gastos" },
    });

    const automaticDebitCount = await generateAutomaticDebits(supabase);

    const listRes = await fetch("https://api.mercadopago.com/v1/account/settlement_report/list", {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!listRes.ok) {
      return new Response(`Error al listar reportes de Mercado Pago: ${listRes.status}`, { status: 500 });
    }

    const reports = await listRes.json();
    const readyReports = Array.isArray(reports)
      ? reports.filter((report) => report.status === "processed" && report.file_name)
      : [];
    if (readyReports.length === 0) {
      return new Response(`Débitos automáticos agregados: ${automaticDebitCount}. Todavía no hay reportes procesados de Mercado Pago.`, { status: 200 });
    }

    readyReports.sort(
      (a, b) => new Date(b.date_created || b.generation_date).getTime()
        - new Date(a.date_created || a.generation_date).getTime(),
    );
    const latest = readyReports[0];

    const { data: state, error: stateError } = await supabase
      .from("sync_state")
      .select("last_file_name")
      .eq("id", "mercadopago")
      .maybeSingle();
    if (stateError) throw stateError;
    if (state?.last_file_name === latest.file_name) {
      return new Response(`Débitos automáticos agregados: ${automaticDebitCount}. Nada nuevo de Mercado Pago para sincronizar.`, { status: 200 });
    }

    const fileRes = await fetch(
      `https://api.mercadopago.com/v1/account/settlement_report/${encodeURIComponent(latest.file_name)}`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } },
    );
    if (!fileRes.ok) {
      return new Response(`Error al descargar el reporte: ${fileRes.status}`, { status: 500 });
    }

    const { headers, rows } = parseCsv(await fileRes.text());
    const indexOf = (name: string) => headers.indexOf(name);
    const dateIndex = indexOf("TRANSACTION_DATE") >= 0 ? indexOf("TRANSACTION_DATE") : indexOf("RELEASE_DATE");
    const typeIndex = indexOf("TRANSACTION_TYPE");
    const descriptionIndex = indexOf("DESCRIPTION");
    const sourceIndex = indexOf("SOURCE_ID");
    const referenceIndex = indexOf("EXTERNAL_REFERENCE") >= 0
      ? indexOf("EXTERNAL_REFERENCE")
      : indexOf("REFERENCE_ID");
    const amountIndexes = ["SETTLEMENT_NET_AMOUNT", "TRANSACTION_NET_AMOUNT", "TRANSACTION_AMOUNT"]
      .map(indexOf)
      .filter((index) => index >= 0);

    if (dateIndex < 0 || amountIndexes.length === 0) {
      throw new Error(`Faltan columnas de fecha o monto. Columnas disponibles: ${headers.join(", ")}`);
    }

    const { data: userRules, error: rulesError } = await supabase
      .from("category_rules")
      .select("keyword, category_id")
      .eq("user_id", SYNC_USER_ID);
    if (rulesError) throw rulesError;

    let { data: fallbackCat, error: categoryError } = await supabase
      .from("categories")
      .select("id")
      .eq("user_id", SYNC_USER_ID)
      .eq("name", "Sin categorizar")
      .maybeSingle();
    if (categoryError) throw categoryError;

    if (!fallbackCat) {
      const { data: created, error } = await supabase
        .from("categories")
        .insert({
          user_id: SYNC_USER_ID,
          name: "Sin categorizar",
          icon: "",
          color: "#9B9B94",
          budget: 0,
        })
        .select("id")
        .single();
      if (error) throw error;
      fallbackCat = created;
    }

    const seen: Record<string, number> = {};
    const inserts = rows.flatMap((cols) => {
      const rawAmount = amountIndexes.map((index) => parseAmount(cols[index])).find((value) => value !== null);
      const date = parseDate(cols[dateIndex]);
      if (rawAmount == null || rawAmount >= 0 || !date) return [];

      const type = typeIndex >= 0 ? (cols[typeIndex] || "").trim() : "";
      const description = ((descriptionIndex >= 0 && cols[descriptionIndex]) || type || "Movimiento Mercado Pago")
        .trim()
        .replace(/\s+/g, " ");
      const sourceId = sourceIndex >= 0 ? (cols[sourceIndex] || "").trim() : "";
      const reference = referenceIndex >= 0 ? (cols[referenceIndex] || "").trim() : "";
      const identity = sourceId || reference || description;
      const baseId = `${identity}|${type}|${date}|${rawAmount.toFixed(2)}`;
      seen[baseId] = (seen[baseId] || 0) + 1;
      const externalId = seen[baseId] > 1 ? `${baseId}#${seen[baseId]}` : baseId;

      const found = (userRules || []).find((rule) =>
        rule.keyword && description.toLowerCase().includes(rule.keyword.toLowerCase())
      );
      return [{
        user_id: SYNC_USER_ID,
        category_id: found?.category_id || fallbackCat!.id,
        description,
        amount: Math.abs(rawAmount),
        date,
        source: "mercadopago",
        external_id: externalId,
        needs_review: !found,
      }];
    });

    if (inserts.length > 0) {
      const { error } = await supabase
        .from("transactions")
        .upsert(inserts, { onConflict: "user_id,external_id", ignoreDuplicates: true });
      if (error) throw error;
    }

    const { error: syncError } = await supabase.from("sync_state").upsert({
      id: "mercadopago",
      last_file_name: latest.file_name,
      synced_at: new Date().toISOString(),
    });
    if (syncError) throw syncError;

    return new Response(`Listo: ${inserts.length} gastos de Mercado Pago y ${automaticDebitCount} débitos automáticos agregados.`, { status: 200 });
  } catch (err) {
    console.error("sync-mercadopago:", err);
    return new Response("Error al sincronizar el reporte de Mercado Pago.", { status: 500 });
  }
});
