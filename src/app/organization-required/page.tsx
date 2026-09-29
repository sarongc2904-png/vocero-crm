import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/session";
import { SignOutButton } from "@/components/sign-out-button";

export const dynamic = "force-dynamic";

/**
 * AUTH-2 — Pantalla terminal para una cuenta autenticada sin organización.
 *
 * Antes, este estado caía en el mismo `null` que "no hay sesión", así que el
 * layout de `(app)` devolvía al usuario a `/login`. Tras ingresar con
 * credenciales correctas volvía a `/inbox`, que lo mandaba otra vez a `/login`:
 * un bucle sin mensaje donde la persona no podía saber qué pasaba ni qué hacer.
 *
 * Regla explícita: aquí NO se crea ninguna organización. Un usuario sin
 * membership no puede fabricarse un tenant por el hecho de iniciar sesión; el
 * alta la hace un owner o el superadmin por la vía controlada.
 */
const COPY: Record<
  "no_membership" | "suspended" | "generic",
  { title: string; body: string }
> = {
  no_membership: {
    title: "Tu cuenta no tiene acceso a una organización.",
    body: "Tu correo y tu contraseña son correctos, pero esta cuenta todavía no pertenece a ninguna organización del CRM. Pide a la persona administradora de tu cuenta que te agregue al equipo con el correo con el que iniciaste sesión.",
  },
  suspended: {
    title: "Tu acceso a la organización está suspendido.",
    body: "La cuenta es válida, pero tu acceso a esta organización está suspendido ahora mismo. Contacta a la persona administradora para que lo reactive.",
  },
  generic: {
    title: "Tu cuenta no tiene acceso a una organización.",
    body: "No pudimos resolver una organización activa para esta cuenta. Contacta a la persona administradora de tu cuenta.",
  },
};

export default async function OrganizationRequiredPage() {
  const state = await getSessionState();

  // Sin sesión no hay nada que explicar: al login.
  if (state.status === "anonymous") redirect("/login");
  // Si ya tiene acceso, esta pantalla no aplica.
  if (state.status === "ok") redirect("/");

  // El motivo se recalcula aquí en el servidor, nunca se lee de la URL: un
  // parámetro de query no debe poder cambiar lo que la pantalla afirma.
  const copy = COPY[state.reason];

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="w-full max-w-lg rounded-2xl border bg-background p-6 shadow-sm">
        <p className="kicker text-brand-text">Acceso</p>
        <h1 className="mt-2 text-2xl font-bold">{copy.title}</h1>
        <p className="mt-3 text-sm leading-6 text-text-3">{copy.body}</p>

        <div className="mt-6 rounded-xl bg-secondary p-4 text-sm text-text-3">
          <p>
            Iniciaste sesión correctamente, así que tu contraseña y tu correo
            funcionan. Lo que falta es la pertenencia a una organización.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SignOutButton />
        </div>

        <p className="mt-6 text-xs leading-5 text-text-3">
          Por seguridad no creamos una organización automáticamente al iniciar
          sesión: el acceso se otorga desde el equipo de tu cuenta.
        </p>
      </section>
    </main>
  );
}
