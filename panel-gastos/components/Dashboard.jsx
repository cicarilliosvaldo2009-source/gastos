"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Plus, X, Trash2, ChevronLeft, ChevronRight, ChevronDown, Settings } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const NEW_CATEGORY_COLORS = [
  "#5C8FA8", "#8A6FB0", "#C9738F", "#6FA893", "#B08A3F", "#7A7A72", "#A3763F", "#5C7AA8",
];

const DEFAULT_CATEGORIES = [
  { name: "Comida", icon: "", color: "#C98A2C", budget: 150000 },
  { name: "Transporte", icon: "", color: "#4E7EA3", budget: 100000 },
  { name: "Servicios", icon: "", color: "#6B5CA5", budget: 80000 },
  { name: "Ocio", icon: "", color: "#B85C7E", budget: 60000 },
  { name: "Salud", icon: "", color: "#4A8577", budget: 40000 },
  { name: "Otros", icon: "", color: "#9B9B94", budget: 30000 },
];

const fmt = (n) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);

const fmtDate = (isoDate) =>
  new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short" }).format(new Date(isoDate + "T00:00:00"));

const fmtDateTime = (dateTime) => dateTime
  ? new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(dateTime))
  : "";

const fmtMonth = (date) => {
  const s = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const monthIsoOffset = (offset) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const nextMonthIso = () => monthIsoOffset(1);
const dateForMonth = (monthIso, offset) => {
  const [year, month] = monthIso.split("-").map(Number);
  const d = new Date(year, month - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

function statusFor(pct) {
  if (pct >= 100) return "over";
  if (pct >= 80) return "warn";
  return "ok";
}
const STATUS_COLOR = { warn: "#C98A2C", over: "#C1453B" };

function matchCategory(description, rules) {
  const desc = (description || "").toLowerCase();
  if (!desc) return null;
  const found = rules.find((r) => r.keyword && desc.includes(r.keyword.toLowerCase()));
  return found ? found.category_id : null;
}

// ---- Importación de reportes CSV de Mercado Pago ----
function parseArNumber(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/"/g, "");
  if (!t) return null;
  const clean = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}

function parseMpCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = source.split(/\r?\n/, 1)[0].includes(";") ? ";" : ",";
  const records = [];
  let row = [];
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
  return records;
}

function parseArDate(raw) {
  const t = String(raw || "").trim();
  let m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Devuelve { expenses, incomeCount } o null si no reconoce un reporte de Mercado Pago.
// Prefiere el impacto neto sobre la cuenta y solo importa movimientos negativos.
function parseMpStatement(text) {
  const records = parseMpCsv(text);
  const headerIdx = records.findIndex((record) =>
    record.includes("TRANSACTION_DATE") || record.includes("RELEASE_DATE")
  );
  if (headerIdx < 0) return null;
  const headers = records[headerIdx].map((h) => h.trim().replace(/^\uFEFF/, "").toUpperCase());
  const iDate = headers.indexOf("TRANSACTION_DATE") >= 0
    ? headers.indexOf("TRANSACTION_DATE")
    : headers.indexOf("RELEASE_DATE");
  const iType = headers.indexOf("TRANSACTION_TYPE");
  const iDescription = headers.indexOf("DESCRIPTION");
  const iSource = headers.indexOf("SOURCE_ID");
  const iRef = headers.indexOf("EXTERNAL_REFERENCE") >= 0
    ? headers.indexOf("EXTERNAL_REFERENCE")
    : headers.indexOf("REFERENCE_ID");
  const amountColumns = ["SETTLEMENT_NET_AMOUNT", "TRANSACTION_NET_AMOUNT", "TRANSACTION_AMOUNT"]
    .map((name) => headers.indexOf(name))
    .filter((index) => index >= 0);
  if (iDate < 0 || amountColumns.length === 0) return null;

  const seen = {};
  const expenses = [];
  let incomeCount = 0;
  for (const cols of records.slice(headerIdx + 1)) {
    const amount = amountColumns.map((index) => parseArNumber(cols[index])).find((value) => value !== null);
    const date = parseArDate(cols[iDate]);
    if (amount === null || !date) continue;
    if (amount >= 0) {
      incomeCount++;
      continue;
    }
    const type = iType >= 0 ? (cols[iType] || "").trim() : "";
    const description = ((iDescription >= 0 && cols[iDescription]) || type || "Movimiento Mercado Pago")
      .trim()
      .replace(/\s+/g, " ");
    const sourceId = iSource >= 0 ? (cols[iSource] || "").trim() : "";
    const reference = iRef >= 0 ? (cols[iRef] || "").trim() : "";
    const identity = sourceId || reference || description;
    let externalId = `${identity}|${type}|${date}|${amount.toFixed(2)}`;
    seen[externalId] = (seen[externalId] || 0) + 1;
    if (seen[externalId] > 1) externalId = `${externalId}#${seen[externalId]}`;
    expenses.push({ externalId, date, description, amount: Math.abs(amount) });
  }
  return { expenses, incomeCount };
}

export default function Dashboard() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [lastCategoryId, setLastCategoryId] = useState("");
  const [mpSyncStatus, setMpSyncStatus] = useState(null);
  const [mpSyncStatusLoading, setMpSyncStatusLoading] = useState(true);
  const [mpSyncStatusError, setMpSyncStatusError] = useState(false);
  const [categories, setCategories] = useState([]);
  const [rules, setRules] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monthOffset, setMonthOffset] = useState(0);
  const [transactionView, setTransactionView] = useState("month");
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionCategory, setTransactionCategory] = useState("");
  const [transactionDateFrom, setTransactionDateFrom] = useState("");
  const [transactionDateTo, setTransactionDateTo] = useState("");
  const [transactionAmountMin, setTransactionAmountMin] = useState("");
  const [transactionAmountMax, setTransactionAmountMax] = useState("");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [savingsModalOpen, setSavingsModalOpen] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ categoryId: "", amount: "", description: "", date: todayIso() });

  const [categoriesModalOpen, setCategoriesModalOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState({});
  const [savingBudgets, setSavingBudgets] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatBudget, setNewCatBudget] = useState("");

  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [newRuleKeyword, setNewRuleKeyword] = useState("");
  const [newRuleCategoryId, setNewRuleCategoryId] = useState("");

  const [txEditing, setTxEditing] = useState(null);
  const [txEditCategoryId, setTxEditCategoryId] = useState("");
  const [txEditDescription, setTxEditDescription] = useState("");
  const [txEditAmount, setTxEditAmount] = useState("");
  const [txEditDate, setTxEditDate] = useState("");
  const [deletingTxId, setDeletingTxId] = useState(null);
  const [txEditExcluded, setTxEditExcluded] = useState(false);
  const [rememberCategoryRule, setRememberCategoryRule] = useState(false);
  const [ruleKeywordDraft, setRuleKeywordDraft] = useState("");
  const [txEditError, setTxEditError] = useState("");
  const [savingTxEdit, setSavingTxEdit] = useState(false);

  const [settings, setSettings] = useState(null);
  const [monthlyBudgets, setMonthlyBudgets] = useState([]);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");
  const [limitEditing, setLimitEditing] = useState(false);
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitError, setLimitError] = useState("");

  const [cardPlanModalOpen, setCardPlanModalOpen] = useState(false);
  const [cardPlanSaving, setCardPlanSaving] = useState(false);
  const [cardPlanError, setCardPlanError] = useState("");
  const [cardPlanForm, setCardPlanForm] = useState({
    description: "",
    amount: "",
    categoryId: "",
    remaining: "",
    startMonth: nextMonthIso(),
  });
  const [debitModalOpen, setDebitModalOpen] = useState(false);
  const [debitSaving, setDebitSaving] = useState(false);
  const [debitError, setDebitError] = useState("");
  const [debitForm, setDebitForm] = useState({
    description: "",
    amount: "",
    categoryId: "",
    startMonth: nextMonthIso(),
  });
  const [recurringExpenses, setRecurringExpenses] = useState([]);

  const fileInputRef = useRef(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importInfo, setImportInfo] = useState({ duplicates: 0, incomeCount: 0 });
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) {
          router.replace("/login");
          return;
        }
        if (cancelled) return;

        setUserEmail(user.email || "");
        setUserId(user.id);
        try {
          setLastCategoryId(window.localStorage.getItem(`panel-gastos:last-category:${user.id}`) || "");
        } catch {
          setLastCategoryId("");
        }

        // Estas lecturas son independientes: ejecutarlas juntas evita esperar
        // una ida y vuelta a Supabase por cada sección del panel.
        const [
          { data: cats, error: categoriesError },
          { data: rls, error: rulesError },
          { data: settingsRow, error: settingsError },
          { data: txs, error: transactionsError },
          { data: recurring, error: recurringError },
          { data: budgetRows, error: monthlyBudgetsError },
        ] = await Promise.all([
          supabase.from("categories").select("*").order("created_at"),
          supabase.from("category_rules").select("*").order("created_at"),
          supabase.from("settings").select("*").maybeSingle(),
          supabase.from("transactions").select("*").order("date", { ascending: false }),
          supabase.from("recurring_expenses").select("*").order("created_at"),
          supabase.from("monthly_budgets").select("*").order("month_start"),
        ]);

        const queryError = categoriesError || rulesError || settingsError || transactionsError || recurringError || monthlyBudgetsError;
        if (queryError) throw queryError;

        let loadedCategories = cats || [];
        if (loadedCategories.length === 0) {
          const { data: inserted, error: insertError } = await supabase
            .from("categories")
            .insert(DEFAULT_CATEGORIES)
            .select();
          if (insertError) throw insertError;
          loadedCategories = inserted || [];
        }

        let loadedSettings = settingsRow;
        if (!loadedSettings) {
          const defaultLimit = loadedCategories.reduce((sum, category) => sum + Number(category.budget), 0);
          const { data: inserted, error: settingsInsertError } = await supabase
            .from("settings")
            .insert({ monthly_limit: defaultLimit })
            .select()
            .single();
          if (settingsInsertError) throw settingsInsertError;
          loadedSettings = inserted;
        }

        let loadedBudgets = budgetRows || [];
        const currentMonthStart = dateForMonth(monthIsoOffset(0), 0);
        if (!loadedBudgets.some((budget) => budget.month_start === currentMonthStart)) {
          const { data: snapshot, error: snapshotError } = await supabase
            .from("monthly_budgets")
            .upsert({ month_start: currentMonthStart, monthly_limit: Number(loadedSettings.monthly_limit) }, { onConflict: "user_id,month_start" })
            .select()
            .single();
          if (snapshotError) throw snapshotError;
          loadedBudgets = [...loadedBudgets, snapshot].sort((a, b) => a.month_start.localeCompare(b.month_start));
        }

        if (cancelled) return;
        setCategories(loadedCategories);
        if (loadedCategories.length > 0) {
          setForm((formState) => ({ ...formState, categoryId: loadedCategories[0].id }));
        }
        setRules(rls || []);
        setSettings(loadedSettings);
        setMonthlyBudgets(loadedBudgets);
        setTransactions(txs || []);
        setRecurringExpenses(recurring || []);
      } catch (error) {
        console.error("No se pudo cargar el panel:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDashboard();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  useEffect(() => {
    if (!configModalOpen || !userId) return;
    let cancelled = false;

    async function loadMpSyncStatus() {
      setMpSyncStatusLoading(true);
      try {
        const { data, error } = await supabase
          .from("mercadopago_sync_status")
          .select("last_checked_at,last_status,imported_count,skipped_count,last_message")
          .maybeSingle();
        if (error) throw error;
        if (!cancelled) {
          setMpSyncStatus(data);
          setMpSyncStatusError(false);
        }
      } catch (error) {
        console.warn("No se pudo cargar el estado de Mercado Pago:", error);
        if (!cancelled) {
          setMpSyncStatus(null);
          setMpSyncStatusError(true);
        }
      } finally {
        if (!cancelled) setMpSyncStatusLoading(false);
      }
    }

    loadMpSyncStatus();
    return () => {
      cancelled = true;
    };
  }, [configModalOpen, userId, supabase]);

  const viewDate = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  }, [monthOffset]);

  const monthTx = useMemo(() => {
    return transactions.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      return d.getFullYear() === viewDate.getFullYear() && d.getMonth() === viewDate.getMonth();
    });
  }, [transactions, viewDate]);

  const budgetTx = useMemo(() => monthTx.filter((t) => !t.excluded_from_budget), [monthTx]);
  const totalGastado = budgetTx.reduce((s, t) => s + Number(t.amount), 0);
  const sumaCategorias = categories.reduce((s, c) => s + Number(c.budget), 0);
  const viewMonthKey = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, "0")}`;
  const viewBudget = monthlyBudgets
    .filter((budget) => budget.month_start.slice(0, 7) <= viewMonthKey)
    .sort((a, b) => b.month_start.localeCompare(a.month_start))[0];
  const earliestBudgetMonth = monthlyBudgets[0]?.month_start.slice(0, 7);
  const noHistoricalBudget = Boolean(earliestBudgetMonth && viewMonthKey < earliestBudgetMonth);
  const presupuestoTotal = viewBudget
    ? Number(viewBudget.monthly_limit)
    : noHistoricalBudget ? null : settings?.monthly_limit > 0 ? Number(settings.monthly_limit) : sumaCategorias;
  const disponible = presupuestoTotal === null ? null : presupuestoTotal - totalGastado;

  const monthlyRemainders = useMemo(() => {
    return Array.from({ length: 6 }, (_, index) => {
      const monthKey = monthIsoOffset(-index);
      const spent = transactions
        .filter((transaction) => transaction.date.startsWith(monthKey) && !transaction.excluded_from_budget)
        .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
      const budget = monthlyBudgets
        .filter((item) => item.month_start.slice(0, 7) <= monthKey)
        .sort((a, b) => b.month_start.localeCompare(a.month_start))[0];
      const [year, month] = monthKey.split("-").map(Number);
      return {
        key: monthKey,
        label: fmtMonth(new Date(year, month - 1, 1)),
        spent,
        limit: budget ? Number(budget.monthly_limit) : null,
        amount: budget ? Number(budget.monthly_limit) - spent : null,
      };
    });
  }, [transactions, monthlyBudgets]);

  const savingsScale = Math.max(
    1,
    ...monthlyRemainders.map((month) => Math.max(month.spent, month.limit || 0))
  );

  const currentMonthProjection = useMemo(() => {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const spent = transactions
      .filter((transaction) => transaction.date.startsWith(monthKey) && !transaction.excluded_from_budget)
      .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const projectedSpent = daysElapsed > 0 ? Math.round((spent / daysElapsed) * daysInMonth) : 0;
    const monthStart = `${monthKey}-01`;
    const budget = monthlyBudgets
      .filter((item) => item.month_start.slice(0, 7) <= monthKey)
      .sort((a, b) => b.month_start.localeCompare(a.month_start))[0];
    const limit = budget
      ? Number(budget.monthly_limit)
      : settings?.monthly_limit > 0 ? Number(settings.monthly_limit) : null;

    return {
      monthKey,
      spent,
      daysElapsed,
      daysInMonth,
      projectedSpent,
      limit,
      projectedRemainder: limit === null ? null : limit - projectedSpent,
      monthStart,
    };
  }, [transactions, monthlyBudgets, settings]);

  const categorySpend = useMemo(() => {
    return categories.map((c) => {
      const spent = budgetTx.filter((t) => t.category_id === c.id).reduce((s, t) => s + Number(t.amount), 0);
      const pct = c.budget > 0 ? Math.round((spent / c.budget) * 100) : 0;
      return { ...c, spent, pct, status: statusFor(pct) };
    });
  }, [categories, budgetTx]);

  const frequentCategories = useMemo(() => {
    const usage = new Map();
    transactions.forEach((transaction) => {
      if (transaction.category_id && !transaction.excluded_from_budget) {
        usage.set(transaction.category_id, (usage.get(transaction.category_id) || 0) + 1);
      }
    });
    return categories
      .map((category) => ({ ...category, usage: usage.get(category.id) || 0 }))
      .filter((category) => category.usage > 0)
      .sort((a, b) => b.usage - a.usage)
      .slice(0, 3);
  }, [transactions, categories]);

  const quickAddCategories = useMemo(() => {
    const orderedIds = [lastCategoryId, ...frequentCategories.map((category) => category.id), ...categories.map((category) => category.id)];
    return [...new Set(orderedIds)]
      .map((id) => categories.find((category) => category.id === id))
      .filter(Boolean)
      .slice(0, 4);
  }, [lastCategoryId, frequentCategories, categories]);

  const chartData = categorySpend.filter((c) => c.spent > 0).map((c) => ({
    name: c.name,
    value: c.spent,
    color: c.color,
    budget: Number(c.budget),
    overBudget: c.status === "over",
  }));
  const pendingReviewTx = useMemo(
    () => transactions.filter((t) => t.needs_review).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [transactions]
  );

  function handleDescriptionChange(desc) {
    const match = matchCategory(desc, rules);
    setForm((f) => ({ ...f, description: desc, categoryId: match || f.categoryId }));
  }

  function openAddModal() {
    let storedCategoryId = "";
    try {
      if (userId) storedCategoryId = window.localStorage.getItem(`panel-gastos:last-category:${userId}`) || "";
    } catch {
      storedCategoryId = "";
    }
    const preferredCategoryId = [
      storedCategoryId,
      lastCategoryId,
      frequentCategories[0]?.id,
      form.categoryId,
      categories[0]?.id,
    ].find((id) => id && categories.some((category) => category.id === id)) || "";
    setForm((current) => ({ ...current, categoryId: preferredCategoryId }));
    setModalOpen(true);
  }

  async function addTransaction() {
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0 || !form.description.trim() || !form.categoryId) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("transactions")
      .insert({
        category_id: form.categoryId,
        description: form.description.trim(),
        amount,
        date: form.date,
        source: "manual",
      })
      .select()
      .single();
    setSaving(false);
    if (!error && data) {
      setTransactions((prev) => [data, ...prev]);
      setLastCategoryId(form.categoryId);
      try {
        if (userId) window.localStorage.setItem(`panel-gastos:last-category:${userId}`, form.categoryId);
      } catch {
        // La categoría elegida sigue activa aunque el navegador bloquee localStorage.
      }
      setModalOpen(false);
      setForm({ categoryId: form.categoryId, amount: "", description: "", date: todayIso() });
    }
  }

  function openCategoriesEdit() {
    const draft = {};
    categories.forEach((c) => { draft[c.id] = String(c.budget); });
    setBudgetDraft(draft);
    setNewCatName("");
    setNewCatBudget("");
    setCategoriesModalOpen(true);
  }

  async function saveCategoryBudgets() {
    setSavingBudgets(true);
    const changed = categories
      .map((c) => ({ id: c.id, val: parseFloat(budgetDraft[c.id]) }))
      .filter((c) => c.val > 0);
    const results = await Promise.all(
      changed.map((c) => supabase.from("categories").update({ budget: c.val }).eq("id", c.id).select().single())
    );
    setCategories((prev) =>
      prev.map((c) => {
        const updated = results.find((r) => r.data && r.data.id === c.id);
        return updated ? updated.data : c;
      })
    );
    setSavingBudgets(false);
    setCategoriesModalOpen(false);
  }

  async function addCategory() {
    if (!newCatName.trim()) return;
    const color = NEW_CATEGORY_COLORS[categories.length % NEW_CATEGORY_COLORS.length];
    const budget = parseFloat(newCatBudget) || 0;
    const { data, error } = await supabase
      .from("categories")
      .insert({ name: newCatName.trim(), color, budget, icon: "" })
      .select()
      .single();
    if (!error && data) {
      setCategories((prev) => [...prev, data]);
      setBudgetDraft((d) => ({ ...d, [data.id]: String(budget) }));
      setNewCatName("");
      setNewCatBudget("");
    }
  }

  async function deleteCategory(id) {
    await supabase.from("categories").delete().eq("id", id);
    setCategories((prev) => prev.filter((c) => c.id !== id));
    setTransactions((prev) => prev.map((t) => (t.category_id === id ? { ...t, category_id: null } : t)));
    setRules((prev) => prev.filter((r) => r.category_id !== id));
  }

  function openRulesModal() {
    setNewRuleKeyword("");
    setNewRuleCategoryId(categories[0]?.id || "");
    setRulesModalOpen(true);
  }

  async function addRule() {
    if (!newRuleKeyword.trim() || !newRuleCategoryId) return;
    const { data, error } = await supabase
      .from("category_rules")
      .insert({ keyword: newRuleKeyword.trim(), category_id: newRuleCategoryId })
      .select()
      .single();
    if (!error && data) {
      setRules((prev) => [...prev, data]);
      setNewRuleKeyword("");
    }
  }

  async function deleteRule(id) {
    await supabase.from("category_rules").delete().eq("id", id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  function openTxEdit(t) {
    setTxEditing(t);
    setTxEditDescription(t.description || "");
    setTxEditAmount(String(t.amount ?? ""));
    setTxEditDate(t.date || todayIso());
    setTxEditCategoryId(t.category_id || "");
    setTxEditExcluded(Boolean(t.excluded_from_budget));
    setRememberCategoryRule(false);
    setRuleKeywordDraft(t.description || "");
    setTxEditError("");
  }

  async function saveTxCategory() {
    const amount = Number(String(txEditAmount).replace(",", "."));
    if (!txEditDescription.trim() || !Number.isFinite(amount) || amount <= 0 || !txEditDate) {
      setTxEditError("Completá una descripción, un importe válido y una fecha.");
      return;
    }
    setSavingTxEdit(true);
    setTxEditError("");
    try {
      const { data, error } = await supabase
        .from("transactions")
        .update({
          description: txEditDescription.trim(),
          amount,
          date: txEditDate,
          category_id: txEditCategoryId || null,
          excluded_from_budget: txEditExcluded,
          needs_review: false,
        })
        .eq("id", txEditing.id)
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (!data) throw new Error("Supabase no confirmó el cambio.");
      setTransactions((prev) => prev.map((t) => (t.id === data.id ? data : t)));

      if (rememberCategoryRule && txEditCategoryId && ruleKeywordDraft.trim()) {
        const keyword = ruleKeywordDraft.trim();
        const { data: oldRule, error: lookupError } = await supabase
          .from("category_rules")
          .select("id")
          .eq("keyword", keyword)
          .maybeSingle();
        if (lookupError) throw lookupError;
        const ruleResult = oldRule
          ? await supabase.from("category_rules").update({ category_id: txEditCategoryId }).eq("id", oldRule.id).select().single()
          : await supabase.from("category_rules").insert({ keyword, category_id: txEditCategoryId }).select().single();
        if (ruleResult.error) throw ruleResult.error;
        setRules((prev) => oldRule
          ? prev.map((rule) => rule.id === oldRule.id ? ruleResult.data : rule)
          : [...prev, ruleResult.data]);
      }
      setTxEditing(null);
    } catch (error) {
      setTxEditError(error.name === "TimeoutError"
        ? "La base de datos tardó demasiado en responder. Intentá otra vez."
        : `No se pudo guardar: ${error.message || "error de conexión"}`);
    } finally {
      setSavingTxEdit(false);
    }
  }

  async function deleteTransaction(transaction) {
    if (!window.confirm(`¿Eliminar el gasto "${transaction.description}"?`)) return;
    setDeletingTxId(transaction.id);
    try {
      const { error } = await supabase.from("transactions").delete().eq("id", transaction.id);
      if (error) throw error;
      setTransactions((previous) => previous.filter((item) => item.id !== transaction.id));
      setTxEditing(null);
    } catch (error) {
      window.alert(`No se pudo eliminar: ${error.message || "error de conexión"}`);
    } finally {
      setDeletingTxId(null);
    }
  }

  function openCardPlan() {
    setConfigModalOpen(false);
    setCardPlanForm({
      description: "",
      amount: "",
      categoryId: categories[0]?.id || "",
      remaining: "",
      startMonth: nextMonthIso(),
    });
    setCardPlanError("");
    setCardPlanModalOpen(true);
  }

  async function addCardPlan() {
    const amount = Number(String(cardPlanForm.amount).replace(",", "."));
    const remaining = Number.parseInt(cardPlanForm.remaining, 10);
    if (!cardPlanForm.description.trim() || !Number.isFinite(amount) || amount <= 0 ||
      !Number.isInteger(remaining) || remaining < 1 || remaining > 120 || !cardPlanForm.categoryId || !cardPlanForm.startMonth) {
      setCardPlanError("Completá la descripción, el importe de cada cuota, las cuotas pendientes, la categoría y el primer mes.");
      return;
    }

    setCardPlanSaving(true);
    setCardPlanError("");
    const planId = crypto.randomUUID();
    const installments = Array.from({ length: remaining }, (_, index) => ({
      category_id: cardPlanForm.categoryId,
      description: cardPlanForm.description.trim(),
      amount,
      date: dateForMonth(cardPlanForm.startMonth, index),
      source: "credit_card",
      external_id: `card-installment:${planId}:${index + 1}`,
      installment_plan_id: planId,
      installment_number: index + 1,
      installment_total: remaining,
      excluded_from_budget: false,
      needs_review: false,
    }));

    try {
      const { data, error } = await supabase.from("transactions").insert(installments).select()
        .abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      setTransactions((prev) => [...(data || []), ...prev].sort((a, b) => (a.date < b.date ? 1 : -1)));
      setCardPlanModalOpen(false);
      setConfigModalOpen(false);
    } catch (error) {
      setCardPlanError(error.name === "TimeoutError"
        ? "La base de datos tardó demasiado en responder. Intentá otra vez."
        : `No se pudieron guardar las cuotas: ${error.message || "error de conexión"}`);
    } finally {
      setCardPlanSaving(false);
    }
  }

  function openDebitModal() {
    setConfigModalOpen(false);
    setDebitForm({
      description: "",
      amount: "",
      categoryId: categories[0]?.id || "",
      startMonth: nextMonthIso(),
    });
    setDebitError("");
    setDebitModalOpen(true);
  }

  async function addAutomaticDebit() {
    const amount = Number(String(debitForm.amount).replace(",", "."));
    if (!debitForm.description.trim() || !Number.isFinite(amount) || amount <= 0 || !debitForm.categoryId || !debitForm.startMonth) {
      setDebitError("Completá descripción, importe mensual, categoría y mes de inicio.");
      return;
    }

    setDebitSaving(true);
    setDebitError("");
    try {
      const { data: debit, error } = await supabase.from("recurring_expenses").insert({
        description: debitForm.description.trim(),
        amount,
        category_id: debitForm.categoryId,
        start_month: dateForMonth(debitForm.startMonth, 0),
        active: true,
      }).select().single().abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (!debit) throw new Error("Supabase no confirmó el débito automático.");

      setRecurringExpenses((prev) => [debit, ...prev]);
      const currentMonth = dateForMonth(monthIsoOffset(0), 0);
      if (debit.start_month <= currentMonth) {
        const { data: createdTransactions, error: transactionError } = await supabase.from("transactions").upsert({
          recurring_expense_id: debit.id,
          category_id: debit.category_id,
          description: debit.description,
          amount: Number(debit.amount),
          date: debit.start_month,
          source: "automatic_debit",
          external_id: `automatic-debit:${debit.id}:${debit.start_month.slice(0, 7)}`,
          excluded_from_budget: false,
          needs_review: false,
        }, { onConflict: "user_id,external_id", ignoreDuplicates: true }).select().abortSignal(AbortSignal.timeout(15000));
        if (transactionError) throw transactionError;
        if (createdTransactions?.length) setTransactions((prev) => [...createdTransactions, ...prev]);
      }

      setDebitModalOpen(false);
      setConfigModalOpen(false);
    } catch (error) {
      setDebitError(error.name === "TimeoutError"
        ? "La base de datos tardó demasiado en responder. Intentá otra vez."
        : `No se pudo guardar el débito: ${error.message || "error de conexión"}`);
    } finally {
      setDebitSaving(false);
    }
  }

  async function toggleAutomaticDebit(debit) {
    const { data, error } = await supabase.from("recurring_expenses")
      .update({ active: !debit.active }).eq("id", debit.id).select().single();
    if (!error && data) setRecurringExpenses((prev) => prev.map((item) => item.id === data.id ? data : item));
    else setDebitError(`No se pudo actualizar el débito: ${error?.message || "error"}`);
  }

  function openConfig() {
    setLimitDraft(String(settings?.monthly_limit > 0 ? settings.monthly_limit : sumaCategorias));
    setLimitEditing(false);
    setLimitError("");
    setConfigModalOpen(true);
  }

  async function saveLimit() {
    const val = parseFloat(limitDraft);
    if (!Number.isFinite(val) || val <= 0) {
      setLimitError("Ingresá un límite mensual mayor que cero.");
      return;
    }
    setSavingLimit(true);
    setLimitError("");
    try {
      const { data, error } = await supabase
        .from("settings")
        .upsert({ monthly_limit: val }, { onConflict: "user_id" })
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (!data) throw new Error("Supabase no confirmó el cambio.");
      setSettings(data);
      const currentMonthStart = dateForMonth(monthIsoOffset(0), 0);
      setMonthlyBudgets((previous) => {
        const current = previous.find((budget) => budget.month_start === currentMonthStart);
        return current
          ? previous.map((budget) => budget.month_start === currentMonthStart ? { ...budget, monthly_limit: val } : budget)
          : [...previous, { month_start: currentMonthStart, monthly_limit: val }].sort((a, b) => a.month_start.localeCompare(b.month_start));
      });
      setConfigModalOpen(false);
    } catch (error) {
      setLimitError(error.name === "TimeoutError"
        ? "La base de datos tardó demasiado en responder. Revisá tu conexión e intentá otra vez."
        : `No se pudo guardar el límite: ${error.message || "error de conexión"}`);
    } finally {
      setSavingLimit(false);
    }
  }

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    setImportNotice("");
    let parsed = null;
    try {
      parsed = parseMpStatement(await file.text());
    } catch (err) {
      parsed = null;
    }
    if (!parsed) {
      setImportRows([]);
      setImportInfo({ duplicates: 0, incomeCount: 0 });
      setImportError(
        "No reconozco este archivo. Tiene que ser un CSV de Mercado Pago con fecha, tipo de movimiento y monto."
      );
      setImportModalOpen(true);
      return;
    }
    const known = new Set(transactions.map((t) => t.external_id).filter(Boolean));
    const fresh = parsed.expenses.filter((r) => !known.has(r.externalId));
    setImportRows(
      fresh.map((r) => ({ ...r, categoryId: matchCategory(r.description, rules) || "", selected: true }))
    );
    setImportInfo({ duplicates: parsed.expenses.length - fresh.length, incomeCount: parsed.incomeCount });
    setImportModalOpen(true);
  }

  function updateImportRow(externalId, patch) {
    setImportRows((rows) => rows.map((r) => (r.externalId === externalId ? { ...r, ...patch } : r)));
  }

  async function confirmImport() {
    const chosen = importRows.filter((r) => r.selected);
    if (chosen.length === 0) return;
    setImporting(true);
    setImportError("");
    const payload = chosen.map((r) => ({
      category_id: r.categoryId || null,
      description: r.description,
      amount: r.amount,
      date: r.date,
      source: "mercadopago",
      external_id: r.externalId,
      needs_review: !r.categoryId,
    }));
    const { data, error } = await supabase
      .from("transactions")
      .upsert(payload, { onConflict: "user_id,external_id", ignoreDuplicates: true })
      .select();
    setImporting(false);
    if (error) {
      setImportError(
        error.message && error.message.includes("external_id")
          ? "Falta correr el SQL nuevo en Supabase (la columna external_id). Está en las instrucciones."
          : "No se pudo importar: " + error.message
      );
      return;
    }
    setTransactions((prev) => [...(data || []), ...prev]);
    setImportNotice(`Se importaron ${(data || []).length} gastos de Mercado Pago.`);
    setImportModalOpen(false);
    setImportRows([]);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const sortedTx = [...monthTx].sort((a, b) => (a.date < b.date ? 1 : -1));
  const transactionBase = transactionView === "review" ? pendingReviewTx : sortedTx;
  const displayedTx = transactionBase.filter((transaction) => {
    const category = categories.find((item) => item.id === transaction.category_id);
    const search = transactionSearch.trim().toLowerCase();
    if (search && !transaction.description.toLowerCase().includes(search) && !(category?.name || "").toLowerCase().includes(search)) return false;
    if (transactionCategory && transaction.category_id !== transactionCategory) return false;
    if (transactionDateFrom && transaction.date < transactionDateFrom) return false;
    if (transactionDateTo && transaction.date > transactionDateTo) return false;
    const amount = Number(transaction.amount);
    const min = transactionAmountMin === "" ? null : Number(String(transactionAmountMin).replace(",", "."));
    const max = transactionAmountMax === "" ? null : Number(String(transactionAmountMax).replace(",", "."));
    if (min !== null && Number.isFinite(min) && amount < min) return false;
    if (max !== null && Number.isFinite(max) && amount > max) return false;
    return true;
  });
  const hasTransactionFilters = Boolean(
    transactionSearch.trim() || transactionCategory || transactionDateFrom || transactionDateTo ||
    transactionAmountMin || transactionAmountMax
  );

  function clearTransactionFilters() {
    setTransactionSearch("");
    setTransactionCategory("");
    setTransactionDateFrom("");
    setTransactionDateTo("");
    setTransactionAmountMin("");
    setTransactionAmountMax("");
  }

  return (
    <div className="et-app">
      <div className="et-container">
        {loading ? (
          <div className="et-empty">Cargando tu panel…</div>
        ) : (
          <div className="et-fade">
            <div className="et-nav">
              <button className="et-nav-btn" aria-label="Mes anterior" onClick={() => setMonthOffset((m) => m - 1)}>
                <ChevronLeft size={16} />
              </button>
              <span className="et-month">{fmtMonth(viewDate)}</span>
              <button className="et-nav-btn" aria-label="Mes siguiente" onClick={() => setMonthOffset((m) => m + 1)}>
                <ChevronRight size={16} />
              </button>
              <button type="button" className="et-nav-btn et-settings-trigger" aria-label="Configuración" title="Configuración" onClick={openConfig}>
                <Settings size={17} />
              </button>
            </div>

            <div className="et-hero">
              <div className="et-hero-label">Te queda para gastar</div>
              <div className="et-hero-amount et-num">{disponible === null ? "—" : fmt(disponible)}</div>
            </div>

            <div className="et-stats">
              <div className="et-stat">
                <div className="et-stat-top">GASTADO ESTE MES</div>
                <div className="et-stat-amount et-num">{fmt(totalGastado)}</div>
              </div>
              <div className="et-stat">
                <div className="et-stat-top">PRESUPUESTO TOTAL</div>
                <div className="et-stat-amount et-num">{presupuestoTotal === null ? "—" : fmt(presupuestoTotal)}</div>
              </div>
            </div>

            <div className="et-section-title">En qué se fue la plata</div>
            {chartData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart>
                    <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={56} outerRadius={72} paddingAngle={3} stroke="none">
                      {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip
                      formatter={(value) => fmt(value)}
                      contentStyle={{ background: "#FFFFFF", border: "1px solid #E8E6E1", borderRadius: 10, fontSize: 12 }}
                      labelStyle={{ color: "#1C1B18" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="et-legend">
                  {chartData.map((d) => (
                    <div className="et-legend-row" key={d.name}>
                      <span className="et-dot" style={{ background: d.color }} />
                      <span className="et-legend-name">{d.name}</span>
                      <span className="et-legend-value-wrap">
                        <span className="et-legend-val et-num">{Math.round((d.value / totalGastado) * 100)}% · {fmt(d.value)}</span>
                        {d.overBudget && <small className="et-over-amount">Excede {fmt(d.value - d.budget)}</small>}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="et-empty">Todavía no hay gastos en este mes.</div>
            )}

            <div className="et-section-row">
              <button
                type="button"
                className="et-edit-all"
                onClick={() => setCategoriesExpanded((expanded) => !expanded)}
                aria-expanded={categoriesExpanded}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 0 }}
              >
                <span className="et-section-title">Presupuestos por categoría</span>
                <ChevronDown size={16} style={{ transform: categoriesExpanded ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
              </button>
            </div>
            {categoriesExpanded && (
            <div>
              {categorySpend.map((c) => {
                const fillColor = c.status === "ok" ? c.color : STATUS_COLOR[c.status];
                return (
                  <div className="et-budget-row" key={c.id}>
                    <div className="et-budget-top">
                      <span className="et-cat-label">
                        <span className="et-dot" style={{ background: c.color }} />
                        <span className="et-cat-name">{c.name}</span>
                      </span>
                      <span className="et-cat-nums">
                        <span className="et-num">{fmt(c.spent)} / {fmt(c.budget)}</span>
                        {c.status === "over" && <small className="et-over-amount">Excede {fmt(c.spent - c.budget)}</small>}
                      </span>
                    </div>
                    <div className="et-track">
                      <div className="et-fill" style={{ width: Math.min(c.pct, 100) + "%", background: fillColor }} />
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            <div className="et-section-row">
              <button
                type="button"
                className="et-edit-all"
                onClick={() => setTransactionsExpanded((expanded) => !expanded)}
                aria-expanded={transactionsExpanded}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 0 }}
              >
                <span className="et-section-title">Movimientos</span>
                <ChevronDown size={16} style={{ transform: transactionsExpanded ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
              </button>
            </div>
            {transactionsExpanded && <>
            <div style={{ display: "flex", gap: 8, margin: "-4px 0 14px" }}>
              {transactionView === "month" ? (
                <button className="et-edit-all" onClick={() => setTransactionView("review")}>
                  Por revisar{pendingReviewTx.length ? ` (${pendingReviewTx.length})` : ""}
                </button>
              ) : (
                <button className="et-edit-all" onClick={() => setTransactionView("month")}>Este mes</button>
              )}
              <button className="et-edit-all" onClick={() => setFiltersExpanded((expanded) => !expanded)}
                aria-expanded={filtersExpanded}>Buscar{hasTransactionFilters ? " ·" : ""}</button>
            </div>
            {filtersExpanded && <div className="et-search-panel">
            <input className="et-input et-movement-search" type="search" placeholder="Descripción o categoría" value={transactionSearch} onChange={(e) => setTransactionSearch(e.target.value)} />
            <div className="et-filter-grid">
              <select className="et-select" aria-label="Filtrar por categoría" value={transactionCategory} onChange={(e) => setTransactionCategory(e.target.value)}>
                <option value="">Todas las categorías</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
              <input className="et-input" type="date" aria-label="Desde" value={transactionDateFrom} onChange={(e) => setTransactionDateFrom(e.target.value)} />
              <input className="et-input" type="date" aria-label="Hasta" value={transactionDateTo} onChange={(e) => setTransactionDateTo(e.target.value)} />
              <input className="et-input et-num" type="number" min="0" aria-label="Importe mínimo" placeholder="Importe mín." value={transactionAmountMin} onChange={(e) => setTransactionAmountMin(e.target.value)} />
              <input className="et-input et-num" type="number" min="0" aria-label="Importe máximo" placeholder="Importe máx." value={transactionAmountMax} onChange={(e) => setTransactionAmountMax(e.target.value)} />
            </div>
            {hasTransactionFilters && <button className="et-edit-all et-clear-filters" onClick={clearTransactionFilters}>Limpiar filtros</button>}
            </div>}
            {importNotice && (
              <p style={{ fontSize: 12.5, color: "var(--accent)", margin: "-6px 0 10px" }}>{importNotice}</p>
            )}
            {displayedTx.length === 0 ? (
              <div className="et-empty">{transactionView === "review" && !hasTransactionFilters
                ? "No hay movimientos pendientes de revisión."
                : hasTransactionFilters
                  ? "No hay movimientos que coincidan con esos filtros."
                  : <>Todavía no hay gastos cargados en este mes.<br />Tocá "Agregar gasto" para sumar el primero.</>}</div>
            ) : (
              <div>
                {displayedTx.map((t) => {
                  const cat = categories.find((c) => c.id === t.category_id);
                  const color = cat ? cat.color : "#9B9B94";
                  return (
                    <div className="et-tx-row" key={t.id}>
                      <button type="button" className="et-tx-main-button" aria-label={`Editar ${t.description}`} onClick={() => openTxEdit(t)}>
                      <span className="et-dot" style={{ background: color }} />
                      <span className="et-tx-main">
                        <span className="et-tx-desc">{t.description}</span>
                        <span className="et-tx-meta">
                          <span>{cat ? cat.name : "Sin categoría"} · {fmtDate(t.date)}</span>
                          {t.source === "mercadopago" && <span className="et-tx-badge-mp">MP</span>}
                          {t.source === "credit_card" && <span className="et-tx-badge-mp">Tarjeta</span>}
                          {t.source === "automatic_debit" && <span className="et-tx-badge-mp">Débito automático</span>}
                          {t.installment_number && <span className="et-tx-badge-mp">Cuota {t.installment_number}/{t.installment_total}</span>}
                          {t.needs_review && <span className="et-tx-badge-mp">Por revisar</span>}
                          {t.excluded_from_budget && <span className="et-tx-badge-mp">Fuera del presupuesto</span>}
                        </span>
                      </span>
                      <span className="et-tx-amount et-num">-{fmt(t.amount)}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            </>}

          </div>
        )}
      </div>

      <button className="et-fab" onClick={openAddModal}>
        <Plus size={17} /> Agregar gasto
      </button>

      {modalOpen && (
        <div className="et-modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Nuevo gasto</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="et-field">
              <label className="et-label">MONTO</label>
              <input className="et-input" type="number" placeholder="0" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>

            <div className="et-field">
              <label className="et-label">DESCRIPCIÓN</label>
              <input className="et-input" type="text" placeholder="Ej: Ignacio Hanna"
                value={form.description} onChange={(e) => handleDescriptionChange(e.target.value)} />
            </div>

            <div className="et-field">
              <label className="et-label">CATEGORÍA</label>
              {quickAddCategories.length > 0 && (
                <div className="et-quick-categories" aria-label="Categorías usadas recientemente">
                  {quickAddCategories.map((category) => (
                    <button
                      type="button"
                      key={category.id}
                      className={`et-category-chip${form.categoryId === category.id ? " active" : ""}`}
                      aria-pressed={form.categoryId === category.id}
                      onClick={() => setForm((current) => ({ ...current, categoryId: category.id }))}
                    >
                      <span className="et-dot" style={{ background: category.color }} />
                      {category.name}
                      {category.id === lastCategoryId && <small>Última</small>}
                    </button>
                  ))}
                </div>
              )}
              <select className="et-select" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <div className="et-field">
              <label className="et-label">FECHA</label>
              <input className="et-input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>

            <button className="et-save-btn" onClick={addTransaction} disabled={saving}>
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      )}

      {categoriesModalOpen && (
        <div className="et-modal-overlay" onClick={() => setCategoriesModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Categorías</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setCategoriesModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            {categories.map((c) => (
              <div className="et-manage-row" key={c.id}>
                <span className="et-manage-label">
                  <span className="et-dot" style={{ background: c.color }} />
                  <span className="et-cat-name">{c.name}</span>
                </span>
                <input
                  className="et-manage-input et-num"
                  type="number"
                  value={budgetDraft[c.id] ?? ""}
                  onChange={(e) => setBudgetDraft({ ...budgetDraft, [c.id]: e.target.value })}
                />
                <button className="et-delete-btn" aria-label={`Borrar ${c.name}`} onClick={() => deleteCategory(c.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}

            <div className="et-subhead">Nueva categoría</div>
            <div className="et-add-row">
              <input className="et-input" type="text" placeholder="Nombre" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
              <input className="et-input" type="number" placeholder="Presupuesto" style={{ maxWidth: 120 }} value={newCatBudget} onChange={(e) => setNewCatBudget(e.target.value)} />
              <button className="et-add-btn" aria-label="Agregar categoría" onClick={addCategory}>
                <Plus size={16} />
              </button>
            </div>

            <button className="et-save-btn" onClick={saveCategoryBudgets} disabled={savingBudgets}>
              {savingBudgets ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}

      {rulesModalOpen && (
        <div className="et-modal-overlay" onClick={() => setRulesModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Reglas automáticas</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setRulesModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 0, marginBottom: 16 }}>
              Si la descripción de un gasto contiene este texto, se le asigna la categoría sola (incluidos los que
              lleguen automáticos desde Mercado Pago). Siempre la podés cambiar a mano después.
            </p>

            {rules.length === 0 && <div style={{ fontSize: 13, color: "var(--faint)", marginBottom: 10 }}>Todavía no creaste ninguna regla.</div>}

            {rules.map((r) => {
              const cat = categories.find((c) => c.id === r.category_id);
              return (
                <div className="et-rule-row" key={r.id}>
                  <span className="et-rule-text">
                    "{r.keyword}" <span className="et-rule-arrow">→</span> <b>{cat ? cat.name : "—"}</b>
                  </span>
                  <button className="et-delete-btn" aria-label="Borrar regla" onClick={() => deleteRule(r.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}

            <div className="et-subhead">Nueva regla</div>
            <div className="et-field">
              <label className="et-label">SI LA DESCRIPCIÓN CONTIENE</label>
              <input className="et-input" type="text" placeholder="Ej: Ignacio Hanna" value={newRuleKeyword} onChange={(e) => setNewRuleKeyword(e.target.value)} />
            </div>
            <div className="et-add-row">
              <select className="et-select" value={newRuleCategoryId} onChange={(e) => setNewRuleCategoryId(e.target.value)}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="et-add-btn" aria-label="Agregar regla" onClick={addRule}>
                <Plus size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {configModalOpen && (
        <div className="et-modal-overlay" onClick={() => setConfigModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Configuración</span>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button className="et-edit-all" onClick={handleLogout}>Cerrar sesión</button>
                <button className="et-modal-close" aria-label="Cerrar" onClick={() => setConfigModalOpen(false)}>
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="et-subhead">Administrar</div>
            <div className="et-settings-grid">
              <button className="et-menu-btn" onClick={() => { setLimitEditing((editing) => !editing); setLimitError(""); }} aria-expanded={limitEditing}>
                {limitEditing ? "Cancelar" : "Cambiar límite"}
              </button>
              <button className="et-menu-btn" onClick={() => { setConfigModalOpen(false); openCategoriesEdit(); }}>Categorías</button>
              <button className="et-menu-btn" onClick={() => { setConfigModalOpen(false); openRulesModal(); }}>Reglas</button>
            </div>

            {limitEditing && (
              <>
                <div className="et-field">
                  <label className="et-label">LÍMITE MENSUAL</label>
                  <input
                    className="et-input et-num"
                    type="number"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.target.value)}
                  />
                </div>
                <button className="et-save-btn" onClick={saveLimit} disabled={savingLimit}>
                  {savingLimit ? "Guardando…" : "Guardar"}
                </button>
                {limitError && <p role="alert" style={{ fontSize: 12.5, color: "var(--over)", lineHeight: 1.5 }}>{limitError}</p>}
              </>
            )}

            <div className="et-subhead">Tarjeta de crédito</div>
            <button className="et-menu-btn" onClick={openCardPlan}>Agregar cuotas</button>

            <div className="et-subhead">Débito automático</div>
            <button className="et-menu-btn" onClick={openDebitModal}>Administrar débitos</button>

            <div className="et-subhead">Sobrante mes a mes</div>
            <button className="et-menu-btn" onClick={() => { setConfigModalOpen(false); setSavingsModalOpen(true); }}>
              Ver gastos por mes
            </button>

            <div className="et-subhead">Proyección del mes</div>
            <div className="et-projection-card">
              <span className="et-projection-label">A este ritmo, terminarías gastando</span>
              {currentMonthProjection.spent > 0 ? (
                <>
                  <strong className="et-projection-amount et-num">~{fmt(currentMonthProjection.projectedSpent)}</strong>
                  <span className="et-projection-note">
                    Estimación basada en {currentMonthProjection.daysElapsed} de {currentMonthProjection.daysInMonth} días.
                  </span>
                  {currentMonthProjection.limit !== null && (
                    <>
                      <div className="et-projection-track">
                        <div
                          className="et-projection-fill"
                          style={{
                            width: `${Math.min((currentMonthProjection.projectedSpent / currentMonthProjection.limit) * 100, 100)}%`,
                            background: currentMonthProjection.projectedRemainder < 0 ? "var(--over)" : "var(--accent)",
                          }}
                        />
                      </div>
                      <span className="et-projection-balance" style={{ color: currentMonthProjection.projectedRemainder < 0 ? "var(--over)" : "var(--accent)" }}>
                        {currentMonthProjection.projectedRemainder < 0
                          ? `Superarías el límite por ${fmt(Math.abs(currentMonthProjection.projectedRemainder))}`
                          : `Quedarían ${fmt(currentMonthProjection.projectedRemainder)} disponibles`}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span className="et-projection-note">Todavía no hay gastos cargados este mes para estimar.</span>
              )}
            </div>

            <div className="et-subhead">Mercado Pago</div>
            <div className="et-sync-card" role="status" aria-live="polite">
              {mpSyncStatusLoading ? (
                <span className="et-sync-muted">Consultando estado…</span>
              ) : mpSyncStatusError ? (
                <span className="et-sync-muted">No se pudo consultar el estado.</span>
              ) : !mpSyncStatus?.last_checked_at ? (
                <span className="et-sync-muted">Todavía no hay consultas automáticas registradas.</span>
              ) : (
                <>
                  <div className="et-sync-status-line">
                    <span className={`et-sync-dot ${mpSyncStatus.last_status === "success" ? "success" : "error"}`} />
                    <strong>{mpSyncStatus.last_status === "success" ? "Última consulta correcta" : "Falló la última consulta"}</strong>
                  </div>
                  <div className="et-sync-meta">{fmtDateTime(mpSyncStatus.last_checked_at)}</div>
                  {mpSyncStatus.last_status === "success" && (
                    <div className="et-sync-counts">
                      {mpSyncStatus.imported_count > 0
                        ? `${mpSyncStatus.imported_count} agregados`
                        : "Sin movimientos nuevos"}
                      {mpSyncStatus.skipped_count > 0 ? ` · ${mpSyncStatus.skipped_count} duplicados omitidos` : ""}
                    </div>
                  )}
                  {mpSyncStatus.last_message && <p className="et-sync-message">{mpSyncStatus.last_message}</p>}
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {savingsModalOpen && (
        <div className="et-modal-overlay" onClick={() => setSavingsModalOpen(false)}>
          <div className="et-modal et-savings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Sobrante mes a mes</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setSavingsModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="et-savings-chart">
              {monthlyRemainders.map((month) => (
                <div className="et-savings-month" key={month.key}>
                  <div className="et-savings-head">
                    <span>{month.label}</span>
                    <strong className="et-num">{fmt(month.spent)}</strong>
                  </div>
                  <div className="et-savings-track">
                    <div
                      className="et-savings-fill"
                      style={{
                        width: `${Math.min((month.spent / savingsScale) * 100, 100)}%`,
                        background: month.amount !== null && month.amount < 0 ? "var(--over)" : "var(--accent)",
                      }}
                    />
                    {month.limit !== null && (
                      <span className="et-savings-budget-marker" style={{ left: `${Math.min((month.limit / savingsScale) * 100, 100)}%` }} />
                    )}
                  </div>
                  <div className="et-savings-meta">
                    <span>{month.limit === null ? "Sin límite guardado" : `Límite: ${fmt(month.limit)}`}</span>
                    {month.amount !== null && (
                      <strong className="et-num" style={{ color: month.amount < 0 ? "var(--over)" : "var(--accent)" }}>
                        {month.amount < 0 ? `Excedido ${fmt(Math.abs(month.amount))}` : `Sobrante ${fmt(month.amount)}`}
                      </strong>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="et-savings-legend">
              <span><i className="et-savings-legend-fill" /> Gastado</span>
              <span><i className="et-savings-legend-marker" /> Límite mensual</span>
            </div>
          </div>
        </div>
      )}
      {cardPlanModalOpen && (
        <div className="et-modal-overlay" onClick={() => !cardPlanSaving && setCardPlanModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Compra con tarjeta</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setCardPlanModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 0 }}>
              Se creará un movimiento mensual por cada cuota pendiente, empezando en el mes elegido.
            </p>
            <div className="et-field">
              <label className="et-label">DESCRIPCIÓN</label>
              <input className="et-input" type="text" placeholder="Ej: Heladera" value={cardPlanForm.description}
                onChange={(e) => setCardPlanForm({ ...cardPlanForm, description: e.target.value })} />
            </div>
            <div className="et-field">
              <label className="et-label">IMPORTE DE CADA CUOTA</label>
              <input className="et-input et-num" type="number" min="0.01" step="0.01" placeholder="0"
                value={cardPlanForm.amount} onChange={(e) => setCardPlanForm({ ...cardPlanForm, amount: e.target.value })} />
            </div>
            <div className="et-field">
              <label className="et-label">CUOTAS PENDIENTES</label>
              <input className="et-input" type="number" min="1" max="120" step="1" placeholder="Ej: 4"
                value={cardPlanForm.remaining} onChange={(e) => setCardPlanForm({ ...cardPlanForm, remaining: e.target.value })} />
            </div>
            <div className="et-field">
              <label className="et-label">PRIMER MES A CONTABILIZAR</label>
              <select className="et-select" value={cardPlanForm.startMonth}
                onChange={(e) => setCardPlanForm({ ...cardPlanForm, startMonth: e.target.value })}>
                <option value={monthIsoOffset(0)}>Este mes</option>
                <option value={monthIsoOffset(1)}>El próximo mes</option>
              </select>
            </div>
            <div className="et-field">
              <label className="et-label">CATEGORÍA</label>
              <select className="et-select" value={cardPlanForm.categoryId}
                onChange={(e) => setCardPlanForm({ ...cardPlanForm, categoryId: e.target.value })}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {cardPlanError && <p role="alert" style={{ fontSize: 12.5, color: "var(--over)", lineHeight: 1.5 }}>{cardPlanError}</p>}
            <button className="et-save-btn" onClick={addCardPlan} disabled={cardPlanSaving}>
              {cardPlanSaving ? "Guardando…" : "Agregar cuotas"}
            </button>
          </div>
        </div>
      )}

      {debitModalOpen && (
        <div className="et-modal-overlay" onClick={() => !debitSaving && setDebitModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Débito automático mensual</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setDebitModalOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 0 }}>
              Se agregará una vez por mes desde el inicio elegido. Podés pausarlo cuando deje de cobrarse.
            </p>
            <div className="et-field">
              <label className="et-label">DESCRIPCIÓN</label>
              <input className="et-input" type="text" placeholder="Ej: Internet" value={debitForm.description}
                onChange={(e) => setDebitForm({ ...debitForm, description: e.target.value })} />
            </div>
            <div className="et-field">
              <label className="et-label">IMPORTE MENSUAL</label>
              <input className="et-input et-num" type="number" min="0.01" step="0.01" placeholder="0"
                value={debitForm.amount} onChange={(e) => setDebitForm({ ...debitForm, amount: e.target.value })} />
            </div>
            <div className="et-field">
              <label className="et-label">DESDE CUÁNDO</label>
              <select className="et-select" value={debitForm.startMonth}
                onChange={(e) => setDebitForm({ ...debitForm, startMonth: e.target.value })}>
                <option value={monthIsoOffset(0)}>Este mes</option>
                <option value={monthIsoOffset(1)}>El próximo mes</option>
              </select>
            </div>
            <div className="et-field">
              <label className="et-label">CATEGORÍA</label>
              <select className="et-select" value={debitForm.categoryId}
                onChange={(e) => setDebitForm({ ...debitForm, categoryId: e.target.value })}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {debitError && <p role="alert" style={{ fontSize: 12.5, color: "var(--over)", lineHeight: 1.5 }}>{debitError}</p>}
            <button className="et-save-btn" onClick={addAutomaticDebit} disabled={debitSaving}>
              {debitSaving ? "Guardando…" : "Crear débito automático"}
            </button>

            <div className="et-subhead">Débitos configurados</div>
            {recurringExpenses.length === 0 && <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Todavía no agregaste débitos automáticos.</p>}
            {recurringExpenses.map((debit) => (
              <div className="et-rule-row" key={debit.id}>
                <span className="et-rule-text">
                  <b>{debit.description}</b> · {fmt(debit.amount)} / mes · {debit.active ? "Activo" : "Pausado"}
                </span>
                <button className="et-edit-all" onClick={() => toggleAutomaticDebit(debit)}>
                  {debit.active ? "Pausar" : "Reanudar"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        style={{ display: "none" }}
        onChange={handleFile}
      />

      {importModalOpen && (
        <div className="et-modal-overlay" onClick={() => !importing && setImportModalOpen(false)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Importar de Mercado Pago</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setImportModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            {importError && (
              <p style={{ fontSize: 12.5, color: "var(--over)", lineHeight: 1.5, marginTop: 0 }}>{importError}</p>
            )}

            {importRows.length > 0 && (
              <>
                <p className="et-import-note">
                  {importRows.length} gastos nuevos
                  {importInfo.duplicates > 0 ? ` · ${importInfo.duplicates} ya estaban importados` : ""}
                  {importInfo.incomeCount > 0 ? ` · ${importInfo.incomeCount} ingresos ignorados` : ""}.
                  Destildá lo que no quieras sumar (por ejemplo, plata que movés entre tus propias cuentas) y elegí
                  la categoría de los que no se asignaron solos.
                </p>

                {importRows.map((r) => (
                  <div className="et-import-row" key={r.externalId}>
                    <input
                      className="et-import-check"
                      type="checkbox"
                      checked={r.selected}
                      onChange={(e) => updateImportRow(r.externalId, { selected: e.target.checked })}
                    />
                    <div className="et-import-main">
                      <div className="et-import-desc">{r.description}</div>
                      <div className="et-import-meta">
                        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtDate(r.date)}</span>
                        <select
                          className="et-import-select"
                          value={r.categoryId}
                          onChange={(e) => updateImportRow(r.externalId, { categoryId: e.target.value })}
                        >
                          <option value="">Sin categoría</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="et-import-amount et-num">-{fmt(r.amount)}</div>
                  </div>
                ))}

                <button
                  className="et-save-btn"
                  onClick={confirmImport}
                  disabled={importing || importRows.filter((r) => r.selected).length === 0}
                >
                  {importing ? "Importando…" : `Importar ${importRows.filter((r) => r.selected).length} gastos`}
                </button>
              </>
            )}

            {importRows.length === 0 && !importError && (
              <p className="et-import-note">
                No hay gastos nuevos en este archivo
                {importInfo.duplicates > 0 ? ` (${importInfo.duplicates} ya estaban importados)` : ""}.
              </p>
            )}
          </div>
        </div>
      )}

      {txEditing && (
        <div className="et-modal-overlay" onClick={() => setTxEditing(null)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Editar movimiento</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setTxEditing(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="et-field">
              <label className="et-label">DESCRIPCIÓN</label>
              <input className="et-input" type="text" value={txEditDescription} onChange={(e) => setTxEditDescription(e.target.value)} />
            </div>
            <div className="et-field">
              <label className="et-label">IMPORTE</label>
              <input className="et-input et-num" type="number" min="0.01" step="0.01" value={txEditAmount} onChange={(e) => setTxEditAmount(e.target.value)} />
            </div>
            <div className="et-field">
              <label className="et-label">FECHA</label>
              <input className="et-input" type="date" value={txEditDate} onChange={(e) => setTxEditDate(e.target.value)} />
            </div>
            <div className="et-field">
              <label className="et-label">CATEGORÍA</label>
              <select className="et-select" value={txEditCategoryId} onChange={(e) => setTxEditCategoryId(e.target.value)}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 13, color: "var(--muted)", lineHeight: 1.45, margin: "8px 0 14px" }}>
              <input type="checkbox" className="et-import-check" checked={rememberCategoryRule}
                disabled={!txEditCategoryId}
                onChange={(e) => setRememberCategoryRule(e.target.checked)} />
              <span>¿Recordar esta categoría para futuros movimientos parecidos?</span>
            </label>
            {rememberCategoryRule && (
              <div className="et-field">
                <label className="et-label">SI LA DESCRIPCIÓN CONTIENE</label>
                <input className="et-input" type="text" value={ruleKeywordDraft}
                  onChange={(e) => setRuleKeywordDraft(e.target.value)} />
              </div>
            )}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 13, color: "var(--muted)", lineHeight: 1.45, margin: "8px 0 16px" }}>
              <input
                type="checkbox"
                className="et-import-check"
                checked={txEditExcluded}
                onChange={(e) => setTxEditExcluded(e.target.checked)}
              />
              <span>Excluir del presupuesto y de los totales. El movimiento seguirá guardado y visible.</span>
            </label>
            {txEditError && <p role="alert" style={{ fontSize: 12.5, color: "var(--over)", lineHeight: 1.5 }}>{txEditError}</p>}
            <button className="et-save-btn" onClick={saveTxCategory} disabled={savingTxEdit || deletingTxId !== null}>
              {savingTxEdit ? "Guardando…" : "Guardar cambios"}
            </button>
            <button
              type="button"
              className="et-delete-movement"
              onClick={() => deleteTransaction(txEditing)}
              disabled={deletingTxId === txEditing.id || savingTxEdit}
            >
              <Trash2 size={15} /> {deletingTxId === txEditing.id ? "Eliminando…" : "Eliminar movimiento"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
