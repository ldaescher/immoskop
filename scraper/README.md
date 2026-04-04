-- Neue Spalten zu plz_prices hinzufügen (falls Tabelle schon existiert)
ALTER TABLE plz_prices
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS kauf_whg_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_whg_p10 numeric,
  ADD COLUMN IF NOT EXISTS kauf_whg_p90 numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_p10 numeric,
  ADD COLUMN IF NOT EXISTS kauf_haus_p90 numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_median numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_p10 numeric,
  ADD COLUMN IF NOT EXISTS miete_whg_p90 numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_median numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_p10 numeric,
  ADD COLUMN IF NOT EXISTS miete_haus_p90 numeric,
  ADD COLUMN IF NOT EXISTS has_override boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_note text;

-- Neue Spalten zu street_prices hinzufügen
ALTER TABLE street_prices
  ADD COLUMN IF NOT EXISTS gemeinde_slug text,
  ADD COLUMN IF NOT EXISTS strasse_slug text,
  ADD COLUMN IF NOT EXISTS kauf_median numeric,
  ADD COLUMN IF NOT EXISTS kauf_p10 numeric,
  ADD COLUMN IF NOT EXISTS kauf_p90 numeric,
  ADD COLUMN IF NOT EXISTS has_override boolean DEFAULT false;
