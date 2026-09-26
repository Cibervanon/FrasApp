-- =============================================================================
-- Seed de desarrollo. Un tenant de demo, su marca, sus 7 features y su
-- contenido. `supabase db reset` lo aplica siempre.
--
-- Regla 3: **cada feature del MVP tiene su fila.** Si anades una fila aqui que
-- no este en el `check` de tenant_features, la migracion falla; y si falta una,
-- el test `config-schema` que fija las 7 keys falla. Los dos lados estan atados.
--
-- Regla 1: la marca de aqui es del club de DEMO. La app nunca la hardcodea, la
-- lee de la BD. Por eso estos valores pueden existir sin violar la regla.
-- =============================================================================

-- Id fijo para que los tests puedan referenciarlo sin consultarlo.
-- 00000000-0000-4000-8000-000000000001
insert into public.tenants (id, name, slug, currency, timezone, locale, min_player_age)
values (
  '00000000-0000-4000-8000-000000000001',
  'Club Padel Demo',
  'club-padel-demo',
  'eur',
  'Europe/Madrid',
  'es-ES',
  18
)
on conflict (id) do nothing;

-- Marca del club de demo. Sin logo ni favicon: en desarrollo no hay ficheros
-- en Storage, y un logo_path que no existe daria 404 en todas las pantallas.
insert into public.tenant_branding (
  tenant_id,
  primary_color,
  secondary_color,
  logo_path,
  favicon_path,
  hero_image_path,
  font_family,
  email_from_name,
  email_reply_to
)
values (
  '00000000-0000-4000-8000-000000000001',
  '#1a4d8f',
  '#e8a33d',
  null,
  null,
  null,
  'Inter',
  'Club Padel Demo',
  'padel@clubpaddemo.example'
)
on conflict (tenant_id) do nothing;

-- Las 7 features del MVP. Estado por defecto: lo minimo para que la app arranque
-- y el club pueda probar. `payments` apagado a proposito: sin onboarding de
-- Connect el club NO cobra, y encenderlo sin cuenta daria un error de Stripe al
-- socio en vez de un mensaje accionable al gestor.
insert into public.tenant_features (tenant_id, feature_key, enabled)
values
  ('00000000-0000-4000-8000-000000000001', 'calendar',           true),
  ('00000000-0000-4000-8000-000000000001', 'booking',            true),
  ('00000000-0000-4000-8000-000000000001', 'payments',           false),
  ('00000000-0000-4000-8000-000000000001', 'open_matches',       true),
  ('00000000-0000-4000-8000-000000000001', 'news',               true),
  ('00000000-0000-4000-8000-000000000001', 'gdpr_export',        true),
  ('00000000-0000-4000-8000-000000000001', 'push_notifications', false)
on conflict (tenant_id, feature_key) do nothing;

-- Politica de cancelacion (OQ-5) y aviso legal (OQ-9).
--
-- Los 3 tramos son el **valor por defecto sugerido**, no un fijo: el club puede
-- cambiarlos desde el panel y el motor de reembolso lee lo de aqui.
--
-- Cada tramo lleva `label` porque es el texto que ve el socio en
-- /reserva/confirmar y al cancelar. Lo escribe el gestor, no la app.
insert into public.tenant_content (tenant_id, content_key, value)
values (
  '00000000-0000-4000-8000-000000000001',
  'cancellation_policy',
  '{
    "tiers": [
      {
        "hours_before": 24,
        "refund_percent": 100,
        "label": "Cancelacion gratuita hasta 24h antes"
      },
      {
        "hours_before": 12,
        "refund_percent": 50,
        "label": "Entre 24h y 12h antes se devuelve el 50%"
      },
      {
        "hours_before": 0,
        "refund_percent": 0,
        "label": "Con menos de 12h no hay devolucion"
      }
    ],
    "policy_text": "Si cancelas con mas de 24h de antelacion, te devolvemos el 100%. Entre 24 y 12 horas te devolvemos la mitad. Con menos de 12h no hay devolucion, pero puedes ceder tu plaza a otro socio del club.",
    "notice_text": "Al reservar declaras que tienes al menos 18 anos o que cuenta con el consentimiento de tu tutor."
  }'::jsonb
),
(
  '00000000-0000-4000-8000-000000000001',
  'about_club',
  '"Club de padel de demostracion. Sustituye este texto desde el panel del gestor."'::jsonb
)
on conflict (tenant_id, content_key) do nothing;
