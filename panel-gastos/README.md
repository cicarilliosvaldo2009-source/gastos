# Panel de Gastos

App web para controlar tus gastos, pensada para vos como único usuario.
Next.js (App Router) + Supabase (base de datos + login) + Vercel (hosting).

No incluye seguimiento de ingresos/sueldo a propósito: la app solo registra
y organiza gastos.

## 1. Crear el proyecto en Supabase

¿Ya tenés un proyecto de Supabase gratis usado en otra cosa (como tu cursada) y llegaste al límite de 2 proyectos gratis por cuenta? No hace falta crear uno nuevo ni pagar: **usá ese mismo proyecto**. Este `schema.sql` ya está pensado para eso — crea todo dentro de un esquema propio llamado `gastos`, separado de tus otras tablas, así que no choca con nada de la otra app. El único paso extra es el 1.6 de abajo.

1. Entrá a https://supabase.com y abrí el proyecto que vayas a usar (nuevo o uno que ya tengas).
2. Andá a **SQL Editor** y pegá el contenido de `supabase/schema.sql`. Ejecutalo.
   Esto crea el esquema `gastos` con las tablas `categories`, `transactions`,
   `category_rules` y `sync_state`, y las políticas de seguridad (RLS) para
   que solo vos puedas ver y modificar tus datos.
3. Andá a **Authentication > Providers > Email** y desactivá
   "Allow new users to sign up". Así nadie más se puede registrar en tu app.
   (Si ya usás ese proyecto para la cursada y ahí sí necesitás que la gente
   se registre, podés saltear este paso — igual nadie va a poder entrar a
   *esta* app sin que le crees el usuario vos, porque el login solo lee
   contra Supabase Auth y vos sos el único con datos en el esquema `gastos`.)
4. Andá a **Authentication > Users > Add user** y create tu propio usuario
   (email + contraseña), si todavía no tenés uno en ese proyecto.
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

Abrí http://localhost:3000, iniciá sesión con el usuario que creaste en el
paso 1.4, y deberías ver el panel con las 6 categorías por defecto
(Comida, Transporte, Servicios, Ocio, Salud, Otros) ya cargadas y en $0.

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

Como el login está protegido por Supabase Auth y los signups están
desactivados, aunque la URL sea pública nadie más va a poder entrar.

## Sobre el botón "+"

El botón "+" sirve para los gastos que cargás manualmente. Cuando completes
la Fase 2, Mercado Pago se sincronizará a diario. Vas a seguir usando el botón
para lo que Mercado Pago no vea (efectivo, gastos compartidos, etc.)
— por eso cada gasto tiene una etiqueta `manual` o `MP` junto a la fecha,
para que después puedas distinguir lo que cargaste vos de lo que entró solo.

## Fase 2: carga automática desde Mercado Pago

### 1. Crear tu aplicación en Mercado Pago y obtener el Access Token

1. Entrá a https://www.mercadopago.com.ar/developers/panel con tu cuenta
   habitual de Mercado Pago (la misma con la que cobrás los viajes de Uber).
2. "Tus integraciones" > "Crear aplicación". Elegí cualquier nombre
   (ej. "Panel de gastos"), y como tipo de integración "Pagos online".
3. Entrá a la aplicación creada > "Credenciales de producción" y copiá el
   **Access Token**. Guardalo, lo vas a necesitar en el paso 5.

### 2. Configurar el reporte "Todas las transacciones" (una sola vez)

Con `curl` (o Postman), reemplazando `TU_ACCESS_TOKEN`:

```bash
curl -X POST \
  -H 'accept: application/json' \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer TU_ACCESS_TOKEN' \
  'https://api.mercadopago.com/v1/account/settlement_report/config' \
  -d '{
    "file_name_prefix": "gastos-mp",
    "display_timezone": "GMT-03",
    "separator": ";",
    "header_language": "es",
    "frequency": { "type": "daily", "hour": 6 },
    "columns": [
      { "key": "TRANSACTION_DATE" },
      { "key": "TRANSACTION_TYPE" },
      { "key": "TRANSACTION_AMOUNT" },
      { "key": "SETTLEMENT_NET_AMOUNT" },
      { "key": "SOURCE_ID" },
      { "key": "EXTERNAL_REFERENCE" },
      { "key": "DESCRIPTION" }
    ]
  }'
```

Después activá la generación automática diaria:

```bash
curl -X POST \
  -H 'Authorization: Bearer TU_ACCESS_TOKEN' \
  'https://api.mercadopago.com/v1/account/settlement_report/schedule'
```

Desde ahora, Mercado Pago va a generar solo, todos los días, un reporte con
tus movimientos. Podés ver el primero generándose en el panel de Mercado
Pago, en "Tu negocio > Reportes", para confirmar que quedó bien configurado.

La función está preparada para el CSV con las columnas configuradas arriba.
La sincronización usa `SETTLEMENT_NET_AMOUNT` (impacto neto en la cuenta) y
solo carga las filas con monto negativo. Para reconocer un movimiento entre
reportes y evitar duplicados usa `SOURCE_ID`, el tipo, la fecha y el monto.

### 3. Instalar el Supabase CLI y conectarlo a tu proyecto

```bash
npm install -g supabase
supabase login
supabase link --project-ref TU_PROJECT_REF
```

(`TU_PROJECT_REF` está en la URL de tu proyecto en supabase.com, algo como
`abcdefghijklmnop`).

### 4. Aplicar las migraciones a una base existente

En el **SQL Editor** de Supabase ejecutá una vez el contenido de cada archivo:
`supabase/add_external_id.sql`, `supabase/add_settings.sql`,
`supabase/add_excluded_from_budget.sql` y
`supabase/add_review_and_card_installments.sql`. Agregan los identificadores
para evitar duplicados, el límite mensual, la exclusión de gastos del negocio,
la bandeja de revisión y los datos de cuotas de tarjeta.

### 5. Guardar tus credenciales como secrets de la función

```bash
supabase secrets set MP_ACCESS_TOKEN=tu_access_token_de_mercado_pago
supabase secrets set MP_SYNC_USER_ID=tu_user_id_de_supabase
```

Tu `MP_SYNC_USER_ID` es el UID de tu usuario: lo encontrás en
**Authentication > Users** dentro del panel de Supabase.

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

### 8. Probarla a mano antes de esperar 24hs

```bash
supabase functions invoke sync-mercadopago
```

Si devuelve `Listo: se sincronizaron N gastos`, andá a la app: deberían
aparecer en la categoría "Sin categorizar" con la etiqueta `MP`, listos para
que los reclasifiques con un toque. Si no tienen una regla, aparecen en
"Por revisar". Al elegir una categoría, podés guardar una regla permanente
para futuras descripciones similares.

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
