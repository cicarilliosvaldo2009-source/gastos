"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Plus, X, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
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

const fmtMonth = (date) => {
  const s = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const todayIso = () => new Date().toISOString().slice(0, 10);

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

export default function Dashboard() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [categories, setCategories] = useState([]);
  const [rules, setRules] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monthOffset, setMonthOffset] = useState(0);

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

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setUserEmail(user.email || "");

      let { data: cats } = await supabase.from("categories").select("*").order("created_at");
      if (!cats || cats.length === 0) {
        const { data: inserted } = await supabase.from("categories").insert(DEFAULT_CATEGORIES).select();
        cats = inserted || [];
      }
      setCategories(cats);
      if (cats.length > 0) setForm((f) => ({ ...f, categoryId: cats[0].id }));

      const { data: rls } = await supabase.from("category_rules").select("*").order("created_at");
      setRules(rls || []);

      const { data: txs } = await supabase.from("transactions").select("*").order("date", { ascending: false });
      setTransactions(txs || []);
      setLoading(false);
    })();
  }, [supabase]);

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

  const totalGastado = monthTx.reduce((s, t) => s + Number(t.amount), 0);
  const presupuestoTotal = categories.reduce((s, c) => s + Number(c.budget), 0);
  const disponible = presupuestoTotal - totalGastado;

  const categorySpend = useMemo(() => {
    return categories.map((c) => {
      const spent = monthTx.filter((t) => t.category_id === c.id).reduce((s, t) => s + Number(t.amount), 0);
      const pct = c.budget > 0 ? Math.round((spent / c.budget) * 100) : 0;
      return { ...c, spent, pct, status: statusFor(pct) };
    });
  }, [categories, monthTx]);

  const alerts = useMemo(() => {
    const over = categorySpend.filter((c) => c.status === "over");
    const warn = categorySpend.filter((c) => c.status === "warn");
    return { over, warn };
  }, [categorySpend]);

  const chartData = categorySpend.filter((c) => c.spent > 0).map((c) => ({ name: c.name, value: c.spent, color: c.color }));

  function handleDescriptionChange(desc) {
    const match = matchCategory(desc, rules);
    setForm((f) => ({ ...f, description: desc, categoryId: match || f.categoryId }));
  }

  function openAddModal() {
    setForm((f) => ({ ...f, categoryId: categories.find((c) => c.id === f.categoryId) ? f.categoryId : categories[0]?.id || "" }));
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
      setModalOpen(false);
      setForm({ categoryId: categories[0]?.id || "", amount: "", description: "", date: todayIso() });
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
    setTxEditCategoryId(t.category_id || "");
  }

  async function saveTxCategory() {
    const { data, error } = await supabase
      .from("transactions")
      .update({ category_id: txEditCategoryId || null })
      .eq("id", txEditing.id)
      .select()
      .single();
    if (!error && data) {
      setTransactions((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
    setTxEditing(null);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const sortedTx = [...monthTx].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <div className="et-app">
      <div className="et-container">
        {loading ? (
          <div className="et-empty">Cargando tu panel…</div>
        ) : (
          <div className="et-fade">
            <div className="et-header">
              <span className="et-header-user">{userEmail}</span>
              <button className="et-logout" onClick={handleLogout}>Cerrar sesión</button>
            </div>

            <div className="et-nav">
              <button className="et-nav-btn" aria-label="Mes anterior" onClick={() => setMonthOffset((m) => m - 1)}>
                <ChevronLeft size={16} />
              </button>
              <span className="et-month">{fmtMonth(viewDate)}</span>
              <button className="et-nav-btn" aria-label="Mes siguiente" onClick={() => setMonthOffset((m) => m + 1)}>
                <ChevronRight size={16} />
              </button>
            </div>

            <div className="et-hero">
              <div className="et-hero-label">Gastado este mes</div>
              <div className="et-hero-amount et-num">{fmt(totalGastado)}</div>
              <div className="et-hero-sub">de {fmt(presupuestoTotal)} presupuestados</div>
            </div>

            <div className="et-stats">
              <div className="et-stat">
                <div className="et-stat-top">PRESUPUESTO TOTAL</div>
                <div className="et-stat-amount et-num">{fmt(presupuestoTotal)}</div>
              </div>
              <div className="et-stat">
                <div className="et-stat-top">DISPONIBLE</div>
                <div className="et-stat-amount et-num" style={{ color: disponible >= 0 ? "var(--accent)" : "var(--over)" }}>
                  {fmt(disponible)}
                </div>
              </div>
            </div>

            {(alerts.over.length > 0 || alerts.warn.length > 0) && (
              <div className="et-alerts">
                {alerts.over.map((c) => (
                  <div className="et-alert over" key={c.id}>
                    <span className="et-alert-dot" />
                    <span>Superaste el presupuesto de <strong>{c.name}</strong>: gastaste {fmt(c.spent)} de {fmt(c.budget)}.</span>
                  </div>
                ))}
                {alerts.warn.map((c) => (
                  <div className="et-alert warn" key={c.id}>
                    <span className="et-alert-dot" />
                    <span>Estás cerca del límite en <strong>{c.name}</strong>: usaste el {c.pct}% de {fmt(c.budget)}.</span>
                  </div>
                ))}
              </div>
            )}

            <div className="et-section-row">
              <span className="et-section-title">Presupuestos por categoría</span>
              <span className="et-section-links">
                <button className="et-edit-all" onClick={openCategoriesEdit}>Categorías</button>
                <button className="et-edit-all" onClick={openRulesModal}>Reglas</button>
              </span>
            </div>
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
                      </span>
                    </div>
                    <div className="et-track">
                      <div className="et-fill" style={{ width: Math.min(c.pct, 100) + "%", background: fillColor }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {chartData.length > 0 && (
              <>
                <div className="et-section-title">En qué se fue la plata</div>
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
                      <span className="et-legend-val et-num">{Math.round((d.value / totalGastado) * 100)}% · {fmt(d.value)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="et-section-title">Movimientos</div>
            {sortedTx.length === 0 ? (
              <div className="et-empty">Todavía no hay gastos cargados en este mes.<br />Tocá "Agregar gasto" para sumar el primero.</div>
            ) : (
              <div>
                {sortedTx.map((t) => {
                  const cat = categories.find((c) => c.id === t.category_id);
                  const color = cat ? cat.color : "#9B9B94";
                  return (
                    <div className="et-tx-row" key={t.id} onClick={() => openTxEdit(t)}>
                      <span className="et-dot" style={{ background: color }} />
                      <div className="et-tx-main">
                        <div className="et-tx-desc">{t.description}</div>
                        <div className="et-tx-meta">
                          <span>{fmtDate(t.date)}{cat ? " · " + cat.name : " · Sin categoría"}</span>
                          {t.source === "mercadopago" && <span className="et-tx-badge-mp">MP</span>}
                        </div>
                      </div>
                      <div className="et-tx-amount et-num">-{fmt(t.amount)}</div>
                    </div>
                  );
                })}
              </div>
            )}
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

      {txEditing && (
        <div className="et-modal-overlay" onClick={() => setTxEditing(null)}>
          <div className="et-modal" onClick={(e) => e.stopPropagation()}>
            <div className="et-modal-head">
              <span className="et-modal-title">Cambiar categoría</span>
              <button className="et-modal-close" aria-label="Cerrar" onClick={() => setTxEditing(null)}>
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 0 }}>{txEditing.description}</p>
            <div className="et-field">
              <label className="et-label">CATEGORÍA</label>
              <select className="et-select" value={txEditCategoryId} onChange={(e) => setTxEditCategoryId(e.target.value)}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <button className="et-save-btn" onClick={saveTxCategory}>Guardar</button>
          </div>
        </div>
      )}
    </div>
  );
}
