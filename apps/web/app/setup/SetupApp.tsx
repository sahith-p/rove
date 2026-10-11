"use client";
// /setup client: loads GET /api/me, edits shop + menu, saves with PUT /api/me/shop + PUT /api/me/menu.
// Owner: Sahith · Task: SH-B2. Demo fixtures kick in only when NEXT_PUBLIC_DEMO_FIXTURES=1 and the API fails / is 501.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MeRes, UpdateMenuReq, UpdateShopReq, currencyInfo, isCurrency, type Currency } from "@rove/shared";
import { Check, ChevronDown, ChevronUp, Clock, Pencil, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { IconBadge } from "../../components/Bits";
import { CardFrame, CardLink, CardTitle } from "../../components/CardFrame";
import { Button } from "../../components/Button";
import { CurrencyFlag } from "../../components/icons";
import { Notice } from "../../components/Notice";
import { sessionHeaders } from "../../lib/ui/headers";
import {
  CATEGORIES,
  CATEGORY_MAX,
  MAX_ITEMS,
  NAME_MAX,
  categoryFromStored,
  categoryToStored,
  itemNameError,
  parsePrice,
  parseQuickAdd,
  shopNameError,
  type CategoryChoice,
  type SetupData,
} from "./model";
import styles from "./setup.module.css";

const FIXTURES = process.env.NEXT_PUBLIC_DEMO_FIXTURES === "1";
const EXPIRED_TEXT = "This link expired. Text Rove “edit my shop” for a new one.";
const UNDO_MS = 5000;

interface Row {
  key: string;
  id?: string;
  name: string;
  price: string;
  active: boolean;
}

interface FormState {
  name: string;
  category: CategoryChoice | null;
  custom: string;
  rows: Row[];
}

type Phase = { kind: "loading" } | { kind: "ready"; demo: boolean } | { kind: "error"; message: string } | { kind: "expired" };

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let keySeq = 0;
const newKey = () => `row${++keySeq}`;

function toForm(data: SetupData): FormState {
  const { choice, custom } = categoryFromStored(data.category);
  return {
    name: data.name,
    category: choice,
    custom,
    rows: data.menu.map((m) => ({ key: newKey(), id: m.id, name: m.name, price: m.price, active: m.active })),
  };
}

/** Normalised form → string, so "5.5" vs "5.50" or trailing spaces don't count as changes. */
function snapshot(f: FormState): string {
  return JSON.stringify({
    name: f.name.trim(),
    category: categoryToStored(f.category, f.custom) ?? null,
    items: f.rows.map((r) => {
      const p = parsePrice(r.price);
      return [r.id ?? null, r.name.trim(), p.ok ? p.amount : r.price.trim(), r.active];
    }),
  });
}

async function api(path: string, t: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...sessionHeaders(t), ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") msg = body.error;
    } catch {
      /* no JSON body */
    }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const isAuthError = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);

