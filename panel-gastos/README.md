# Panel de Gastos

App web para controlar gastos con cuentas independientes para cada usuario.
Next.js (App Router) + Supabase (base de datos + login) + Vercel (hosting).

No incluye seguimiento de ingresos/sueldo a propósito: la app solo registra
y organiza gastos.

## 1. Crear el proyecto en Supabase

¿Ya tenés un proyecto de Supabase gratis usado en otra cosa (como tu cursada) y llegaste al límite de 2 proyectos gratis por cuenta? No hace falta crear uno nuevo ni pagar: **usá ese mismo proyecto**. Este `schema.sql` ya está pensado para eso — crea todo dentro de un esquema propio llamado `gastos`, separado de tus otras tablas, así que no choca con nada de la otra app. El único paso extra es el 1.6 de abajo.

1. Entrá a https://supabase.com y abrí el proyecto que vayas a usar (nuevo o uno que ya tengas).
2. Andá a **SQL Editor** y pegá el contenido de `supabase/schema.sql`. Ejecutalo.
   Esto crea el esquema `gastos` y activa políticas RLS para que cada cuenta
   solo pueda ver y modificar sus propios movimientos y configuración.
3. Para permitir que otras personas creen cuentas desde la app, andá a
   **Authentication > Providers > Email** y habilitá **Allow new users to sign up**.
   Mantené la confirmación por correo activada.
4. En **Authentication > URL Configuration**, configurá la URL pública de la app
   como **Site URL** y agregá a **Redirect URLs** `https://TU-DOMINIO/auth/callback`
   (y `http://localhost:3000/auth/callback` para desarrollo).
5. Andá a **Settings > API** y copiá:
   - **Project URL**
   - La clave **anon / public** (puede aparecer como "anon key" o
     "publishable key" según cuándo creaste el proyecto — cualquiera de
     las dos sirve acá).
6. **Solo si estás reutilizando un proyecto existente**: andá a
   **Settings > API > Data API Settings** y en "Exposed schemas" agregá
   `gastos` a la lista (va a estar `public` por defecto — dejalo y agregá
   el nuevo al lado). Sin este paso, Supabase no deja que la app lea ni
   escriba en las tablas de `gastos` aunque el SQL se haya ejecutado bien.

## 2. Configurar el proyecto localmente

```bash
npm install
cp .env.local.example .env.local
```

Editá `.env.local` y pegá los dos valores que copiaste de Supabase:

```
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=tu-clave
```

Probalo local:

```bash
npm run dev
```

Abrí http://localhost:3000 y elegí **Crear cuenta**. Después de confirmar el
correo, vas a ver el panel con las 6 categorías iniciales ya cargadas.

## 3. Subir a GitHub

```bash
git init
git add .
git commit -m "Panel de gastos"
```

Creá un repositorio nuevo en GitHub y subilo (podés hacerlo desde la web de
GitHub con "Add file > Upload files" si preferís no usar la terminal para esto).

## 4. Deployar en Vercel

