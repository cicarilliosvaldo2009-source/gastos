import Dashboard from "@/components/Dashboard";

// Esta página depende de la sesión del usuario (Supabase Auth), así que no
// tiene sentido pre-renderizarla como estática en el build: forzamos que
// se renderice en cada visita.
export const dynamic = "force-dynamic";

export default function Home() {
  return <Dashboard />;
}