export function SetupApp({ t, fixture, cardHref = null }: { t: string; fixture: SetupData | null; cardHref?: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [currency, setCurrency] = useState<Currency>("SGD");
  const [form, setForm] = useState<FormState>({ name: "", category: null, custom: "", rows: [] });
  const [baseline, setBaseline] = useState("");
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [quickError, setQuickError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ row: Row; index: number } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const loadSeq = useRef(0);

  // ---------------------------------------------------------------- load
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase({ kind: "loading" });
    const apply = (data: SetupData, demo: boolean) => {
      if (seq !== loadSeq.current) return;
      const f = toForm(data);
      setForm(f);
      setCurrency(isCurrency(data.currency) ? data.currency : "SGD");
      setBaseline(snapshot(f));
      setTouched(new Set());
      setSubmitted(false);
      setPhase({ kind: "ready", demo });
    };
    if (!t && FIXTURES && fixture) return apply(fixture, true);
    try {
      const me = MeRes.parse(await api("/api/me", t));
      apply(
        {
          name: me.merchant.name,
          currency: me.merchant.currency,
          category: me.merchant.category,
          menu: me.menu.map((m) => ({ id: m.id, name: m.name, price: m.price.amount, active: m.active })),
        },
        false,
      );
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (FIXTURES && fixture) return apply(fixture, true);
      if (isAuthError(err)) return setPhase({ kind: "expired" });
      setPhase({ kind: "error", message: "Couldn’t load your shop. Check your connection and try again." });
    }
  }, [t, fixture]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------------------------------------------------------------- derived
  const dirty = phase.kind === "ready" && snapshot(form) !== baseline;
  const nameErr = shopNameError(form.name);
  const rowErrors = useMemo(
    () =>
      new Map(
        form.rows.map((r) => {
          const p = parsePrice(r.price);
          return [r.key, { name: itemNameError(r.name), price: p.ok ? null : p.error }] as const;
        }),
      ),
    [form.rows],
  );
  const hasErrors = !!nameErr || [...rowErrors.values()].some((e) => e.name || e.price);
  const show = (field: string) => submitted || touched.has(field);
  const atMax = form.rows.length >= MAX_ITEMS;
  const activeCount = form.rows.filter((r) => r.active).length;

  // Edits clear the "Saved ✓" notice and any stale save error.
  const edit = useCallback((fn: (f: FormState) => FormState) => {
    setForm(fn);
    setSaved(false);
    setSaveError(null);
  }, []);
  const touch = (field: string) => setTouched((s) => (s.has(field) ? s : new Set(s).add(field)));
  const updateRow = (key: string, patch: Partial<Row>) =>
    edit((f) => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  // Focus a freshly added row's name field.
  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(`name-${focusKey}`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  // Undo toast auto-dismiss.
  useEffect(() => {
    if (!removed) return;
    const id = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [removed]);

  // ---------------------------------------------------------------- menu actions
  const addRow = () => {
    if (atMax) return;
    const key = newKey();
    edit((f) => ({ ...f, rows: [...f.rows, { key, name: "", price: "", active: true }] }));
    setFocusKey(key);
  };

  const removeRow = (key: string) => {
    const index = form.rows.findIndex((r) => r.key === key);
    const row = form.rows[index];
    if (!row) return;
    edit((f) => ({ ...f, rows: f.rows.filter((r) => r.key !== key) }));
    setRemoved({ row, index });
  };

  const undoRemove = () => {
    if (!removed) return;
    const { row, index } = removed;
    edit((f) => {
      if (f.rows.length >= MAX_ITEMS) return f;
      const rows = [...f.rows];
      rows.splice(Math.min(index, rows.length), 0, row);
      return { ...f, rows };
    });
    setRemoved(null);
  };

  const moveRow = (key: string, dir: -1 | 1) =>
    edit((f) => {
      const i = f.rows.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= f.rows.length) return f;
      const rows = [...f.rows];
      [rows[i], rows[j]] = [rows[j]!, rows[i]!];
      return { ...f, rows };
    });

  const quickAdd = () => {
    const { items, bad } = parseQuickAdd(quick);
    if (!items.length && !bad.length) return;
    const room = MAX_ITEMS - form.rows.length;
    const accepted = items.slice(0, Math.max(0, room));
    if (accepted.length) {
      edit((f) => ({
        ...f,
        rows: [...f.rows, ...accepted.map((i) => ({ key: newKey(), name: i.name, price: i.price, active: true }))],
      }));
    }
    const overflow = items.length - accepted.length;
    if (bad.length) {
      setQuick(bad.join(", "));
      setQuickError(
        `Couldn’t read ${bad.map((b) => `“${b}”`).join(", ")}. Try a name then a price, like “kopi 1.80”.`,
      );
    } else if (overflow > 0) {
      setQuick("");
      setQuickError(`Menus hold up to ${MAX_ITEMS} items, so ${overflow} weren’t added.`);
    } else {
      setQuick("");
      setQuickError(null);
    }
  };

  const onQuickKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      quickAdd();
    }
  };

  // ---------------------------------------------------------------- save
  const save = async () => {
    if (!dirty || saving || phase.kind !== "ready") return;
    setSubmitted(true);
    setSaveError(null);
    if (hasErrors) {
      setSaveError("Fix the highlighted fields, then save.");
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>('[aria-invalid="true"]:not(#quick)');
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 0);
      return;
    }

    // Normalise prices ("5.5" → "5.50") and build the contract bodies.
    const rows = form.rows.map((r) => {
      const p = parsePrice(r.price);
      return { ...r, name: r.name.trim(), price: p.ok ? p.amount : r.price };
    });
    const shopBody = UpdateShopReq.safeParse({
      name: form.name.trim(),
      category: categoryToStored(form.category, form.custom),
    });
    const menuBody = UpdateMenuReq.safeParse({
      items: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, price: r.price, active: r.active })),
    });
    if (!shopBody.success || !menuBody.success) {
      setSaveError("Something in the form isn’t valid. Check the fields and try again.");
      return;
    }

    setSaving(true);
    try {
      try {
        await api("/api/me/shop", t, { method: "PUT", body: JSON.stringify(shopBody.data) });
        await api("/api/me/menu", t, { method: "PUT", body: JSON.stringify(menuBody.data) });
      } catch (err) {
        if (!FIXTURES) throw err;
        await new Promise((r) => setTimeout(r, 450)); // demo: the save "succeeds" locally
      }
      const next = { ...form, name: form.name.trim(), rows };
      setForm(next);
      setBaseline(snapshot(next));
      setTouched(new Set());
      setSubmitted(false);
      setRemoved(null);
      setSaved(true);
    } catch (err) {
      if (isAuthError(err)) setSaveError(EXPIRED_TEXT);
      else if (err instanceof ApiError) setSaveError(`Couldn’t save (${err.message}). Try again.`);
      else setSaveError("Couldn’t save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------- render
  // Card mode (`?card=1`): shop name + item count + "Edit shop" → the full editor in Safari.
  if (cardHref) {
    return (
      <CardFrame
        demo={phase.kind === "ready" && phase.demo}
        label="Shop setup"
        action={
          phase.kind === "expired" ? undefined : (
            <CardLink href={cardHref} icon={<Pencil size={17} strokeWidth={1.5} />}>
              Edit shop
            </CardLink>
          )
        }
      >
        {phase.kind === "loading" ? (
          <CardTitle>Your shop</CardTitle>
        ) : phase.kind === "expired" ? (
          <CardTitle sub="Text Rove “edit my shop” for a new one.">This link expired.</CardTitle>
        ) : phase.kind === "error" ? (
          <CardTitle>Your shop</CardTitle>
        ) : (
          <CardTitle>{form.name.trim() || "Name your shop"}</CardTitle>
        )}
      </CardFrame>
    );
  }

  if (phase.kind === "loading") return <Skeleton />;

  if (phase.kind === "expired") {
    return <Expired />;
  }

  if (phase.kind === "error") {
    return (
      <main className={styles.page}>
        <Header />
        <Notice variant="error" title="Something went wrong">
          {phase.message}
        </Notice>
        <Button variant="secondary" fullWidth onClick={() => void load()}>
          Try again
        </Button>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <Header />

      {phase.demo ? (
        <Notice variant="simulated">Demo data. Saves stay on this device.</Notice>
      ) : null}

      {/* -------- Shop -------- */}
      <section className={styles.section} aria-labelledby="shop-h">
        <h2 id="shop-h" className="sr-only">
          Shop
        </h2>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <label htmlFor="shop-name" className={styles.label}>
              Shop name
            </label>
            <span className={styles.counter} aria-hidden="true">
              {form.name.trim().length}/{NAME_MAX}
            </span>
          </div>
          <input
            id="shop-name"
            className={styles.input}
            value={form.name}
            maxLength={NAME_MAX + 10}
            autoComplete="organization"
            enterKeyHint="done"
            placeholder="Ah Seng Chicken Rice"
            aria-invalid={show("name") && !!nameErr}
            aria-describedby={show("name") && nameErr ? "shop-name-err" : undefined}
            onChange={(e) => edit((f) => ({ ...f, name: e.target.value }))}
            onBlur={() => touch("name")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          {show("name") && nameErr ? (
            <p id="shop-name-err" className={styles.error}>
              {nameErr}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <span className={styles.label} id="cat-label">
            What do you sell?
          </span>
          <div className={styles.chips} role="radiogroup" aria-labelledby="cat-label">
            {CATEGORIES.map((c) => {
              const on = form.category === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                  onClick={() => edit((f) => ({ ...f, category: on ? null : c.value }))}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {form.category === "other" ? (
            <input
              aria-label="Describe what you sell"
              className={styles.input}
              value={form.custom}
              maxLength={CATEGORY_MAX}
              placeholder="e.g. Bakery, Florist, Kopi stall"
              enterKeyHint="done"
              onChange={(e) => edit((f) => ({ ...f, custom: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          ) : null}
        </div>

        <div className={styles.currency}>
          <span className={styles.label}>Currency</span>
          <span className={styles.currencyValue}>
            <CurrencyFlag currency={currency} size={16} />
            <span className={styles.currencyCode}>{currency}</span>
            <span className={styles.currencyFixed}>Fixed</span>
          </span>
        </div>
      </section>

      {/* -------- Menu -------- */}
      <section className={styles.section} aria-labelledby="menu-h">
        <div className={styles.sectionHead}>
          <h2 id="menu-h" className={styles.sectionTitle}>
            Menu
          </h2>
          <span className={styles.count}>
            {form.rows.length === 0
              ? "No items yet"
              : `${form.rows.length} item${form.rows.length === 1 ? "" : "s"}${
                  activeCount < form.rows.length ? ` · ${activeCount} showing` : ""
                }`}
          </span>
        </div>

        <div className={styles.field}>
          <label htmlFor="quick" className={styles.label}>
            Quick add
          </label>
          <div className={styles.quickRow}>
            <input
              id="quick"
              className={styles.input}
              value={quick}
              placeholder="chicken rice 5.50, barley 1.50"
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="go"
              disabled={atMax}
              aria-invalid={!!quickError}
              aria-describedby="quick-hint"
              onChange={(e) => {
                setQuick(e.target.value);
                setQuickError(null);
              }}
              onKeyDown={onQuickKey}
            />
            <button type="button" className={styles.quickBtn} onClick={quickAdd} disabled={!quick.trim() || atMax}>
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              Add
            </button>
          </div>
          {quickError ? (
            <p id="quick-hint" className={styles.error}>
              {quickError}
            </p>
          ) : (
            <p id="quick-hint" className={styles.hint}>
              Type items and prices separated by commas.
            </p>
          )}
        </div>

        {form.rows.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <UtensilsCrossed size={20} strokeWidth={1.5} />
            </span>
            <p className={styles.emptyTitle}>Add your first item</p>
            <p className="muted">Customers pick from your menu when they scan your QR.</p>
            <Button variant="secondary" onClick={addRow} icon={<Plus size={18} strokeWidth={1.75} />}>
              Add item
            </Button>
          </div>
        ) : (
          <ol className={styles.list}>
            {form.rows.map((r, i) => {
              const err = rowErrors.get(r.key);
              const nameBad = show(`${r.key}:name`) && !!err?.name;
              const priceBad = show(`${r.key}:price`) && !!err?.price;
              const label = r.name.trim() || `item ${i + 1}`;
              return (
                <li key={r.key} className={`${styles.row} ${r.active ? "" : styles.rowOff}`}>
                  <div className={styles.rowFields}>
                    <input
                      id={`name-${r.key}`}
                      className={`${styles.input} ${styles.itemName}`}
                      value={r.name}
                      placeholder="Item name"
                      aria-label={`Item ${i + 1} name`}
                      maxLength={80}
                      enterKeyHint="next"
                      aria-invalid={nameBad}
                      onChange={(e) => updateRow(r.key, { name: e.target.value })}
                      onBlur={() => touch(`${r.key}:name`)}
                    />
                    <div className={`${styles.priceWrap} ${priceBad ? styles.priceWrapBad : ""}`}>
                      <span className={styles.pricePrefix} aria-hidden="true">
                        {currencyInfo(currency).symbol}
                      </span>
                      <input
                        className={styles.priceInput}
                        value={r.price}
                        placeholder="0.00"
                        inputMode="decimal"
                        autoComplete="off"
                        enterKeyHint="done"
                        aria-label={`${label} price in Singapore dollars`}
                        aria-invalid={priceBad}
                        onChange={(e) => updateRow(r.key, { price: e.target.value.replace(/[^\d.]/g, "") })}
                        onBlur={() => {
                          touch(`${r.key}:price`);
                          const p = parsePrice(r.price);
                          if (p.ok && p.amount !== r.price) updateRow(r.key, { price: p.amount });
                        }}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                    </div>
                  </div>
                  {nameBad || priceBad ? (
                    <p className={styles.error}>{[nameBad && err?.name, priceBad && err?.price].filter(Boolean).join(" · ")}</p>
                  ) : null}
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.active}
                      aria-label={`Show ${label} on menu`}
                      className={styles.switchBtn}
                      onClick={() => updateRow(r.key, { active: !r.active })}
                    >
                      <span className={`${styles.switch} ${r.active ? styles.switchOn : ""}`} aria-hidden="true">
                        <span className={styles.knob} />
                      </span>
                      <span className={styles.switchLabel}>{r.active ? "On menu" : "Hidden"}</span>
                    </button>
                    <div className={styles.iconGroup}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={`Move ${label} up`}
                        disabled={i === 0}
                        onClick={() => moveRow(r.key, -1)}
                      >
                        <Chevron dir="up" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        aria-label={`Move ${label} down`}
                        disabled={i === form.rows.length - 1}
                        onClick={() => moveRow(r.key, 1)}
                      >
                        <Chevron dir="down" />
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.removeBtn}`}
                        aria-label={`Remove ${label}`}
                        onClick={() => removeRow(r.key)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {form.rows.length > 0 ? (
          <button type="button" className={styles.addRow} onClick={addRow} disabled={atMax}>
            {atMax ? null : <Plus size={16} strokeWidth={1.75} aria-hidden="true" />}
            {atMax ? `Menu is full (${MAX_ITEMS} items)` : "Add item"}
          </button>
        ) : null}
      </section>

      {/* -------- Sticky save bar -------- */}
      <div className={styles.bar}>
        {removed ? (
          <div className={styles.toast} role="status">
            <span className={styles.toastText}>Removed &ldquo;{removed.row.name.trim() || "item"}&rdquo;</span>
            <button type="button" className={styles.toastBtn} onClick={undoRemove}>
              Undo
            </button>
          </div>
        ) : null}
        {saveError ? (
          <Notice variant="error" className={styles.barNotice}>
            {saveError}
          </Notice>
        ) : saved && !dirty ? (
          <Notice variant="success" className={styles.barNotice}>
            Saved ✓ — Rove will update your card
          </Notice>
        ) : null}
        <Button
          fullWidth
          disabled={!dirty}
          loading={saving}
          onClick={() => void save()}
          icon={saved && !dirty ? <Check size={18} strokeWidth={2} /> : undefined}
        >
          {saving ? "Saving…" : saved && !dirty ? "Saved" : "Save"}
        </Button>
      </div>
    </main>
  );
}

/** Also rendered by the server page when the `t` token is missing, tampered with or expired. */
export function Expired() {
  return (
    <main className={styles.expired}>
      <IconBadge>
        <Clock size={22} strokeWidth={1.5} />
      </IconBadge>
      <h1 className={styles.expiredTitle}>This link expired.</h1>
      <p className="muted">Text Rove &ldquo;edit my shop&rdquo; for a new one.</p>
    </main>
  );
}

function Header() {
  return (
    <header className={styles.header}>
      <span className="eyebrow">Shop setup</span>
      <h1 className="twoTone">
        <span>Your shop</span>
        <span>Name, category and menu.</span>
      </h1>
    </header>
  );
}

function Skeleton() {
  return (
    <main className={styles.page} aria-busy="true" aria-label="Loading your shop">
      <Header />
      <div className={styles.skel} style={{ height: 52 }} />
      <div className={styles.skel} style={{ height: 40, width: "80%" }} />
      <div className={styles.skel} style={{ height: 112 }} />
      <div className={styles.skel} style={{ height: 112 }} />
    </main>
  );
}

function Chevron({ dir }: { dir: "up" | "down" }) {
  return dir === "up" ? <ChevronUp size={18} strokeWidth={1.5} aria-hidden="true" /> : <ChevronDown size={18} strokeWidth={1.5} aria-hidden="true" />;
}

function TrashIcon() {
  return <Trash2 size={17} strokeWidth={1.5} aria-hidden="true" />;
}