1. Entrá a https://vercel.com, conectá tu cuenta de GitHub.
2. "Add New… > Project" y elegí el repo que acabás de subir.
3. En **Environment Variables**, agregá las mismas dos variables que pusiste
   en `.env.local` (`NEXT_PUBLIC_SUPABASE_URL` y
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`).
4. Deploy. En un par de minutos tenés la URL pública de tu app.

Cada persona crea su cuenta desde la pantalla de inicio de sesión. Las tablas
de gastos filtran por el usuario autenticado, así que cada cuenta mantiene sus
movimientos, categorías y límites separados.

## Sobre el botón "+"

El botón "+" sirve para los gastos que cargás manualmente. Cada cuenta puede
conectar su propio Mercado Pago para sincronizarlo a diario. Vas a seguir usando
el botón para lo que Mercado Pago no vea (efectivo, gastos compartidos, etc.)
— por eso cada gasto tiene una etiqueta `manual` o `MP` junto a la fecha,
para que después puedas distinguir lo que cargaste vos de lo que entró solo.

## Fase 2: carga automática desde Mercado Pago

### 1. Crear tu aplicación en Mercado Pago y obtener el Access Token

1. Entrá a https://www.mercadopago.com.ar/developers/panel con tu cuenta
   habitual de Mercado Pago (la misma con la que cobrás los viajes de Uber).
2. "Tus integraciones" > "Crear aplicación". Elegí cualquier nombre
   (ej. "Panel de gastos"), y como tipo de integración "Pagos online".
3. Entrá a la aplicación creada > "Credenciales de producción" y copiá el
   **Access Token**. Lo vas a pegar en Configuración > Mercado Pago.

### 2. Activar el reporte diario

No hace falta configurarlo con comandos. Al guardar el Access Token en
**Configuración > Mercado Pago**, la app valida el token y activa el reporte
diario si todavía no existe. Mercado Pago puede tardar un tiempo en generar el
primer archivo; la app lo buscará automáticamente en la siguiente ejecución.

La sincronización usa `SETTLEMENT_NET_AMOUNT` (impacto neto en la cuenta) y
solo carga las filas con monto negativo. Para reconocer movimientos repetidos
usa `SOURCE_ID`, el tipo, la fecha y el monto.

### 3. Instalar el Supabase CLI y conectarlo a tu proyecto

```bash
npm install -g supabase
supabase login
supabase link --project-ref TU_PROJECT_REF
```

(`TU_PROJECT_REF` está en la URL de tu proyecto en supabase.com, algo como
`abcdefghijklmnop`).

### 4. Aplicar las migraciones a una base existente

En el **SQL Editor** de Supabase ejecutá una vez el contenido de cada archivo
que todavía no hayas aplicado:
`supabase/add_external_id.sql`, `supabase/add_settings.sql`,
`supabase/add_excluded_from_budget.sql`,
`supabase/add_review_and_card_installments.sql`,
`supabase/add_mercadopago_sync_status.sql` y la nueva migración
`supabase/migrations/20261014160000_user_mp_credentials.sql`. Esta última
crea el almacén privado de Access Tokens y los permisos del estado de sincronización.

### 5. Conectar Mercado Pago desde la app

Cada usuario abre **Configuración > Mercado Pago** y pega el Access Token de su
propia cuenta. La app guarda el token del lado del servidor, configura el
reporte diario si todavía no existe y sincroniza los movimientos de esa cuenta.
No se necesita Client ID ni Client Secret para esta conexión con Access Token.

La función mantiene compatibilidad con `MP_ACCESS_TOKEN` y `MP_SYNC_USER_ID`
existentes hasta que el usuario conecte su token desde Configuración. Después
de migrarlo, se pueden quitar esos dos secrets del proyecto Supabase.

### 6. Deployar la función

```bash
supabase functions deploy sync-mercadopago
```

### 7. Programar la descarga diaria

En el **SQL Editor** de Supabase, corré el bloque final de
`supabase/schema.sql` (la parte de `pg_cron` / `pg_net`), reemplazando
`<PROJECT_REF>` y `<SERVICE_ROLE_KEY>` (esta última está en
Settings > API > service_role — es distinta de la anon/publishable key
que usa la app, y nunca va en el código del frontend). El cron ejecuta la
función a las 8am de Argentina, después del horario diario configurado en
Mercado Pago.

### 8. Verificar la primera sincronización

Al conectar el token desde **Configuración > Mercado Pago**, la app hace una
primera consulta y muestra su resultado ahí mismo. Los movimientos que no
coincidan con una regla quedan en **Por revisar** para que les asignes categoría.

Desde **Configuración > Tarjeta de crédito** podés cargar el importe por cuota,
las cuotas pendientes, la categoría y el primer mes. La app crea un movimiento
en cada mes futuro, así queda incluido en esos presupuestos.

La función selecciona reportes con estado `processed`; si todavía no hay
ninguno, no importa movimientos y se puede volver a invocar más tarde.

## ¿Por qué comparte proyecto con la cursada?

Supabase Free da 2 proyectos activos, pero ese límite es **por cuenta**
(sumando todas las organizaciones donde sos owner o admin), no algo que se
esquive creando una organización nueva. La otra opción sería una base de
datos aparte solo para Postgres — [Neon](https://neon.com) tiene un free
tier bastante más generoso en cantidad de proyectos — pero no trae login ni
políticas de seguridad como Supabase, así que habría que armar la
autenticación de cero. Compartir el proyecto con un esquema separado
(`gastos`) es la opción sin fricción: mismo Auth, mismo panel, cero costo
extra, y tus datos de la cursada ni se enteran de que esta app existe.
