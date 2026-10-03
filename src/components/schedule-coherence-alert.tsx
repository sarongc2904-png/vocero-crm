export type ScheduleCoherenceView = {
  status: "matches" | "differences" | "unverifiable";
  message: string;
  differences: Array<{ day: string; document: string; agenda: string }>;
  shortBookingWindow: boolean;
  maxDaysAhead: number | null;
};

export function ScheduleCoherenceAlert({
  coherence,
}: {
  coherence: ScheduleCoherenceView;
}) {
  const warning = coherence.status !== "matches" || coherence.shortBookingWindow;
  return (
    <section
      className={`rounded-xl border p-4 text-sm ${
        warning ? "border-warning-soft bg-warning-tint" : "bg-secondary"
      }`}
    >
      <p className="font-semibold">Coherencia de horarios</p>
      <p className="mt-1 text-text-2">{coherence.message}</p>
      {coherence.differences.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {coherence.differences.map((difference) => (
            <li key={`${difference.day}-${difference.document}`}>
              {difference.day}: documento {difference.document}; agenda {difference.agenda}.
            </li>
          ))}
        </ul>
      )}
      {coherence.shortBookingWindow && (
        <p className="mt-2 font-medium">
          La agenda está abierta solo {coherence.maxDaysAhead} días; se recomiendan al menos 14.
        </p>
      )}
    </section>
  );
}
