# FrasApp

Monorepo de plantillas PWA multi-tenant para negocios locales. Cada cliente es una
instancia aislada: su propia base de datos, su propia marca, sus propias features.

## Estructura

```
packages/
  ui/              Componentes presentacionales. SIN marca, SIN logica, SIN Supabase
  core/            Dominio puro: precios, reembolsos, maquina de estados. SIN React, SIN red
  config-schema/   Contrato Zod de tenant: branding, features, content
apps/
  padel-template/  La plantilla vendible. Next.js App Router. Orquesta las tres capas
clients/           Uno por cliente real. Vacio en el MVP
docs/
  specs/           Especificaciones funcionales y tecnicas
  adr/             Un ADR por decision de arquitectura
```

## Regla de capas

```
app  ->  ui  ->  core
app  ->  config-schema
app  ->  core
```

- `ui` no sabe nada de padel ni de Supabase. Si importa `@supabase/*`, es un fallo.
- `core` no sabe nada de Next.js ni de React. Sus tests corren sin browser y sin red.
- `ui` y `core` no se conocen entre si. Los une la app.
- Nada de marca hardcodeada: color, logo y nombre vienen de `tenant_branding`.

El test de limites de capas (T6) verifica esto automaticamente.

## Comandos

| Comando | Que hace |
|---------|----------|
| `pnpm install` | Instala dependencias |
| `pnpm dev` | Levanta la app en desarrollo |
| `pnpm build` | Build de produccion |
| `pnpm typecheck` | TypeScript estricto, incluye tests |
| `pnpm lint` | ESLint, `--max-warnings 0` |
| `pnpm test` | Tests unitarios de los 4 paquetes |
| `pnpm test:e2e` | Playwright en 375x667 |
| `pnpm verify` | typecheck + lint + test + build. **El gate antes de commitear** |
| `pnpm db:reset` | Resetea la base local de Supabase |

## Variables de entorno

Copiar `.env.example` a `.env.local` y rellenar. **9 variables.** `.env.local` esta en
`.gitignore` y no se commitea nunca.

Las `NEXT_PUBLIC_*` llegan al cliente: son publicas por diseno. La `anon key` solo es
segura si **RLS esta completa** en cada tabla con `tenant_id`. Sin RLS, es una puerta
abierta.

## Estado

T0 completo: monorepo, tooling y capas montadas. El esquema y la logica de negocio
empiezan en T1. Ver `tasks/todo.md` para el plan completo.
