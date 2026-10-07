import { Badge } from "@/components/ui/badge";
import { QUOTE_STATUS_LABEL, type QuoteStatusValue } from "@/lib/quote-format";

const VARIANT: Record<QuoteStatusValue, "secondary" | "default" | "success" | "destructive" | "warning" | "outline"> = {
  borrador: "secondary",
  enviada: "default",
  aceptada: "success",
  rechazada: "destructive",
  expirada: "warning",
  cancelada: "outline",
};

export function QuoteStatusBadge({ status }: { status: QuoteStatusValue }) {
  return <Badge variant={VARIANT[status]}>{QUOTE_STATUS_LABEL[status]}</Badge>;
}
