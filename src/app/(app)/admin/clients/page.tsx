import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { CommercialAdminClient } from "@/components/admin/commercial-admin-client";

export const dynamic = "force-dynamic";

export default async function CommercialAdminPage() {
  const session = await requireSession();
  if (!session.isSuperadmin) redirect("/dashboard");

  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-7xl">
        <CommercialAdminClient />
      </div>
    </main>
  );
}
