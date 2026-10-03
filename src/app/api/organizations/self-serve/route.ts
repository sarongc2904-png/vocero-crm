import { headers } from "next/headers";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import {
  BUSINESS_NAME_MAX_LENGTH,
  createSelfServeOrganizationForOwner,
  OrganizationBootstrapError,
} from "@/server/auth/organizations";
import { isPublicSignupExplicitlyOpen } from "@/server/auth/registration";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  businessName: z.string().trim().min(2).max(BUSINESS_NAME_MAX_LENGTH),
});

export async function POST(request: Request) {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return apiError(401, "unauthorized", "No autenticado");

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      422,
      "invalid_business_name",
      `El nombre del negocio debe tener entre 2 y ${BUSINESS_NAME_MAX_LENGTH} caracteres`
    );
  }

  try {
    const organization = await createSelfServeOrganizationForOwner(
      session.user.id,
      parsed.data.businessName,
      { publicSignupOpen: isPublicSignupExplicitlyOpen() }
    );
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: organization.id },
    });
    return Response.json({ organization }, { status: organization.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof OrganizationBootstrapError) {
      const status = error.code === "signup_closed" ? 403 : 422;
      return apiError(status, error.code, error.message);
    }
    throw error;
  }
}
