// Administra conexiones individuales de Mercado Pago y procesa sus reportes diarios.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const LEGACY_MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const LEGACY_USER_ID = Deno.env.get("MP_SYNC_USER_ID") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function getJwtRole(token: string) {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)).role ?? null;
  } catch {
    return null;
  }
}

function createAdminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Falta la configuración interna de Supabase.");
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "gastos" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getAuthenticatedUser(token: string) {
  const apiKey = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_ROLE_KEY;
  const authClient = createClient(SUPABASE_URL, apiKey, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new Error("La sesión no es válida. Volvé a iniciar sesión.");
  return data.user;
}

function parseCsv(text: string) {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = source.split(/\r?\n/, 1)[0].includes(";") ? ";" : ",";
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    if (quoted) {
      if (character === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell === "") {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, "").trim());
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
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
  return {
    headers: records[headerIndex].map((value) => value.toUpperCase()),
    rows: records.slice(headerIndex + 1),
  };
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
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  const local = value.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (local) return local[3] + "-" + local[2] + "-" + local[1];
  return null;
}

function currentArgentinaMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-01";
}

async function generateAutomaticDebits(supabase: ReturnType<typeof createAdminClient>) {
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
    external_id: "automatic-debit:" + debit.id + ":" + monthStart.slice(0, 7),
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

async function saveSyncStatus(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  status: "success" | "error",
  importedCount: number,
  skippedCount: number,
  message: string,
) {
  const { error } = await supabase.from("mercadopago_sync_status").upsert({
    user_id: userId,
    last_checked_at: new Date().toISOString(),
    last_status: status,
    imported_count: importedCount,
    skipped_count: skippedCount,
    last_message: message,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

async function configureDailyReport(accessToken: string) {
  const authorization = { Authorization: "Bearer " + accessToken };
  const configUrl = "https://api.mercadopago.com/v1/account/settlement_report/config";
  let configResponse = await fetch(configUrl, { headers: authorization });
  let configuration: { scheduled?: boolean } | null = null;

  if (configResponse.status === 404) {
    configResponse = await fetch(configUrl, {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name_prefix: "gastos-mp",
        display_timezone: "GMT-03",
        separator: ";",
        header_language: "es",
        frequency: { type: "daily", hour: 6 },
        columns: [
          { key: "TRANSACTION_DATE" },
          { key: "TRANSACTION_TYPE" },
          { key: "TRANSACTION_AMOUNT" },
          { key: "SETTLEMENT_NET_AMOUNT" },
          { key: "SOURCE_ID" },
          { key: "EXTERNAL_REFERENCE" },
          { key: "DESCRIPTION" },
        ],
      }),
    });
    if (!configResponse.ok) {
      throw new Error("Mercado Pago no permitió configurar el reporte. Revisá el Access Token y sus permisos.");
    }
    configuration = await configResponse.json();
  } else if (!configResponse.ok) {
    if (configResponse.status === 401 || configResponse.status === 403) {
      throw new Error("Mercado Pago rechazó el Access Token. Revisá que sea de la cuenta correcta y tenga permisos.");
    }
    throw new Error("No se pudo consultar la configuración del reporte de Mercado Pago.");
  } else {
    configuration = await configResponse.json();
  }

  if (!configuration?.scheduled) {
    const scheduleResponse = await fetch(
      "https://api.mercadopago.com/v1/account/settlement_report/schedule",
      { method: "POST", headers: authorization },
    );
    if (!scheduleResponse.ok) {
      throw new Error("Mercado Pago no permitió activar el reporte diario.");
    }
  }
}

async function syncUserReport(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  accessToken: string,
) {
  try {
    const listResponse = await fetch(
      "https://api.mercadopago.com/v1/account/settlement_report/list",
      { headers: { Authorization: "Bearer " + accessToken } },
    );
    if (!listResponse.ok) {
      if (listResponse.status === 401 || listResponse.status === 403) {
        throw new Error("Mercado Pago rechazó el Access Token o sus permisos.");
      }
      throw new Error("No se pudieron consultar los reportes de Mercado Pago.");
    }

    const reportList = await listResponse.json();
    const reports = Array.isArray(reportList) ? reportList : [];
    const readyReports = reports.filter((report) => report.status === "processed" && report.file_name);
    const pendingReports = reports.some((report) => {
      const status = String(report.status || "").toLowerCase();
      return report.file_name && !["processed", "error", "failed"].includes(status);
    });

    if (readyReports.length === 0) {
      const message = pendingReports
        ? "Mercado Pago todavía está procesando el reporte. Se volverá a consultar automáticamente."
        : "Mercado Pago todavía no generó un reporte disponible para esta cuenta. Se volverá a consultar automáticamente.";
      await saveSyncStatus(supabase, userId, "success", 0, 0, message);
      return { importedCount: 0, skippedCount: 0, message };
    }

    // Revisa todos los reportes procesados, no solo el más reciente. MP puede
    // terminar reportes con demora; el índice único por usuario evita duplicados.
    readyReports.sort(
      (a, b) => new Date(a.date_created || a.generation_date).getTime()
        - new Date(b.date_created || b.generation_date).getTime(),
    );

    const { data: userRules, error: rulesError } = await supabase
      .from("category_rules")
      .select("keyword, category_id")
      .eq("user_id", userId);
    if (rulesError) throw rulesError;

    let { data: fallbackCategory, error: categoryError } = await supabase
      .from("categories")
      .select("id")
      .eq("user_id", userId)
      .eq("name", "Sin categorizar")
      .maybeSingle();
    if (categoryError) throw categoryError;

    if (!fallbackCategory) {
      const { data: created, error } = await supabase
        .from("categories")
        .insert({
          user_id: userId,
          name: "Sin categorizar",
          icon: "",
          color: "#9B9B94",
          budget: 0,
        })
        .select("id")
        .single();
      if (error) throw error;
      fallbackCategory = created;
    }

    let importedCount = 0;
    let skippedCount = 0;

    for (const report of readyReports) {
      const fileResponse = await fetch(
        "https://api.mercadopago.com/v1/account/settlement_report/" + encodeURIComponent(report.file_name),
        { headers: { Authorization: "Bearer " + accessToken } },
      );
      if (!fileResponse.ok) throw new Error("No se pudo descargar uno de los reportes de Mercado Pago.");

      const { headers, rows } = parseCsv(await fileResponse.text());
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
        throw new Error("El reporte no tiene columnas de fecha o importe reconocidas.");
      }

      const seen: Record<string, number> = {};
      const inserts = rows.flatMap((columns) => {
        const amount = amountIndexes
          .map((index) => parseAmount(columns[index]))
          .find((value) => value !== null);
        const date = parseDate(columns[dateIndex]);
        if (amount == null || amount >= 0 || !date) return [];

        const type = typeIndex >= 0 ? (columns[typeIndex] || "").trim() : "";
        const description = ((descriptionIndex >= 0 && columns[descriptionIndex]) || type || "Movimiento Mercado Pago")
          .trim()
          .replace(/\s+/g, " ");
        const sourceId = sourceIndex >= 0 ? (columns[sourceIndex] || "").trim() : "";
        const reference = referenceIndex >= 0 ? (columns[referenceIndex] || "").trim() : "";
        const identity = sourceId || reference || description;
        const baseId = identity + "|" + type + "|" + date + "|" + amount.toFixed(2);
        seen[baseId] = (seen[baseId] || 0) + 1;
        const externalId = seen[baseId] > 1 ? baseId + "#" + seen[baseId] : baseId;
        const found = (userRules || []).find((rule) =>
          rule.keyword && description.toLowerCase().includes(rule.keyword.toLowerCase())
        );

        return [{
          user_id: userId,
          category_id: found?.category_id || fallbackCategory!.id,
          description,
          amount: Math.abs(amount),
          date,
          source: "mercadopago",
          external_id: externalId,
          needs_review: !found,
        }];
      });

      let importedFromReport = 0;
      if (inserts.length > 0) {
        const { data: importedRows, error } = await supabase
          .from("transactions")
          .upsert(inserts, { onConflict: "user_id,external_id", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        importedFromReport = importedRows?.length || 0;
      }
      importedCount += importedFromReport;
      skippedCount += Math.max(inserts.length - importedFromReport, 0);
    }

    const latest = readyReports[readyReports.length - 1];
    const { error: stateSaveError } = await supabase.from("sync_state").upsert({
      id: "mercadopago:" + userId,
      last_file_name: latest.file_name,
      synced_at: new Date().toISOString(),
    });
    if (stateSaveError) throw stateSaveError;

    const message = importedCount > 0
      ? "Se procesaron " + readyReports.length + " reportes disponibles y se importaron " + importedCount + " gastos."
      : "Se revisaron " + readyReports.length + " reportes procesados; no había movimientos nuevos.";
    await saveSyncStatus(supabase, userId, "success", importedCount, skippedCount, message);
    return { importedCount, skippedCount, message };
  } catch (error) {
    console.error("Error al sincronizar la cuenta de Mercado Pago", userId, error);
    try {
      await saveSyncStatus(
        supabase,
        userId,
        "error",
        0,
        0,
        "No se pudo completar la consulta a Mercado Pago. Revisá el Access Token y la configuración del reporte.",
      );
    } catch (statusError) {
      console.error("No se pudo guardar el estado de sincronización", userId, statusError);
    }
    throw error;
  }
}
async function getUserConnection(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
) {
  const { data: connection, error } = await supabase
    .from("mercadopago_credentials")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(connection || (LEGACY_MP_TOKEN && LEGACY_USER_ID === userId));
}

async function handleUserRequest(request: Request, supabase: ReturnType<typeof createAdminClient>, userId: string) {
  let body: { action?: string; accessToken?: string } = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "La solicitud no tiene un formato válido." }, 400);
  }

  if (body.action === "status") {
    const [{ data: connection, error: connectionError }, { data: syncStatus, error: statusError }] = await Promise.all([
      supabase
        .from("mercadopago_credentials")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("mercadopago_sync_status")
        .select("last_checked_at,last_status,imported_count,skipped_count,last_message")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (connectionError || statusError) {
      console.error("No se pudo consultar la conexión de Mercado Pago", userId, connectionError || statusError);
      return jsonResponse({ error: "No se pudo consultar la conexión." }, 500);
    }
    return jsonResponse({
      connected: Boolean(connection || (LEGACY_MP_TOKEN && LEGACY_USER_ID === userId)),
      syncStatus: syncStatus || null,
    });
  }

  if (body.action === "connect") {
    const accessToken = body.accessToken?.trim();
    if (!accessToken || accessToken.length > 4096) {
      return jsonResponse({ error: "Pegá un Access Token válido de Mercado Pago." }, 400);
    }

    try {
      await configureDailyReport(accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo validar el Access Token.";
      return jsonResponse({ error: message }, 400);
    }

    const { error: saveError } = await supabase.from("mercadopago_credentials").upsert({
      user_id: userId,
      access_token: accessToken,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (saveError) {
      console.error("No se pudo guardar el Access Token de Mercado Pago", userId, saveError);
      return jsonResponse({ error: "No se pudo guardar el token en forma segura." }, 500);
    }

    let message = "Mercado Pago quedó conectado y el reporte diario está activo.";
    try {
      await syncUserReport(supabase, userId, accessToken);
    } catch {
      message += " La primera consulta no se completó; la app volverá a intentar en la próxima actualización.";
    }
    const { data: syncStatus } = await supabase
      .from("mercadopago_sync_status")
      .select("last_checked_at,last_status,imported_count,skipped_count,last_message")
      .eq("user_id", userId)
      .maybeSingle();

    return jsonResponse({ connected: true, message, syncStatus: syncStatus || null });
  }

  return jsonResponse({ error: "Acción no reconocida." }, 400);
}

async function runScheduledSync(supabase: ReturnType<typeof createAdminClient>) {
  const automaticDebitCount = await generateAutomaticDebits(supabase);
  const { data: storedConnections, error } = await supabase
    .from("mercadopago_credentials")
    .select("user_id, access_token");
  if (error) throw error;

  const connections = new Map<string, string>(
    (storedConnections || []).map((connection) => [connection.user_id, connection.access_token]),
  );
  if (LEGACY_MP_TOKEN && LEGACY_USER_ID && !connections.has(LEGACY_USER_ID)) {
    connections.set(LEGACY_USER_ID, LEGACY_MP_TOKEN);
  }

  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const [userId, accessToken] of connections.entries()) {
    try {
      // Revalida la programación de cada cuenta para recuperar una que haya
      // quedado desactivada o no se haya terminado de activar en Mercado Pago.
      await configureDailyReport(accessToken);
    } catch (error) {
      failedCount += 1;
      console.error("No se pudo verificar el reporte diario de Mercado Pago", userId, error);
      try {
        await saveSyncStatus(
          supabase,
          userId,
          "error",
          0,
          0,
          "No se pudo verificar la programación diaria de Mercado Pago. Revisá el Access Token y los permisos.",
        );
      } catch (statusError) {
        console.error("No se pudo guardar el estado de sincronización", userId, statusError);
      }
      continue;
    }

    try {
      const result = await syncUserReport(supabase, userId, accessToken);
      importedCount += result.importedCount;
      skippedCount += result.skippedCount;
    } catch {
      failedCount += 1;
    }
  }

  return jsonResponse({
    syncedAccounts: connections.size,
    importedCount,
    skippedCount,
    failedCount,
    automaticDebitCount,
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Método no permitido." }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token) return jsonResponse({ error: "Iniciá sesión para continuar." }, 401);

    const supabase = createAdminClient();
    if (getJwtRole(token) === "service_role") {
      return await runScheduledSync(supabase);
    }

    const user = await getAuthenticatedUser(token);
    return await handleUserRequest(request, supabase, user.id);
  } catch (error) {
    console.error("sync-mercadopago:", error);
    return jsonResponse({ error: "No se pudo completar la operación de Mercado Pago." }, 500);
  }
});
