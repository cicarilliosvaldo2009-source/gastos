-- Reduce API privileges and enforce tenant ownership across related records.
REVOKE ALL ON SCHEMA gastos FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA gastos TO authenticated, service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA gastos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gastos FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE gastos.categories, gastos.transactions TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE gastos.category_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE gastos.settings, gastos.recurring_expenses, gastos.monthly_budgets TO authenticated;
GRANT SELECT ON TABLE gastos.mercadopago_sync_status TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA gastos TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA gastos TO service_role;

-- New tables/sequences created by migrations do not inherit broad API permissions.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA gastos
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA gastos
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA gastos
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA gastos
  GRANT ALL ON SEQUENCES TO service_role;

-- Credentials and sync bookkeeping are accessible only to Edge Functions.
REVOKE ALL ON TABLE gastos.mercadopago_credentials, gastos.sync_state
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE gastos.mercadopago_credentials, gastos.sync_state TO service_role;

-- Make all user-owned CRUD policies explicitly authenticated and prevent owner changes.
DROP POLICY IF EXISTS "select propias categorias" ON gastos.categories;
CREATE POLICY "select propias categorias" ON gastos.categories
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "insert propias categorias" ON gastos.categories;
CREATE POLICY "insert propias categorias" ON gastos.categories
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "update propias categorias" ON gastos.categories;
CREATE POLICY "update propias categorias" ON gastos.categories
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "delete propias categorias" ON gastos.categories;
CREATE POLICY "delete propias categorias" ON gastos.categories
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "select propios gastos" ON gastos.transactions;
CREATE POLICY "select propios gastos" ON gastos.transactions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "insert propios gastos" ON gastos.transactions;
CREATE POLICY "insert propios gastos" ON gastos.transactions
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "update propios gastos" ON gastos.transactions;
CREATE POLICY "update propios gastos" ON gastos.transactions
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "delete propios gastos" ON gastos.transactions;
CREATE POLICY "delete propios gastos" ON gastos.transactions
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "select propias reglas" ON gastos.category_rules;
CREATE POLICY "select propias reglas" ON gastos.category_rules
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "insert propias reglas" ON gastos.category_rules;
CREATE POLICY "insert propias reglas" ON gastos.category_rules
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "delete propias reglas" ON gastos.category_rules;
CREATE POLICY "delete propias reglas" ON gastos.category_rules
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "select propia configuracion" ON gastos.settings;
CREATE POLICY "select propia configuracion" ON gastos.settings
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "insert propia configuracion" ON gastos.settings;
CREATE POLICY "insert propia configuracion" ON gastos.settings
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "update propia configuracion" ON gastos.settings;
CREATE POLICY "update propia configuracion" ON gastos.settings
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "select propios debitos automaticos" ON gastos.recurring_expenses;
CREATE POLICY "select propios debitos automaticos" ON gastos.recurring_expenses
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "insert propios debitos automaticos" ON gastos.recurring_expenses;
CREATE POLICY "insert propios debitos automaticos" ON gastos.recurring_expenses
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "update propios debitos automaticos" ON gastos.recurring_expenses;
CREATE POLICY "update propios debitos automaticos" ON gastos.recurring_expenses
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Database constraints also prevent linking records across different users.
ALTER TABLE gastos.categories
  ADD CONSTRAINT categories_user_id_id_key UNIQUE (user_id, id);
ALTER TABLE gastos.recurring_expenses
  ADD CONSTRAINT recurring_expenses_user_id_id_key UNIQUE (user_id, id);

ALTER TABLE gastos.transactions
  DROP CONSTRAINT IF EXISTS transactions_category_id_fkey;
ALTER TABLE gastos.transactions
  DROP CONSTRAINT IF EXISTS transactions_recurring_expense_id_fkey;
ALTER TABLE gastos.category_rules
  DROP CONSTRAINT IF EXISTS category_rules_category_id_fkey;
ALTER TABLE gastos.recurring_expenses
  DROP CONSTRAINT IF EXISTS recurring_expenses_category_id_fkey;

ALTER TABLE gastos.transactions
  ADD CONSTRAINT transactions_user_category_fkey
  FOREIGN KEY (user_id, category_id)
  REFERENCES gastos.categories (user_id, id)
  ON DELETE SET NULL (category_id);
ALTER TABLE gastos.transactions
  ADD CONSTRAINT transactions_user_recurring_expense_fkey
  FOREIGN KEY (user_id, recurring_expense_id)
  REFERENCES gastos.recurring_expenses (user_id, id)
  ON DELETE SET NULL (recurring_expense_id);
ALTER TABLE gastos.category_rules
  ADD CONSTRAINT category_rules_user_category_fkey
  FOREIGN KEY (user_id, category_id)
  REFERENCES gastos.categories (user_id, id)
  ON DELETE CASCADE;
ALTER TABLE gastos.recurring_expenses
  ADD CONSTRAINT recurring_expenses_user_category_fkey
  FOREIGN KEY (user_id, category_id)
  REFERENCES gastos.categories (user_id, id)
  ON DELETE SET NULL (category_id);
